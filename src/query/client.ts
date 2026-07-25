/**
 * The seam between src/query and the real `@arkiv-network/sdk`. `QueryApi` (see index.ts) only
 * ever needs one primitive — "give me every entity currently carrying this one attribute" — so
 * that's the entire surface exposed upward. Keeping it to one method is what lets
 * test/query.test.ts run fully offline against a plain in-memory stub, no Braga connection or
 * credentials required.
 *
 * Deliberately a separate, narrower seam from src/arkiv/client.ts's `ArkivEntityClient`: that one
 * is shaped around the writer's read-merge-write identity lookup (an AND of several DISTINCT-key
 * attributes, capped at 10 results — identity should match at most one entity). This one is
 * shaped around open-ended reads on a SINGLE key — "every strategy for this maker" can
 * legitimately be more than 10 rows — so it paginates instead of capping.
 */

import { createPublicClient } from '@arkiv-network/sdk';
import { eq } from '@arkiv-network/sdk/query';
import { defineChain, http, type Hex } from 'viem';
import type { ArkivReadConfig } from '../config.js';

export type { ArkivReadConfig } from '../config.js';

export interface RawAttribute {
  readonly key: string;
  readonly value: string | number;
}

export interface RawEntity {
  readonly key: Hex;
  readonly payload: Uint8Array;
  readonly attributes: readonly RawAttribute[];
}

export interface ArkivQueryClient {
  /**
   * Every entity currently carrying attribute `key = value`. An entity that has expired and been
   * pruned by the network simply doesn't come back — no error, no tombstone — which is exactly
   * the "absence is meaningful, not an error" semantic index.ts is built around.
   */
  findByAttribute(key: string, value: string | number): Promise<readonly RawEntity[]>;
}

/** Safety valve against an unbounded live set turning one demo query into an unbounded loop. At
 * 100 entities/page this caps a single call at 5,000 entities — generous for a POC. */
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

export function createRealArkivQueryClient(config: ArkivReadConfig): ArkivQueryClient {
  // Built from config rather than importing the SDK's `braga` chain constant, same reasoning as
  // src/arkiv/client.ts: config.rpcUrl is the actual network this instance talks to, and
  // hardcoding a chain constant here would silently drift from whatever config.chainId says.
  const chain = defineChain({
    id: config.chainId,
    name: 'arkiv',
    nativeCurrency: { name: 'Golem', symbol: 'GLM', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const client = createPublicClient({ chain, transport: http(config.rpcUrl) });

  return {
    async findByAttribute(key, value) {
      const out: RawEntity[] = [];
      let result = await client
        .select({ key: true, payload: true, attributes: true })
        .where(eq(key, value))
        .limit(PAGE_SIZE)
        .fetch();
      out.push(...result.entities.map(toRawEntity));

      let pages = 1;
      while (result.hasNextPage() && pages < MAX_PAGES) {
        await result.next();
        out.push(...result.entities.map(toRawEntity));
        pages++;
      }
      return out;
    },
  };
}

function toRawEntity(entity: {
  key: Hex;
  payload?: Uint8Array | undefined;
  attributes: readonly RawAttribute[];
}): RawEntity {
  if (entity.payload === undefined) {
    // Selection asked for `payload: true`, so this would mean the SDK broke its own contract —
    // fail loudly rather than let a decoder downstream see a phantom empty attestation.
    throw new Error(`Entity ${entity.key} was returned without a payload despite selecting it.`);
  }
  return { key: entity.key, payload: entity.payload, attributes: entity.attributes };
}
