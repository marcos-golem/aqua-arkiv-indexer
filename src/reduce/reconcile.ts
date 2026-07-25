/**
 * On-chain reconciliation — the load-bearing correctness claim: the reducer-vs-on-chain diff is
 * what proves the off-chain state is a faithful mirror. See the README's "Testing strategy".
 *
 * Two separate operations live here:
 *
 *  - `resolveOpening` is a resync/corroboration path: given a batch of on-chain balance reads,
 *    it rebases each position's `committedDelta` onto the absolute value and flips
 *    `openingKnown`. It is NOT the primary way opening positions get established — `ship()` was
 *    verified (live contract, anvil mainnet fork) to emit `Shipped` plus one `Pushed` per token
 *    in the same tx, so `apply()` in fold.ts already knows a strategy's opening as soon as it
 *    observes that strategy's own `Shipped` (see the comment on the `shipped` case there). This
 *    function stays useful for a fold that starts indexing after a strategy's true `Shipped`
 *    block, or to correct suspected drift. See its doc comment for why rebasing (not adding a
 *    new field) is enough.
 *  - `reconcile` does the read + diff: it fetches fresh `rawBalances` at a pinned block and
 *    compares against whatever `committedDelta` currently holds. It does not call
 *    `resolveOpening` itself — composing the two is the caller's job. This is still the PRD's
 *    load-bearing test regardless of the above: it's the independent, on-chain proof that the
 *    fold hasn't silently drifted from reality.
 */

import { ABI } from '@1inch/aqua-sdk';
import {
  strategyKeyId,
  type Addr,
  type ReconciliationEntry,
  type ReconciliationReport,
  type ReducedState,
  type StrategyKey,
  type StrategyHash,
} from '../types.js';
import { live } from './fold.js';

const AQUA_ABI = ABI.AQUA_ABI;

/** One `rawBalances` call, fully specified — the only read this module ever issues. */
interface RawBalancesCall {
  readonly address: Addr;
  readonly abi: typeof AQUA_ABI;
  readonly functionName: 'rawBalances';
  readonly args: readonly [Addr, Addr, StrategyHash, Addr];
  readonly blockNumber: bigint;
}

type RawBalancesResult = readonly [balance: bigint, tokensCount: number];

/**
 * The slice of a viem `PublicClient` this module needs, narrowed to exactly the `rawBalances`
 * shape. A real `PublicClient` satisfies this structurally; a test can stub it with a plain
 * object instead of constructing viem's (enormous, generic) client type.
 */
export interface AquaRpcClient {
  readContract(call: RawBalancesCall): Promise<RawBalancesResult>;
  /** Optional — used to batch reads into one RPC round-trip when the client supports it. */
  multicall?(params: {
    contracts: readonly RawBalancesCall[];
    blockNumber: bigint;
    allowFailure: true;
  }): Promise<
    readonly (
      | { readonly status: 'success'; readonly result: RawBalancesResult }
      | { readonly status: 'failure'; readonly error: unknown }
    )[]
  >;
}

export interface ReconcileOptions {
  /** Max concurrent `readContract` calls when the client has no `multicall`. Default 8. */
  readonly concurrency?: number;
}

/** One on-chain absolute-balance observation, keyed to the position it resolves. */
export interface OnChainRead {
  readonly key: StrategyKey;
  readonly token: Addr;
  readonly balance: bigint;
}

/**
 * Rebase a position's `committedDelta` onto an on-chain absolute balance read.
 *
 * Usually unnecessary: `apply()` already knows a strategy's opening the moment it observes that
 * strategy's own `Shipped`, because `ship()` emits `Shipped` plus one `Pushed` per token in the
 * same tx (verified against the live contract on an anvil mainnet fork — see fold.ts). This
 * function exists for the cases that still leave `committedDelta` as a delta rather than an
 * absolute value: a fold that starts indexing after a strategy's true `Shipped` block (so its
 * opening `Pushed` events are outside the window), or suspected drift from a missed event.
 *
 * The trick is the same either way: an on-chain absolute balance read *is* the true opening
 * amount plus every delta folded so far, by construction (nothing else can move the ledger). So
 * the read doesn't need to be decomposed into "opening" + "delta" as two separate numbers — it
 * can simply *become* the new `committedDelta`. Same accumulator, new meaning: before resolution
 * it may be a delta, after resolution it's the absolute balance (see the doc comment on
 * `TokenPosition.committedDelta` in src/types.ts). Every subsequent Pull/Push keeps adding to it
 * exactly as before; `apply()` never needs to know whether a position has been resolved.
 *
 * Pure and synchronous on purpose — the RPC round-trip happens in `reconcile` (or wherever the
 * caller sources `reads` from); this function just applies them.
 */
