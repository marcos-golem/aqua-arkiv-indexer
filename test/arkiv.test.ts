/**
 * Tier 1 (below) is offline by construction: every test builds a `FakeArkivClient` and injects
 * it via `ArkivWriterDeps.client`, so `npx vitest run` never touches a network or reads
 * ARKIV_PRIVATE_KEY. Tier 2, at the bottom, is the opt-in live-Braga suite gated on
 * `RUN_LIVE === '1'`.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Hex } from 'viem';
import {
  ATTR,
  decodeAttestationPayload,
  deriveAttributes,
  encodeAttestationPayload,
  identityAttributes,
  TOKEN_KEY_PREFIX,
  TOKEN_PRESENT,
  tokenKey,
} from '../src/arkiv/entity.js';
import type {
  ArkivEntityClient,
  CreateEntityInput,
  EntityAttribute,
  EntityRecord,
  UpdateEntityInput,
} from '../src/arkiv/client.js';
import { AttestationNotQueryableError, createArkivWriter } from '../src/arkiv/writer.js';
import { createHeartbeatRunner } from '../src/arkiv/runner.js';
import type { ArkivConfig } from '../src/config.js';
import type { HeartbeatConfig, StrategyAttestation } from '../src/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHAIN_ID = 1 as const;
const MAKER: Hex = '0x1111111111111111111111111111111111111111';
const APP: Hex = '0x2222222222222222222222222222222222222222';
const TOKEN_A: Hex = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const TOKEN_B: Hex = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function makeAttestation(overrides: Partial<StrategyAttestation> = {}): StrategyAttestation {
  return {
    chainId: CHAIN_ID,
    maker: MAKER,
    app: APP,
    strategyHash: '0x3333333333333333333333333333333333333333333333333333333333333333',
    committed: {
      [TOKEN_A]: '1000000000000000000',
      [TOKEN_B]: '2000000000000000000',
    },
    tokens: [TOKEN_A, TOKEN_B],
    coverageRatio: '1500000000000000000',
    underfunded: false,
    lastBlock: '23800123',
    attestedAt: 1_753_400_000,
    ...overrides,
  };
}

// Short, valid-per-SDK expiration window (multiple of the 2s block time, refresh well under
// half the expiry) — mirrors what loadHeartbeatConfig would validate, without importing it.
const HEARTBEAT: HeartbeatConfig = { expirySeconds: 300, refreshSeconds: 60 };

const FAKE_CONFIG: ArkivConfig = {
  rpcUrl: 'http://fake.invalid/rpc',
  privateKey: '0xnotarealkey',
  chainId: 393530,
};

// ---------------------------------------------------------------------------
// In-memory fake client — the injectable seam this module was designed around
// ---------------------------------------------------------------------------

interface FakeClientOptions {
  /** Number of leading `getEntity` calls (per key) that return `undefined` before the record
   * appears — simulates the measured submit->queryable propagation delay. */
  queryableAfterCalls?: number;
  /** When true, `getEntity` always returns `undefined` — simulates a write that never becomes
   * queryable within any timeout. */
  neverQueryable?: boolean;
  /** Predicate over the identity attributes of a create/update; when true, that call throws. */
  failIdentity?: (identity: Record<string, string | number>) => boolean;
}

function identityMapOf(attributes: readonly EntityAttribute[]): Record<string, string | number> {
  const map: Record<string, string | number> = {};
  for (const key of [ATTR.chainId, ATTR.maker, ATTR.app, ATTR.strategyHash]) {
    const found = attributes.find((a) => a.key === key);
    if (found !== undefined) map[key] = found.value;
  }
  return map;
}

function identityKeyOf(attributes: readonly EntityAttribute[]): string {
  const map = identityMapOf(attributes);
  return `${map[ATTR.chainId]}:${map[ATTR.maker]}:${map[ATTR.app]}:${map[ATTR.strategyHash]}`;
}

