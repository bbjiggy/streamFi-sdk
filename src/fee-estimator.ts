import { SorobanRpc, Transaction } from '@stellar/stellar-sdk';
import { createRpcServer } from './soroban.js';

/** Inclusion-fee priority tier used by {@link FeeEstimator.getDynamicFee}. */
export type FeePriority = 'low' | 'standard' | 'urgent';

/**
 * Resource-fee components reported by a Soroban simulation (#906).
 *
 * Unlike the inclusion fee (see {@link FeeEstimator.getDynamicFee}, which
 * comes from Horizon's `/fee_stats`), these come from `simulateTransaction`
 * and represent what the network will actually charge to run the invocation:
 *
 * - `resourceFee` — total resource fee in stroops (CPU + RAM + storage
 *   footprint), as `SimulateTransactionResponse.minResourceFee`.
 * - `cpuInstructions` — instruction budget the invocation is scheduled for.
 * - `readBytes` / `writeBytes` — storage footprint (read/write) bytes.
 */
export interface SorobanResourceFees {
  resourceFee:     bigint;
  cpuInstructions: bigint;
  readBytes:       bigint;
  writeBytes:      bigint;
}

/**
 * Pull the resource-fee components out of a `simulateTransaction` result.
 *
 * `minResourceFee` is the network's single number for the whole invocation;
 * the per-host-function `transactionData.resources()` breaks that down into
 * the CPU instruction budget and the storage read/write footprint so a caller
 * can see *why* a fee is high (a big read footprint, say) and trim it. Pure
 * and side-effect free, so it can be unit-tested without a live RPC.
 *
 * @param simulation - The `SimulateTransactionResponse` to read.
 * @returns Aggregated resource-fee components; `0n` for any field the
 *   simulation did not populate (e.g. an error simulation with no results).
 */
export function extractResourceFees(
  simulation: SorobanRpc.Api.SimulateTransactionResponse,
): SorobanResourceFees {
  // The installed SDK's `SimulateTransactionResponse` type lags the live RPC
  // shape, which always carries `minResourceFee` and `results[].transactionData`;
  // read them through a loose cast (same defensiveness the SDK uses elsewhere
  // for fields its own types omit).
  const sim = simulation as unknown as {
    minResourceFee?: string;
    results?: Array<{ transactionData?: { resources?: () => { instructions?: bigint; diskReadBytes?: bigint; writeBytes?: bigint } } }>;
  };
  const resourceFee = sim.minResourceFee ? BigInt(sim.minResourceFee) : 0n;
  let cpuInstructions = 0n;
  let readBytes = 0n;
  let writeBytes = 0n;
  for (const result of sim.results ?? []) {
    const resources = result.transactionData?.resources?.();
    if (resources) {
      cpuInstructions += resources.instructions ?? 0n;
      readBytes += resources.diskReadBytes ?? 0n;
      writeBytes += resources.writeBytes ?? 0n;
    }
  }
  return { resourceFee, cpuInstructions, readBytes, writeBytes };
}

const DEFAULT_PRIORITY_MULTIPLIERS: Record<FeePriority, number> = {
  low: 1,
  standard: 1.5,
  urgent: 3,
};

const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';

export interface DynamicFeeOptions extends FeeEstimateOptions {
  /** Priority tier, or a custom numeric multiplier (>= 1). Defaults to `'standard'`. */
  priority?: FeePriority | number;
}

export interface FeeEstimatorOptions {
  /** Horizon base URL queried for `/fee_stats`. Defaults to Stellar mainnet Horizon. */
  horizonUrl?: string;
  /** `fetch` implementation used for Horizon requests. Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Override the multipliers applied per priority tier. */
  priorityMultipliers?: Partial<Record<FeePriority, number>>;
  /**
   * Minimum interval in milliseconds between network fetches.
   * Within this window, `estimateFee` serves the cached `baseFee`
   * instead of calling `networkFetcher` again. Default: no interval (every call fetches).
   */
  minRefetchIntervalMs?: number;
  /**
   * Inclusion-fee buffer multiplier applied to every estimated fee to resist
   * out-bidding during high-congestion ledger periods. A value of `1` (default)
   * disables the buffer; e.g. `1.2` adds a 20% safety margin so urgent stream
   * creations are included without delay. Must be a finite number `>= 1`.
   */
  feeMultiplier?: number;
}

/**
 * Options for fee estimation with error handling callback.
 */

