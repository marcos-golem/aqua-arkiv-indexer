/**
 * Shared contract for the Aqua indexer.
 *
 * Every module codes against this file and nothing else of its neighbours'. The one
 * architectural rule that makes the rest of the system testable:
 *
 *   The 1inch SDK's wrapper classes (`Address`, `HexString`) live ONLY inside src/ingest.
 *   The moment an event crosses out of the ingestor it is plain, normalised, comparable data.
 *
 * That means the reducer is a pure function over plain objects, `===` is safe everywhere
 * downstream, and nothing outside the ingestor needs to know `.equal()` exists.
 */

/** Lowercase `0x`-prefixed hex. Normalised at the ingest boundary — safe to compare with `===`. */
export type Hex = `0x${string}`;

/** Lowercase 20-byte address. Always lowercase, so it is safe as a map key. */
export type Addr = Hex;

/** `keccak256(abi.encode(strategy))`. Identifies one immutable strategy incarnation. */
export type StrategyHash = Hex;

// ---------------------------------------------------------------------------
// Fixed-point ratios
// ---------------------------------------------------------------------------

/**
 * All ratios in this codebase are scaled bigints, never floats — an accounting path that
 * touches IEEE-754 is a bug. A ratio of 1.0 (fully covered) is exactly `RATIO_SCALE`.
 */
export const RATIO_SCALE = 10n ** 18n;

/** A ratio scaled by {@link RATIO_SCALE}. `1500000000000000000n` means 1.5x coverage. */
export type ScaledRatio = bigint;

/** Format a {@link ScaledRatio} for display only. Never feed the result back into accounting. */
export function formatRatio(r: ScaledRatio, decimals = 4): string {
  const negative = r < 0n;
  const abs = negative ? -r : r;
  const whole = abs / RATIO_SCALE;
  const frac = ((abs % RATIO_SCALE) * 10n ** BigInt(decimals)) / RATIO_SCALE;
  const fracStr = frac.toString().padStart(decimals, '0');
  return `${negative ? '-' : ''}${whole}.${fracStr}`;
}

// ---------------------------------------------------------------------------
// Chain / config
// ---------------------------------------------------------------------------

/** Chain IDs the Aqua SDK actually ships an address for. Verified against the SDK constant. */
export const SUPPORTED_CHAIN_IDS = [
  1, 10, 56, 100, 130, 137, 146, 324, 8453, 42161, 43114, 59144,
] as const;

export type SupportedChainId = (typeof SUPPORTED_CHAIN_IDS)[number];

export function isSupportedChainId(id: number): id is SupportedChainId {
  return (SUPPORTED_CHAIN_IDS as readonly number[]).includes(id);
}