function createFakeArkivClient(opts: FakeClientOptions = {}) {
  const store = new Map<Hex, EntityRecord>();
  const getEntityCallCount = new Map<Hex, number>();
  let nextKeySuffix = 1;
  const creates: CreateEntityInput[] = [];
  const updates: UpdateEntityInput[] = [];

  const client: ArkivEntityClient = {
    async createEntity(input) {
      if (opts.failIdentity?.(identityMapOf(input.attributes))) {
        throw new Error('simulated createEntity failure');
      }
      const key = `0x${String(nextKeySuffix++).padStart(64, '0')}` as Hex;
      store.set(key, { key, payload: input.payload, attributes: input.attributes });
      creates.push(input);
      return { entityKey: key, txHash: key };
    },
    async updateEntity(input) {
      if (opts.failIdentity?.(identityMapOf(input.attributes))) {
        throw new Error('simulated updateEntity failure');
      }
      store.set(input.entityKey, {
        key: input.entityKey,
        payload: input.payload,
        attributes: input.attributes,
      });
      updates.push(input);
      return { entityKey: input.entityKey, txHash: input.entityKey };
    },
    async getEntity(key) {
      if (opts.neverQueryable) return undefined;
      const count = (getEntityCallCount.get(key) ?? 0) + 1;
      getEntityCallCount.set(key, count);
      if (count <= (opts.queryableAfterCalls ?? 0)) return undefined;
      return store.get(key);
    },
    async findByAttributes(attributes) {
      const wanted = identityKeyOf(attributes);
      return [...store.values()].filter((e) => identityKeyOf(e.attributes) === wanted);
    },
  };

  return { client, store, creates, updates, getEntityCallCount };
}

// ---------------------------------------------------------------------------
// Tier 1 — offline
// ---------------------------------------------------------------------------

describe('entity payload and annotation shape', () => {
  it('carries every annotation the QueryApi needs, with committed/lastBlock kept as strings', () => {
    const a = makeAttestation();
    const attrs = deriveAttributes(a, a.attestedAt);

    // Identity + query annotations, per the table in entity.ts.
    expect(attrs).toContainEqual({ key: ATTR.chainId, value: CHAIN_ID });
    expect(attrs).toContainEqual({ key: ATTR.maker, value: MAKER });
    expect(attrs).toContainEqual({ key: ATTR.app, value: APP });
    expect(attrs).toContainEqual({ key: ATTR.strategyHash, value: a.strategyHash });
    // strategiesByPair() needs one membership key PER token. It must be `token_<addr>` and not a
    // repeated bare `token` key: Braga rejects a duplicated annotation key outright ("string
    // annotation key token is duplicated"), so the repeated form is unwritable, not merely
    // unqueryable. Asserting the exact key shape here is what keeps that regression from
    // reappearing in a suite that otherwise never touches the network.
    expect(attrs.filter((x) => x.key.startsWith(TOKEN_KEY_PREFIX))).toEqual([
      { key: tokenKey(TOKEN_A), value: TOKEN_PRESENT },
      { key: tokenKey(TOKEN_B), value: TOKEN_PRESENT },
    ]);
    // No key may repeat, for any key — the network validates this across the whole attribute set.
    const keys = attrs.map((x) => x.key);
    expect(new Set(keys).size).toBe(keys.length);
    // underfundedMakers() needs a plain eq('underfunded', 'true'|'false') — string, not number.
    expect(attrs).toContainEqual({ key: ATTR.underfunded, value: 'false' });
    expect(typeof attrs.find((x) => x.key === ATTR.underfunded)?.value).toBe('string');

    // numeric attributes must be integers (Arkiv throws InvalidAttributeError otherwise).
    const chainIdAttr = attrs.find((x) => x.key === ATTR.chainId);
    expect(Number.isInteger(chainIdAttr?.value)).toBe(true);

    // Round-trip through the payload never touches Number() on money/block fields.
    const decoded = decodeAttestationPayload(encodeAttestationPayload(a));
    expect(typeof decoded.committed[TOKEN_A]).toBe('string');
    expect(decoded.committed[TOKEN_A]).toBe('1000000000000000000');
    expect(typeof decoded.lastBlock).toBe('string');
    expect(decoded.lastBlock).toBe('23800123');
  });

  it('identityAttributes() is a subset of deriveAttributes() sufficient to relocate the record', () => {
    const a = makeAttestation();
    const identity = identityAttributes(a);
    const full = deriveAttributes(a, a.attestedAt);
    for (const attr of identity) {
      expect(full).toContainEqual(attr);
    }
  });
});