export interface FeeEstimateOptions {
  onError?: (error: Error) => void;
  /** Stable operation key. Entries with the same key share a short-lived estimate. */
  cacheKey?: string;
  /** Contract method used to derive a cache key when `cacheKey` is omitted. */
  method?: string;
  /** Contract arguments used to derive a cache key when `cacheKey` is omitted. */
  args?: unknown[];
}

/**
 * Estimates Soroban fees with caching and fallback behavior.
 * Represents all fees as bigint stroops to maintain precision and avoid IEEE-754 rounding errors.
 * Consistent with the SDK's bigint-stroops convention used for all on-chain monetary amounts.
 */
export class FeeEstimator {
  private baseFee: bigint;
  private isEstimating: boolean = false;
  private currentPromises = new Map<string, Promise<bigint>>();
  private readonly minRefetchIntervalMs: number;
  private lastSuccessfulFetchAtValue: number | null = null;
  private lastErrorValue: Error | null = null;
  private readonly cache = new Map<string, { fee: bigint; fetchedAt: number }>();
  private readonly cacheTtlMs = 3_000;
  private readonly horizonUrl: string;
  private readonly fetchImpl: typeof fetch | undefined;
  private readonly priorityMultipliers: Record<FeePriority, number>;
  private readonly feeMultiplier: number;

  /**
   * Creates a new FeeEstimator instance.
   *
   * @param initialFee - Starting fee in stroops (bigint). Defaults to 100n stroops.
   * @param options - Configuration options for caching behavior.
   */
  constructor(initialFee: bigint = 100n, options?: FeeEstimatorOptions) {
    this.baseFee = initialFee;
    this.minRefetchIntervalMs = options?.minRefetchIntervalMs ?? 0;
    this.horizonUrl = (options?.horizonUrl ?? DEFAULT_HORIZON_URL).replace(/\/+$/, '');
    this.fetchImpl = options?.fetch;
    this.priorityMultipliers = { ...DEFAULT_PRIORITY_MULTIPLIERS, ...options?.priorityMultipliers };
    const feeMultiplier = options?.feeMultiplier ?? 1;
    if (!Number.isFinite(feeMultiplier) || feeMultiplier < 1) {
      throw new Error(`Invalid feeMultiplier: must be a finite number >= 1, got ${String(feeMultiplier)}`);
    }
    this.feeMultiplier = feeMultiplier;
  }

  /**
   * Estimates an inclusion fee (stroops per operation) from live network
   * congestion by querying Horizon's `/fee_stats`, then scales it by the
   * requested priority multiplier.
   *
   * The base is the modal fee charged in recent ledgers (falling back to
   * `last_ledger_base_fee`). Result caching, request de-duplication and the
   * last-known-fee fallback on network errors are shared with `estimateFee`.
   *
   * @example
   * const fee = await estimator.getDynamicFee({ priority: 'urgent' });
   */
  async getDynamicFee(options: DynamicFeeOptions = {}): Promise<bigint> {
    const { priority = 'standard', ...rest } = options;
    const multiplier = typeof priority === 'number' ? priority : this.priorityMultipliers[priority];
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      throw new Error(`Invalid fee priority multiplier: ${String(priority)}`);
    }

    const fee = await this.estimateFee(async () => {
      const doFetch = this.fetchImpl ?? globalThis.fetch;
      const res = await doFetch(`${this.horizonUrl}/fee_stats`);
      if (!res.ok) throw new Error(`Horizon fee_stats request failed: ${res.status}`);
      const stats = (await res.json()) as {
        last_ledger_base_fee?: string;
        fee_charged?: { mode?: string };
      };
      const raw = stats.fee_charged?.mode ?? stats.last_ledger_base_fee;
      if (raw === undefined || !/^\d+$/.test(raw)) throw new Error('Invalid network fee response');
      // Basis-point math keeps the result an exact bigint.
      return (BigInt(raw) * BigInt(Math.round(multiplier * 100)) + 99n) / 100n;
    }, { cacheKey: `dynamic:${String(priority)}`, ...rest });

