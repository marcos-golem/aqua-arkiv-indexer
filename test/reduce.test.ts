import { describe, expect, it } from 'vitest';
import { apply, live, reconcile, resolveOpening, type AquaRpcClient } from '../src/reduce/index.js';
import {
  strategyKeyId,
  type Addr,
  type DockedEventRecord,
  type Hex,
  type Provenance,
  type PulledEventRecord,
  type PushedEventRecord,
  type ReducedState,
  type ShippedEventRecord,
  type StrategyHash,
} from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures — deterministic addresses/hashes and event factories. All offline,
// no network, per the module's constraints.
// ---------------------------------------------------------------------------

function addr(n: number): Addr {
  return (`0x` + n.toString(16).padStart(40, '0')) as Addr;
}

function hash(n: number): StrategyHash {
  return (`0x` + n.toString(16).padStart(64, '0')) as StrategyHash;
}

const MAKER1 = addr(1);
const MAKER2 = addr(2);
const APP1 = addr(10);
const APP2 = addr(11);
const TOKEN = addr(20);
const TOKEN2 = addr(21);
const HASH1 = hash(1);
const HASH2 = hash(2);
const AQUA_ADDR = addr(99);
const STRATEGY_BLOB = hash(9999) as Hex;

function prov(block: number, logIndex: number): Provenance {
  return {
    chainId: 1,
    blockNumber: BigInt(block),
    blockHash: hash(block),
    txHash: hash(block * 1000 + logIndex),
    logIndex,
  };
}

function shipped(maker: Addr, app: Addr, strategyHash: StrategyHash, block: number, logIndex: number): ShippedEventRecord {
  return { kind: 'shipped', provenance: prov(block, logIndex), maker, app, strategyHash, strategy: STRATEGY_BLOB };
}

function pulled(
  maker: Addr,
  app: Addr,
  strategyHash: StrategyHash,
  token: Addr,
  amount: bigint,
  block: number,
  logIndex: number,
): PulledEventRecord {
  return { kind: 'pulled', provenance: prov(block, logIndex), maker, app, strategyHash, token, amount };
}

function pushed(
  maker: Addr,
  app: Addr,
  strategyHash: StrategyHash,
  token: Addr,
  amount: bigint,
  block: number,
  logIndex: number,
): PushedEventRecord {
  return { kind: 'pushed', provenance: prov(block, logIndex), maker, app, strategyHash, token, amount };
}

function docked(maker: Addr, app: Addr, strategyHash: StrategyHash, block: number, logIndex: number): DockedEventRecord {
  return { kind: 'docked', provenance: prov(block, logIndex), maker, app, strategyHash };
}

function emptyState(): ReducedState {
  return { strategies: new Map(), lastBlock: 0n, anomalies: [] };
}

function key(maker: Addr, app: Addr, strategyHash: StrategyHash): string {
  return strategyKeyId({ maker, app, strategyHash });
}

/** Fake viem client — no network. Balances keyed by `maker:app:strategyHash:token`. */
function fakeClient(balances: ReadonlyMap<string, bigint>): AquaRpcClient {
  return {
    async readContract(call) {
      const k = call.args.join(':');
      const balance = balances.get(k);
      if (balance === undefined) throw new Error(`fakeClient: no stub balance for ${k}`);
      return [balance, 1];
    },
  };
}

// ---------------------------------------------------------------------------
// apply()
// ---------------------------------------------------------------------------

