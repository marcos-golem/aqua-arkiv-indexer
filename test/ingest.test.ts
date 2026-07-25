import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAddress } from 'viem';
import type { AbiEvent } from 'viem';
import { ABI, Address as SdkAddress } from '@1inch/aqua-sdk';

import type { Hex, Provenance } from '../src/types.js';
import { chunkRanges, decodeLog, toRecords } from '../src/ingest/index.js';
import type { RawLog } from '../src/ingest/index.js';

// ---------------------------------------------------------------------------
// Fixtures — encoded for real via viem against ABI.AQUA_ABI, not hand-written guesses.
// ---------------------------------------------------------------------------

function eventAbi(name: string): AbiEvent {
  const item = ABI.AQUA_ABI.find((i) => i.type === 'event' && i.name === name) as
    | AbiEvent
    | undefined;
  if (item === undefined) throw new Error(`missing ${name} event in ABI`);
  return item;
}

/** Encode a real Aqua log: correct topic0 (from the ABI) and ABI-encoded non-indexed data. */
function buildLog(eventName: string, values: readonly unknown[]): { data: Hex; topics: Hex[] } {
  const abiItem = eventAbi(eventName);
  const topics = encodeEventTopics({ abi: [abiItem], eventName }) as Hex[];
  const data = encodeAbiParameters(abiItem.inputs, values as never) as Hex;
  return { data, topics };
}

function fixedProvenance(overrides: Partial<Provenance> = {}): Provenance {
  return {
    chainId: 1,
    blockNumber: 100n,
    blockHash: `0x${'aa'.repeat(32)}`,
    txHash: `0x${'bb'.repeat(32)}`,
    logIndex: 0,
    ...overrides,
  };
}

function rawLog(
  eventName: string,
  values: readonly unknown[],
  overrides: Partial<RawLog> = {},
): RawLog {
  const { data, topics } = buildLog(eventName, values);
  return {
    data,
    topics,
    blockNumber: 100n,
    blockHash: `0x${'aa'.repeat(32)}`,
    transactionHash: `0x${'bb'.repeat(32)}`,
    logIndex: 0,
    ...overrides,
  };
}

const MAKER = `0x${'abcdef1234'.repeat(4)}` as Hex; // has letters, so it can be checksummed
const APP = `0x${'22'.repeat(20)}` as Hex;
const TOKEN = `0x${'33'.repeat(20)}` as Hex;
const STRATEGY_HASH = `0x${'44'.repeat(32)}` as Hex;
const STRATEGY_BLOB = `0x${'deadbeef'}` as Hex;

describe('decodeLog — topic0 dispatch', () => {
  it('routes a Shipped log to the shipped decoder', () => {
    const log = buildLog('Shipped', [MAKER, APP, STRATEGY_HASH, STRATEGY_BLOB]);
    const outcome = decodeLog(log, fixedProvenance());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.kind).toBe('shipped');
    expect(outcome.record.maker).toBe(MAKER);
    expect(outcome.record.app).toBe(APP);
    expect(outcome.record.strategyHash).toBe(STRATEGY_HASH);
    if (outcome.record.kind === 'shipped') {
      expect(outcome.record.strategy).toBe(STRATEGY_BLOB);
    }
  });

  it('routes a Docked log to the docked decoder', () => {
    const log = buildLog('Docked', [MAKER, APP, STRATEGY_HASH]);
    const outcome = decodeLog(log, fixedProvenance());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.kind).toBe('docked');
    expect(outcome.record.maker).toBe(MAKER);
  });

  it('routes a Pulled log to the pulled decoder', () => {
    const log = buildLog('Pulled', [MAKER, APP, STRATEGY_HASH, TOKEN, 123456n]);
    const outcome = decodeLog(log, fixedProvenance());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.kind).toBe('pulled');
    if (outcome.record.kind === 'pulled') {
      expect(outcome.record.token).toBe(TOKEN);
      expect(outcome.record.amount).toBe(123456n);
    }
  });

  it('routes a Pushed log to the pushed decoder', () => {
    const log = buildLog('Pushed', [MAKER, APP, STRATEGY_HASH, TOKEN, 654321n]);
    const outcome = decodeLog(log, fixedProvenance());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.record.kind).toBe('pushed');
    if (outcome.record.kind === 'pushed') {
      expect(outcome.record.token).toBe(TOKEN);
      expect(outcome.record.amount).toBe(654321n);
    }
  });
});

describe('decodeLog — normalisation', () => {
  it('emits lowercase plain strings, never SDK wrapper instances, even for checksummed input', () => {
    // getAddress() produces a mixed-case EIP-55 checksummed string — the exact shape a wrapper
    // is most likely to leak through un-normalised.
    const checksummed = getAddress(MAKER);
    expect(checksummed).not.toBe(MAKER); // sanity: this really is mixed-case

    const log = buildLog('Shipped', [checksummed, APP, STRATEGY_HASH, STRATEGY_BLOB]);
    const outcome = decodeLog(log, fixedProvenance());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    expect(typeof outcome.record.maker).toBe('string');
    expect(outcome.record.maker).toBe(MAKER.toLowerCase());
    expect(outcome.record.maker).not.toBeInstanceOf(SdkAddress);
  });
});

