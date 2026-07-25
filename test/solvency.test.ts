import { describe, expect, it } from 'vitest';
import type { PublicClient } from 'viem';
import {
  RATIO_SCALE,
  formatRatio,
  type Addr,
  type MakerSolvency,
  type Provenance,
  type StrategyKey,
  type StrategyState,
  type TokenPosition,
} from '../src/types.js';
import {
  aggregateCommitments,
  computeMakerSolvency,
  computeSolvency,
  computeTokenSolvency,
  coverageRatio,
  strategyCoverageRatio,
} from '../src/solvency/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MAKER: Addr = '0xmaker00000000000000000000000000000000';
const OTHER_MAKER: Addr = '0xmaker00000000000000000000000000000001';
const APP_1: Addr = '0xapp10000000000000000000000000000000000';
const APP_2: Addr = '0xapp20000000000000000000000000000000000';
const WETH: Addr = '0xtokenweth000000000000000000000000000000';
const USDC: Addr = '0xtokenusdc000000000000000000000000000000';
const HASH_A = '0xhasha000000000000000000000000000000000000000000000000000000';
const HASH_B = '0xhashb000000000000000000000000000000000000000000000000000000';

let blockCounter = 1;
function provenance(blockNumber = blockCounter++): Provenance {
  return {
    chainId: 1,
    blockNumber: BigInt(blockNumber),
    blockHash: '0xblock000000000000000000000000000000000000000000000000000000',
    txHash: '0xtx0000000000000000000000000000000000000000000000000000000000',
    logIndex: 0,
  };
}

function position(token: Addr, committedDelta: bigint, onChainBalance?: bigint): TokenPosition {
  return onChainBalance === undefined
    ? { token, committedDelta }
    : { token, committedDelta, onChainBalance };
}

function strategy(opts: {
  maker?: Addr;
  app: Addr;
  strategyHash: Hex;
  status?: 'live' | 'docked';
  positions: TokenPosition[];
  openingKnown?: boolean;
}): StrategyState {
  const key: StrategyKey = {
    maker: opts.maker ?? MAKER,
    app: opts.app,
    strategyHash: opts.strategyHash,
  };
  const shippedAt = provenance();
  return {
    key,
    status: opts.status ?? 'live',
    strategy: '0x',
    positions: new Map(opts.positions.map((p) => [p.token, p])),
    openingKnown: opts.openingKnown ?? true,
    shippedAt,
    lastSeenAt: shippedAt,
  };
}

type Hex = `0x${string}`;

// Minimal stub of the viem PublicClient surface this module actually calls. Cast through
// `unknown` rather than implementing viem's full generic client type.
function stubClient(balancesByToken: ReadonlyMap<Addr, bigint>): PublicClient {
  const stub = {
    multicall: async ({ contracts }: { contracts: readonly { address: Addr }[] }) =>
      contracts.map((c) => ({ status: 'success' as const, result: balancesByToken.get(c.address) ?? 0n })),
    readContract: async ({ address }: { address: Addr }) => balancesByToken.get(address) ?? 0n,
  };
  return stub as unknown as PublicClient;
}

// ---------------------------------------------------------------------------
// Headline scenario (PRD success metric): one maker, two live strategies sharing one wallet
// balance, then drain the wallet below total commitments -> the ratio flags the underfunded
// maker.
// ---------------------------------------------------------------------------

