/**
 * Read side of the Aqua indexer: turns Arkiv attribute queries back into `StrategyAttestation[]`.
 *
 * The core semantic, worth stating once up front because it is the single easiest thing to get
 * backwards on this side of the system — see the README's "mechanism mismatch" section and the
 * heartbeat doc comment on `StrategyAttestation` in src/types.ts. An attestation that isn't found
 * is NOT "the strategy closed". Arkiv entities expire on a clock, refreshed by a heartbeat while
 * the indexer still observes the strategy live; an aged-out (and pruned) record means "nobody is
 * currently vouching for this right now". So every method here treats an empty result as a valid
 * answer — `[]`, never a thrown error — and the demo UI (web/) is worded to match: "nobody is
 * currently vouching", not "closed" or "not found".
 *
 * This module takes its Arkiv config as a parameter (`ArkivReadConfig` — rpcUrl + chainId, no
 * private key: see src/config.ts) rather than reading `process.env` itself, so it stays a pure
 * function of its arguments and testable without env juggling. src/query/serve.ts is the one
 * place that resolves config from the environment, via src/config.ts's `loadArkivReadConfig()`.
 */

import { ATTR, decodeAttestationPayload, TOKEN_PRESENT, tokenKey } from '../arkiv/entity.js';
import type { Addr, QueryApi, StrategyAttestation } from '../types.js';
import type { ArkivQueryClient, ArkivReadConfig, RawEntity } from './client.js';
import { createRealArkivQueryClient } from './client.js';
import { normalizePair, toLowerAddr } from './normalize.js';

export type { ArkivQueryClient, ArkivReadConfig, RawAttribute, RawEntity } from './client.js';
export { createRealArkivQueryClient } from './client.js';
export { isAddrLike, normalizePair, toLowerAddr } from './normalize.js';

export interface QueryApiDeps {
  /** Injectable seam for tests. Defaults to a real Braga-connected client built from `config`. */
  readonly client?: ArkivQueryClient;
  /** Called once per entity that fails to decode. Defaults to a `console.warn`. */
  readonly onSkippedEntity?: (entityKey: string, error: unknown) => void;
}

export function createQueryApi(config: ArkivReadConfig, deps: QueryApiDeps = {}): QueryApi {
  const client = deps.client ?? createRealArkivQueryClient(config);
  const onSkippedEntity =
    deps.onSkippedEntity ??
    ((entityKey: string, error: unknown) => {
      console.warn(`[query] skipping malformed Arkiv entity ${entityKey}:`, error);
    });

  /**
   * Decodes every entity, skipping (with a warning) anything that doesn't decode. A malformed or
   * partial entity must not crash the whole response — one bad write, or a stray entity that
   * happens to carry the same attribute key from an unrelated writer sharing this Arkiv instance,
   * shouldn't take down every other maker's query.
   */
  function decodeAll(raw: readonly RawEntity[]): StrategyAttestation[] {
    const out: StrategyAttestation[] = [];
    for (const entity of raw) {
      try {
        out.push(decodeAttestationPayload(entity.payload));
      } catch (err) {
        onSkippedEntity(entity.key, err);
      }
    }
    return out;
  }

  async function strategiesByPair(
    tokenA: Addr,
    tokenB: Addr,
  ): Promise<readonly StrategyAttestation[]> {
    const [t0, t1] = normalizePair(tokenA, tokenB);

    // Query one leg server-side, then verify the other client-side against the decoded payload's
    // `tokens` array.
    //
    // Since token membership is one attribute key per token (`token_<addr>`, see entity.ts), the
    // server COULD answer both legs: `and(eq(tokenKey(t0),'1'), eq(tokenKey(t1),'1'))` was
    // verified live on Braga (25 Jul 2026) to match an entity carrying both keys and return
    // nothing when either is absent. That is a strictly narrower fetch, and worth doing if the
    // over-fetch ever matters.
    //
    // It isn't done here because it would widen `ArkivQueryClient` — deliberately one method,
    // "every entity carrying this one attribute" (see client.ts) — to earn one saved round trip
    // on a discovery/solvency read path that is not hot. The client-side leg is correct either
    // way and costs one `Array.includes` per candidate.
    const candidates = decodeAll(await client.findByAttribute(tokenKey(t0), TOKEN_PRESENT));
    if (t0 === t1) return candidates;
    return candidates.filter((a) => a.tokens.includes(t1));
  }

  async function strategiesByMaker(maker: Addr): Promise<readonly StrategyAttestation[]> {
    return decodeAll(await client.findByAttribute(ATTR.maker, toLowerAddr(maker)));
  }

  async function underfundedMakers(): Promise<readonly StrategyAttestation[]> {
    // 'true' is a string, not a boolean, on purpose — see entity.ts's ATTR doc comment note 2:
    // the SDK's numeric-attribute encoder special-cases the literal `0`, so booleans are encoded
    // as the strings 'true' / 'false' to sidestep that footgun entirely.
    return decodeAll(await client.findByAttribute(ATTR.underfunded, 'true'));
  }

  return { strategiesByPair, strategiesByMaker, underfundedMakers };
}
