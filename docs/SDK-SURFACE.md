# SDK ground truth — verified against installed packages, 25 Jul 2026

Everything below was read out of `node_modules` or probed against Ethereum mainnet, not recalled
from memory or docs. **Do not invent APIs beyond this file.** If you need something not listed,
read the `.d.ts` yourself and add it here.

Installed: `@1inch/aqua-sdk@0.2.0`, `@1inch/sdk-core@0.1.2` (transitive), `@arkiv-network/sdk@0.7.0`, `viem@2.55.8`.

---

## Corrections to the spec this was built from — this file overrides it

### 1. Contract address — resolve it from the SDK, never a literal

The PRD and the research primer both hardcode `0x499943e74fb0ce105688beee8ef2abec5d936d31`.
The SDK's own `AQUA_CONTRACT_ADDRESSES` says **`0x1111113ccf1426a8e30e2bff5e005d929bf6a90a`** —
the same address on all 12 chains, and carrying the `0x1111113` vanity prefix characteristic of
1inch contracts.

Probed on mainnet (25 Jul 2026), and this is more nuanced than "the PRD is wrong":

| Address | `eth_getCode` | `rawBalances` eth_call |
|---|---|---|
| `0x1111113ccf…` (SDK constant) | 11240 bytes | returns 64 bytes ✅ |
| `0x499943e7…` (PRD / primer) | 12504 bytes | returns 64 bytes ✅ |
| `0x8fdd04db…` (SwapVM) | 45282 bytes | reverts ❌ |

So **both** Aqua candidates are live and both answer the Aqua ledger ABI — the PRD's address is
not fictional, it looks like an earlier or parallel deployment. SwapVM correctly does not answer
the ledger ABI, which confirms the probe discriminates properly.

**What to do:** always resolve via `AQUA_CONTRACT_ADDRESSES` (see `aquaAddressFor` in
`src/config.ts`), never a literal. **Open question we could not close:** which deployment carries
current activity. Settling it needs an `eth_getLogs` over a wide block range, and every free
public RPC we tried refuses archive log queries without a key. Do not assert one is "the" Aqua
until someone runs that query with a keyed RPC.

### 2. Every Aqua event field is NON-indexed

`Shipped`, `Docked`, `Pulled`, `Pushed` all declare `indexed: false` on every input, including
`maker`. Consequences:
- You **cannot** filter logs by maker/app/strategyHash via topics. Only `topic0` is filterable.
- Per-maker filtering happens **after** decoding, in the reducer. Plan for full-firehose ingest
  of all four event types and client-side filtering.
- `getLogs` takes the four topic0 values as a nested OR array, never an `args` filter.

### 3. `ship()` ABI arg shape differs from the SDK's `ShipArgs` type

On-chain `ship` takes `(app, strategy, address[] tokens, uint256[] amounts)` — two parallel
arrays. The SDK's `ShipArgs` uses `amountsAndTokens: {amount, token}[]` and transposes for you
inside `encodeShipCallData`. Don't mix the two shapes.

### 4. `ship()` emits `Shipped` + one `Pushed` PER TOKEN — opening amounts ARE recoverable

**This supersedes an earlier version of this document, and it supersedes the PRD.** Verified
empirically on an anvil mainnet fork at block 25,608,240 (25 Jul 2026) by calling the real Aqua
contract. One `ship()` with two tokens produced **three** logs in one transaction:

| logIndex | topic0 | event | payload |
|---|---|---|---|
| 0 | `0xdc3622e0…` | `Shipped` | maker, app, strategyHash, strategy blob |
| 1 | `0x3f18354a…` | `Pushed` | maker, app, strategyHash, token0, `100e18` |
| 2 | `0x3f18354a…` | `Pushed` | maker, app, strategyHash, token1, `200e18` |

So the committed opening amounts arrive as ordinary `Pushed` events in the same transaction as
the `Shipped`. Consequences, and they simplify the reducer a lot:

- The `Shipped` event itself still carries only `(maker, app, strategyHash, strategy)` — that part
  was right. But you do **not** need calldata decoding or a `rawBalances` read to learn the
  opening position. Just fold the `Pushed` events that follow it.
- **Therefore `committedDelta` is an absolute committed balance**, not a delta against an unknown
  opening, PROVIDED your event stream starts at or before the strategy's `Shipped`. It is only a
  delta when you began indexing mid-strategy.
- `openingKnown` in `src/types.ts` should be read as "did I see this strategy's `Shipped`, and
  therefore its opening `Pushed` events?" — set it `true` when you fold a `Shipped`, not only
  after an on-chain read. A mid-stream backfill still leaves it `false`.
