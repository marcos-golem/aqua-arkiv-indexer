# Aqua strategy indexer — PoC

Indexes [1inch Aqua](https://github.com/1inch/aqua) strategy events into a queryable read layer,
stored as wallet-owned, self-expiring records on [Arkiv](https://arkiv.network).

Answers two questions Aqua itself can't answer cheaply on-chain:

- **Discovery** — which strategies are live, on what token pair, backed by how much.
- **Solvency** — whether a maker's actual wallet balance covers their virtual commitments across
  *every* app they've shipped to. Aqua lets one balance back many strategies, so a maker can look
  live everywhere and be unable to settle. Trades revert at execution time.

Aqua's whitepaper states that "aggregators and solvers must index and track available liquidity
through off-chain mechanisms." This is that mechanism.

**Status:** proof of concept. The read and write paths are exercised end-to-end against a mainnet
fork and the Braga testnet. Historical mainnet replay is not verified (needs a keyed archive RPC),
and solvency is currently recomputed only on Aqua events — see [`todo.md`](todo.md).

## Prerequisites

| Need | Why |
|---|---|
| Node and pnpm | Developed on Node 25 / pnpm 10 (lockfile v9). No `engines` floor is declared; nothing exotic is used, but older Node is untested. |
| Mainnet RPC URL | Aqua is **mainnet-only** — no testnet. Backfill needs `eth_getLogs` over a wide block range, so a free public RPC will usually refuse. Use a keyed provider. |
| Arkiv private key, funded on Braga | Writes only. Reads are public and need no key. |
| [Foundry](https://getfoundry.sh) | Only for the local fork lifecycle (`anvil`, `forge`). |

## Setup

```bash
pnpm install
cp .env.example .env      # RPC_URL is required; ARKIV_PRIVATE_KEY only for writes
```

## Running

```bash
pnpm typecheck            # tsc --noEmit
pnpm test                 # vitest, fully offline
pnpm index                # backfill, then follow the chain and attest to Arkiv
pnpm demo                 # read-only HTTP server on :8787 (PORT to override)
```

## API

`pnpm demo` serves the endpoints below plus a static demo page at `/`. All return JSON.
Errors are `{ status, error }` — `400` on a malformed address, `500` when the Arkiv query itself
failed. An empty array means "nobody is currently vouching for a matching strategy", which is
deliberately distinct from an error.

| Endpoint | Params | Returns |
|---|---|---|
| `GET /api/strategies` | `tokenA`, `tokenB` (both required, hex addresses) | Live strategies covering that pair |
| `GET /api/maker` | `maker` (hex address) | That maker's live strategies |
| `GET /api/underfunded` | — | Live strategies whose maker fails the coverage check |

Each result is a `StrategyAttestation`:

```jsonc
{
  "chainId": 1,
  "maker": "0x…",
  "app": "0x…",
  "strategyHash": "0x…",
  "committed": { "0x<token>": "94000000000000000000" },  // decimal strings — JSON has no bigint
  "tokens": ["0x…", "0x…"],                              // sorted, so pair queries are canonical
  "coverageRatio": "0.0000",                             // weakest token; null if no exposure
  "underfunded": true,
  "lastBlock": "23800123",
  "attestedAt": 1753440000
}
```

## Architecture

```
Aqua contract logs ──▶ Ingestor ──▶ Reducer ──▶ Arkiv writer ──▶ Query API / demo UI
 (viem eth_getLogs)   (fromLog)    (fold)     (heartbeat + expiration)
                                      │
                                      └──▶ Solvency (wallet balance vs. commitments)
```

| Module | Role |
|---|---|
| `src/types.ts` | Shared types. Every module codes against this, not its neighbours' internals. |
| `src/config.ts` | The only place that reads `process.env`. |
| `src/ingest/` | Chain logs → normalised, ordered `AquaEventRecord[]`. The 1inch SDK's `Address`/`HexString` wrapper classes are confined here; everything downstream sees plain lowercase hex. |
| `src/reduce/` | Pure fold into live state, plus on-chain reconciliation. |
| `src/arkiv/` | Attestation writes with heartbeat expiration. |
| `src/solvency/` | Cross-app commitment aggregation and coverage ratios. |
| `src/query/` | Read side and demo server. |

### Heartbeat expiration

Aqua strategies end on an **event** (`dock()`). Arkiv entities expire on a **clock**. The bridge is
a heartbeat: each attestation is written with a short expiration date and refreshed while the
indexer still observes the strategy live. An expired record means *"nobody is currently vouching
for this"* — not *"the strategy closed"*. `HEARTBEAT_REFRESH_SECONDS` must be well under half
`HEARTBEAT_EXPIRY_SECONDS` or records flicker; the config rejects it otherwise.

## Local end-to-end lifecycle

Since Aqua is mainnet-only, write paths are exercised against a fork:

```bash
anvil --fork-url <MAINNET_RPC> --port 8545 --silent
(cd contracts && forge build)
pnpm lifecycle              # ship → pull → push → dock, with assertions
pnpm lifecycle --underfund  # leaves a live strategy with a drained wallet, for solvency
```

The script signs with anvil's published dev keys, so it refuses to run against anything that isn't
a loopback anvil node (verified via `anvil_nodeInfo`). A mainnet fork reports chain ID 1, so the
chain ID alone can't be the safety check.

## Tests

`pnpm test` is fully offline. Braga tests are opt-in and skip cleanly without credentials:

```bash
RUN_LIVE=1 pnpm test        # requires a funded ARKIV_PRIVATE_KEY
```

| Layer | Proves |
|---|---|
| Parsers | Decoding matches the on-chain ABI |
| Reducer | State reconstruction is order-independent, idempotent, replay-safe |
| Reducer vs. chain | Reconstructed state matches `rawBalances` — the off-chain mirror is faithful |
| End-to-end | anvil fork lifecycle tracks a real strategy through the whole pipeline |
| Arkiv | Braga write → read back → stop heartbeat → confirm it ages out |
| Solvency | A maker with two strategies on one balance is flagged when drained |

## Reference

[`docs/SDK-SURFACE.md`](docs/SDK-SURFACE.md) records the verified Aqua and Arkiv SDK behaviour this
code depends on — event shapes, address resolution, Arkiv's annotation-key grammar, and where the
original spec was wrong. Read it before changing the ingest or Arkiv layers.

## Scope

**In:** event ingest, state reconstruction, an Arkiv write layer with heartbeat expiry, a query
interface, a solvency ratio per maker.

**Out:** SwapVM opcodes (an indexer uses zero), routing and execution, any new on-chain contract,
and a consumer frontend — the demo page is minimal and read-only.

This is a read layer. Execution stays on-chain in Aqua, exactly as designed.

## License

MIT — see [LICENSE](LICENSE).
