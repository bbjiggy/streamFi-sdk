/**
 * In-memory mock transport for {@link GraphQLIndexer}.
 *
 * Lets consumers unit-test indexer-backed code without stubbing the global
 * `fetch` or running a real GraphQL server. Query results and subscription
 * events are injected up-front and returned deterministically.
 *
 * @example
 * ```ts
 * const indexer = createMockIndexer({
 *   'query GetStreams { streams { id } }': { streams: [{ id: '1' }] },
 * });
 *
 * const result = await indexer.query({ query: 'query GetStreams { streams { id } }' });
 * // result === { streams: [{ id: '1' }] }
 * ```
 */

import type {
  GraphQLQueryOptions,
  GraphQLSubscriptionOptions,
  IndexerSubscription,
} from "./indexer.js";

/** Preset response map: query string → resolved data. */
export type MockQueryMap = Record<string, unknown>;

/** Preset subscription event map: query string → array of events to emit. */
export type MockSubscriptionMap = Record<string, unknown[]>;

export interface MockIndexerOptions {
  /** Pre-baked responses for `query()` calls. */
  queries?: MockQueryMap;
  /** Pre-baked event arrays for `subscribe()` calls. */
  subscriptions?: MockSubscriptionMap;
  /** When true, unknown queries throw instead of returning undefined. Default false. */
  strict?: boolean;
  /**
   * Artificial delay (ms) applied to every `query()` resolution and every
   * `subscribe()` emission, simulating network latency (#911). Default 0.
   */
  latencyMs?: number;
  /**
   * Probability in `[0, 1)` that any given call/emission fails, simulating
   * intermittent RPC connection drops so clients can exercise their
   * error-handling UI (#911). Default 0. Failures throw from `query()` and
   * surface through `subscribe()`'s `onError`.
   */
  failureRate?: number;
  /**
   * Source of randomness, defaults to `Math.random`. Inject a deterministic
   * generator in tests to assert failure behaviour reproducibly.
   */
  random?: () => number;
}

/**
 * A drop-in replacement for {@link GraphQLIndexer} that serves injected
 * responses from memory. Useful in unit tests and offline demos.
 */
export class MockGraphQLIndexer {
  private readonly queries: MockQueryMap;
  private readonly subscriptions: MockSubscriptionMap;
  private readonly strict: boolean;
  private readonly latencyMs: number;
  private readonly failureRate: number;
  private readonly random: () => number;
  private _destroyed = false;

  constructor(options: MockIndexerOptions = {}) {
    this.queries = options.queries ?? {};
    this.subscriptions = options.subscriptions ?? {};
    this.strict = options.strict ?? false;
    this.latencyMs = options.latencyMs ?? 0;
    this.failureRate = options.failureRate ?? 0;
    this.random = options.random ?? Math.random;
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    }
  }

  /** True when the next operation should be simulated as a dropped connection. */
  private shouldFail(): boolean {
    return this.failureRate > 0 && this.random() < this.failureRate;
  }

  async query(options: GraphQLQueryOptions): Promise<unknown> {
    if (this._destroyed) {
      throw new Error("MockGraphQLIndexer has been destroyed");
    }
    await this.delay();
    if (this.shouldFail()) {
      throw new Error("MockGraphQLIndexer: simulated RPC connection drop");
    }
    const q = options.query.trim();
    if (q in this.queries) {
      return this.queries[q];
    }
    if (this.strict) {
      throw new Error(
        `MockGraphQLIndexer: no preset response for query "${q}"`,
      );
    }
    return undefined;
  }

  subscribe(options: GraphQLSubscriptionOptions): IndexerSubscription {
    if (this._destroyed) {
      throw new Error("MockGraphQLIndexer has been destroyed");
    }
    const q = options.query.trim();
    const events = this.subscriptions[q] ?? [];

    let unsubscribed = false;
    // Emit events on next tick so the caller can attach listeners first,
    // applying the configured latency and dropping some at random (#911).
    const timers = events.map((evt, i) =>
      setTimeout(() => {
        if (unsubscribed || this._destroyed) return;
        if (this.shouldFail()) {
          options.onError?.(new Error("MockGraphQLIndexer: simulated RPC connection drop"));
          return;
        }
        options.onData(evt);
      }, (i * 10) + this.latencyMs),
    );

    return {
      unsubscribe: () => {
        if (unsubscribed) return;
        unsubscribed = true;
        for (const timer of timers) {
          clearTimeout(timer);
        }
      },
    };
  }

  getSubscriptionCount(): number {
    return 0;
  }

  cleanup(): void {
    this._destroyed = true;
  }
}

/**
 * Convenience factory for {@link MockGraphQLIndexer}.
 *
 * @example
 * ```ts
 * const indexer = createMockIndexer({
 *   queries: {
 *     'query { streams }': { streams: [] },
 *   },
 * });
 * ```
 */
export function createMockIndexer(
  options?: MockIndexerOptions,
): MockGraphQLIndexer {
  return new MockGraphQLIndexer(options);
}
