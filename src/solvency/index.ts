/**
 * src/solvency — the number Aqua doesn't give you: a maker's real wallet balance vs. their
 * total virtual commitments, summed across every app and strategy they've shipped to.
 *
 * Aqua doesn't auto-pause underfunded positions, so the failure mode this
 * module detects isn't insolvency — it's silent illiquidity: trades that revert at settlement,
 * on strategies that looked live right up until they weren't funded to cover them.
 */
export { aggregateCommitments, groupCommitmentsByMaker } from './commitments.js';
export type { AggregatedCommitment } from './commitments.js';

export { readWalletBalances } from './balances.js';
export { ERC20_BALANCE_OF_ABI } from './erc20.js';

export {
  coverageRatio,
  computeTokenSolvency,
  computeMakerSolvency,
  computeSolvency,
  strategyCoverageRatio,
} from './ratio.js';
