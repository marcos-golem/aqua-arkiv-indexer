/**
 * Minimal ERC-20 read surface for this module: just `balanceOf`.
 *
 * Declared `as const` so viem infers `outputs[0]` as `uint256` -> `bigint`, instead of `unknown`.
 * No point pulling in a token library for one function.
 */
export const ERC20_BALANCE_OF_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const;
