/**
 * Per-log decoding: dispatch on `topics[0]` to the matching SDK event class, then normalise the
 * result at this boundary — the most important thing this module does.
 *
 * The SDK returns `Address`/`HexString` wrapper class instances, not strings (see
 * docs/SDK-SURFACE.md — this is called out as the single most likely source of bugs in this
 * repo). Every wrapper is converted to a lowercase `0x` string via `.toString().toLowerCase()`
 * right here, so nothing downstream of `src/ingest` ever sees a wrapper class or does `===` on
 * one.
 */
import { DockedEvent, PulledEvent, PushedEvent, ShippedEvent } from '@1inch/aqua-sdk';

import type { AquaEventKind, AquaEventRecord, Hex, Provenance, StrategyHash } from '../types.js';

/** Structural subset of viem's `Log` that the SDK's `fromLog` needs (`LogLike` in sdk-core). */
export interface DecodableLog {
  readonly data: Hex;
  readonly topics: readonly Hex[];
}

export type DecodeOutcome =
  | { readonly ok: true; readonly record: AquaEventRecord }
  | { readonly ok: false; readonly reason: string };

/** Normalise an SDK `Address`/`HexString` wrapper to a lowercase plain string. Never `===` a wrapper. */
function lowerHex(wrapped: { toString(): string }): Hex {
  return wrapped.toString().toLowerCase() as Hex;
}

/**
 * `fromLog`'s `LogLike` wants a non-empty topics tuple. We only call this once `topics[0]` has
 * already been confirmed present by the dispatch below, so this is a reshape, not a guess.
 */
function asFromLogInput(log: DecodableLog): { data: Hex; topics: [Hex, ...Hex[]] } {
  const [first, ...rest] = log.topics;
  if (first === undefined) {
    throw new Error('log has no topics');
  }
  return { data: log.data, topics: [first, ...rest] };
}

interface Decoder {
  readonly kind: AquaEventKind;
  /** Read via `.TOPIC.toString().toLowerCase()` — never hardcoded, per house rule. */
  readonly topic0: string;
  readonly toRecord: (log: DecodableLog, provenance: Provenance) => AquaEventRecord;
}

const DECODERS: readonly Decoder[] = [
  {
    kind: 'shipped',
    topic0: ShippedEvent.TOPIC.toString().toLowerCase(),
    toRecord: (log, provenance) => {
      const e = ShippedEvent.fromLog(asFromLogInput(log));
      return {
        kind: 'shipped',
        provenance,
        maker: lowerHex(e.maker),
        app: lowerHex(e.app),
        strategyHash: lowerHex(e.strategyHash) as StrategyHash,
        strategy: lowerHex(e.strategy),
      };
    },
  },
  {
    kind: 'docked',
    topic0: DockedEvent.TOPIC.toString().toLowerCase(),
    toRecord: (log, provenance) => {
      const e = DockedEvent.fromLog(asFromLogInput(log));
      return {
        kind: 'docked',
        provenance,
        maker: lowerHex(e.maker),
        app: lowerHex(e.app),
        strategyHash: lowerHex(e.strategyHash) as StrategyHash,
      };
    },
  },
  {
    kind: 'pulled',
    topic0: PulledEvent.TOPIC.toString().toLowerCase(),
    toRecord: (log, provenance) => {
      const e = PulledEvent.fromLog(asFromLogInput(log));
      return {
        kind: 'pulled',
        provenance,
        maker: lowerHex(e.maker),
        app: lowerHex(e.app),
        strategyHash: lowerHex(e.strategyHash) as StrategyHash,
        token: lowerHex(e.token),
        amount: e.amount,
      };
    },
  },
  {
    kind: 'pushed',
    topic0: PushedEvent.TOPIC.toString().toLowerCase(),
    toRecord: (log, provenance) => {
      const e = PushedEvent.fromLog(asFromLogInput(log));
      return {
        kind: 'pushed',
        provenance,
        maker: lowerHex(e.maker),
        app: lowerHex(e.app),
        strategyHash: lowerHex(e.strategyHash) as StrategyHash,
        token: lowerHex(e.token),
        amount: e.amount,
      };
    },
  },
];

/**
 * Decode one log, in isolation. `fromLog` throws on a shape mismatch, and a single bad log must
 * never take down a whole batch — every failure path here returns a result instead of throwing,
 * so the caller can count it and keep going.
 */
export function decodeLog(log: DecodableLog, provenance: Provenance): DecodeOutcome {
  const topic0 = log.topics[0];
  if (topic0 === undefined) {
    return { ok: false, reason: 'log has no topics' };
  }
  const lowerTopic0 = topic0.toLowerCase();
  const decoder = DECODERS.find((d) => d.topic0 === lowerTopic0);
  if (decoder === undefined) {
    return { ok: false, reason: `no Aqua decoder for topic0 ${lowerTopic0}` };
  }
  try {
    return { ok: true, record: decoder.toRecord(log, provenance) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `${decoder.kind} fromLog failed: ${message}` };
  }
}
