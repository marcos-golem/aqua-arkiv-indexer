/**
 * Mapping between {@link StrategyAttestation} and an Arkiv entity: what goes in the payload,
 * what goes in the attributes (Arkiv's term is "attribute", commonly called an annotation —
 * both are used interchangeably in this file's comments), and how each direction round-trips.
 */

import type { StrategyAttestation } from '../types.js';
import type { EntityAttribute } from './client.js';

/** Content type for every attestation entity this module writes. */
export const CONTENT_TYPE = 'application/json';

/**
 * Annotation keys written on every attestation entity. The query module (src/query) reads
 * entities back by these exact keys — do not rename one without updating it.
 *
 * | Key             | Type   | Value                              | Why                                                                 |
 * |-----------------|--------|------------------------------------|----------------------------------------------------------------------|
 * | chainId         | number | `a.chainId`                       | identity component; scopes one Arkiv instance to one source chain    |
 * | maker           | string | `a.maker`                         | identity component; `QueryApi.strategiesByMaker` -> `eq('maker', m)` |
 * | app             | string | `a.app`                           | identity component; the same maker can ship to two different apps    |
 * | strategyHash    | string | `a.strategyHash`                  | identity component; a maker+app can carry several strategy hashes    |
 * | token           | string | one row PER entry of `a.tokens`   | `QueryApi.strategiesByPair` -> `and(eq('token',A), eq('token',B))`   |
 * | underfunded     | string | `'true' \| 'false'`               | `QueryApi.underfundedMakers` -> `eq('underfunded', 'true')`          |
 * | firstAttestedAt | number | first successful `attestedAt`     | NOT recomputed on refresh — see writer.ts's read-merge-write step    |
 *
 * Two design notes worth keeping visible:
 *
 * 1. `token` is deliberately written as a REPEATED attribute key (one row per token in the
 *    strategy) rather than a single joined string, because Arkiv's attribute model is a flat
 *    multiset of key/value rows per entity — there is no array-valued attribute. Repeating the
 *    key is the only way this model can express "this entity's token set contains X", and an AND
 *    of two `eq('token', ...)` predicates is how the read side expresses containment of a pair.
 *    This assumes the query engine matches an AND of same-key predicates existentially across
 *    separate rows, which we could not verify against a live Braga instance in this pass (no
 *    credentials) — the query module should confirm it against the real network before relying
 *    on it in production.
 * 2. `underfunded` is a string, not a number. The SDK's numeric-attribute encoder special-cases
 *    the literal value `0` (see `opsToTxData` in `@arkiv-network/sdk`, which encodes numeric `0`
 *    as an empty byte string rather than the number zero) — an unnecessary footgun for a plain
 *    boolean flag, so we sidestep it entirely.
 *
 * `chainId` + `maker` + `app` + `strategyHash` together are this record's logical identity (see
 * {@link identityAttributes}). An Arkiv entity key is assigned by the chain at creation and can't
 * be chosen by the caller, so "deterministic identity per (chainId, maker, app, strategyHash)" is
 * enforced at the application layer here, via a query-before-write in writer.ts, not via the key.
 */
export const ATTR = {
  chainId: 'chainId',
  maker: 'maker',
  app: 'app',
  strategyHash: 'strategyHash',
  token: 'token',
  underfunded: 'underfunded',
  firstAttestedAt: 'firstAttestedAt',
} as const;

/** The attributes that jointly identify one logical attestation record (see module doc). */
export function identityAttributes(a: StrategyAttestation): EntityAttribute[] {
  return [
    { key: ATTR.chainId, value: a.chainId },
    { key: ATTR.maker, value: a.maker },
    { key: ATTR.app, value: a.app },
    { key: ATTR.strategyHash, value: a.strategyHash },
  ];
}

/**
 * The full attribute set for a create/update. `firstAttestedAt` is a parameter rather than
 * derived from `a`: on an update it must be carried forward from the existing entity rather than
 * recomputed, which is exactly the read-merge-write step writer.ts performs before calling this.
 */
export function deriveAttributes(a: StrategyAttestation, firstAttestedAt: number): EntityAttribute[] {
  return [
    ...identityAttributes(a),
    ...a.tokens.map((token): EntityAttribute => ({ key: ATTR.token, value: token })),
    { key: ATTR.underfunded, value: a.underfunded ? 'true' : 'false' },
    { key: ATTR.firstAttestedAt, value: Math.trunc(firstAttestedAt) },
  ];
}

/**
 * The entity payload is the whole {@link StrategyAttestation} as JSON, unabridged. `committed`
 * values and `lastBlock` are already decimal strings on the type — nothing here ever calls
 * `Number()` on them, so no precision is at risk crossing this boundary.
 */
export function encodeAttestationPayload(a: StrategyAttestation): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(a));
}

/**
 * Decodes and shape-checks an entity payload. The shape check matters because this reads back
 * data written by (in principle) any holder of the identity attributes, not only this process —
 * an entity that looks like ours by attribute but isn't a real attestation should fail loudly
 * here rather than propagate a garbage object downstream.
 */
export function decodeAttestationPayload(payload: Uint8Array): StrategyAttestation {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(payload));
  if (!isStrategyAttestationShape(parsed)) {
    throw new Error('Arkiv entity payload does not look like a StrategyAttestation.');
  }
  return parsed;
}

function isStrategyAttestationShape(v: unknown): v is StrategyAttestation {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.chainId === 'number' &&
    typeof r.maker === 'string' &&
    typeof r.app === 'string' &&
    typeof r.strategyHash === 'string' &&
    Array.isArray(r.tokens) &&
    typeof r.committed === 'object' &&
    r.committed !== null &&
    typeof r.underfunded === 'boolean' &&
    typeof r.lastBlock === 'string' &&
    typeof r.attestedAt === 'number'
  );
}

/** Looks up one attribute's value by key. Used to read `firstAttestedAt` off an existing entity. */
export function findAttributeValue(
  attributes: readonly EntityAttribute[],
  key: string,
): string | number | undefined {
  return attributes.find((attr) => attr.key === key)?.value;
}