- Ordering inside a single tx therefore matters: the `Shipped` is at a LOWER logIndex than its
  opening `Pushed` events. Sorting by `compareProvenance` already gets this right; do not
  special-case it.

`rawBalances` reconciliation is still worth having — it is the independent check that proves the
fold is faithful — but it is no longer *required* to establish the opening position.

### 4a. Full lifecycle verified on a fork — the fold arithmetic is confirmed

Ran `ship` → `pull` → `push` → `dock` against the real Aqua contract on an anvil mainnet fork.
Every step returned status 1, and `rawBalances` tracked exactly as the reducer model predicts:

| Step | Action | `rawBalances(T0)` |
|---|---|---|
| ship | commit 100e18 T0, 200e18 T1 | `100e18`, tokensCount `2` |
| pull | app takes 10e18 T0 | — |
| push | app returns 4e18 T0 | `94e18` (= 100 − 10 + 4) ✅ |
| dock | maker closes all tokens | `0`, tokensCount `255` |

So `Pulled` subtracts and `Pushed` adds, against an absolute committed balance — exactly the
reducer semantics in `src/types.ts`. This is the empirical basis for the fold, not an assumption.

Note `push` requires the app to have approved Aqua for the token first, and `pull`'s `to` argument
sends the tokens wherever the app says (we used the app itself).

### 4b. `ship()` accepts an EOA as the `app`

Also verified on the fork: `ship(app, …)` with `app` set to a plain EOA (no contract code)
succeeds, status 1. Aqua does not require the app to be a deployed `AquaApp`. That is what makes
the local lifecycle harness possible — impersonate an EOA as the app and call `pull`/`push`
directly, with no need to obtain or deploy Aqua's own app contracts.

### 5. Mainnet launch block is approximate

`src/config.ts` uses `23_800_000` as the mainnet start block, derived: head was 25,608,178 on
25 Jul 2026, Aqua launched 17 Nov 2025 (~250 days, ~7200 blocks/day at 12s). **This is an
estimate, not a verified deployment block.** Pin it properly by binary-searching for the first
`Shipped` log once a keyed archive RPC is available. Starting too low only costs backfill time;
starting too high silently misses strategies.

---

## `@1inch/aqua-sdk` — exact exports

```ts
export {
  ABI,                        // namespace: ABI.AQUA_ABI
  AQUA_CONTRACT_ADDRESSES,    // Record<NetworkEnum, Address>
  Address, HexString, NetworkEnum, type CallInfo,
  AquaProtocolContract,
  ShippedEvent, DockedEvent, PulledEvent, PushedEvent,
  type ShipArgs, type DockArgs, type AmountsAndTokens, type ShipDecodedResult,
}
```

### Event classes

All four expose `static TOPIC: HexString` and `static fromLog(log: LogLike): T`, and **throw**
on a log that doesn't match. Fields are readonly.

| Class | Fields |
|---|---|
| `ShippedEvent` | `maker: Address`, `app: Address`, `strategyHash: HexString`, `strategy: HexString` |
| `DockedEvent` | `maker: Address`, `app: Address`, `strategyHash: HexString` |
| `PulledEvent` | `maker: Address`, `app: Address`, `strategyHash: HexString`, `token: Address`, `amount: bigint` |
| `PushedEvent` | `maker: Address`, `app: Address`, `strategyHash: HexString`, `token: Address`, `amount: bigint` |

