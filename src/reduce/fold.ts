/**
 * The pure fold: `AquaEventRecord[]` -> `ReducedState`.
 *
 * No I/O, no clock, no randomness, no mutation of `prior`. Every update produces new Map/array
 * instances instead of touching what was passed in, so `prior` is safe to reuse across calls
 * (e.g. re-running a batch during a test, or a caller that keeps a reference to the old state).
 */

import {
  compareProvenance,
  strategyKeyId,
  type Addr,
  type Anomaly,
  type AquaEventRecord,
  type Provenance,
  type ReducedState,
  type StrategyState,
  type TokenPosition,
} from '../types.js';

/**
 * An event is a replay of one already folded into `state` when its provenance does not come
 * strictly after the last event we folded for that strategy. Because `apply` always sorts its
 * input and always advances `lastSeenAt` when it actually applies an event, "not after" can only
 * mean "we've already seen this exact slot" for a well-behaved caller (ingestor emits events in
 * chronological order; the one expected exception — a backfill window overlapping a live tail —
 * reproduces exact duplicates, not reorderings). That's the precondition this module leans on
 * instead of re-deriving a total order across calls.
 */
function alreadyFolded(state: StrategyState | undefined, provenance: Provenance): boolean {
  if (!state) return false;
  return compareProvenance(provenance, state.lastSeenAt) <= 0;
}

/** Apply a signed amount to one token's committedDelta, returning a new position. */
function adjustPosition(existing: TokenPosition | undefined, token: Addr, delta: bigint): TokenPosition {
  const committedDelta = (existing?.committedDelta ?? 0n) + delta;
  // Preserve onChainBalance only if it was already set — never fabricate the key, since
  // exactOptionalPropertyTypes treats `{ onChainBalance: undefined }` as a different (invalid)
  // shape from simply omitting it.
  if (existing?.onChainBalance !== undefined) {
    return { token, committedDelta, onChainBalance: existing.onChainBalance };
  }
  return { token, committedDelta };
}

/** Fold one signed delta into a strategy's positions, immutably, and bump lastSeenAt. */
function withDelta(state: StrategyState, provenance: Provenance, token: Addr, delta: bigint): StrategyState {
  const positions = new Map(state.positions);
  positions.set(token, adjustPosition(positions.get(token), token, delta));
  return { ...state, positions, lastSeenAt: provenance };
}

export function apply(prior: ReducedState, events: readonly AquaEventRecord[]): ReducedState {
  const strategies = new Map(prior.strategies);
  const anomalies: Anomaly[] = [...prior.anomalies];
  let lastBlock = prior.lastBlock;

  // Ordering is load-bearing: folding pull/push out of order silently corrupts committedDelta.
  // Sort a copy rather than requiring the caller to pre-sort, so the precondition can't be
  // violated by accident. `events` itself is never touched.
  const sorted = [...events].sort((a, b) => compareProvenance(a.provenance, b.provenance));

  for (const event of sorted) {
    if (event.provenance.blockNumber > lastBlock) lastBlock = event.provenance.blockNumber;

    const id = strategyKeyId(event);
    const existing = strategies.get(id);

    switch (event.kind) {
      case 'shipped': {
        // Any repeat Shipped for a triple that's already tracked — whether a true replay of the
        // same log or (impossible on a correct chain, but not this module's job to assume) a
        // second ship — is the same observable anomaly: we already have an entry, don't overwrite
        // it. This doubles as the dedup path for Shipped, since there is no prior committedDelta
        // history to compare provenance against yet.
        if (existing) {
          anomalies.push({ reason: 'duplicate-ship', event });
          break;
        }
        strategies.set(id, {
          key: { maker: event.maker, app: event.app, strategyHash: event.strategyHash },
          status: 'live',
          strategy: event.strategy,
          positions: new Map(),
          // ship() emits Shipped, then one Pushed per token in the SAME tx (verified against
          // the live contract on an anvil mainnet fork — corrects the original assumption that
          // Shipped carries no recoverable amounts). Those Pushed events sort right after this
          // one (same block, higher logIndex) and fold normally via the 'pushed' case below, so
          // committedDelta builds up from a known zero baseline instead of an unknown one.
          // Opening is therefore known as of the moment we observe a strategy's own Shipped —
          // reconcile.resolveOpening is now a resync/corroboration path (e.g. a fold that
          // started after this strategy's true Shipped block), not the only way to learn it.
          openingKnown: true,
          shippedAt: event.provenance,
          lastSeenAt: event.provenance,
        });
        break;
      }

      case 'pulled': {
        if (!existing) {
          // Normal when a backfill starts after the strategy's real Shipped block — the ship is
          // outside the indexed window and will never arrive. Diagnostic, not a bug.
          anomalies.push({ reason: 'pull-before-ship', event });
          break;
        }
        if (alreadyFolded(existing, event.provenance)) break;
        // An app can pull straight out of the opening deposit before any Push is ever observed,
        // so the first pull on a fresh position legitimately drives committedDelta negative.
        strategies.set(id, withDelta(existing, event.provenance, event.token, -event.amount));
        break;
      }

      case 'pushed': {
        if (!existing) {
          anomalies.push({ reason: 'push-before-ship', event });
          break;
        }
        if (alreadyFolded(existing, event.provenance)) break;
        if (existing.status === 'docked') {
          // On-chain this reverts (`PushToNonActiveStrategyPrevented`), so a genuinely new
          // (non-duplicate) Pushed after Docked means the indexer's view is corrupted somehow —
          // record it, don't apply it on top of a closed strategy.
          anomalies.push({ reason: 'push-after-dock', event });
          break;
        }
        strategies.set(id, withDelta(existing, event.provenance, event.token, event.amount));
        break;
      }

      case 'docked': {
        if (!existing) {
          anomalies.push({ reason: 'dock-before-ship', event });
          break;
        }
        if (alreadyFolded(existing, event.provenance)) break;
        if (existing.status === 'docked') {
          // Reached only for a second, later-provenance Docked on an already-docked strategy —
          // an exact replay of the first dock was already caught by alreadyFolded above. Aqua's
          // `DockingShouldCloseAllTokens` guard means this shouldn't happen on a correct chain.
          anomalies.push({ reason: 'dock-when-already-docked', event });
          break;
        }
        // Docked closes ALL tokens at once (Aqua reverts a partial dock) — that's why this is a
        // single status flip and not a per-token update like pull/push.
        strategies.set(id, {
          ...existing,
          status: 'docked',
          dockedAt: event.provenance,
          lastSeenAt: event.provenance,
        });
        break;
      }
    }
  }

  return { strategies, lastBlock, anomalies };
}

/** Only the live strategies — this is what gets attested. */
export function live(state: ReducedState): readonly StrategyState[] {
  return [...state.strategies.values()].filter((s) => s.status === 'live');
}