describe('attest(): identity, expiry, and the full-replacement read-merge-write', () => {
  it('creates once then updates the same entity on refresh, never piling up duplicates', async () => {
    const { client, creates, updates, store } = createFakeArkivClient();
    const writer = createArkivWriter(FAKE_CONFIG, HEARTBEAT, { client, pollIntervalMs: 1 });

    const first = await writer.attest(makeAttestation({ attestedAt: 100 }));
    const second = await writer.attest(makeAttestation({ attestedAt: 200, underfunded: true }));

    expect(creates).toHaveLength(1);
    expect(updates).toHaveLength(1);
    expect(second.entityKey).toBe(first.entityKey);
    expect(store.size).toBe(1);
  });

  it(
    'a refresh preserves firstAttestedAt (a field the new write does not touch) while updating ' +
      'everything else — regression test for updateEntity being full replacement, not a patch',
    async () => {
      const { client } = createFakeArkivClient();
      const writer = createArkivWriter(FAKE_CONFIG, HEARTBEAT, { client, pollIntervalMs: 1 });

      const { entityKey } = await writer.attest(makeAttestation({ attestedAt: 100, underfunded: false }));
      await writer.attest(makeAttestation({ attestedAt: 200, underfunded: true }));
      await writer.attest(makeAttestation({ attestedAt: 300, underfunded: false }));

      const record = await client.getEntity(entityKey as Hex);
      expect(record).toBeDefined();
      const attrs = record?.attributes ?? [];
      // firstAttestedAt must still be the FIRST write's timestamp, not the latest one.
      expect(attrs.find((a) => a.key === ATTR.firstAttestedAt)?.value).toBe(100);
      // ...while the payload and the derived `underfunded` flag reflect the latest write. A naive
      // "rebuild attributes from `a` every time" implementation would pass this half and fail the
      // firstAttestedAt assertion above — that's the footgun this test exists to catch.
      const decoded = decodeAttestationPayload(record?.payload ?? new Uint8Array());
      expect(decoded.attestedAt).toBe(300);
      expect(attrs.find((a) => a.key === ATTR.underfunded)?.value).toBe('false');
    },
  );

  it('every write carries the configured short expiration date (create AND update)', async () => {
    const { client, creates, updates } = createFakeArkivClient();
    const writer = createArkivWriter(FAKE_CONFIG, HEARTBEAT, { client, pollIntervalMs: 1 });

    await writer.attest(makeAttestation({ attestedAt: 1 }));
    await writer.attest(makeAttestation({ attestedAt: 2 }));

    expect(creates[0]?.expiresInSeconds).toBe(HEARTBEAT.expirySeconds);
    expect(updates[0]?.expiresInSeconds).toBe(HEARTBEAT.expirySeconds);
  });

  it('polls after write and retries until the entity is queryable', async () => {
    const { client, getEntityCallCount } = createFakeArkivClient({ queryableAfterCalls: 3 });
    const writer = createArkivWriter(FAKE_CONFIG, HEARTBEAT, { client, pollIntervalMs: 1 });

    const { entityKey, queryableAfterMs } = await writer.attest(makeAttestation());

    expect(queryableAfterMs).toBeGreaterThanOrEqual(0);
    expect(getEntityCallCount.get(entityKey as Hex)).toBeGreaterThan(3);
  });

  it('throws a clear error if the entity never becomes queryable within the timeout', async () => {
    const { client } = createFakeArkivClient({ neverQueryable: true });
    const writer = createArkivWriter(FAKE_CONFIG, HEARTBEAT, {
      client,
      pollIntervalMs: 1,
      pollTimeoutMs: 20,
    });

    await expect(writer.attest(makeAttestation())).rejects.toThrow(AttestationNotQueryableError);
  });
});