describe('headline scenario: draining a shared wallet flags the maker', () => {
  // Two live strategies, two different apps, same maker, same token (WETH) — the same wallet
  // balance backs both at once, which is exactly the exposure nothing on-chain can total.
  const strategies: StrategyState[] = [
    strategy({ app: APP_1, strategyHash: HASH_A, positions: [position(WETH, 100n)] }),
    strategy({ app: APP_2, strategyHash: HASH_B, positions: [position(WETH, 50n)] }),
  ];

  it('is healthy while the wallet covers total commitments (150)', async () => {
    const client = stubClient(new Map([[WETH, 200n]]));
    const [solvency] = await computeSolvency(client, strategies, 1, 1_000n);
    expect(solvency).toBeDefined();
    expect(solvency?.underfunded).toBe(false);
    expect(solvency?.worstRatio).toBe((200n * RATIO_SCALE) / 150n);
  });

  it('flags the maker once the wallet is drained below total commitments (150)', async () => {
    const client = stubClient(new Map([[WETH, 100n]]));
    const [solvency] = await computeSolvency(client, strategies, 1, 1_001n);
    expect(solvency).toBeDefined();
    expect(solvency?.underfunded).toBe(true);
    // 100 * 1e18 / 150, truncated -> 666666666666666666
    expect(solvency?.worstRatio).toBe(666666666666666666n);
  });
});

// ---------------------------------------------------------------------------
// Commitment aggregation
// ---------------------------------------------------------------------------

describe('aggregateCommitments', () => {
  it('sums commitments across multiple apps for the same maker/token', () => {
    const strategies = [
      strategy({ app: APP_1, strategyHash: HASH_A, positions: [position(WETH, 100n)] }),
      strategy({ app: APP_2, strategyHash: HASH_B, positions: [position(WETH, 50n)] }),
    ];
    const commitments = aggregateCommitments(strategies);
    expect(commitments).toHaveLength(1);
    expect(commitments[0]?.totalCommitted).toBe(150n);
    expect(commitments[0]?.liveStrategyCount).toBe(2);
  });

  it('excludes docked strategies entirely', () => {
    const strategies = [
      strategy({ app: APP_1, strategyHash: HASH_A, positions: [position(WETH, 100n)] }),
      strategy({
        app: APP_2,
        strategyHash: HASH_B,
        status: 'docked',
        positions: [position(WETH, 999n)],
      }),
    ];
    const commitments = aggregateCommitments(strategies);
    expect(commitments).toHaveLength(1);
    expect(commitments[0]?.totalCommitted).toBe(100n);
    expect(commitments[0]?.liveStrategyCount).toBe(1);
  });

  it('groups independently per maker', () => {
    const strategies = [
      strategy({ maker: MAKER, app: APP_1, strategyHash: HASH_A, positions: [position(WETH, 10n)] }),
      strategy({
        maker: OTHER_MAKER,
        app: APP_1,
        strategyHash: HASH_B,
        positions: [position(WETH, 20n)],
      }),
    ];
    const commitments = aggregateCommitments(strategies);
    expect(commitments).toHaveLength(2);
    const byMaker = new Map(commitments.map((c) => [c.maker, c.totalCommitted]));
    expect(byMaker.get(MAKER)).toBe(10n);
    expect(byMaker.get(OTHER_MAKER)).toBe(20n);
  });

  describe('openingKnown === false policy', () => {
    // ship() emits Shipped + one Pushed per token in the same tx (see docs/SDK-SURFACE.md §4),
    // so openingKnown === true is the normal case and committedDelta is absolute then. false only
    // means the indexer started mid-strategy and never saw the Shipped/opening Pushed events.

    it('prefers onChainBalance when present, even if openingKnown is false', () => {
      const strategies = [
        strategy({
          app: APP_1,
          strategyHash: HASH_A,
          openingKnown: false,
          positions: [position(WETH, 5n, 999n)],
        }),
      ];
      const [c] = aggregateCommitments(strategies);
      expect(c?.totalCommitted).toBe(999n);
      expect(c?.incomplete).toBe(false);
    });

    it('treats committedDelta as absolute once openingKnown is true', () => {
      const strategies = [
        strategy({
          app: APP_1,
          strategyHash: HASH_A,
          openingKnown: true,
          positions: [position(WETH, 42n)],
        }),
      ];
      const [c] = aggregateCommitments(strategies);
      expect(c?.totalCommitted).toBe(42n);
      expect(c?.incomplete).toBe(false);
    });

    it('excludes the position from totalCommitted and marks incomplete, when opening is unknown', () => {
      // Not folded in as a lower bound: a partially-counted total still looks like a complete,
      // trustworthy number to a caller that doesn't know to distrust it. Excluding it and
      // flagging `incomplete` (which computeTokenSolvency turns into a forced `underfunded`)
      // is the honest failure mode for a tool whose job is catching silent illiquidity.
      const strategies = [
        strategy({
          app: APP_1,
          strategyHash: HASH_A,
          openingKnown: false,
          positions: [position(WETH, 30n)],
        }),
      ];
      const [c] = aggregateCommitments(strategies);
      expect(c?.totalCommitted).toBe(0n);
      expect(c?.incomplete).toBe(true);
      expect(c?.liveStrategyCount).toBe(1);
    });

    it('excludes a negative delta the same way — sign is irrelevant once opening is unknown', () => {
      const strategies = [
        strategy({
          app: APP_1,
          strategyHash: HASH_A,
          openingKnown: false,
          positions: [position(WETH, -20n)],
        }),
      ];
      const [c] = aggregateCommitments(strategies);
      expect(c?.totalCommitted).toBe(0n);
      expect(c?.incomplete).toBe(true);
    });

    it('a known strategy plus an incomplete one still marks the aggregate incomplete', () => {
      const strategies = [
        strategy({ app: APP_1, strategyHash: HASH_A, openingKnown: true, positions: [position(WETH, 50n)] }),
        strategy({ app: APP_2, strategyHash: HASH_B, openingKnown: false, positions: [position(WETH, 999n)] }),
      ];
      const [c] = aggregateCommitments(strategies);
      // Only the known 50 counts -- the unknown-opening strategy contributes 0, not 999.
      expect(c?.totalCommitted).toBe(50n);
      expect(c?.incomplete).toBe(true);
      expect(c?.liveStrategyCount).toBe(2);
    });
  });
});

