/**
 * Commitment aggregation: sums committed amounts per (maker, token) across every app and every
 * live strategy the maker has shipped to. This is the number nothing on-chain can produce
 * cheaply — an app contract only ever sees its own slice of `balances[maker][app][...]`; the
 * cross-app, cross-strategy sum only exists once someone folds the full event stream, which is
 * exactly what this function does.
 */
import type { Addr, StrategyState, TokenPosition } from '../types.js';

/**
 * A maker's total committed exposure in one token, summed across every live strategy and app.
 */
export interface AggregatedCommitment {
  readonly maker: Addr;
  readonly token: Addr;
  readonly totalCommitted: bigint;
  /** How many live strategies contribute to this total (known or not — see `incomplete`). */
  readonly liveStrategyCount: number;
  /**
   * True when at least one contributing live strategy's committed amount could not be
   * established (see `resolvePositionAmount` below) and was therefore EXCLUDED from
   * `totalCommitted` rather than estimated. When this is true, `totalCommitted` undercounts real
   * exposure — treat it as a floor on what we can currently prove, never as the whole picture.
   * `computeTokenSolvency` forces `underfunded: true` whenever this is set, precisely so this
   * doesn't get read as a clean bill of health further downstream.
   */
  readonly incomplete: boolean;
}

/**
 * Resolves one strategy's position in a token to an absolute committed amount.
 *
 * Originally this module assumed opening amounts were unrecoverable from events at all (see the
 * old `TokenPosition.committedDelta` doc). That premise turned out to be wrong: `ship()` emits
 * `Shipped` plus one `Pushed` per token in the same transaction, at a higher logIndex — see
 * docs/SDK-SURFACE.md §4 (verified against a real Aqua contract on an anvil fork). The reducer
 * sets `openingKnown: true` the moment it folds a `Shipped`, so `committedDelta` is an ABSOLUTE
 * balance whenever the indexer's stream covers the strategy's opening — which is the normal
 * case. `openingKnown === false` now means something narrower and rarer: the indexer started
 * mid-strategy and never saw the `Shipped` (and its opening `Pushed`s), so `committedDelta` here
 * really is just the net of whatever pushes/pulls happened *after* the stream picked it up —
 * against a genuinely unknown opening.
 *
 * Policy, in priority order:
 *
 * 1. `onChainBalance` present -> use it. It came from a `rawBalances` read, so it's ground
 *    truth regardless of whether events established the opening position.
 * 2. No on-chain read, but `openingKnown` -> `committedDelta` IS the absolute balance (the
 *    normal case, per the correction above).
 * 3. Neither -> opening is genuinely unknown. `committedDelta` is still a mathematically valid
 *    LOWER BOUND (opening >= 0, so true = opening + delta >= delta), but we deliberately do NOT
 *    fold even that lower bound into `totalCommitted`. A partially-counted total still *looks*
 *    like a complete, trustworthy number to any caller that doesn't know to distrust it — and
 *    for a tool whose whole job is catching silent illiquidity, a confident-looking understated
 *    total is worse than one that visibly admits it doesn't know. So this position contributes
 *    0 to the sum and the aggregate is marked `incomplete: true` instead; `computeTokenSolvency`
 *    turns that into a forced `underfunded: true` rather than a quietly optimistic ratio.
 */
function resolvePositionAmount(
  position: TokenPosition,
  openingKnown: boolean,
): { amount: bigint; incomplete: boolean } {
  if (position.onChainBalance !== undefined) {
    return { amount: position.onChainBalance, incomplete: false };
  }
  if (openingKnown) {
    return { amount: position.committedDelta, incomplete: false };
  }
  return { amount: 0n, incomplete: true };
}

interface MutableAggregate {
  maker: Addr;
  token: Addr;
  total: bigint;
  count: number;
  incomplete: boolean;
}

/**
 * Sums committed amounts per (maker, token) across every live strategy and every app.
 *
 * Only `status === 'live'` strategies count. Aqua's `Docked` event closes ALL of a strategy's
 * tokens at once (a partial dock reverts on-chain), so a docked strategy commits nothing — its
 * positions are stale history, not a partial exposure.
 */
export function aggregateCommitments(
  strategies: readonly StrategyState[],
): AggregatedCommitment[] {
  const byMakerToken = new Map<string, MutableAggregate>();

  for (const strategy of strategies) {
    if (strategy.status !== 'live') continue;
    const { maker } = strategy.key;
    for (const position of strategy.positions.values()) {
      const { amount, incomplete } = resolvePositionAmount(position, strategy.openingKnown);
      const mapKey = `${maker}:${position.token}`;
      const existing = byMakerToken.get(mapKey);
      if (existing === undefined) {
        byMakerToken.set(mapKey, { maker, token: position.token, total: amount, count: 1, incomplete });
      } else {
        existing.total += amount;
        existing.count += 1;
        existing.incomplete = existing.incomplete || incomplete;
      }
    }
  }

  return Array.from(byMakerToken.values(), (v) => ({
    maker: v.maker,
    token: v.token,
    totalCommitted: v.total,
    liveStrategyCount: v.count,
    incomplete: v.incomplete,
  }));
}

/** Groups aggregated commitments by maker, for per-maker balance reads and solvency rollups. */
export function groupCommitmentsByMaker(
  commitments: readonly AggregatedCommitment[],
): Map<Addr, AggregatedCommitment[]> {
  const byMaker = new Map<Addr, AggregatedCommitment[]>();
  for (const c of commitments) {
    const list = byMaker.get(c.maker);
    if (list === undefined) byMaker.set(c.maker, [c]);
    else list.push(c);
  }
  return byMaker;
}