Verified `topic0` values (listed so you can sanity-check — read `XEvent.TOPIC.toString()` in code,
don't hardcode):

| Event | topic0 |
|---|---|
| `Shipped` | `0xdc3622e06fb145651f567d421c9ef261d71d43e3778b761907bc0d70d42e52b0` |
| `Docked` | `0xd173a1d140c154eb1ce9298d251d5eb8c4089cc2d16e70f1067bdc810c6fe004` |
| `Pulled` | `0x3ad61047071575417c75e3311e5d46ff042e292b5dd8769ff18b4b254098ca7a` |
| `Pushed` | `0x3f18354abbd5306dd1665c2c90f614a4559e39dd620d04fbe5458e613b6588f3` |

### `LogLike` — what `fromLog` actually accepts

```ts
type LogLike = { data: Hex; topics: [signature: Hex, ...Hex[]] | [] }
```

Only `data` and `topics`. A viem `Log` is structurally compatible (extra fields are fine), so
`ShippedEvent.fromLog(viemLog)` works. Block number / tx hash / log index are **not** part of
`LogLike`, so decoded events carry no provenance. Attach it yourself.

### Domain wrappers — `Address` and `HexString` are NOT strings

From `@1inch/sdk-core`. The single most likely source of bugs in this repo.

```ts
declare class HexString {
  static EMPTY: HexString
  static fromBigInt(v: bigint, name?: string): HexString
  static fromUnknown(v: unknown, name?: string): HexString
  toBigInt(): bigint
  isEmpty(): boolean
  concat(other: HexString): HexString
  bytesCount(): number
  sliceBytes(start: number, end?: number): HexString
  equal(other: HexString): boolean
  toString(): Hex          // <-- use this to get a `0x...` string
}

declare class Address {
  static NATIVE_CURRENCY: Address
  static ZERO_ADDRESS: Address
  static fromBigInt(v: bigint): Address
  static fromFirstBytes(bytes: string): Address
  toString(): Hex          // <-- use this
  equal(other: Address): boolean
  lt(other: Address): boolean
  gt(other: Address): boolean
  isNative(): boolean
  isZero(): boolean
}
```

Rules:
- **Never** `===` on `Address`/`HexString`. Use `.equal()`, or normalise via `.toString()`.
- **Always `.toLowerCase()`** before using as a map key — casing is not guaranteed consistent
  across construction paths.
- Comparing a wrapper against a viem address string without normalising is a silent bug.

### `AquaProtocolContract`

Static, pure calldata helpers — no RPC, no provider:

```ts
AquaProtocolContract.encodeShipCallData(args: ShipArgs): HexString
AquaProtocolContract.encodeDockCallData(args: DockArgs): HexString
AquaProtocolContract.buildShipTx(contractAddress: Address, params: ShipArgs): CallInfo
AquaProtocolContract.buildDockTx(contractAddress: Address, params: DockArgs): CallInfo
AquaProtocolContract.calculateStrategyHash(strategy: HexString): HexString
// instance: new AquaProtocolContract(address).ship(params) / .dock(params) -> CallInfo
```

There is **no** encoder for `pull` / `push` — those are app-contract-initiated. To call them in a
test, encode with viem against `ABI.AQUA_ABI`.

### Read functions for reconciliation

```
rawBalances(maker, app, strategyHash, token)           -> (uint248 balance, uint8 tokensCount)
safeBalances(maker, app, strategyHash, token0, token1) -> (uint256 balance0, uint256 balance1)
```

- `rawBalances` returns a **tuple** — viem gives `readonly [bigint, number]`. Destructure it.
  Verified live: returns 64 bytes. `balance` is `uint248`, still a JS `bigint`.
- **`tokensCount == 255` is the docked sentinel.** Verified on the fork across a full lifecycle:
  while live with two tokens it reads `2`; after `dock()` the same slot reads
  `(balance: 0, tokensCount: 255)`. So `255` (`0xff`) means "this strategy existed and was
  docked", which is distinguishable from a strategy that never existed (`0, 0`). That is a cheap
  on-chain way to confirm a dock without replaying events — useful in reconciliation to tell
  "closed" apart from "I never saw it".
- `safeBalances` **reverts** for a strategy that isn't active (declared error
  `SafeBalancesForTokenNotInActiveStrategy`). Verified live: reverts on a zero-arg probe. So a
  revert here is expected signal, not necessarily a failure — handle it, don't let it throw
  through your reconciliation loop.

### Chain IDs in `AQUA_CONTRACT_ADDRESSES`

`1, 10, 56, 100, 130, 137, 146, 324, 8453, 42161, 43114, 59144`

The record also has a literal `"undefined"` key (an SDK bug — a `NetworkEnum` member stringifies
to `undefined`). **Guard your lookups** against the list above; `src/config.ts` already does.

---

## Aqua protocol semantics that matter for the reducer

- Ledger shape: `balances[maker][app][strategyHash][token]`.
- `strategyHash = keccak256(abi.encode(strategy))`, and strategy params are **immutable** once
  shipped. Changing terms = `dock()` then `ship()` again → a *new* hash. A hash identifies one
  immutable incarnation; a "strategy" in the product sense may be a chain of hashes.
- Lifecycle: `Shipped` opens → `Pulled` (app takes tokens out) / `Pushed` (app returns them)
  move committed amounts → `Docked` closes.
- **`Docked` closes ALL tokens** — see the `DockingShouldCloseAllTokens` error. A `Docked` event
  means the whole strategy closed, never one leg.
- `PushToNonActiveStrategyPrevented` exists, so a `Pushed` on a docked strategy is impossible
  on-chain. A reducer that sees one has an ordering bug, not a chain anomaly.