export interface ChainConfig {
  readonly chainId: SupportedChainId;
  readonly rpcUrl: string;
  /** Aqua contract. Resolved from the SDK constant, never a hardcoded literal. */
  readonly aquaAddress: Addr;
  /** Block to start a cold backfill from. See MAINNET_LAUNCH_BLOCK — it is an estimate. */
  readonly startBlock: bigint;
  /** Max block span per `getLogs` call. RPC providers cap this; 2_000 is a safe default. */
  readonly logChunkSize: bigint;
  /** How many blocks behind head to treat as final, to survive reorgs. */
  readonly confirmations: bigint;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type AquaEventKind = 'shipped' | 'docked' | 'pulled' | 'pushed';

/**
 * Where a log came from. The SDK's event classes deliberately carry no provenance
 * (`LogLike` is only `{data, topics}`), so the ingestor attaches this itself.
 */
export interface Provenance {
  readonly chainId: SupportedChainId;
  readonly blockNumber: bigint;
  readonly blockHash: Hex;
  readonly txHash: Hex;
  readonly logIndex: number;
}

interface EventBase {
  readonly provenance: Provenance;
  readonly maker: Addr;
  readonly app: Addr;
  readonly strategyHash: StrategyHash;
}

/**
 * A strategy opens. Note what is NOT here: committed token amounts. The on-chain `Shipped`
 * event carries only the opaque `strategy` blob, so opening positions have to be recovered
 * from `rawBalances` reads (or the originating calldata). See docs/SDK-SURFACE.md §4.
 */
export interface ShippedEventRecord extends EventBase {
  readonly kind: 'shipped';
  /** Opaque ABI-encoded strategy params. Its keccak256 is the strategyHash. */
  readonly strategy: Hex;
}

/** A strategy closes. Closes ALL tokens — Aqua reverts a partial dock. */
export interface DockedEventRecord extends EventBase {
  readonly kind: 'docked';
}

/** An app took `amount` of `token` out of the maker's committed balance. */
export interface PulledEventRecord extends EventBase {
  readonly kind: 'pulled';
  readonly token: Addr;
  readonly amount: bigint;
}

/** An app returned `amount` of `token` to the maker's committed balance. */
export interface PushedEventRecord extends EventBase {
  readonly kind: 'pushed';
  readonly token: Addr;
  readonly amount: bigint;
}

export type AquaEventRecord =
  | ShippedEventRecord
  | DockedEventRecord
  | PulledEventRecord
  | PushedEventRecord;

/**
 * Canonical ordering key. Events MUST be reduced in this order or committed balances drift.
 * Returns negative / zero / positive, so it drops straight into `Array.prototype.sort`.
 */
export function compareProvenance(a: Provenance, b: Provenance): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

// ---------------------------------------------------------------------------
// Reconstructed state
// ---------------------------------------------------------------------------

/**
 * Composite identity of a position in the Aqua ledger: `balances[maker][app][strategyHash]`.
 * A strategyHash alone is NOT unique across makers — always key on the triple.
 */
export interface StrategyKey {
  readonly maker: Addr;
  readonly app: Addr;
  readonly strategyHash: StrategyHash;
}

/**
 * Stable string form of a {@link StrategyKey}, for use as a Map key.
 * Single-chain scope per indexer instance, so chainId is deliberately not part of the id.
 */
export function strategyKeyId(k: StrategyKey): string {
  return `${k.maker}:${k.app}:${k.strategyHash}`;
}

export type StrategyStatus = 'live' | 'docked';

/** Per-token committed position within one strategy. */
export interface TokenPosition {
  readonly token: Addr;
  /**
   * Net committed amount as reconstructed from events: pushes add, pulls subtract.
   *
   * This is a DELTA against the (unknown-from-events) opening position, not an absolute
   * balance, unless `openingKnown` is true on the parent strategy. Signed on purpose —
   * a negative value before reconciliation is expected, not corrupt.
   */
  readonly committedDelta: bigint;
  /** Absolute balance from an on-chain `rawBalances` read, when one has been done. */
  readonly onChainBalance?: bigint;
}

export interface StrategyState {
  readonly key: StrategyKey;
  readonly status: StrategyStatus;
  /** Opaque strategy blob from the `Shipped` event. */
  readonly strategy: Hex;
  /** Token positions, keyed by lowercase token address. */
  readonly positions: ReadonlyMap<Addr, TokenPosition>;
  /**
   * True once absolute opening amounts have been established from on-chain reads.
   * While false, `committedDelta` is a delta and MUST NOT be presented as a balance.
   */
  readonly openingKnown: boolean;
  readonly shippedAt: Provenance;
  readonly dockedAt?: Provenance;
  /** Provenance of the most recent event folded into this state. */
  readonly lastSeenAt: Provenance;
}

/** Output of a reduce pass over an ordered event stream. */
export interface ReducedState {
  readonly strategies: ReadonlyMap<string, StrategyState>;
  /** Highest block fully folded in. Resume point for the next pass. */
  readonly lastBlock: bigint;
  /** Events the reducer could not apply, with a reason. Never silently dropped. */
  readonly anomalies: readonly Anomaly[];
}

export interface Anomaly {
  readonly reason:
    | 'pull-before-ship'
    | 'push-before-ship'
    | 'push-after-dock'
    | 'dock-before-ship'
    | 'duplicate-ship'
    | 'dock-when-already-docked';
  readonly event: AquaEventRecord;
}

// ---------------------------------------------------------------------------
// Reconciliation — the load-bearing correctness claim
// ---------------------------------------------------------------------------

/**
 * One reconstructed-vs-on-chain comparison. The PRD's headline claim is that the whole
 * live set reconciles with zero drift; this is the unit that claim is made of.
 */
export interface ReconciliationEntry {
  readonly key: StrategyKey;
  readonly token: Addr;
  readonly reconstructed: bigint;
  readonly onChain: bigint;
  readonly drift: bigint;
}

export interface ReconciliationReport {
  readonly atBlock: bigint;
  readonly entries: readonly ReconciliationEntry[];
  readonly driftCount: number;
  /** True only when every entry has zero drift AND at least one entry was checked. */
  readonly clean: boolean;
}

// ---------------------------------------------------------------------------
// Solvency
// ---------------------------------------------------------------------------

/**
 * A maker's exposure in ONE token, across every app and strategy they have shipped to.
 *
 * This is the number the protocol cannot give you: an app contract can read its own slice of
 * `balances[maker][app][...]`, but nothing on-chain cheaply enumerates a maker's global
 * position. The same wallet balance can back many strategies at once.
 */
export interface TokenSolvency {
  readonly token: Addr;
  /** Actual ERC-20 balance in the maker's wallet. */
  readonly walletBalance: bigint;
  /** Sum of committed amounts across every live strategy of this maker for this token. */
  readonly totalCommitted: bigint;
  /**
   * `walletBalance / totalCommitted`, scaled by {@link RATIO_SCALE}.
   * `null` when `totalCommitted` is 0 — that is "no exposure", not "infinitely solvent".
   */
  readonly coverageRatio: ScaledRatio | null;
  /** How many live strategies this token's commitment is spread across. */
  readonly liveStrategyCount: number;
  readonly underfunded: boolean;
}

export interface MakerSolvency {
  readonly maker: Addr;
  readonly chainId: SupportedChainId;
  readonly tokens: readonly TokenSolvency[];
  /** Worst coverage ratio across tokens with non-zero exposure, or null if no exposure. */
  readonly worstRatio: ScaledRatio | null;
  readonly underfunded: boolean;
  readonly atBlock: bigint;
}

/** Coverage below this is flagged. 1.0x — a maker whose wallet exactly covers commitments. */
export const DEFAULT_UNDERFUNDED_THRESHOLD: ScaledRatio = RATIO_SCALE;

// ---------------------------------------------------------------------------
// Arkiv attestation layer
// ---------------------------------------------------------------------------

/**
 * What gets written to Arkiv per live strategy.
 *
 * Semantics of expiry, because it is the whole point and easy to get backwards: this record
 * is written with a SHORT expiration date and refreshed by a heartbeat while the indexer still
 * observes the strategy as live. A record that has aged out means "nobody is currently
 * vouching for this", NOT "the strategy closed". It fails toward silence, not toward a
 * stale quote.
 */
export interface StrategyAttestation {
  readonly chainId: SupportedChainId;
  readonly maker: Addr;
  readonly app: Addr;
  readonly strategyHash: StrategyHash;
  /** Committed amount per token, as decimal strings — JSON has no bigint. */
  readonly committed: Readonly<Record<Addr, string>>;
  /** Tokens in this strategy, sorted, so a pair query has a canonical form. */
  readonly tokens: readonly Addr[];
  /** Maker's coverage for the weakest token in this strategy, as a decimal string. */
  readonly coverageRatio: string | null;
  readonly underfunded: boolean;
  /** Last block the indexer observed this strategy live at. */
  readonly lastBlock: string;
  /** Unix seconds when this attestation was written. */
  readonly attestedAt: number;
}

/**
 * Heartbeat tuning. The expiration date must comfortably exceed the refresh period or
 * records flicker in and out of existence.
 */
export interface HeartbeatConfig {
  /** How long each attestation's expiration date is set for. */
  readonly expirySeconds: number;
  /** How often the writer refreshes still-live strategies. Must be well under `expirySeconds`. */
  readonly refreshSeconds: number;
}

export const DEFAULT_HEARTBEAT: HeartbeatConfig = {
  expirySeconds: 300,
  refreshSeconds: 60,
};

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

/** src/ingest — turns chain logs into normalised, ordered {@link AquaEventRecord}s. */
export interface Ingestor {
  /** Historical sweep over `[from, to]`, returned in canonical provenance order. */
  backfill(from: bigint, to: bigint): AsyncIterable<AquaEventRecord[]>;
  /** Live tail from `from` onward. Yields batches as blocks land. */
  watch(from: bigint): AsyncIterable<AquaEventRecord[]>;
  /** Current chain head. */
  head(): Promise<bigint>;
}

/** src/reduce — pure fold, plus on-chain reconciliation. */
export interface Reducer {
  /** Fold a batch into prior state. Pure: same inputs, same output, no I/O. */
  apply(prior: ReducedState, events: readonly AquaEventRecord[]): ReducedState;
  /** Only the live strategies, which is what gets attested. */
  live(state: ReducedState): readonly StrategyState[];
}

/** src/arkiv — attestation write layer with heartbeat expiry. */
export interface AttestationWriter {
  /** Write or refresh one attestation. Read-merge-write, since updateEntity replaces wholesale. */
  attest(a: StrategyAttestation): Promise<{ entityKey: string; queryableAfterMs: number }>;
  /** Refresh every attestation still considered live. Returns how many were refreshed. */
  heartbeat(live: readonly StrategyAttestation[]): Promise<number>;
}

/** src/query — read side. */
export interface QueryApi {
  /** Live strategies whose token set contains both legs of the pair. */
  strategiesByPair(tokenA: Addr, tokenB: Addr): Promise<readonly StrategyAttestation[]>;
  /** Every live attestation for one maker. */
  strategiesByMaker(maker: Addr): Promise<readonly StrategyAttestation[]>;
  /** Makers currently flagged underfunded. */
  underfundedMakers(): Promise<readonly StrategyAttestation[]>;
}
