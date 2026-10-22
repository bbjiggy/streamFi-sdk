/** Inclusion-fee priority tier used by {@link FeeEstimator.getDynamicFee}. */
export type FeePriority = 'low' | 'standard' | 'urgent';

const DEFAULT_PRIORITY_MULTIPLIERS: Record<FeePriority, number> = {
  low: 1,
  standard: 1.5,
  urgent: 3,
};

const DEFAULT_HORIZON_URL = 'https://horizon.stellar.org';

/** Soroban's per-transaction CPU instruction ceiling on Stellar mainnet. */
export const DEFAULT_CPU_INSTRUCTION_LIMIT = 100_000_000;

/**
 * Estimated CPU instructions consumed by one batched withdraw operation
 * (contract invocation, auth verification, storage read/write), calibrated
 * from observed mainnet simulation results for `withdraw`.
 */
export const DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM = 4_000_000;

/**
 * Fixed per-transaction CPU overhead (envelope decoding, auth-entry
 * verification, footprint merge) that doesn't scale with batch size.
 */
export const DEFAULT_BATCH_FIXED_OVERHEAD_INSTRUCTIONS = 2_000_000;

/** Default fraction of {@link DEFAULT_CPU_INSTRUCTION_LIMIT} at which {@link estimateBatchFootprint} flags a batch. */
export const DEFAULT_BATCH_WARN_THRESHOLD = 0.9;

export interface BatchFootprintOptions {
  /** CPU instructions consumed per batch item. Default {@link DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM}. */
  instructionsPerItem?: number;
  /** Fixed per-transaction overhead instructions. Default {@link DEFAULT_BATCH_FIXED_OVERHEAD_INSTRUCTIONS}. */
  fixedOverheadInstructions?: number;
  /** Network CPU instruction ceiling per transaction. Default {@link DEFAULT_CPU_INSTRUCTION_LIMIT}. */
  cpuInstructionLimit?: number;
  /** Utilization fraction (0-1] above which `exceedsThreshold` is set. Default {@link DEFAULT_BATCH_WARN_THRESHOLD}. */
  warnThreshold?: number;
}

/** Pre-execution estimate of a batch's Soroban CPU instruction footprint. */
export interface ResourceEstimate {
  /** The `itemCount` the estimate was computed for. */
  itemCount: number;
  /** Estimated total CPU instructions the batch will consume. */
  cpuInstructions: number;
  /** The CPU instruction ceiling the estimate was computed against. */
  cpuInstructionLimit: number;
  /** `cpuInstructions / cpuInstructionLimit`. Can exceed 1 for a batch that will not fit in a single transaction. */
  utilizationRatio: number;
  /** `true` once `utilizationRatio` passes the configured `warnThreshold`. */
  exceedsThreshold: boolean;
  /** The largest `itemCount` that stays at or under `warnThreshold`, for splitting an oversized batch. */
  recommendedMaxItems: number;
}

/**
 * Estimates the Soroban CPU instruction footprint of a multi-stream batch
 * withdrawal, without submitting or simulating anything on-chain.
 *
 * Soroban caps CPU instructions per transaction; a batch sized without
 * regard for that limit fails simulation only after the caller has already
 * built it. This gives clients a cheap, synchronous pre-flight check so they
 * can split an oversized batch — e.g. 25 withdrawals — before submission.
 *
 * The per-item and overhead costs are heuristics (see
 * {@link DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM}); pass `options` to recalibrate
 * them against your own contract's measured simulation footprint.
 *
 * @example
 * const estimate = estimateBatchFootprint(25);
 * if (estimate.exceedsThreshold) {
 *   // split into chunks of estimate.recommendedMaxItems
 * }
 */
export function estimateBatchFootprint(
  itemCount: number,
  options: BatchFootprintOptions = {},
): ResourceEstimate {
  if (!Number.isInteger(itemCount) || itemCount < 1) {
    throw new Error(`itemCount must be a positive integer, got ${String(itemCount)}`);
  }

  const instructionsPerItem = options.instructionsPerItem ?? DEFAULT_INSTRUCTIONS_PER_BATCH_ITEM;
  const fixedOverheadInstructions = options.fixedOverheadInstructions ?? DEFAULT_BATCH_FIXED_OVERHEAD_INSTRUCTIONS;
  const cpuInstructionLimit = options.cpuInstructionLimit ?? DEFAULT_CPU_INSTRUCTION_LIMIT;
  const warnThreshold = options.warnThreshold ?? DEFAULT_BATCH_WARN_THRESHOLD;

  if (!Number.isFinite(instructionsPerItem) || instructionsPerItem < 0) {
    throw new Error(`instructionsPerItem must be a non-negative finite number, got ${String(instructionsPerItem)}`);
  }
  if (!Number.isFinite(fixedOverheadInstructions) || fixedOverheadInstructions < 0) {
    throw new Error(`fixedOverheadInstructions must be a non-negative finite number, got ${String(fixedOverheadInstructions)}`);
  }
  if (!Number.isFinite(cpuInstructionLimit) || cpuInstructionLimit <= 0) {
    throw new Error(`cpuInstructionLimit must be a positive finite number, got ${String(cpuInstructionLimit)}`);
  }
  if (!Number.isFinite(warnThreshold) || warnThreshold <= 0 || warnThreshold > 1) {
    throw new Error(`warnThreshold must be a finite number in (0, 1], got ${String(warnThreshold)}`);
  }

  const cpuInstructions = fixedOverheadInstructions + instructionsPerItem * itemCount;
  const utilizationRatio = cpuInstructions / cpuInstructionLimit;
  const exceedsThreshold = utilizationRatio > warnThreshold;

  const usableInstructions = Math.max(0, cpuInstructionLimit * warnThreshold - fixedOverheadInstructions);
  const recommendedMaxItems = instructionsPerItem > 0
    ? Math.max(1, Math.floor(usableInstructions / instructionsPerItem))
    : itemCount;

  return {
    itemCount,
    cpuInstructions,
    cpuInstructionLimit,
    utilizationRatio,
    exceedsThreshold,
    recommendedMaxItems,
  };
}

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
}