- No auto-pause on underfunding. Solvency is entirely an off-chain observation.
- **Mainnet only** — launched 17 Nov 2025, no testnet. Live validation is fork-based (anvil) or
  historical replay.

---

## `@arkiv-network/sdk@0.7.0`

Subpath exports: `.`, `./chains`, `./query`, `./types`, `./utils`.

Two footguns the PRD flags, both real:
- `updateEntity` is **full replacement**, not a patch → read-merge-write.
- Writes are not instantly self-visible → poll after write.

Measured on Braga 25 Jul 2026 (n=3): submit→queryable ~4.5s, mined→queryable ~40ms.

Verified by reading the installed SDK source:

- **Braga's chain id is `60138453102`.** An earlier version of `src/config.ts` and `.env.example`
  said `393530`, which was simply invented and wrong. Confirmed from
  `@arkiv-network/sdk/chains`: `braga` → id `60138453102`, rpc
  `https://braga.hoodi.arkiv.network/rpc`; `kaolin` → `60138453025`; `localhost` → `1337`.
  `src/config.ts` now defaults from the SDK export rather than a literal, so it cannot drift again.
- **You need TWO clients, not one.** `createWalletClient` carries only the mutations
  (`createEntity`/`updateEntity`/`deleteEntity`/`extendEntity`/`mutateEntities`); the reads
  (`getEntity`, `select`) are public actions on `createPublicClient`. Assuming one client does both
  is a real bug — build both over the same transport/chain.
- **Entity keys cannot be chosen by the caller.** `createEntity` takes no key; it is assigned by the
  chain and read from the tx receipt log. So "deterministic identity per (chainId, maker, app,
  strategyHash)" has to be enforced at the application layer via query-before-write, not by
  addressing a key.
- **The attribute encoder special-cases numeric `0`**, encoding it as an empty byte string rather
  than the number zero. Avoid numeric `0` attribute values — `src/arkiv` writes the `underfunded`
  flag as the string `'true'`/`'false'` to sidestep this entirely.
- **Attributes are a flat multiset of key/value rows per entity** — there is no array-valued
  attribute (confirmed from the SDK's RLP encoder, which maps the attribute array with no dedup).
  Expressing "this entity's token set contains X" therefore means writing a **repeated** `token`
  key, one row per token. **Unverified:** whether the query engine matches an AND of two same-key
  predicates existentially across separate rows. `src/query` does not depend on it — it filters on
  one leg server-side and confirms the second client-side.
- `expiresIn` is in seconds and should be a multiple of the 2s block time.

## viem notes (2.55.8) worth knowing

- **`getLogs` has no raw `topics` parameter** in its public TS surface — `GetLogsParameters` accepts
  only `address`/`event`/`events`/`args`/block range. Pass `events: AbiEvent[]` instead; viem's
  implementation builds `topics = [events.flatMap(encodeEventTopics)]`, i.e. exactly the nested-OR
  topic0 filter, and this was confirmed on the wire against anvil.
- Do **not** hand-roll `client.request({method:'eth_getLogs'})` to get raw topics: viem's JSON body
  serializer renders bigint as a decimal string, not a hex quantity, so bigint block numbers become
  invalid JSON-RPC params. The typed action converts correctly.
- **`multicall` needs a `chain` on the client.** A client built with only a transport throws
  "client chain not configured. multicallAddress is required" rather than degrading to individual
  reads. `src/config.ts` exposes `viemChainFor(chainId)` for this. An anvil mainnet fork reports
  chain 1 and inherits mainnet's multicall3, so it works there too.

## anvil fork limitation

A fork only serves logs from **its own post-fork blocks**. Querying a range below the fork block
makes anvil proxy upstream, and free public RPCs reject those as archive requests
(`403 Archive requests require a personal token`). So the fork validates the pipeline on strategies
it created itself; it cannot substitute for a historical mainnet replay. That replay still needs a
keyed archive RPC.

---

## House rules for this repo

- ESM only (`"type": "module"`), `verbatimModuleSyntax` on → `import type` for type-only imports,
  `.js` extensions on relative imports.
- `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are on. Indexing an array
  or record yields `T | undefined`. Handle it; don't `!` your way out.
- All money is `bigint`. **Never** `Number()` a token amount. No floats in accounting paths.
  Ratios are scaled bigints (`RATIO_SCALE` in `src/types.ts`).
- Every module owns its directory and exports through an `index.ts`.
- No module reaches into another's internals — only `src/types.ts` and a neighbour's `index.ts`.
- Arkiv house language: entities have **expiration dates**, never "TTL".