    return this.applyBuffer(fee);
  }

  /**
   * Applies the configured inclusion-fee buffer multiplier (see
   * {@link FeeEstimatorOptions.feeMultiplier}) to a computed fee so urgent
   * transactions resist out-bidding during high-congestion ledger periods.
   * Uses basis-point math to keep the result an exact bigint stroops value.
   */
  private applyBuffer(fee: bigint): bigint {
    if (this.feeMultiplier === 1) return fee;
    return (fee * BigInt(Math.round(this.feeMultiplier * 100)) + 99n) / 100n;
  }

  /**
   * Safely estimates the fee by fetching it asynchronously.
   * Utilizes an atomic state transition / locking mechanism to prevent race conditions
   * when multiple async hooks fire simultaneously.
   *
   * If `minRefetchIntervalMs` was configured, returns the cached `baseFee` when
   * called within that window after the last successful fetch.
   *
   * Returns fee as bigint stroops to avoid IEEE-754 floating-point precision loss.
   */
  async estimateFee(
    networkFetcher: () => Promise<bigint>,
    options: FeeEstimateOptions = {}
  ): Promise<bigint> {
    const cacheKey = options.cacheKey ?? (options.method
      ? `${options.method}:${JSON.stringify(options.args ?? [], (_key, value) =>
        typeof value === 'bigint' ? `${value}n` : value,
      )}`
      : undefined);
    const cached = cacheKey ? this.cache.get(cacheKey) : undefined;
    if (cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) {
      return cached.fee;
    }

    const promiseKey = cacheKey ?? '__uncached__';
    const currentPromise = this.currentPromises.get(promiseKey);
    if (currentPromise) {
      return currentPromise;
    }

    // Return cached fee if within the minimum re-fetch interval
    if (this.minRefetchIntervalMs > 0) {
      const elapsed = Date.now() - (this.lastSuccessfulFetchAtValue ?? 0);
      if (elapsed < this.minRefetchIntervalMs) {
        // Surface the last error if one exists, instead of silently returning stale fee
        if (this.lastErrorValue) {
          options.onError?.(this.lastErrorValue);
          throw this.lastErrorValue;
        }
        return this.baseFee;
      }
    }

    const promise = (async () => {
      try {
        this.isEstimating = true;
        const rawFee = await networkFetcher();

        // Ensure bigint is valid and non-negative
        if (typeof rawFee !== 'bigint' || rawFee < 0n) {
            throw new Error("Invalid network fee response");
        }

        this.baseFee = rawFee;
        this.lastSuccessfulFetchAtValue = Date.now();
        this.lastErrorValue = null;
        if (cacheKey) this.cache.set(cacheKey, { fee: rawFee, fetchedAt: this.lastSuccessfulFetchAtValue });
        return this.baseFee;
      } catch (error) {
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        this.lastErrorValue = normalizedError;
        options.onError?.(normalizedError);

        // Fallback sequence: return the last known base fee
        return this.baseFee;
      } finally {
        this.isEstimating = false;
        this.currentPromises.delete(promiseKey);
      }
    })();
    this.currentPromises.set(promiseKey, promise);

    return promise;
  }

  get _isEstimating(): boolean {
    return this.isEstimating;
  }

  /**
   * Returns the current base fee in stroops (bigint).
   * This is either the last successfully fetched value or the initial/fallback fee.
   *
   * @returns The base fee as bigint stroops.
   */
  getBaseFee(): bigint {
    return this.baseFee;
  }

  get lastSuccessfulFetchAt(): number | null {
    return this.lastSuccessfulFetchAtValue;
  }

  get lastError(): Error | null {
    return this.lastErrorValue;
  }

  get isStale(): boolean {
    return this.lastErrorValue !== null;
  }

  /**
   * Estimate the Soroban resource fee for a transaction by simulating it.
   *
   * Inclusion fee (`getDynamicFee`) tells you what the network charges to
   * *include* the transaction; this tells you what the invocation itself
   * costs in CPU/RAM/footprint — the component that spikes during fee surges
   * and causes "insufficient fee" rejections (#906). The breakdown comes from
   * {@link extractResourceFees}.
   *
   * @param transaction - The (unsigned) transaction to simulate.
   * @param options.simulate - Inject a simulator for testing; defaults to
   *   `sorobanServer.simulateTransaction(tx)` against `options.rpcUrl`.
   * @param options.rpcUrl - RPC endpoint used when no `simulate` is supplied.
   * @example
   * ```ts
   * const fees = await estimator.estimateResourceFees(tx, { rpcUrl });
   * console.log(`resource fee: ${fees.resourceFee} stroops, CPU: ${fees.cpuInstructions}`);
   * ```
   */
  async estimateResourceFees(
    transaction: Transaction,
    options: {
      rpcUrl?: string;
      simulate?: (tx: Transaction) => Promise<SorobanRpc.Api.SimulateTransactionResponse>;
    } = {},
  ): Promise<SorobanResourceFees> {
    const simulate = options.simulate ?? (async (tx) => {
      if (!options.rpcUrl) {
        throw new Error('estimateResourceFees requires rpcUrl or a simulate callback');
      }
      return createRpcServer(options.rpcUrl).simulateTransaction(tx);
    });
    const simulation = await simulate(transaction);
    return extractResourceFees(simulation);
  }
}
