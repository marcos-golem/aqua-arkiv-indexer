# Aqua strategy indexer — PoC

A read layer over [1inch Aqua](https://github.com/1inch/aqua) strategy state: ingest
`Shipped`/`Docked`/`Pulled`/`Pushed`, reconstruct live strategy state, expose it queryably with
wallet-owned, self-expiring records on [Arkiv](https://arkiv.network).

The verified SDK/protocol ground truth is in [`docs/SDK-SURFACE.md`](docs/SDK-SURFACE.md) —
**read that before touching the code.** It was written by probing mainnet and the installed SDKs,
and it corrects several things the original spec got wrong.

## Why this exists

Aqua's whitepaper says the quiet part out loud:

> "Aqua liquidity is off-chain discoverable but on-chain accessible—aggregators and solvers must
> index and track available liquidity through off-chain mechanisms."

Nobody appears to have built that. Two derived needs — **discovery** (which strategies are live,
on what pairs, backed by how much) and **solvency** (a maker's real balance vs. their total
virtual commitments *across every app*, which no on-chain call can cheaply enumerate).

The failure mode being detected is not insolvency — it is **silent illiquidity**: trades that
revert at settlement, on strategies that looked live.

## Architecture

```
Aqua contract logs ──▶ Ingestor ──▶ Reducer ──▶ Arkiv writer ──▶ Query API / demo UI
 (viem eth_getLogs)   (fromLog)    (fold)     (heartbeat + expiration)
                                      │
                                      └──▶ Solvency (wallet balance vs. commitments)
```

| Module | Role |
|---|---|
| `src/types.ts` | The shared contract. Every module codes against this and nothing else of its neighbours'. |
| `src/config.ts` | The only place that reads `process.env`. |
| `src/ingest/` | Chain logs → normalised, ordered `AquaEventRecord[]`. The 1inch SDK's `Address`/`HexString` wrapper classes are confined here. |
| `src/reduce/` | Pure fold into live state, plus on-chain reconciliation. |
| `src/arkiv/` | Attestation writes with heartbeat expiration. |
| `src/solvency/` | Cross-app commitment aggregation and coverage ratios. |
| `src/query/` | Read side + minimal demo page. |

One rule worth stating: **the SDK's wrapper classes live only in `src/ingest`.** Everything
downstream sees plain lowercase hex strings, so `===` is safe and the reducer is a pure function
over plain objects. `Address.toString()` casing isn't reliably consistent, and `===` on two
wrapper instances is a silent bug — confining them removes the whole class of error.

## The mechanism mismatch (the interesting part)

Aqua strategies terminate on an **event** (`dock()`). Arkiv entities expire on a **clock**. Those
are not the same mechanism, and pretending otherwise would be the easiest way to ship something
subtly wrong.

The bridge is a **heartbeat**: each attestation is written with a short expiration date and
refreshed while the indexer still observes the strategy live. A record that has aged out means
*"nobody is currently vouching for this"* — **not** *"the strategy closed"*. It fails toward
silence rather than toward a stale quote.

## What was verified empirically, and what wasn't

Everything below was run, not assumed. Full detail in `docs/SDK-SURFACE.md`.

**Verified on an anvil mainnet fork against the real Aqua contract:**

- `ship()` emits `Shipped` **plus one `Pushed` per token**. The spec assumed opening committed
  amounts were unrecoverable from events and required calldata decoding or `rawBalances`. They are
  recoverable. This materially simplified the reducer.
- `ship()` accepts a plain **EOA** as the `app` — Aqua does not require app contract code. That is
  what makes a local lifecycle harness possible without obtaining Aqua's app contracts.
- The fold arithmetic: committed balance went `100e18` → (pull 10e18) → (push 4e18) → `94e18`,
  exactly as `Pulled`-subtracts / `Pushed`-adds predicts.
- After `dock()`, `rawBalances` returns `tokensCount = 255` (`0xff`) — a docked sentinel, distinct
  from a strategy that never existed (`0, 0`).
- Both `0x1111113ccf…` (the SDK constant) and `0x499943e7…` (the address the spec hardcoded) are
  live and answer the Aqua ledger ABI. SwapVM does not. Always resolve via the SDK constant.

**Verified by running the demo server against live Braga** (Arkiv reads are public, so this needed
no credentials): `/api/underfunded` and `/api/strategies` return `200 []` against the real network,
and — importantly — pointing the server at a dead RPC returns `500` with a clean JSON error rather
than an empty array. "Nobody is currently vouching" is genuinely distinguished from "the query
failed", which is the one confusion that would make this read layer untrustworthy. Static assets
serve with correct content types, a malformed address gets a `400`, and path traversal gets a `404`.

**Verified by reading the installed SDKs (things the spec didn't cover):**

- **Braga's chain id is `60138453102`.** An earlier draft of this repo's config said `393530`, which
  was wrong. Both `src/config.ts` and `.env.example` now default from the SDK's own `braga` export.
- Arkiv needs **two** clients: mutations live on `createWalletClient`, reads on
  `createPublicClient`.
- Arkiv entity keys are **assigned by the chain**, not chosen — logical identity is enforced by
  query-before-write.
- Arkiv attributes are a flat set with no array values, so token-set membership is **one key per
  token** (`token_<addr>` = `'1'`). An earlier draft used a *repeated* `token` key; Braga rejects
  that outright (`string annotation key token is duplicated`), so it could never have been
  written — see the live findings below.
- viem's `getLogs` has no raw `topics` parameter; `events:` compiles to the same nested-OR topic0
  filter (confirmed on the wire), and `multicall` requires a `chain` on the client.

**Not verified — do not present these as settled:**

- **Which Aqua deployment carries current activity.** Needs an `eth_getLogs` over a wide range;
  every free public RPC tried refuses archive log queries without a key.
- **The mainnet launch block.** `src/config.ts` uses `23_800_000`, derived arithmetically from
  head-at-date, not from finding the first `Shipped` log. Erring low costs backfill time; erring
  high silently misses strategies.
- **Historical replay against mainnet** (the load-bearing test) — same keyed-RPC blocker.
  Note an anvil fork cannot stand in: it only serves logs from its own post-fork blocks, and
  querying below the fork point gets proxied upstream and rejected as an archive request. The fork
  proves the pipeline on strategies it created itself, which is not the same claim.
- Whether anyone has already built an Aqua indexer, e.g. in the $100k bounty submissions.

**Verified against live Braga with a funded key (25 Jul 2026)** — this section previously listed
the write path as unverified:

- `RUN_LIVE=1 pnpm test` passes **82/82**. The round-trip writes a 10s-expiry attestation, reads it
  back, stops refreshing, and confirms the record is gone — so heartbeat expiry is now demonstrated
  on the network, not only against a stubbed client.
- **Braga rejects duplicated annotation keys.** The first live run failed with `failed to validate
  storage transaction: create[0] string annotation key token is duplicated`. The repeated-`token`
  encoding was therefore *unwritable*, not merely un-queryable — a defect no offline test could
  catch, because the in-memory fake accepts repeated keys. Token membership is now `token_<addr>`.
- Annotation keys must match Arkiv's identifier grammar (`^[\p{L}_][\p{L}\p{N}_]*$`). `token_0xabc…`
  is accepted; a `token:0xabc…` separator is rejected as an invalid identifier.
- `and(eq(token_A,'1'), eq(token_B,'1'))` matches an entity carrying both keys and returns nothing
  when either is absent — so pair containment *is* expressible server-side. `src/query` still
  confirms the second leg client-side (see the comment there for why).
- **Full pipeline, fork → Braga → read API.** `pnpm lifecycle --underfund` then `pnpm index` against
  the fork attested one live strategy to Braga (queryable in 42ms / 111ms across two runs), and
  `pnpm demo` served it back on `/api/underfunded`, `/api/maker`, and the pair query, with
  `coverageRatio 0.0000` and `underfunded: true`. Re-running the indexer in a fresh process updated
  the *same* entity key, which exercises the query-before-write identity across restarts.

**Known gap found during that run:** `AquaIngestor.watch()` yields only when an Aqua event lands
(`if (batch.length > 0)`), and solvency is recomputed only from those batches. A maker's wallet
draining emits an ERC-20 `Transfer`, not an Aqua event — so a strategy that becomes underfunded
between Aqua events keeps being heartbeated with a stale `underfunded: false`. That is exactly the
silent-illiquidity case this PoC exists to detect, so the tail needs a periodic solvency sweep
independent of the event stream.

## Setup

```bash
pnpm install
cp .env.example .env      # fill in RPC_URL, and ARKIV_* for the Arkiv layer
```

## Running

```bash
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest, fully offline
pnpm index                # run the indexer
pnpm demo                 # serve the read-only demo page
```

### Local end-to-end lifecycle

Aqua is **mainnet-only** — there is no testnet — so write paths are exercised on a fork:

```bash
anvil --fork-url <MAINNET_RPC> --port 8545 --silent
(cd contracts && forge build)
pnpm lifecycle              # ship → pull → push → dock, with assertions
pnpm lifecycle --underfund  # leaves a live strategy with a drained wallet, for solvency
```

The script refuses to run against anything that isn't a loopback anvil node (it verifies via
`anvil_nodeInfo`), because it signs with anvil's published dev keys. Note a mainnet fork reports
chain ID **1**, identical to real mainnet, so the chain ID alone cannot be the safety check.

### Live Arkiv tests

Braga tests are opt-in and skip cleanly without credentials:

```bash
RUN_LIVE=1 pnpm test
```

## Testing strategy

The layers, and what each one proves:

| Layer | Test | Proves |
|---|---|---|
| Parsers | Encode real log fixtures, decode via the SDK | Decoding matches the on-chain ABI |
| Reducer | Pure fold: order-independence, idempotence, anomalies | State reconstruction is correct and replay-safe |
| Reducer vs. chain | Diff reconstructed state against `rawBalances` | **The load-bearing test** — the off-chain state is a faithful mirror |
| End-to-end | anvil fork lifecycle | The whole pipeline tracks a real strategy |
| Arkiv | Braga write → poll → read back; stop heartbeat, confirm ageing out | Expiration semantics behave as designed |
| Solvency | Maker with 2 strategies on one balance, then drained | The ratio flags an underfunded maker |

The reducer-vs-chain diff is load-bearing because it is the only test that substantiates the
product claim: that this off-chain state faithfully mirrors the chain.

## Scope

**In:** event ingest, state reconstruction, an Arkiv write layer with heartbeat expiry, a query
interface, and a solvency ratio per maker.

**Out:** SwapVM opcodes (an indexer uses zero), routing and execution, any new on-chain contract,
and a consumer frontend — there is a minimal read-only demo page and nothing more.

This is a read layer. Execution stays on-chain in Aqua, exactly as designed.