describe('apply', () => {
  it('full lifecycle ship -> pull -> push -> dock gives right status and deltas', () => {
    const events = [
      shipped(MAKER1, APP1, HASH1, 1, 0),
      pulled(MAKER1, APP1, HASH1, TOKEN, 10n, 2, 0),
      pushed(MAKER1, APP1, HASH1, TOKEN, 4n, 3, 0),
      docked(MAKER1, APP1, HASH1, 4, 0),
    ];
    const state = apply(emptyState(), events);
    const k = key(MAKER1, APP1, HASH1);
    const strat = state.strategies.get(k);

    expect(strat?.status).toBe('docked');
    // openingKnown flips true as soon as the strategy's own Shipped is folded — see the
    // dedicated ship-with-two-tokens test below for why.
    expect(strat?.openingKnown).toBe(true);
    expect(strat?.positions.get(TOKEN)?.committedDelta).toBe(-6n);
    expect(state.anomalies).toHaveLength(0);
    expect(state.lastBlock).toBe(4n);
    expect(live(state)).toHaveLength(0); // docked, so not in the live set
  });

  it('ship-with-two-tokens (Shipped + 2 Pushed in one tx) yields absolute committed balances and openingKnown: true', () => {
    // ship() emits Shipped, then one Pushed per token, all in the same tx — verified against the
    // live contract on an anvil mainnet fork. Same block, Shipped at the lower logIndex.
    const events = [
      shipped(MAKER1, APP1, HASH1, 1, 0),
      pushed(MAKER1, APP1, HASH1, TOKEN, 100n, 1, 1),
      pushed(MAKER1, APP1, HASH1, TOKEN2, 200n, 1, 2),
    ];
    const state = apply(emptyState(), events);
    const strat = state.strategies.get(key(MAKER1, APP1, HASH1));

    expect(strat?.openingKnown).toBe(true);
    // No prior Pull/Push to net against, so committedDelta *is* the absolute opening balance.
    expect(strat?.positions.get(TOKEN)?.committedDelta).toBe(100n);
    expect(strat?.positions.get(TOKEN2)?.committedDelta).toBe(200n);
    expect(state.anomalies).toHaveLength(0);
  });

  it('shuffled input yields the same state as sorted input', () => {
    const e1 = shipped(MAKER1, APP1, HASH1, 1, 0);
    const e2 = pulled(MAKER1, APP1, HASH1, TOKEN, 10n, 2, 0);
    const e3 = shipped(MAKER2, APP1, HASH1, 1, 1);
    const e4 = pushed(MAKER1, APP1, HASH1, TOKEN, 4n, 3, 0);
    const e5 = pushed(MAKER2, APP1, HASH1, TOKEN, 7n, 3, 1);
    const e6 = docked(MAKER1, APP1, HASH1, 4, 0);

    const sorted = apply(emptyState(), [e1, e2, e3, e4, e5, e6]);
    const shuffled = apply(emptyState(), [e6, e2, e4, e1, e5, e3]);

    expect(shuffled).toEqual(sorted);
  });

  it('replaying an overlapping batch does not double-count', () => {
    const e1 = shipped(MAKER1, APP1, HASH1, 1, 0);
    const e2 = pulled(MAKER1, APP1, HASH1, TOKEN, 10n, 2, 0);
    const e3 = pushed(MAKER1, APP1, HASH1, TOKEN, 4n, 3, 0);
    const e4 = docked(MAKER1, APP1, HASH1, 4, 0);
    const k = key(MAKER1, APP1, HASH1);

    const afterFirstBatch = apply(emptyState(), [e1, e2, e3]);
    expect(afterFirstBatch.strategies.get(k)?.positions.get(TOKEN)?.committedDelta).toBe(-6n);

    // A backfill window overlapping the live tail re-delivers e3 alongside the genuinely new e4.
    const afterOverlap = apply(afterFirstBatch, [e3, e4]);
    const strat = afterOverlap.strategies.get(k);
    expect(strat?.status).toBe('docked');
    expect(strat?.positions.get(TOKEN)?.committedDelta).toBe(-6n); // unchanged by the replay
  });

  it('does not mutate prior', () => {
    const e1 = shipped(MAKER1, APP1, HASH1, 1, 0);
    const e2 = pulled(MAKER1, APP1, HASH1, TOKEN, 10n, 2, 0);
    const k = key(MAKER1, APP1, HASH1);

    const prior = apply(emptyState(), [e1, e2]);
    const priorDelta = prior.strategies.get(k)?.positions.get(TOKEN)?.committedDelta;
    const priorAnomalyCount = prior.anomalies.length;
    const priorLastBlock = prior.lastBlock;

    const e3 = pushed(MAKER1, APP1, HASH1, TOKEN, 4n, 3, 0);
    apply(prior, [e3]); // result intentionally discarded — only checking `prior` afterward

    expect(prior.strategies.get(k)?.positions.get(TOKEN)?.committedDelta).toBe(priorDelta);
    expect(prior.anomalies).toHaveLength(priorAnomalyCount);
    expect(prior.lastBlock).toBe(priorLastBlock);
  });

  it('detects each of the six anomaly kinds', () => {
    const pullBeforeShip = pulled(MAKER1, APP1, HASH1, TOKEN, 1n, 1, 0);
    const pushBeforeShip = pushed(MAKER1, APP1, HASH2, TOKEN, 1n, 1, 0);
    const dockBeforeShip = docked(MAKER2, APP1, HASH1, 1, 0);

    const pushAfterDockBatch = [
      shipped(MAKER1, APP2, HASH1, 1, 0),
      docked(MAKER1, APP2, HASH1, 2, 0),
      pushed(MAKER1, APP2, HASH1, TOKEN, 1n, 3, 0),
    ];

    const duplicateShipBatch = [shipped(MAKER2, APP2, HASH1, 1, 0), shipped(MAKER2, APP2, HASH1, 2, 0)];

    const doubleDockBatch = [
      shipped(MAKER2, APP2, HASH2, 1, 0),
      docked(MAKER2, APP2, HASH2, 2, 0),
      docked(MAKER2, APP2, HASH2, 3, 0),
    ];

    const state = apply(emptyState(), [
      pullBeforeShip,
      pushBeforeShip,
      dockBeforeShip,
      ...pushAfterDockBatch,
      ...duplicateShipBatch,
      ...doubleDockBatch,
    ]);

    const reasons = state.anomalies.map((a) => a.reason).sort();
    expect(reasons).toEqual(
      [
        'pull-before-ship',
        'push-before-ship',
        'dock-before-ship',
        'push-after-dock',
        'duplicate-ship',
        'dock-when-already-docked',
      ].sort(),
    );
  });

  it('keeps strategies separate by the full (maker, app, strategyHash) triple', () => {
    const events = [
      shipped(MAKER1, APP1, HASH1, 1, 0),
      shipped(MAKER1, APP1, HASH2, 1, 1), // same maker+app, different hash
      shipped(MAKER2, APP1, HASH1, 1, 2), // same app+hash, different maker
      pulled(MAKER1, APP1, HASH1, TOKEN, 5n, 2, 0),
      pulled(MAKER1, APP1, HASH2, TOKEN, 3n, 2, 1),
      pulled(MAKER2, APP1, HASH1, TOKEN, 9n, 2, 2),
    ];
    const state = apply(emptyState(), events);

    expect(state.strategies.size).toBe(3);
    expect(state.anomalies).toHaveLength(0);
    expect(live(state)).toHaveLength(3);
    expect(state.strategies.get(key(MAKER1, APP1, HASH1))?.positions.get(TOKEN)?.committedDelta).toBe(-5n);
    expect(state.strategies.get(key(MAKER1, APP1, HASH2))?.positions.get(TOKEN)?.committedDelta).toBe(-3n);
    expect(state.strategies.get(key(MAKER2, APP1, HASH1))?.positions.get(TOKEN)?.committedDelta).toBe(-9n);
  });

  it('committedDelta may go negative even when openingKnown is true — reconstruction can lag reality', () => {
    // Simulates only partially observing a strategy's opening Pushed events (e.g. a missed log),
    // then a later Pull that draws down more than we saw arrive. The reducer must not clamp this
    // to zero — a negative value here is a faithful (if incomplete) mirror, not corruption.
    const events = [
      shipped(MAKER1, APP1, HASH1, 1, 0),
      pushed(MAKER1, APP1, HASH1, TOKEN, 5n, 1, 1),
      pulled(MAKER1, APP1, HASH1, TOKEN, 20n, 2, 0),
    ];
    const state = apply(emptyState(), events);
    const k = key(MAKER1, APP1, HASH1);

    const strat = state.strategies.get(k);
    expect(strat?.openingKnown).toBe(true);
    expect(strat?.positions.get(TOKEN)?.committedDelta).toBe(-15n);
  });

  it('resolveOpening rebases committedDelta onto an on-chain read (resync path)', () => {
    // Same drifted state as above — reconstructed -15n, real on-chain balance 120n because a
    // Pushed event was missed. resolveOpening corrects it using an independent on-chain read.
    const events = [
      shipped(MAKER1, APP1, HASH1, 1, 0),
      pushed(MAKER1, APP1, HASH1, TOKEN, 5n, 1, 1),
      pulled(MAKER1, APP1, HASH1, TOKEN, 20n, 2, 0),
    ];
    const state = apply(emptyState(), events);
    const k = key(MAKER1, APP1, HASH1);

    const resolved = resolveOpening(state, [
      { key: { maker: MAKER1, app: APP1, strategyHash: HASH1 }, token: TOKEN, balance: 120n },
    ]);
    const resolvedStrat = resolved.strategies.get(k);
    expect(resolvedStrat?.openingKnown).toBe(true);
    expect(resolvedStrat?.positions.get(TOKEN)?.committedDelta).toBe(120n);
    expect(resolvedStrat?.positions.get(TOKEN)?.onChainBalance).toBe(120n);
  });
});

