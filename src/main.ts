/**
 * Orchestrator — wires ingest → reduce → solvency → Arkiv into one runnable indexer.
 *
 * Shape of a run:
 *   1. backfill from `startBlock` to a confirmed head, folding events into state
 *   2. reconcile against on-chain `rawBalances` (the load-bearing correctness check) and use the
 *      same reads to resolve absolute opening positions
 *   3. compute cross-app solvency per maker
 *   4. attest live strategies to Arkiv, then hold them alive with a heartbeat
 *   5. tail new blocks, re-folding and re-attesting as events land
 *
 * Runs without Arkiv credentials in `--dry` mode (or automatically when ARKIV_* is unset), which
 * prints the attestations it would write. That keeps the whole pipeline exercisable against a
 * local anvil fork — see scripts/anvil-lifecycle.ts — with no testnet key.
 */

import { createPublicClient, http, type PublicClient } from 'viem';
import { loadArkivConfig, loadChainConfig, loadHeartbeatConfig, viemChainFor } from './config.js';
import { createIngestor } from './ingest/index.js';
import { apply, live, reconcile, resolveOpening, type AquaRpcClient, type OnChainRead } from './reduce/index.js';
import { computeSolvency, strategyCoverageRatio } from './solvency/index.js';
import { createArkivWriter, createHeartbeatRunner } from './arkiv/index.js';
import {
  formatRatio,
  type AquaEventRecord,
  type MakerSolvency,
  type ReducedState,
  type StrategyAttestation,
  type StrategyState,
  type SupportedChainId,
} from './types.js';

const EMPTY_STATE: ReducedState = {
  strategies: new Map(),
  lastBlock: 0n,
  anomalies: [],
};

/**
 * Turn reconstructed state plus solvency into the records we attest.
 *
 * `committed` prefers the absolute on-chain balance when reconciliation has established one, and
 * falls back to `committedDelta`. That fallback is only correct when the strategy's `Shipped` was
 * in our stream (`openingKnown`) — a strategy we picked up mid-flight is marked so callers can
 * tell a real balance from a partial delta rather than quietly trusting it.
 */
function toAttestations(
  strategies: readonly StrategyState[],
  solvency: readonly MakerSolvency[],
  chainId: SupportedChainId,
  lastBlock: bigint,
): StrategyAttestation[] {
  const byMaker = new Map(solvency.map((s) => [s.maker, s] as const));
  const attestedAt = Math.floor(Date.now() / 1000);

  return strategies.map((strategy) => {
    const makerSolvency = byMaker.get(strategy.key.maker);
    const committed: Record<string, string> = {};
    for (const [token, position] of strategy.positions) {
      committed[token] = (position.onChainBalance ?? position.committedDelta).toString();
    }
    return {
      chainId,
      maker: strategy.key.maker,
      app: strategy.key.app,
      strategyHash: strategy.key.strategyHash,
      committed,
      // Sorted so a pair query has a canonical form on the read side.
      tokens: [...strategy.positions.keys()].sort(),
      coverageRatio:
        makerSolvency === undefined ? null : strategyCoverageRatio(strategy, makerSolvency),
      underfunded: makerSolvency?.underfunded ?? false,
      lastBlock: lastBlock.toString(),
      attestedAt,
    } satisfies StrategyAttestation;
  });
}

/** `reconcile` returns diffs; the same reads also give us absolute openings. */
function readsFromReport(
  report: Awaited<ReturnType<typeof reconcile>>,
): OnChainRead[] {
  return report.entries.map((e) => ({ key: e.key, token: e.token, balance: e.onChain }));
}

function describeSolvency(solvency: readonly MakerSolvency[]): string {
  if (solvency.length === 0) return '  (no makers with live commitments)';
  return solvency
    .map((m) => {
      const ratio = m.worstRatio === null ? 'no exposure' : `${formatRatio(m.worstRatio)}x`;
      const flag = m.underfunded ? '  ** UNDERFUNDED **' : '';
      return `  ${m.maker}  worst coverage ${ratio}${flag}`;
    })
    .join('\n');
}

