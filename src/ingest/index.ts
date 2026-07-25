/**
 * src/ingest — turns Aqua contract logs into normalised, ordered `AquaEventRecord`s.
 *
 * Chain-agnostic on purpose: the client is built from `ChainConfig.rpcUrl` alone, no `chain`
 * object, because `getLogs`/`getBlockNumber` don't need one.
 */
import { ABI } from '@1inch/aqua-sdk';
import { createPublicClient, http } from 'viem';
import type { AbiEvent } from 'viem';

import type { AquaEventRecord, ChainConfig, Ingestor } from '../types.js';
import { toRecords } from './batch.js';
import { chunkRanges } from './chunk.js';

const AQUA_EVENT_NAMES: ReadonlySet<string> = new Set(['Shipped', 'Docked', 'Pulled', 'Pushed']);

/**
 * Every Aqua event field is non-indexed (docs/SDK-SURFACE.md §2), so `topic0` is the only thing
 * `getLogs` can filter on, as an OR across the four event types.
 *
 * The installed viem (2.55.8) has no raw `topics` parameter on the public `getLogs` action —
 * confirmed by reading `node_modules/viem/_types/actions/public/getLogs.d.ts`, whose
 * `GetLogsParameters` only accepts `event`/`events`/`args`. Passing `events: AbiEvent[]` is the
 * type-safe equivalent: viem's own implementation (`_esm/actions/public/getLogs.js`) builds
 * `topics = [events.flatMap(event => encodeEventTopics(...))]`, i.e. exactly the nested-OR
 * topic0 filter, from this list. Pulling the fragments out of the SDK's own ABI (rather than
 * hand-building topic hex) keeps this from ever hardcoding a topic value.
 */
const AQUA_EVENTS = ABI.AQUA_ABI.filter(
  (item) => item.type === 'event' && AQUA_EVENT_NAMES.has(item.name),
) as readonly AbiEvent[];

/** Default poll interval for `watch()`, absent an explicit override. */
const DEFAULT_POLL_INTERVAL_MS = 4_000;

export interface IngestorOptions {
  /** How often `watch()` polls for new blocks, in ms. */
  readonly pollIntervalMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class AquaIngestor implements Ingestor {
  private readonly client: ReturnType<typeof createPublicClient>;
  private readonly config: ChainConfig;
  private readonly pollIntervalMs: number;

  constructor(config: ChainConfig, options: IngestorOptions = {}) {
    this.config = config;
    this.client = createPublicClient({ transport: http(config.rpcUrl) });
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  async head(): Promise<bigint> {
    return this.client.getBlockNumber();
  }

  /** Historical sweep over `[from, to]`, chunked to respect `ChainConfig.logChunkSize`. */
  async *backfill(from: bigint, to: bigint): AsyncIterable<AquaEventRecord[]> {
    for (const [start, end] of chunkRanges(from, to, this.config.logChunkSize)) {
      const logs = await this.client.getLogs({
        address: this.config.aquaAddress,
        events: AQUA_EVENTS,
        fromBlock: start,
        toBlock: end,
      });
      const batch = toRecords(logs, this.config.chainId);
      if (batch.length > 0) yield batch;
    }
  }

  /** Live tail from `from` onward, polling and respecting `ChainConfig.confirmations`. */
  async *watch(from: bigint): AsyncIterable<AquaEventRecord[]> {
    let nextBlock = from;
    for (;;) {
      const head = await this.client.getBlockNumber();
      // Confirmation lag: only `head - confirmations` is treated as final, so a reorg above
      // that line can never hand a downstream consumer an event that later disappears.
      if (head >= this.config.confirmations) {
        const safeHead = head - this.config.confirmations;
        if (safeHead >= nextBlock) {
          const logs = await this.client.getLogs({
            address: this.config.aquaAddress,
            events: AQUA_EVENTS,
            fromBlock: nextBlock,
            toBlock: safeHead,
          });
          const batch = toRecords(logs, this.config.chainId);
          if (batch.length > 0) yield batch;
          nextBlock = safeHead + 1n;
        }
      }
      await sleep(this.pollIntervalMs);
    }
  }
}

export function createIngestor(config: ChainConfig, options?: IngestorOptions): Ingestor {
  return new AquaIngestor(config, options);
}

// Exposed for focused, network-free unit testing of the pieces that make up the class above.
export { toRecords } from './batch.js';
export { chunkRanges } from './chunk.js';
export { decodeLog } from './decode.js';
export type { DecodableLog, DecodeOutcome } from './decode.js';
export type { RawLog } from './provenance.js';
export { provenanceFromLog } from './provenance.js';