describe('toRecords — provenance and pending-log handling', () => {
  it('attaches block/tx/log-index provenance from the raw log', () => {
    const log = rawLog('Docked', [MAKER, APP, STRATEGY_HASH], {
      blockNumber: 555n,
      logIndex: 7,
      blockHash: `0x${'cc'.repeat(32)}`,
      transactionHash: `0x${'dd'.repeat(32)}`,
    });
    const records = toRecords([log], 1);
    expect(records).toHaveLength(1);
    expect(records[0]?.provenance).toEqual({
      chainId: 1,
      blockNumber: 555n,
      logIndex: 7,
      blockHash: `0x${'cc'.repeat(32)}`,
      txHash: `0x${'dd'.repeat(32)}`,
    });
  });

  it('skips a pending log (null blockNumber) instead of coercing it', () => {
    const confirmed = rawLog('Docked', [MAKER, APP, STRATEGY_HASH], { logIndex: 0 });
    const pending = rawLog('Docked', [MAKER, APP, STRATEGY_HASH], {
      blockNumber: null,
      blockHash: null,
      transactionHash: null,
      logIndex: null,
    });
    const records = toRecords([confirmed, pending], 1);
    expect(records).toHaveLength(1);
  });
});

describe('toRecords — ordering', () => {
  it('sorts a shuffled batch into compareProvenance order', () => {
    const logs: RawLog[] = [
      rawLog('Docked', [MAKER, APP, STRATEGY_HASH], { blockNumber: 300n, logIndex: 2 }),
      rawLog('Docked', [MAKER, APP, STRATEGY_HASH], { blockNumber: 100n, logIndex: 5 }),
      rawLog('Docked', [MAKER, APP, STRATEGY_HASH], { blockNumber: 100n, logIndex: 1 }),
      rawLog('Docked', [MAKER, APP, STRATEGY_HASH], { blockNumber: 200n, logIndex: 0 }),
    ];
    const records = toRecords(logs, 1);
    const order = records.map((r) => [r.provenance.blockNumber, r.provenance.logIndex]);
    expect(order).toEqual([
      [100n, 1],
      [100n, 5],
      [200n, 0],
      [300n, 2],
    ]);
  });
});

describe('toRecords — malformed log isolation', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('isolates a malformed log and still emits the good ones in the same batch', () => {
    const good1 = rawLog('Docked', [MAKER, APP, STRATEGY_HASH], { logIndex: 0 });
    // Correct topic0 (so it dispatches to the Shipped decoder) but truncated data — fromLog
    // throws decoding this, which must not take the rest of the batch down with it.
    const malformed: RawLog = {
      data: '0x1234',
      topics: buildLog('Shipped', [MAKER, APP, STRATEGY_HASH, STRATEGY_BLOB]).topics,
      blockNumber: 100n,
      blockHash: `0x${'aa'.repeat(32)}`,
      transactionHash: `0x${'bb'.repeat(32)}`,
      logIndex: 1,
    };
    const good2 = rawLog('Docked', [MAKER, APP, STRATEGY_HASH], { logIndex: 2 });

    const records = toRecords([good1, malformed, good2], 1);

    expect(records).toHaveLength(2);
    expect(records.every((r) => r.kind === 'docked')).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('counts an unrecognised topic0 as a skip rather than throwing', () => {
    const unknown: RawLog = {
      data: '0x',
      topics: [`0x${'ff'.repeat(32)}`],
      blockNumber: 100n,
      blockHash: `0x${'aa'.repeat(32)}`,
      transactionHash: `0x${'bb'.repeat(32)}`,
      logIndex: 0,
    };
    expect(() => toRecords([unknown], 1)).not.toThrow();
    expect(toRecords([unknown], 1)).toHaveLength(0);
  });
});

describe('chunkRanges — chunk math', () => {
  it('covers the full range with no gaps and no overlap for an exact multiple', () => {
    const chunks = chunkRanges(0n, 5999n, 2000n);
    expect(chunks).toEqual([
      [0n, 1999n],
      [2000n, 3999n],
      [4000n, 5999n],
    ]);
  });

  it('covers the full range when it does not divide evenly', () => {
    const chunks = chunkRanges(0n, 4500n, 2000n);
    expect(chunks[chunks.length - 1]).toEqual([4000n, 4500n]);
    expect(chunks[0]).toEqual([0n, 1999n]);
  });

  it('handles a single-block range', () => {
    expect(chunkRanges(10n, 10n, 2000n)).toEqual([[10n, 10n]]);
  });

  it('returns no chunks when from > to', () => {
    expect(chunkRanges(50n, 10n, 2000n)).toEqual([]);
  });

  it('never double-counts or skips a block across chunk boundaries', () => {
    const from = 12_345n;
    const to = 98_765n;
    const size = 2_000n;
    const chunks = chunkRanges(from, to, size);

    expect(chunks[0]?.[0]).toBe(from);
    expect(chunks[chunks.length - 1]?.[1]).toBe(to);

    let totalBlocks = 0n;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (chunk === undefined) continue;
      const [start, end] = chunk;
      totalBlocks += end - start + 1n;
      const next = chunks[i + 1];
      if (next !== undefined) {
        expect(next[0]).toBe(end + 1n); // contiguous: no gap, no overlap
      }
    }
    expect(totalBlocks).toBe(to - from + 1n);
  });

  it('rejects a non-positive chunk size', () => {
    expect(() => chunkRanges(0n, 100n, 0n)).toThrow();
  });
});