// ---------------------------------------------------------------------------
// Ratio math
// ---------------------------------------------------------------------------

describe('coverageRatio', () => {
  it('returns null (not Infinity, not flagged) when totalCommitted is zero', () => {
    expect(coverageRatio(1_000n, 0n)).toBeNull();
  });

  it('is exact for a clean 1.5x scaled bigint', () => {
    expect(coverageRatio(1_500n, 1_000n)).toBe(1_500_000_000_000_000_000n);
  });

  it('truncates toward zero at a boundary (1/3), always rounding the ratio down', () => {
    // 1 * 1e18 / 3 = 333333333333333333.33... -> truncates to .333...3, never rounds up.
    expect(coverageRatio(1n, 3n)).toBe(333333333333333333n);
  });
});

describe('computeTokenSolvency', () => {
  it('is not flagged and has a null ratio with zero commitments', () => {
    const solvency = computeTokenSolvency(
      { maker: MAKER, token: WETH, totalCommitted: 0n, liveStrategyCount: 0, incomplete: false },
      1_000n,
    );
    expect(solvency.coverageRatio).toBeNull();
    expect(solvency.underfunded).toBe(false);
  });

  it('flags a zero wallet balance against non-zero commitments as ratio 0', () => {
    const solvency = computeTokenSolvency(
      { maker: MAKER, token: WETH, totalCommitted: 100n, liveStrategyCount: 1, incomplete: false },
      0n,
    );
    expect(solvency.coverageRatio).toBe(0n);
    expect(solvency.underfunded).toBe(true);
  });

  it('forces underfunded on an incomplete commitment even with zero known total (not read as "no exposure")', () => {
    // This is the regression the team-lead correction guards against: a maker with a real but
    // unaccounted-for live strategy (indexer missed its Shipped) must NOT look identical to a
    // maker with no exposure at all just because the known total happens to be 0.
    const solvency = computeTokenSolvency(
      { maker: MAKER, token: WETH, totalCommitted: 0n, liveStrategyCount: 1, incomplete: true },
      1_000n,
    );
    expect(solvency.coverageRatio).toBeNull();
    expect(solvency.underfunded).toBe(true);
  });

  it('forces underfunded on an incomplete commitment even when the partial ratio looks healthy', () => {
    // totalCommitted (50) only reflects the known strategy; a second, unaccounted-for live
    // strategy is excluded. The ratio computed from 50 looks like 2x coverage, but that number
    // is optimistic by construction, so underfunded must not depend on it.
    const solvency = computeTokenSolvency(
      { maker: MAKER, token: WETH, totalCommitted: 50n, liveStrategyCount: 2, incomplete: true },
      100n,
    );
    expect(solvency.coverageRatio).toBe(2n * RATIO_SCALE);
    expect(solvency.underfunded).toBe(true);
  });
});

