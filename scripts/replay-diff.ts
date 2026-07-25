/**
 * Replay-and-diff — PRD §6's "Reducer (ground truth)" row, as a standalone gate.
 *
 * Replays historical Aqua events over a block range, folds them into state, then diffs the
 * reconstructed committed balances against on-chain `rawBalances` at a pinned block. **Exits
 * non-zero on any drift**, so it works as a CI check rather than something a human has to read.
 *
 * This is the load-bearing test: it is the only thing that substantiates the product claim that
 * this off-chain state faithfully mirrors the chain. Everything else tests mechanics.
 *
 * Usage:
 *   pnpm replay                       # START_BLOCK .. confirmed head, from .env
 *   FROM=23800000 TO=23900000 pnpm replay
 *
 * Note the `--dry`-free design: this script never writes anything, to Arkiv or elsewhere.
 */

import { createPublicClient, http } from 'viem';
import { loadChainConfig, viemChainFor } from '../src/config.js';
import { createIngestor } from '../src/ingest/index.js';
import {
  apply,
  live,
  reconcile,
  resolveOpening,
  type AquaRpcClient,
} from '../src/reduce/index.js';
import { formatRatio, RATIO_SCALE, type ReducedState } from '../src/types.js';

const EMPTY: ReducedState = { strategies: new Map(), lastBlock: 0n, anomalies: [] };

function envBigInt(name: string): bigint | undefined {
  const v = process.env[name];
  return v === undefined || v === '' ? undefined : BigInt(v);
}

async function main(): Promise<void> {
  const chain = loadChainConfig();
  const ingestor = createIngestor(chain);
  const client = createPublicClient({
    chain: viemChainFor(chain.chainId),
    transport: http(chain.rpcUrl),
  });

  const head = await ingestor.head();
  const from = envBigInt('FROM') ?? chain.startBlock;
  const to = envBigInt('TO') ?? (head > chain.confirmations ? head - chain.confirmations : 0n);

  if (to < from) {
    throw new Error(`Empty range: FROM=${from} is above TO=${to}.`);
  }
  // Catch a TO above the chain head here, with a clear message. Otherwise the range survives
  // until reconcile pins its reads to that block and the failure surfaces as a
  // `BlockOutOfRangeError` from inside a multicall, which reads like a bug in the reducer.
  if (to > head) {
    throw new Error(
      `TO=${to} is above the chain head (${head}). Pick a TO at or below the head — ` +
        `on an anvil fork the head is the fork block plus whatever you have mined since.`,
    );
  }

  console.log(`Replaying Aqua events on chain ${chain.chainId}`);
  console.log(`  contract ${chain.aquaAddress}`);
  console.log(`  range    ${from} .. ${to}  (${to - from + 1n} blocks)\n`);

  let state = EMPTY;
  let events = 0;
  let chunks = 0;
  const started = Date.now();
  for await (const batch of ingestor.backfill(from, to)) {
    state = apply(state, batch);
    events += batch.length;
    chunks += 1;
    if (chunks % 25 === 0) {
      process.stdout.write(`\r  …${events} events, through block ${state.lastBlock}   `);
    }
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write('\r');
  console.log(`folded ${events} events in ${elapsed}s`);

  const liveSet = live(state);
  const positions = liveSet.reduce((n, s) => n + s.positions.size, 0);
  console.log(`  ${liveSet.length} live strategies, ${positions} token positions`);

  if (state.anomalies.length > 0) {
    // Expected when `from` lands mid-strategy: we see a Pull/Dock whose Ship predates the range.
    // Diagnostics, not failures — but a large count on a launch-block replay means a real bug.
    const counts = new Map<string, number>();
    for (const a of state.anomalies) counts.set(a.reason, (counts.get(a.reason) ?? 0) + 1);
    console.log(`  anomalies: ${[...counts].map(([r, n]) => `${r}=${n}`).join(', ')}`);
  }

  if (liveSet.length === 0) {
    // An empty report is NOT a pass — `clean` requires at least one checked entry, and so do we.
    console.log(
      `\nNo live strategies in this range, so there is nothing to diff. This is not a pass.\n` +
        `Widen the range (FROM/TO) or confirm the contract address carries activity.`,
    );
    process.exitCode = 1;
    return;
  }

  const rpc = client as unknown as AquaRpcClient;

  // First pass establishes absolute positions for any strategy whose Shipped predates `from`;
  // the second pass is the diff that actually means "reconstruction matches the chain".
  const first = await reconcile(rpc, chain.aquaAddress, state, to);
  state = resolveOpening(state, first.entries.map((e) => ({ key: e.key, token: e.token, balance: e.onChain })));
  const report = await reconcile(rpc, chain.aquaAddress, state, to);

  console.log(`\nreconciliation @ block ${report.atBlock}`);
  console.log(`  checked  ${report.entries.length} positions`);
  console.log(`  drifting ${report.driftCount}`);

  if (report.driftCount > 0) {
    console.log('\nDRIFT DETAIL (first 20):');
    for (const e of report.entries.filter((x) => x.drift !== 0n).slice(0, 20)) {
      const rel =
        e.onChain === 0n
          ? 'n/a'
          : `${formatRatio((e.drift * RATIO_SCALE) / e.onChain, 6)}x of on-chain`;
      console.log(
        `  ${e.key.maker.slice(0, 10)}… app ${e.key.app.slice(0, 10)}… ` +
          `strat ${e.key.strategyHash.slice(0, 10)}… token ${e.token.slice(0, 10)}…`,
      );
      console.log(
        `      reconstructed ${e.reconstructed}  onChain ${e.onChain}  drift ${e.drift}  (${rel})`,
      );
    }
  }

  if (report.clean) {
    console.log('\nPASS — reconstructed state matches on-chain reads with zero drift.');
  } else {
    console.log('\nFAIL — reconstructed state does not match the chain.');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(`\nreplay failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