async function main(): Promise<void> {
  const dryRunFlag = process.argv.includes('--dry');
  const chain = loadChainConfig();
  const heartbeatConfig = loadHeartbeatConfig();

  // The `chain` matters here even though the ingestor doesn't need one: reconcile and the solvency
  // reads batch through multicall, whose address viem resolves off the chain object.
  const publicClient = createPublicClient({
    chain: viemChainFor(chain.chainId),
    transport: http(chain.rpcUrl),
  });
  const ingestor = createIngestor(chain);

  console.log(`Aqua indexer — chain ${chain.chainId}, contract ${chain.aquaAddress}`);

  const head = await ingestor.head();
  const confirmedHead = head > chain.confirmations ? head - chain.confirmations : 0n;
  console.log(`head ${head}, confirmed ${confirmedHead}, backfilling from ${chain.startBlock}\n`);

  // --- 1. backfill -------------------------------------------------------------------------
  let state = EMPTY_STATE;
  let eventCount = 0;
  for await (const batch of ingestor.backfill(chain.startBlock, confirmedHead)) {
    state = apply(state, batch);
    eventCount += batch.length;
  }
  console.log(`folded ${eventCount} events -> ${live(state).length} live strategies`);
  if (state.anomalies.length > 0) {
    // Anomalies are diagnostics, not failures: starting a backfill mid-strategy legitimately
    // produces pull-before-ship. Surfaced rather than hidden so a real ordering bug is visible.
    const counts = new Map<string, number>();
    for (const a of state.anomalies) counts.set(a.reason, (counts.get(a.reason) ?? 0) + 1);
    console.log(`anomalies: ${[...counts].map(([r, n]) => `${r}=${n}`).join(', ')}`);
  }

  // --- 2. reconcile + resolve openings ----------------------------------------------------
  const rpc = publicClient as unknown as AquaRpcClient;
  let report = await reconcile(rpc, chain.aquaAddress, state, confirmedHead);
  console.log(
    `\nreconciliation @${report.atBlock}: ${report.entries.length} positions checked, ` +
      `${report.driftCount} drifting, clean=${report.clean}`,
  );
  if (report.entries.length > 0) {
    state = resolveOpening(state, readsFromReport(report));
    // Re-run now that positions hold absolute balances; this is the diff that actually means
    // "our reconstruction matches the chain".
    report = await reconcile(rpc, chain.aquaAddress, state, confirmedHead);
    console.log(`after resolving openings: ${report.driftCount} drifting, clean=${report.clean}`);
    for (const entry of report.entries.filter((e) => e.drift !== 0n).slice(0, 5)) {
      console.log(
        `  DRIFT ${entry.key.strategyHash.slice(0, 12)}… ${entry.token.slice(0, 10)}… ` +
          `reconstructed=${entry.reconstructed} onChain=${entry.onChain} drift=${entry.drift}`,
      );
    }
  }

  // --- 3. solvency -------------------------------------------------------------------------
  const liveStrategies = live(state);
  const solvency = await computeSolvency(
    publicClient as PublicClient,
    liveStrategies,
    chain.chainId,
    confirmedHead,
  );
  console.log(`\nsolvency (${solvency.length} makers):\n${describeSolvency(solvency)}`);

  // --- 4. attest ---------------------------------------------------------------------------
  let attestations = toAttestations(liveStrategies, solvency, chain.chainId, state.lastBlock);

  let arkiv: ReturnType<typeof createArkivWriter> | undefined;
  if (!dryRunFlag) {
    try {
      const arkivConfig = loadArkivConfig();
      arkiv = createArkivWriter(arkivConfig, heartbeatConfig);
    } catch (err) {
      console.log(
        `\nArkiv not configured (${err instanceof Error ? err.message : String(err)})` +
          `\nContinuing in dry mode — attestations will be printed, not written.`,
      );
    }
  }

  if (arkiv === undefined) {
    console.log(`\n[dry] would attest ${attestations.length} strategies:`);
    for (const a of attestations.slice(0, 10)) {
      console.log(
        `  ${a.maker.slice(0, 10)}… app ${a.app.slice(0, 10)}… ` +
          `${a.tokens.length} tokens, coverage ${a.coverageRatio ?? 'n/a'}` +
          `${a.underfunded ? ' UNDERFUNDED' : ''}`,
      );
    }
    if (attestations.length > 10) console.log(`  … and ${attestations.length - 10} more`);
    return;
  }

  console.log(`\nattesting ${attestations.length} strategies to Arkiv…`);
  for (const a of attestations) {
    const { entityKey, queryableAfterMs } = await arkiv.attest(a);
    console.log(`  ${a.strategyHash.slice(0, 12)}… -> ${entityKey} (queryable in ${queryableAfterMs}ms)`);
  }

  // --- 5. heartbeat + live tail ------------------------------------------------------------
  // The heartbeat is what bridges Aqua's event-based termination to Arkiv's clock-based
  // expiration: refreshing means "still vouching", and letting a record lapse is the close signal.
  const runner = createHeartbeatRunner(arkiv, () => attestations);
  const timer = setInterval(() => {
    void runner
      .tick()
      .then(({ refreshed }) => console.log(`heartbeat: refreshed ${refreshed}`))
      .catch((err: unknown) =>
        console.error(`heartbeat failed: ${err instanceof Error ? err.message : String(err)}`),
      );
  }, heartbeatConfig.refreshSeconds * 1_000);

  const shutdown = (): void => {
    clearInterval(timer);
    console.log('\nstopped. Live attestations will age out — that is the close signal, not an error.');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  console.log(`\ntailing from ${confirmedHead + 1n} (heartbeat every ${heartbeatConfig.refreshSeconds}s)`);
  for await (const batch of ingestor.watch(confirmedHead + 1n)) {
    state = apply(state, batch);
    const nowLive = live(state);
    const at = state.lastBlock;
    const freshSolvency = await computeSolvency(
      publicClient as PublicClient,
      nowLive,
      chain.chainId,
      at,
    );
    attestations = toAttestations(nowLive, freshSolvency, chain.chainId, at);
    console.log(
      `block ${at}: +${batch.length} events, ${nowLive.length} live, ` +
        `${freshSolvency.filter((s) => s.underfunded).length} underfunded`,
    );
    for (const a of attestations) await arkiv.attest(a);
  }
}

main().catch((err: unknown) => {
  console.error(`\nindexer failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});

function describeEventKinds(events: readonly AquaEventRecord[]): string {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return [...counts].map(([k, n]) => `${k}=${n}`).join(' ');
}
export { describeEventKinds, toAttestations };