describe('computeMakerSolvency', () => {
  it('worstRatio is the minimum across tokens with exposure, ignoring nulls', () => {
    const solvency = computeMakerSolvency(
      MAKER,
      1,
      [
        { token: WETH, walletBalance: 0n, totalCommitted: 0n, coverageRatio: null, liveStrategyCount: 0, underfunded: false },
        { token: USDC, walletBalance: 2_000n, totalCommitted: 1_000n, coverageRatio: 2n * RATIO_SCALE, liveStrategyCount: 1, underfunded: false },
        { token: WETH, walletBalance: 500n, totalCommitted: 1_000n, coverageRatio: RATIO_SCALE / 2n, liveStrategyCount: 1, underfunded: true },
      ],
      42n,
    );
    expect(solvency.worstRatio).toBe(RATIO_SCALE / 2n);
    expect(solvency.underfunded).toBe(true);
  });

  it('worstRatio is null when the maker has no exposure at all', () => {
    const solvency = computeMakerSolvency(
      MAKER,
      1,
      [
        { token: WETH, walletBalance: 0n, totalCommitted: 0n, coverageRatio: null, liveStrategyCount: 0, underfunded: false },
      ],
      42n,
    );
    expect(solvency.worstRatio).toBeNull();
    expect(solvency.underfunded).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-strategy weakest-token coverage (Arkiv attestation mapping)
// ---------------------------------------------------------------------------

describe('strategyCoverageRatio', () => {
  const s = strategy({
    app: APP_1,
    strategyHash: HASH_A,
    positions: [position(WETH, 100n), position(USDC, 100n)],
  });

  it('returns the formatted ratio of the weakest token in the strategy', () => {
    const maker: MakerSolvency = {
      maker: MAKER,
      chainId: 1,
      tokens: [
        { token: WETH, walletBalance: 200n, totalCommitted: 100n, coverageRatio: 2n * RATIO_SCALE, liveStrategyCount: 1, underfunded: false },
        { token: USDC, walletBalance: 80n, totalCommitted: 100n, coverageRatio: (80n * RATIO_SCALE) / 100n, liveStrategyCount: 1, underfunded: true },
      ],
      worstRatio: (80n * RATIO_SCALE) / 100n,
      underfunded: true,
      atBlock: 1n,
    };
    expect(strategyCoverageRatio(s, maker)).toBe(formatRatio((80n * RATIO_SCALE) / 100n));
  });

  it('returns null when none of the strategy tokens have measurable exposure', () => {
    const maker: MakerSolvency = {
      maker: MAKER,
      chainId: 1,
      tokens: [
        { token: WETH, walletBalance: 0n, totalCommitted: 0n, coverageRatio: null, liveStrategyCount: 0, underfunded: false },
        { token: USDC, walletBalance: 0n, totalCommitted: 0n, coverageRatio: null, liveStrategyCount: 0, underfunded: false },
      ],
      worstRatio: null,
      underfunded: false,
      atBlock: 1n,
    };
    expect(strategyCoverageRatio(s, maker)).toBeNull();
  });
});
