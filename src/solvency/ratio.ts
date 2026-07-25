/**
 * The coverage ratio itself: wallet balance vs. total virtual commitments, as a scaled bigint,
 * plus the per-maker rollup and the mapping into the Arkiv attestation layer's coverage figure.
 */
import type { PublicClient } from 'viem';
import {
  DEFAULT_UNDERFUNDED_THRESHOLD,
  RATIO_SCALE,
  formatRatio,
  type Addr,
  type MakerSolvency,
  type ScaledRatio,
  type StrategyState,
  type SupportedChainId,
  type TokenSolvency,
} from '../types.js';
import { aggregateCommitments, groupCommitmentsByMaker, type AggregatedCommitment } from './commitments.js';
import { readWalletBalances } from './balances.js';

/**
 * `walletBalance * RATIO_SCALE / totalCommitted`, as a scaled bigint. `null` when there's no
 * exposure to measure — that's "no exposure", not "infinitely solvent", so callers must not
 * treat `null` as a huge number or as automatically healthy.
 *
 * Bigint division truncates toward zero, which here always rounds the ratio DOWN (e.g. an exact
 * 1.999999999999999999x can't round up to 2x). That's the safe direction for a monitor whose
 * job is to flag underfunded makers: truncation can only ever make a maker look marginally worse
 * than it truly is, never better, so it can never mask a real shortfall.
 */
export function coverageRatio(walletBalance: bigint, totalCommitted: bigint): ScaledRatio | null {
  if (totalCommitted === 0n) return null;
  return (walletBalance * RATIO_SCALE) / totalCommitted;
}

/**
 * Builds one token's solvency record from its aggregated commitment and its wallet balance.
 *
 * When `commitment.incomplete` is set, `totalCommitted` excludes at least one live strategy
 * whose committed amount we couldn't establish (indexer started after its `Shipped` — see
 * `resolvePositionAmount` in `commitments.ts`). Any ratio computed from that undercounted total
 * necessarily looks at least as healthy as reality, possibly healthier — so `underfunded` is
 * forced `true` regardless of what the ratio says. Silently trusting an optimistic number here
 * is exactly the silent-illiquidity failure this module exists to catch; a maker we can't fully
 * account for gets flagged for follow-up, not a clean bill of health.
 */
export function computeTokenSolvency(
  commitment: AggregatedCommitment,
  walletBalance: bigint,
  threshold: ScaledRatio = DEFAULT_UNDERFUNDED_THRESHOLD,
): TokenSolvency {
  const ratio = coverageRatio(walletBalance, commitment.totalCommitted);
  return {
    token: commitment.token,
    walletBalance,
    totalCommitted: commitment.totalCommitted,
    coverageRatio: ratio,
    liveStrategyCount: commitment.liveStrategyCount,
    underfunded: commitment.incomplete || (ratio !== null && ratio < threshold),
  };
}

/**
 * Rolls a maker's per-token solvency records into the maker-level verdict.
 *
 * `worstRatio` is the minimum ratio across tokens with non-zero exposure (nulls — no exposure —
 * are ignored, not treated as zero). It's `null` only when the maker has no exposure at all,
 * i.e. every token's ratio was null.
 */
export function computeMakerSolvency(
  maker: Addr,
  chainId: SupportedChainId,
  tokens: readonly TokenSolvency[],
  atBlock: bigint,
): MakerSolvency {
  let worstRatio: ScaledRatio | null = null;
  let underfunded = false;
  for (const t of tokens) {
    if (t.underfunded) underfunded = true;
    if (t.coverageRatio === null) continue;
    if (worstRatio === null || t.coverageRatio < worstRatio) worstRatio = t.coverageRatio;
  }
  return { maker, chainId, tokens, worstRatio, underfunded, atBlock };
}

/**
 * Full pipeline: live strategy state -> commitments -> wallet reads -> per-maker solvency.
 *
 * Makers are read sequentially, one `readWalletBalances` call each (itself batched/concurrency-
 * limited per maker — see `balances.ts`), rather than fanning every maker out in parallel. With
 * a maker count large enough for that to matter, an orchestrator should chunk callers of this
 * function itself; this module doesn't guess a fan-out width that fits every deployment.
 */
export async function computeSolvency(
  client: PublicClient,
  strategies: readonly StrategyState[],
  chainId: SupportedChainId,
  atBlock: bigint,
  threshold: ScaledRatio = DEFAULT_UNDERFUNDED_THRESHOLD,
): Promise<MakerSolvency[]> {
  const byMaker = groupCommitmentsByMaker(aggregateCommitments(strategies));
  const results: MakerSolvency[] = [];

  for (const [maker, commitments] of byMaker) {
    const tokens = commitments.map((c) => c.token);
    const balances = await readWalletBalances(client, maker, tokens, atBlock);
    const tokenSolvencies = commitments.map((c) =>
      // A token missing from the balance read (shouldn't happen when the RPC call succeeds)
      // defaults to 0n rather than being dropped — silently omitting a token would understate
      // exposure just like the openingKnown-false case above; treating it as unfunded is the
      // fail-safe direction.
      computeTokenSolvency(c, balances.get(c.token) ?? 0n, threshold),
    );
    results.push(computeMakerSolvency(maker, chainId, tokenSolvencies, atBlock));
  }

  return results;
}

/**
 * The per-strategy coverage figure for `StrategyAttestation.coverageRatio`: the maker's coverage
 * for the WEAKEST token in this strategy, as a decimal string (or `null` when none of the
 * strategy's tokens have measurable exposure). A strategy is only as safe as its worst-covered
 * leg, so a solver reading the attestation should see the pessimistic number, not an average.
 */
export function strategyCoverageRatio(strategy: StrategyState, maker: MakerSolvency): string | null {
  const byToken = new Map(maker.tokens.map((t) => [t.token, t] as const));
  let worst: ScaledRatio | null = null;
  for (const token of strategy.positions.keys()) {
    const solvency = byToken.get(token);
    if (solvency === undefined || solvency.coverageRatio === null) continue;
    if (worst === null || solvency.coverageRatio < worst) worst = solvency.coverageRatio;
  }
  return worst === null ? null : formatRatio(worst);
}
