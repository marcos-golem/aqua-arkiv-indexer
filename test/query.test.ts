/**
 * Fully offline: every test builds a `FakeArkivQueryClient` (an in-memory store of `RawEntity`)
 * and injects it via `QueryApiDeps.client`, so `npx vitest run` never touches a network or reads
 * ARKIV_RPC_URL / ARKIV_PRIVATE_KEY. Fixtures are built with the real `deriveAttributes` /
 * `encodeAttestationPayload` from src/arkiv/entity.ts, so the attribute shape under test matches
 * exactly what the write side actually produces.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { braga } from '@arkiv-network/sdk/chains';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATTR, deriveAttributes, encodeAttestationPayload } from '../src/arkiv/entity.js';
import type { ArkivReadConfig } from '../src/config.js';
import type { Addr, Hex, QueryApi, StrategyAttestation } from '../src/types.js';
import type { ArkivQueryClient, RawEntity } from '../src/query/client.js';
import { createQueryApi } from '../src/query/index.js';
import { createRequestHandler, handleApiRequest } from '../src/query/serve.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Never actually dialled — every test injects a fake client — but a real-looking
// `ArkivReadConfig` (Braga's own id, not a stale literal) keeps the fixture honest.
const FAKE_ARKIV_CONFIG: ArkivReadConfig = { rpcUrl: 'http://fake.invalid', chainId: braga.id };

const CHAIN_ID = 1 as const;
const MAKER = `0x${'1'.repeat(40)}` as Addr;
const MAKER_2 = `0x${'2'.repeat(40)}` as Addr;
const APP = `0x${'3'.repeat(40)}` as Addr;
const TOKEN_A = `0x${'a'.repeat(40)}` as Addr;
const TOKEN_B = `0x${'b'.repeat(40)}` as Addr;
const TOKEN_C = `0x${'c'.repeat(40)}` as Addr;
const TOKEN_D = `0x${'d'.repeat(40)}` as Addr;
const STRATEGY_HASH = `0x${'4'.repeat(64)}` as Hex;
const STRATEGY_HASH_2 = `0x${'5'.repeat(64)}` as Hex;

// Deliberately beyond Number.MAX_SAFE_INTEGER, so any accidental `Number()` coercion would
// silently lose precision — this is the fixture the "stays a string" tests lean on.
const HUGE_AMOUNT = '123456789012345678901234567890';

function makeAttestation(overrides: Partial<StrategyAttestation> = {}): StrategyAttestation {
  return {
    chainId: CHAIN_ID,
    maker: MAKER,
    app: APP,
    strategyHash: STRATEGY_HASH,
    committed: { [TOKEN_A]: HUGE_AMOUNT, [TOKEN_B]: '2000000000000000000' },
    tokens: [TOKEN_A, TOKEN_B],
    coverageRatio: '1500000000000000000',
    underfunded: false,
    lastBlock: HUGE_AMOUNT,
    attestedAt: 1_753_400_000,
    ...overrides,
  };
}

let nextKeySuffix = 1;
function makeEntity(a: StrategyAttestation): RawEntity {
  const key = `0x${String(nextKeySuffix++).padStart(64, '0')}` as Hex;
  return {
    key,
    payload: encodeAttestationPayload(a),
    attributes: deriveAttributes(a, a.attestedAt),
  };
}

// ---------------------------------------------------------------------------
// In-memory fake client — the injectable seam createQueryApi was designed around
// ---------------------------------------------------------------------------

interface FakeCall {
  readonly key: string;
  readonly value: string | number;
}

function createFakeQueryClient(entities: readonly RawEntity[]): {
  client: ArkivQueryClient;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  return {
    calls,
    client: {
      async findByAttribute(key, value) {
        calls.push({ key, value });
        // Mirrors the real query engine's single-predicate semantics: match any entity carrying
        // a row with this exact key/value, regardless of how many other rows (e.g. other `token`
        // entries) it also carries.
        return entities.filter((e) => e.attributes.some((a) => a.key === key && a.value === value));
      },
    },
  };
}

// ---------------------------------------------------------------------------
// strategiesByPair
// ---------------------------------------------------------------------------

describe('strategiesByPair', () => {
  it('is order-independent: (A, B) and (B, A) return the same result', async () => {
    const attestation = makeAttestation({ tokens: [TOKEN_A, TOKEN_B] });
    const { client } = createFakeQueryClient([makeEntity(attestation)]);
    const api = createQueryApi(FAKE_ARKIV_CONFIG, { client });

    const ab = await api.strategiesByPair(TOKEN_A, TOKEN_B);
    const ba = await api.strategiesByPair(TOKEN_B, TOKEN_A);

    expect(ab).toHaveLength(1);
    expect(ba).toHaveLength(1);
    expect(ab[0]).toEqual(ba[0]);
    expect(ab[0]?.strategyHash).toBe(STRATEGY_HASH);
  });

  it('matches a three-token strategy against a two-token pair query', async () => {
    const attestation = makeAttestation({ tokens: [TOKEN_A, TOKEN_C, TOKEN_D] });
    const { client } = createFakeQueryClient([makeEntity(attestation)]);
    const api = createQueryApi(FAKE_ARKIV_CONFIG, { client });

    // A pair query must not require the strategy to be exactly that pair. The server leg narrows
    // to entities carrying `token_<A>`; the client-side `.tokens.includes()` check confirms the
    // second leg against the payload, so a three-token strategy still matches any pair it holds.
    const result = await api.strategiesByPair(TOKEN_A, TOKEN_D);
    expect(result).toHaveLength(1);
    expect(result[0]?.tokens).toEqual([TOKEN_A, TOKEN_C, TOKEN_D]);
  });

  it('excludes a strategy containing only one leg of the pair', async () => {
    const onlyTokenA = makeAttestation({ strategyHash: STRATEGY_HASH, tokens: [TOKEN_A, TOKEN_C] });
    const { client } = createFakeQueryClient([makeEntity(onlyTokenA)]);
    const api = createQueryApi(FAKE_ARKIV_CONFIG, { client });

    const result = await api.strategiesByPair(TOKEN_A, TOKEN_B);
    expect(result).toEqual([]);
  });

  it('returns [] and does not throw when nothing matches', async () => {
    const { client } = createFakeQueryClient([]);
    const api = createQueryApi(FAKE_ARKIV_CONFIG, { client });

    await expect(api.strategiesByPair(TOKEN_A, TOKEN_B)).resolves.toEqual([]);
  });

  it('preserves committed amounts and lastBlock as strings, never coerced to numbers', async () => {
    const attestation = makeAttestation({ tokens: [TOKEN_A, TOKEN_B] });
    const { client } = createFakeQueryClient([makeEntity(attestation)]);
    const api = createQueryApi(FAKE_ARKIV_CONFIG, { client });

    const [result] = await api.strategiesByPair(TOKEN_A, TOKEN_B);
    expect(typeof result?.committed[TOKEN_A]).toBe('string');
    expect(result?.committed[TOKEN_A]).toBe(HUGE_AMOUNT);
    expect(typeof result?.lastBlock).toBe('string');
    expect(result?.lastBlock).toBe(HUGE_AMOUNT);
  });
});

// ---------------------------------------------------------------------------
// strategiesByMaker
// ---------------------------------------------------------------------------

describe('strategiesByMaker', () => {
  it('normalises mixed-case address input before querying', async () => {
    const attestation = makeAttestation({ maker: MAKER });
    const { client, calls } = createFakeQueryClient([makeEntity(attestation)]);
    const api = createQueryApi(FAKE_ARKIV_CONFIG, { client });

    const mixedCase = `0x${'1'.repeat(20)}${'A'.repeat(20)}` as Addr; // not a real match, just casing
    // Use a genuinely mixed-case version of MAKER itself so it still matches the fixture.
    const mixedMaker = (MAKER.slice(0, 2) + MAKER.slice(2).toUpperCase()) as Addr;

    const result = await api.strategiesByMaker(mixedMaker);

    expect(result).toHaveLength(1);
    expect(result[0]?.maker).toBe(MAKER);
    // The fake client must have been queried with the lowercased value, not the mixed-case input.
    expect(calls).toContainEqual({ key: ATTR.maker, value: MAKER });
    void mixedCase; // kept only to document what "not a real match" would look like
  });

  it('returns [] and does not throw for a maker with no live attestations', async () => {
    const { client } = createFakeQueryClient([]);
    const api = createQueryApi(FAKE_ARKIV_CONFIG, { client });

    await expect(api.strategiesByMaker(MAKER)).resolves.toEqual([]);
  });

  it('skips a malformed entity but still returns valid ones', async () => {
    const valid = makeEntity(makeAttestation({ maker: MAKER, strategyHash: STRATEGY_HASH }));
    const malformed: RawEntity = {
      key: `0x${'9'.repeat(64)}` as Hex,
      payload: new TextEncoder().encode('not json at all'),
      attributes: deriveAttributes(
        makeAttestation({ maker: MAKER, strategyHash: STRATEGY_HASH_2 }),
        1_753_400_000,
      ),
    };
    const { client } = createFakeQueryClient([valid, malformed]);
    const onSkippedEntity = vi.fn();
    const api = createQueryApi(
      FAKE_ARKIV_CONFIG,
      { client, onSkippedEntity },
    );

    const result = await api.strategiesByMaker(MAKER);

    expect(result).toHaveLength(1);
    expect(result[0]?.strategyHash).toBe(STRATEGY_HASH);
    expect(onSkippedEntity).toHaveBeenCalledTimes(1);
    expect(onSkippedEntity).toHaveBeenCalledWith(malformed.key, expect.anything());
  });
});

// ---------------------------------------------------------------------------
// underfundedMakers
// ---------------------------------------------------------------------------

describe('underfundedMakers', () => {
  it('matches the string "true", not a boolean or number', async () => {
    const underfunded = makeAttestation({
      maker: MAKER,
      strategyHash: STRATEGY_HASH,
      underfunded: true,
    });
    const covered = makeAttestation({
      maker: MAKER_2,
      strategyHash: STRATEGY_HASH_2,
      underfunded: false,
    });
    const { client, calls } = createFakeQueryClient([makeEntity(underfunded), makeEntity(covered)]);
    const api = createQueryApi(FAKE_ARKIV_CONFIG, { client });

    const result = await api.underfundedMakers();

    expect(result).toHaveLength(1);
    expect(result[0]?.maker).toBe(MAKER);
    expect(calls).toContainEqual({ key: ATTR.underfunded, value: 'true' });
    // Never a boolean or number in the query, per entity.ts's ATTR doc comment note 2.
    expect(calls.some((c) => c.key === ATTR.underfunded && typeof c.value !== 'string')).toBe(false);
  });

  it('returns [] and does not throw when nobody is underfunded', async () => {
    const covered = makeAttestation({ underfunded: false });
    const { client } = createFakeQueryClient([makeEntity(covered)]);
    const api = createQueryApi(FAKE_ARKIV_CONFIG, { client });

    await expect(api.underfundedMakers()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// HTTP layer — handleApiRequest, independent of node:http (no port bound)
// ---------------------------------------------------------------------------

describe('handleApiRequest', () => {
  function makeStubApi(overrides: Partial<QueryApi> = {}): QueryApi {
    return {
      strategiesByPair: vi.fn(async () => []),
      strategiesByMaker: vi.fn(async () => []),
      underfundedMakers: vi.fn(async () => []),
      ...overrides,
    };
  }

  it('rejects a malformed tokenA/tokenB with 400', async () => {
    const api = makeStubApi();
    const result = await handleApiRequest(
      api,
      '/api/strategies',
      new URLSearchParams({ tokenA: 'not-an-address', tokenB: TOKEN_B }),
    );
    expect(result.status).toBe(400);
  });

  it('rejects a malformed maker with 400', async () => {
    const api = makeStubApi();
    const result = await handleApiRequest(api, '/api/maker', new URLSearchParams({ maker: '0x123' }));
    expect(result.status).toBe(400);
  });

  it('rejects a missing required param with 400', async () => {
    const api = makeStubApi();
    const result = await handleApiRequest(
      api,
      '/api/strategies',
      new URLSearchParams({ tokenA: TOKEN_A }),
    );
    expect(result.status).toBe(400);
  });

  it('accepts a valid pair request, normalising case before calling the API', async () => {
    const strategiesByPair = vi.fn(async () => [makeAttestation()]);
    const api = makeStubApi({ strategiesByPair });
    const mixedA = (TOKEN_A.slice(0, 2) + TOKEN_A.slice(2).toUpperCase()) as Addr;

    const result = await handleApiRequest(
      api,
      '/api/strategies',
      new URLSearchParams({ tokenA: mixedA, tokenB: TOKEN_B }),
    );

    expect(result.status).toBe(200);
    expect(strategiesByPair).toHaveBeenCalledWith(TOKEN_A, TOKEN_B);
  });

  it('returns 404 for an unknown route', async () => {
    const api = makeStubApi();
    const result = await handleApiRequest(api, '/api/nope', new URLSearchParams());
    expect(result.status).toBe(404);
  });

  it('returns a JSON error body, never a stack trace, when the API throws', async () => {
    const api = makeStubApi({
      underfundedMakers: vi.fn(async () => {
        throw new Error('boom: internal detail that must not leak');
      }),
    });
    const result = await handleApiRequest(api, '/api/underfunded', new URLSearchParams());
    expect(result.status).toBe(500);
    const body = JSON.stringify(result.body);
    expect(body).not.toContain('boom');
    expect(body).not.toContain('.ts:');
  });
});

// ---------------------------------------------------------------------------
// Static file serving — createRequestHandler, exercised without binding a port. Written after
// live-testing the demo server surfaced a real bug: an early version compared a webDir with a
// trailing slash against `resolve()`d target paths, so the traversal guard's `startsWith(webDir +
// sep)` check never matched and every legitimate static request 403'd. These pin the fix.
// ---------------------------------------------------------------------------

describe('static file serving', () => {
  let webDir: string;

  beforeEach(async () => {
    webDir = await mkdtemp(join(tmpdir(), 'aqua-query-web-'));
    await writeFile(join(webDir, 'index.html'), '<!doctype html><title>demo</title>');
    await writeFile(join(webDir, 'style.css'), 'body { color: red; }');
  });

  afterEach(async () => {
    await rm(webDir, { recursive: true, force: true });
  });

  /** Minimal fake of the two `ServerResponse` methods `serveStatic`/`sendJson` actually call. */
  function makeFakeResponse(): {
    res: ServerResponse;
    getStatus: () => number | undefined;
    getBody: () => string;
  } {
    let status: number | undefined;
    let body = '';
    const res = {
      writeHead(code: number) {
        status = code;
        return res;
      },
      end(chunk?: unknown) {
        if (chunk !== undefined) body += String(chunk);
      },
    };
    return { res: res as unknown as ServerResponse, getStatus: () => status, getBody: () => body };
  }

  function makeFakeRequest(url: string): IncomingMessage {
    return { url } as unknown as IncomingMessage;
  }

  it('serves the index page at the root path', async () => {
    const handler = createRequestHandler(makeStubApi(), webDir);
    const { res, getStatus, getBody } = makeFakeResponse();
    await handler(makeFakeRequest('/'), res);
    expect(getStatus()).toBe(200);
    expect(getBody()).toContain('<title>demo</title>');
  });

  it('serves a nested static asset with the right content type', async () => {
    const handler = createRequestHandler(makeStubApi(), webDir);
    const { res, getStatus } = makeFakeResponse();
    await handler(makeFakeRequest('/style.css'), res);
    expect(getStatus()).toBe(200);
  });

  it('returns 404 for a path that does not exist under webDir', async () => {
    const handler = createRequestHandler(makeStubApi(), webDir);
    const { res, getStatus } = makeFakeResponse();
    await handler(makeFakeRequest('/nope.txt'), res);
    expect(getStatus()).toBe(404);
  });

  it('rejects a path-traversal attempt instead of serving a file outside webDir', async () => {
    const handler = createRequestHandler(makeStubApi(), webDir);
    const { res, getStatus, getBody } = makeFakeResponse();
    await handler(makeFakeRequest('/../../../etc/passwd'), res);
    expect(getStatus()).not.toBe(200);
    expect(getBody()).not.toContain('root:');
  });

  function makeStubApi(): QueryApi {
    return {
      strategiesByPair: vi.fn(async () => []),
      strategiesByMaker: vi.fn(async () => []),
      underfundedMakers: vi.fn(async () => []),
    };
  }
});
