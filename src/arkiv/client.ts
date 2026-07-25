/**
 * The seam between src/arkiv and the real `@arkiv-network/sdk`. Everything above this file
 * (entity.ts, writer.ts, runner.ts) talks only to {@link ArkivEntityClient}, which is exactly the
 * four operations attest()/heartbeat() need — nothing from the real SDK's much larger surface
 * leaks upward. That's what lets test/arkiv.test.ts run the offline tier with a plain in-memory
 * stub instead of a live Braga connection and a private key.
 */

import { createPublicClient, createWalletClient, NoEntityFoundError } from '@arkiv-network/sdk';
import { and, eq } from '@arkiv-network/sdk/query';
import { defineChain, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ArkivConfig } from '../config.js';

export interface EntityAttribute {
  readonly key: string;
  readonly value: string | number;
}

export interface EntityRecord {
  readonly key: Hex;
  readonly payload: Uint8Array;
  readonly attributes: readonly EntityAttribute[];
}

export interface CreateEntityInput {
  readonly payload: Uint8Array;
  readonly attributes: readonly EntityAttribute[];
  readonly contentType: string;
  readonly expiresInSeconds: number;
}

export interface UpdateEntityInput extends CreateEntityInput {
  readonly entityKey: Hex;
}

export interface ArkivEntityClient {
  createEntity(input: CreateEntityInput): Promise<{ entityKey: Hex; txHash: Hex }>;
  updateEntity(input: UpdateEntityInput): Promise<{ entityKey: Hex; txHash: Hex }>;
  /** `undefined` when the entity does not (yet) exist or isn't queryable — this seam never
   * throws for "not found"; poll-after-write in writer.ts depends on that. */
  getEntity(key: Hex): Promise<EntityRecord | undefined>;
  /** AND-match entities carrying every given attribute. Used only for the identity lookup that
   * makes attest() a read-merge-write instead of a blind create. */
  findByAttributes(attributes: readonly EntityAttribute[]): Promise<readonly EntityRecord[]>;
}

/** `ARKIV_PRIVATE_KEY` may or may not carry a `0x` prefix; viem's account helpers require one. */
function toPrivateKeyHex(privateKey: string): `0x${string}` {
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      'ARKIV_PRIVATE_KEY must be a 32-byte hex string (64 hex characters, optional 0x prefix).',
    );
  }
  return normalized as `0x${string}`;
}

/**
 * Builds the real client from config. Two clients are required, not one: the SDK's wallet client
 * (`createWalletClient`) only carries the mutation actions (createEntity/updateEntity/...); reads
 * (getEntity/select) are public actions only present on `createPublicClient`. Both share one
 * transport/chain so they observe the same network.
 */
export function createRealArkivEntityClient(config: ArkivConfig): ArkivEntityClient {
  const account = privateKeyToAccount(toPrivateKeyHex(config.privateKey));
  // Built from config rather than importing the SDK's `braga` chain constant: config.rpcUrl is
  // the actual network this instance talks to, and the chain id must match it for correct tx
  // signing — hardcoding `braga` here would silently drift from whatever config.chainId says.
  const chain = defineChain({
    id: config.chainId,
    name: 'arkiv',
    nativeCurrency: { name: 'Golem', symbol: 'GLM', decimals: 18 },
    rpcUrls: { default: { http: [config.rpcUrl] } },
  });
  const transport = http(config.rpcUrl);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });

  return {
    async createEntity(input) {
      return walletClient.createEntity({
        payload: input.payload,
        attributes: [...input.attributes],
        contentType: input.contentType,
        expiresIn: input.expiresInSeconds,
      });
    },

    async updateEntity(input) {
      return walletClient.updateEntity({
        entityKey: input.entityKey,
        payload: input.payload,
        attributes: [...input.attributes],
        contentType: input.contentType,
        expiresIn: input.expiresInSeconds,
      });
    },

    async getEntity(key) {
      try {
        const entity = await publicClient.getEntity(key);
        if (entity.payload === undefined) return undefined;
        return { key: entity.key, payload: entity.payload, attributes: entity.attributes };
      } catch (err) {
        if (err instanceof NoEntityFoundError) return undefined;
        throw err;
      }
    },

    async findByAttributes(attributes) {
      const predicates = attributes.map((attr) => eq(attr.key, attr.value));
      // Identity should match at most one entity; a small limit bounds pathological duplicates
      // (e.g. a create retried after a timed-out first attempt) without over-fetching.
      const result = await publicClient
        .select({ key: true, payload: true, attributes: true })
        .where(and(predicates))
        .limit(10)
        .fetch();
      return result.entities.map((entity) => ({
        key: entity.key,
        payload: entity.payload,
        attributes: entity.attributes,
      }));
    },
  };
}
