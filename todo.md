# TODO

## 1. Solvency is only recomputed on Aqua events — the silent-illiquidity case is missed

**Status:** open. Found 25 Jul 2026 while running the full fork → Braga → read-API demo.

**The bug.** The live tail is event-driven end to end:

- `src/ingest/index.ts:91` — `watch()` yields a batch only `if (batch.length > 0)`, i.e. only when
  an Aqua log lands in the confirmed range.
- `src/main.ts:220` — the tail loop is `for await (const batch of ingestor.watch(...))`, and
  `computeSolvency` (`src/main.ts:224`) runs only inside that loop body.

So solvency is recomputed *only* when Aqua itself emits something. But a maker's wallet draining is
an ERC-20 `Transfer` on the token contract — **not** an Aqua event. Their commitments are unchanged,
so Aqua stays silent, so we never re-check, and the heartbeat keeps refreshing an attestation that
still says `underfunded: false`.

**Why it matters.** This is precisely the failure the PoC exists to detect. Per the README, the
target is not insolvency but *silent illiquidity*: a strategy that looks live and quotable, on a
maker who can no longer pay at settlement. Right now the indexer is blind to exactly that
transition and actively vouches for the strategy while it happens.

**Observed.** In the demo run, `pnpm lifecycle --underfund` burned the maker's TKA at block
25609411. The tail advanced past it and reported `1 live, 0 underfunded`. Only restarting the
process — which re-runs the backfill and therefore recomputes solvency from scratch — produced
`worst coverage 0.0000x ** UNDERFUNDED **`.

**Fix.** Add a periodic solvency sweep independent of the event stream: on a timer, recompute
`computeSolvency` over the current live set, rebuild attestations, and let the next heartbeat carry
the updated `underfunded` flag. Natural place is alongside the existing heartbeat interval in
`src/main.ts` (the heartbeat already runs on its own timer and already re-attests). Open questions
to settle when implementing:

- Sweep interval vs. heartbeat interval — same timer, or slower? A sweep costs one multicall per
  maker per token, so it is not free at scale.
- Should a sweep that flips a strategy to `underfunded: true` write immediately rather than waiting
  for the next heartbeat tick? Argument for yes: this is the whole product claim.
- Does the sweep need its own `confirmations` lag, or is the balance read at confirmed head enough?

**How to verify the fix.** Reproduce the observed case above without a restart: run the lifecycle
with `--underfund`, let the indexer tail, and assert `/api/underfunded` flips to a non-empty result
within one sweep interval. Worth a regression test with a stubbed balance reader so it runs offline.

---

## Also open

- **Demo environment is ephemeral.** `.env` pins `RPC_URL=http://127.0.0.1:8545` and
  `START_BLOCK=25609400`, which are the anvil fork's values. If anvil restarts, the fork state is
  gone and `pnpm lifecycle --underfund` must be re-run — it mints fresh token addresses each time.
  The Braga side survives independently. The Braga key is a throwaway with a 0.001 test-ETH faucet
  drip; regenerate rather than top up when it runs dry.
