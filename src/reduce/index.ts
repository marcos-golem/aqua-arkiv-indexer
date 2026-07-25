/**
 * src/reduce — pure event fold plus on-chain reconciliation.
 *
 * `apply` + `live` implement the `Reducer` interface from src/types.ts. `resolveOpening` and
 * `reconcile` are the reconciliation half, kept as separate composable functions rather than
 * bundled into `Reducer` since one is pure state transformation and the other does RPC I/O.
 *
 * Opening positions are normally established by `apply` itself: `ship()` emits `Shipped` plus
 * one `Pushed` per token in the same tx, so folding a strategy's own `Shipped` also folds its
 * real opening amounts (see fold.ts). `resolveOpening` + `reconcile` exist for what that can't
 * cover: a fold that starts indexing after a strategy's true `Shipped` block, and the ongoing,
 * independent proof (via `rawBalances`) that the fold hasn't drifted from on-chain reality.
 */

export { apply, live } from './fold.js';
export {
  reconcile,
  resolveOpening,
  type AquaRpcClient,
  type OnChainRead,
  type ReconcileOptions,
} from './reconcile.js';