describe(
  'heartbeat(): refreshes live strategies, never a docked one, and one failure does not abort the sweep',
  () => {
    it('refreshes every attestation it is given, tolerating individual failures', async () => {
      const { client } = createFakeArkivClient({
        failIdentity: (id) => id[ATTR.strategyHash] === '0xfails',
      });
      const onHeartbeatError = vi.fn();
      const writer = createArkivWriter(FAKE_CONFIG, HEARTBEAT, {
        client,
        pollIntervalMs: 1,
        onHeartbeatError,
      });

      const live = [
        makeAttestation({ strategyHash: '0xok-1' }),
        makeAttestation({ strategyHash: '0xfails' }),
        makeAttestation({ strategyHash: '0xok-2' }),
      ];

      const refreshed = await writer.heartbeat(live);

      expect(refreshed).toBe(2);
      expect(onHeartbeatError).toHaveBeenCalledTimes(1);
      expect(onHeartbeatError.mock.calls[0]?.[0]).toMatchObject({ strategyHash: '0xfails' });
    });

    it(
      'a strategy simply absent from the live list is never refreshed — that omission, not a ' +
        'delete, is what lets a docked strategy age out ("nobody vouching" rather than "closed")',
      async () => {
        const { client, creates, updates } = createFakeArkivClient();
        const writer = createArkivWriter(FAKE_CONFIG, HEARTBEAT, { client, pollIntervalMs: 1 });

        // Simulate: the strategy was live and attested once, then docked (the reducer's `live()`
        // stops including it), so the next heartbeat sweep is only given the strategies still live.
        const docked = makeAttestation({ strategyHash: '0xdocked-strategy' });
        await writer.attest(docked);
        const stillLive = makeAttestation({ strategyHash: '0xstill-live' });

        await writer.heartbeat([stillLive]);

        const dockedWrites = [...creates, ...updates].filter(
          (w) => identityMapOf(w.attributes)[ATTR.strategyHash] === '0xdocked-strategy',
        );
        // Exactly the one write from the initial attest() above — heartbeat() must not have
        // touched it again.
        expect(dockedWrites).toHaveLength(1);
      },
    );

    it('batches instead of firing unbounded parallel writes', async () => {
      const { client } = createFakeArkivClient();
      let concurrent = 0;
      let maxConcurrent = 0;
      const trackingClient: ArkivEntityClient = {
        ...client,
        async createEntity(input) {
          concurrent++;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          await new Promise((r) => setTimeout(r, 5));
          concurrent--;
          return client.createEntity(input);
        },
      };
      const writer = createArkivWriter(FAKE_CONFIG, HEARTBEAT, {
        client: trackingClient,
        pollIntervalMs: 1,
        heartbeatConcurrency: 2,
      });

      const live = Array.from({ length: 6 }, (_, i) =>
        makeAttestation({ strategyHash: `0xs-${i}` as Hex }),
      );
      await writer.heartbeat(live);

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });
  },
);

describe('createHeartbeatRunner', () => {
  it('tick() calls heartbeat() with whatever the supplier returns right now, and starts no timer', async () => {
    const { client } = createFakeArkivClient();
    const writer = createArkivWriter(FAKE_CONFIG, HEARTBEAT, { client, pollIntervalMs: 1 });
    let call = 0;
    const runner = createHeartbeatRunner(writer, () => {
      call++;
      return call === 1 ? [makeAttestation({ strategyHash: '0xa' })] : [];
    });

    const first = await runner.tick();
    const second = await runner.tick();

    expect(first.refreshed).toBe(1);
    // Second tick's supplier returns nothing live (e.g. the strategy docked between ticks) —
    // nothing gets refreshed, and nothing throws.
    expect(second.refreshed).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 — live Braga, opt-in only
// ---------------------------------------------------------------------------

describe.skipIf(process.env.RUN_LIVE !== '1')('live Braga round-trip', () => {
  it('writes a short-expiry entity, reads it back, then confirms it ages out once refreshing stops', async () => {
    const { loadArkivConfig } = await import('../src/config.js');
    const { createRealArkivEntityClient } = await import('../src/arkiv/client.js');
    const config = loadArkivConfig();
    const shortHeartbeat: HeartbeatConfig = { expirySeconds: 10, refreshSeconds: 4 };
    const client = createRealArkivEntityClient(config);
    const writer = createArkivWriter(config, shortHeartbeat, { client });

    const unique = `0x${Date.now().toString(16).padStart(64, '0')}` as Hex;
    const attestation = makeAttestation({ strategyHash: unique, attestedAt: Math.floor(Date.now() / 1000) });

    const { entityKey, queryableAfterMs } = await writer.attest(attestation);
    expect(queryableAfterMs).toBeGreaterThanOrEqual(0);

    const readBack = await client.getEntity(entityKey as Hex);
    expect(readBack).toBeDefined();
    const decoded = decodeAttestationPayload(readBack?.payload ?? new Uint8Array());
    expect(decoded.maker).toBe(attestation.maker);
    expect(decoded.strategyHash).toBe(attestation.strategyHash);

    // Stop refreshing and wait past the expiration date — the record should disappear on its own.
    await new Promise((r) => setTimeout(r, (shortHeartbeat.expirySeconds + 5) * 1000));
    const afterExpiry = await client.getEntity(entityKey as Hex);
    expect(afterExpiry).toBeUndefined();
  }, 60_000);
});
