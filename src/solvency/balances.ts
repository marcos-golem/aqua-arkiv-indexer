/**
 * Wallet balance reads. The wallet side of the coverage ratio: real ERC-20 balances, pinned to
 * a single block so they describe the same instant as the committed totals they're compared
 * against (see the block-pinning note on `readWalletBalances`).
 */
import type { PublicClient } from 'viem';
import type { Addr } from '../types.js';
import { ERC20_BALANCE_OF_ABI } from './erc20.js';

/** Cap on concurrent `readContract` calls when a chain has no multicall3 deployment. */
const FALLBACK_CONCURRENCY = 5;

/** A `balanceOf` call reverted inside an otherwise-successful multicall batch. Not a missing-multicall3 problem — a real failure that must not be swallowed into a silent fallback retry. */
class BalanceOfRevertError extends Error {}

/**
 * Reads a maker's ERC-20 balance for each token, all pinned to the same block number.
 *
 * Block-pinning matters: wallet balance comes from an RPC call, committed totals come from
 * reduced event state, and the two are computed at slightly different wall-clock moments. An
 * unpinned read races the chain head — a block lands between the two reads and the ratio
 * reflects a balance and a commitment total from two different instants, producing a phantom
 * under- or over-funding signal that has nothing to do with real risk. Pinning both sides to the
 * same block number is what makes the ratio mean anything.
 *
 * Batches via multicall3 when the chain has one deployed; falls back to concurrency-limited
 * direct reads otherwise, so a chain without multicall3 (e.g. some anvil forks) doesn't fire N
 * simultaneous RPC calls.
 */
export async function readWalletBalances(
  client: PublicClient,
  wallet: Addr,
  tokens: readonly Addr[],
  blockNumber: bigint,
): Promise<Map<Addr, bigint>> {
  if (tokens.length === 0) return new Map();

  const contracts = tokens.map((token) => ({
    address: token,
    abi: ERC20_BALANCE_OF_ABI,
    functionName: 'balanceOf' as const,
    args: [wallet] as const,
  }));

  try {
    const results = await client.multicall({ contracts, blockNumber, allowFailure: true });
    return balancesFromMulticallResults(tokens, results, blockNumber);
  } catch (err) {
    if (err instanceof BalanceOfRevertError) throw err;
    // Most likely cause: no multicall3 contract at this address on this chain/fork. Fall back
    // rather than fail the whole read.
    return readWalletBalancesConcurrencyLimited(client, wallet, tokens, blockNumber);
  }
}

function balancesFromMulticallResults(
  tokens: readonly Addr[],
  results: readonly ({ status: 'success'; result: bigint } | { status: 'failure'; error: Error })[],
  blockNumber: bigint,
): Map<Addr, bigint> {
  const balances = new Map<Addr, bigint>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const entry = results[i];
    if (token === undefined || entry === undefined) continue;
    if (entry.status === 'failure') {
      throw new BalanceOfRevertError(
        `balanceOf reverted for token ${token} at block ${blockNumber}: ${String(entry.error)}`,
      );
    }
    balances.set(token, entry.result);
  }
  return balances;
}

async function readWalletBalancesConcurrencyLimited(
  client: PublicClient,
  wallet: Addr,
  tokens: readonly Addr[],
  blockNumber: bigint,
): Promise<Map<Addr, bigint>> {
  const balances = new Map<Addr, bigint>();
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = cursor++;
      const token = tokens[i];
      if (token === undefined) return;
      const balance = await client.readContract({
        address: token,
        abi: ERC20_BALANCE_OF_ABI,
        functionName: 'balanceOf',
        args: [wallet],
        blockNumber,
      });
      balances.set(token, balance);
    }
  }

  const workerCount = Math.min(FALLBACK_CONCURRENCY, tokens.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return balances;
}