// ---------------------------------------------------------------------------
// reconcile()
// ---------------------------------------------------------------------------

describe('reconcile', () => {
  it('reports zero drift and clean:true when on-chain matches reconstructed', async () => {
    const events = [shipped(MAKER1, APP1, HASH1, 1, 0), pushed(MAKER1, APP1, HASH1, TOKEN, 100n, 2, 0)];
    const state = apply(emptyState(), events);
    const client = fakeClient(new Map([[[MAKER1, APP1, HASH1, TOKEN].join(':'), 100n]]));

    const report = await reconcile(client, AQUA_ADDR, state, 999n);

    expect(report.atBlock).toBe(999n);
    expect(report.entries).toHaveLength(1);
    expect(report.driftCount).toBe(0);
    expect(report.clean).toBe(true);
    expect(report.entries[0]?.onChain).toBe(100n);
    expect(report.entries[0]?.drift).toBe(0n);
  });

  it('reports non-zero drift and clean:false when on-chain mismatches reconstructed', async () => {
    const events = [shipped(MAKER1, APP1, HASH1, 1, 0), pushed(MAKER1, APP1, HASH1, TOKEN, 100n, 2, 0)];
    const state = apply(emptyState(), events);
    const client = fakeClient(new Map([[[MAKER1, APP1, HASH1, TOKEN].join(':'), 90n]]));

    const report = await reconcile(client, AQUA_ADDR, state, 999n);

    expect(report.driftCount).toBe(1);
    expect(report.clean).toBe(false);
    expect(report.entries[0]?.drift).toBe(10n);
  });

  it('is not clean on an empty entry set', async () => {
    const client = fakeClient(new Map());

    const report = await reconcile(client, AQUA_ADDR, emptyState(), 999n);

    expect(report.entries).toHaveLength(0);
    expect(report.driftCount).toBe(0);
    expect(report.clean).toBe(false); // an empty report is not a pass — nothing was checked
  });

  it('uses multicall when available and pins reads to atBlock', async () => {
    const events = [shipped(MAKER1, APP1, HASH1, 1, 0), pushed(MAKER1, APP1, HASH1, TOKEN, 50n, 2, 0)];
    const state = apply(emptyState(), events);
    let seenBlock: bigint | undefined;
    const client: AquaRpcClient = {
      readContract() {
        throw new Error('should not be called when multicall is present');
      },
      async multicall(params) {
        seenBlock = params.blockNumber;
        return params.contracts.map(() => ({ status: 'success' as const, result: [50n, 1] as const }));
      },
    };

    const report = await reconcile(client, AQUA_ADDR, state, 12_345n);

    expect(seenBlock).toBe(12_345n);
    expect(report.clean).toBe(true);
  });
});
