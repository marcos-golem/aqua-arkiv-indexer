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
 * | token_&lt;addr&gt;    | string | `'1'`, one key PER entry of `a.tokens` | `QueryApi.strategiesByPair` -> `eq(tokenKey(A), '1')`      |
 * | underfunded     | string | `'true' \| 'false'`               | `QueryApi.underfundedMakers` -> `eq('underfunded', 'true')`          |
 * | firstAttestedAt | number | first successful `attestedAt`     | NOT recomputed on refresh — see writer.ts's read-merge-write step    |
 *
 * Two design notes worth keeping visible:
 *
 * 1. Token-set membership is encoded as ONE ATTRIBUTE KEY PER TOKEN (`token_<addr>` = `'1'`),
 *    not as a repeated `token` key and not as a joined string. Arkiv's attribute model is a flat
 *    set of key/value rows per entity with no array-valued attribute, and — verified live on
 *    Braga, 25 Jul 2026 — **the network rejects a duplicated key outright**:
 *
 *      failed to validate storage transaction: create[0] string annotation key token is duplicated
 *
 *    So the repeated-key encoding this file previously used could never have been written at all.
 *    Folding the token into the key sidesteps that, and makes "contains X" a plain single-key
 *    `eq`. The same probe confirmed `and(eq(token_A,'1'), eq(token_B,'1'))` matches an entity
 *    carrying both and returns nothing when either is absent, so pair containment is expressible
 *    server-side too. Keys must match Arkiv's identifier grammar (`^[\p{L}_][\p{L}\p{N}_]*$`) —
 *    `token_0xabc…` satisfies it; a `token:0xabc…` separator does NOT and is rejected.
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
  underfunded: 'underfunded',
  firstAttestedAt: 'firstAttestedAt',
} as const;

/** Prefix of the per-token membership keys. Never used as a bare key — see {@link tokenKey}. */
export const TOKEN_KEY_PREFIX = 'token_';

/** The value every `token_<addr>` key carries. Presence is the signal; the value is a constant. */
export const TOKEN_PRESENT = '1';

/**
 * The attribute key encoding "this strategy's token set contains `token`".
 *
 * Lowercased because the rest of the pipeline works in lowercase hex (see the README's note on
 * confining the 1inch SDK's `Address` wrappers to src/ingest) and an attribute key is matched
 * byte-for-byte — a mixed-case key would simply never be found by a lowercase query.
 */
export function tokenKey(token: string): string {
  return `${TOKEN_KEY_PREFIX}${token.toLowerCase()}`;
}

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
    ...a.tokens.map((token): EntityAttribute => ({ key: tokenKey(token), value: TOKEN_PRESENT })),
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