export function resolveOpening(state: ReducedState, reads: readonly OnChainRead[]): ReducedState {
  const strategies = new Map(state.strategies);
  for (const read of reads) {
    const id = strategyKeyId(read.key);
    const existing = strategies.get(id);
    // A read for a strategy we don't currently track (never seen, or pruned) has nothing to
    // attach to — skip rather than fabricate an entry from a read alone.
    if (!existing) continue;
    const positions = new Map(existing.positions);
    positions.set(read.token, { token: read.token, committedDelta: read.balance, onChainBalance: read.balance });
    strategies.set(id, { ...existing, positions, openingKnown: true });
  }
  return { ...state, strategies };
}

/** Run `fn` over `items` with at most `limit` calls in flight at once. No unbounded RPC storms. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      const item = items[i];
      if (item === undefined) return; // past the end
      results[i] = await fn(item, i);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Diff reconstructed state against on-chain `rawBalances` for every live (strategy, token).
 *
 * Reads are pinned to `atBlock` — reading at chain head would race incoming blocks against the
 * state snapshot being diffed and produce phantom drift that isn't a real reconciliation failure,
 * just a timing artifact.
 *
 * `reconstructed` here is whatever `committedDelta` currently holds. For a position that hasn't
 * been through `resolveOpening` yet (`openingKnown: false`), that's a delta against an unknown
 * opening, not an absolute balance, and the resulting `drift` isn't a meaningful pass/fail signal
 * — callers building the zero-drift claim should `resolveOpening` first.
 */
export async function reconcile(
  client: AquaRpcClient,
  aquaAddress: Addr,
  state: ReducedState,
  atBlock: bigint,
  opts: ReconcileOptions = {},
): Promise<ReconciliationReport> {
  const jobs = live(state).flatMap((strategy) =>
    [...strategy.positions.values()].map((position) => ({
      key: strategy.key,
      token: position.token,
      reconstructed: position.committedDelta,
    })),
  );

  const calls: RawBalancesCall[] = jobs.map((job) => ({
    address: aquaAddress,
    abi: AQUA_ABI,
    functionName: 'rawBalances' as const,
    args: [job.key.maker, job.key.app, job.key.strategyHash, job.token] as const,
    blockNumber: atBlock,
  }));

  const balances = await readBalances(client, calls, opts.concurrency ?? 8);

  const entries: ReconciliationEntry[] = jobs.map((job, i) => {
    // mapWithConcurrency / multicall preserve input order and length, so this index is safe;
    // the `?? 0n` is only a noUncheckedIndexedAccess formality, never a real fallback path.
    const onChain = balances[i] ?? 0n;
    return {
      key: job.key,
      token: job.token,
      reconstructed: job.reconstructed,
      onChain,
      drift: job.reconstructed - onChain,
    };
  });

  const driftCount = entries.filter((e) => e.drift !== 0n).length;
  return {
    atBlock,
    entries,
    driftCount,
    // An empty entry set is not a pass — nothing was actually checked, so it can't back the
    // "reconstructed state == on-chain reads" claim.
    clean: entries.length > 0 && driftCount === 0,
  };
}

async function readBalances(
  client: AquaRpcClient,
  calls: readonly RawBalancesCall[],
  concurrency: number,
): Promise<bigint[]> {
  if (calls.length === 0) return [];

  if (client.multicall) {
    const blockNumber = calls[0]?.blockNumber;
    if (blockNumber === undefined) return [];
    const results = await client.multicall({ contracts: calls, blockNumber, allowFailure: true });
    return results.map((result, i) => {
      if (result.status === 'success') return result.result[0];
      // rawBalances (unlike safeBalances) doesn't revert for an inactive strategy — it returns
      // zero. A multicall failure here means something else went wrong (bad RPC, bad address),
      // which is worth surfacing loudly rather than silently defaulting the entry to 0 drift.
      throw new Error(`rawBalances failed for call ${i}: ${String(result.error)}`);
    });
  }

  return mapWithConcurrency(calls, concurrency, async (call) => {
    const [balance] = await client.readContract(call);
    return balance;
  });
}
