/**
 * The attestation write layer: `attest()` (write-or-refresh one strategy) and `heartbeat()`
 * (refresh every still-live strategy). See src/types.ts's `AttestationWriter` doc comment and
 * the README's "mechanism mismatch" section for the semantics this implements — the
 * short version, repeated here because it's easy to get backwards while reading the code below:
 *
 *   Aqua strategies close on an EVENT (`dock()`). Arkiv entities expire on a CLOCK. Every
 *   attestation this module writes carries a short expiration date (`heartbeat.expirySeconds`,
 *   validated by `loadHeartbeatConfig` to be well over double the refresh period) and must be
 *   refreshed while the strategy is still observed live. If refreshing stops, the record ages out
 *   on its own — that means "nobody is currently vouching for this", NOT "the strategy closed".
 *   A stale quote is worse than no quote, so this design fails toward silence.
 */

import type { Hex } from 'viem';
import type { ArkivConfig } from '../config.js';
import type { AttestationWriter, HeartbeatConfig, StrategyAttestation } from '../types.js';
import type { ArkivEntityClient, EntityRecord } from './client.js';
import { createRealArkivEntityClient } from './client.js';
import {
  CONTENT_TYPE,
  ATTR,
  decodeAttestationPayload,
  deriveAttributes,
  encodeAttestationPayload,
  findAttributeValue,
  identityAttributes,
} from './entity.js';

export class AttestationNotQueryableError extends Error {
  constructor(entityKey: Hex, timeoutMs: number) {
    super(
      `Arkiv entity ${entityKey} did not become queryable within ${timeoutMs}ms of the write. ` +
        `The write itself succeeded (a tx hash was returned) — this only means readers can't see ` +
        `it yet. Measured on Braga: submit->queryable ~4.5s, mined->queryable ~40ms, so a ` +
        `long-running timeout past a few seconds usually points at an RPC/network problem rather ` +
        `than expected propagation lag.`,
    );
    this.name = 'AttestationNotQueryableError';
  }
}

export interface ArkivWriterDeps {
  /** Injectable seam for tests. Defaults to a real Braga-connected client built from `config`. */
  readonly client?: ArkivEntityClient;
  /** Max time to poll for post-write queryability before throwing. Default 15s — well over the
   * ~4.5s worst case measured on Braga. */
  readonly pollTimeoutMs?: number;
  /** Delay between poll attempts. */
  readonly pollIntervalMs?: number;
  /** How many attest() calls a heartbeat sweep runs concurrently. Bounds request fan-out instead
   * of firing one call per live strategy at once. */
  readonly heartbeatConcurrency?: number;
  /** heartbeat() never lets one failing refresh abort the sweep (see below) — failures are
   * surfaced here instead of thrown, since the interface pins the return type to a plain count.
   * Defaults to logging to console.error. */
  readonly onHeartbeatError?: (a: StrategyAttestation, error: unknown) => void;
  /** Clock seam for tests. */
  readonly now?: () => number;
}

const DEFAULT_POLL_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_HEARTBEAT_CONCURRENCY = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createArkivWriter(
  config: ArkivConfig,
  heartbeat: HeartbeatConfig,
  deps: ArkivWriterDeps = {},
): AttestationWriter {
  const client = deps.client ?? createRealArkivEntityClient(config);
  const pollTimeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const concurrency = deps.heartbeatConcurrency ?? DEFAULT_HEARTBEAT_CONCURRENCY;
  const now = deps.now ?? (() => Date.now());
  const onHeartbeatError =
    deps.onHeartbeatError ??
    ((a: StrategyAttestation, error: unknown) => {
      console.error(
        `[arkiv] heartbeat refresh failed for ${a.maker}:${a.app}:${a.strategyHash}`,
        error,
      );
    });

  /**
   * The "read" of read-merge-write: find the entity this attestation already owns, if any, by
   * its identity attributes (an Arkiv entity key is chain-assigned, not chosen by us, so identity
   * has to be enforced this way — see entity.ts). More than one match is pathological (e.g. a
   * create retried after a timed-out first attempt) but not impossible; we deterministically pick
   * the one with the newest `attestedAt` in its own payload, since that's data we wrote and trust,
   * rather than relying on chain metadata this narrowed client interface doesn't carry.
   */
  async function findExisting(a: StrategyAttestation): Promise<EntityRecord | undefined> {
    const matches = await client.findByAttributes(identityAttributes(a));
    if (matches.length === 0) return undefined;
    return matches.reduce((newest, candidate) => {
      const newestAt = decodeAttestationPayload(newest.payload).attestedAt;
      const candidateAt = decodeAttestationPayload(candidate.payload).attestedAt;
      return candidateAt > newestAt ? candidate : newest;
    });
  }

  /**
   * Writes are not instantly self-visible (measured on Braga: submit->queryable ~4.5s). Poll
   * `getEntity` until the entity we just wrote — specifically THIS write, identified by its fresh
   * `attestedAt`, not just any version of the entity — is readable, or give up with a clear error.
   * Matching on `attestedAt` matters for updates: without it, a poll could observe the
   * pre-update version during the write's visibility window and report success prematurely.
   */
  async function pollUntilQueryable(entityKey: Hex, expected: StrategyAttestation): Promise<number> {
    const start = now();
    for (;;) {
      const record = await client.getEntity(entityKey);
      if (record !== undefined && decodeAttestationPayload(record.payload).attestedAt === expected.attestedAt) {
        return now() - start;
      }
      if (now() - start >= pollTimeoutMs) {
        throw new AttestationNotQueryableError(entityKey, pollTimeoutMs);
      }
      await sleep(pollIntervalMs);
    }
  }

  async function attest(
    a: StrategyAttestation,
  ): Promise<{ entityKey: string; queryableAfterMs: number }> {
    const existing = await findExisting(a);

    // The "merge" of read-merge-write: `firstAttestedAt` is the one attribute this call must NOT
    // recompute from `a`. On a fresh strategy it starts at this attestation's own timestamp; on a
    // refresh it must be carried forward from the entity we just read. Skipping this read — i.e.
    // deriving every attribute fresh from `a` on every call, which is the natural-looking but
    // wrong implementation — is exactly the full-replacement footgun `updateEntity` invites:
    // it takes no diff, so anything not explicitly carried forward is silently gone.
    const firstAttestedAt = existing
      ? Number(findAttributeValue(existing.attributes, ATTR.firstAttestedAt) ?? a.attestedAt)
      : a.attestedAt;

    const { entityKey } = existing
      ? await client.updateEntity({
          entityKey: existing.key,
          payload: encodeAttestationPayload(a),
          attributes: deriveAttributes(a, firstAttestedAt),
          contentType: CONTENT_TYPE,
          expiresInSeconds: heartbeat.expirySeconds,
        })
      : await client.createEntity({
          payload: encodeAttestationPayload(a),
          attributes: deriveAttributes(a, firstAttestedAt),
          contentType: CONTENT_TYPE,
          expiresInSeconds: heartbeat.expirySeconds,
        });

    const queryableAfterMs = await pollUntilQueryable(entityKey, a);
    return { entityKey, queryableAfterMs };
  }

  async function runHeartbeat(live: readonly StrategyAttestation[]): Promise<number> {
    // This function only ever sees the strategies its caller currently considers live (see the
    // `AttestationWriter.heartbeat` doc comment in src/types.ts). There is deliberately no
    // "is this docked?" check here: a docked strategy simply stops being included in `live` on
    // the caller's next reduce pass, this function stops refreshing its entity, and the entity's
    // own short expiration date does the rest. That silence — not an explicit delete — IS the
    // close signal this whole design exists to produce. Adding a docked-check here would be
    // reintroducing the event/clock mismatch this module exists to bridge.
    let refreshed = 0;
    for (let i = 0; i < live.length; i += concurrency) {
      const batch = live.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map((a) => attest(a)));
      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const a = batch[j];
        if (result === undefined || a === undefined) continue;
        // One strategy failing to refresh must not abort the sweep — every other live strategy
        // still gets its chance this tick. Failures are surfaced via the error hook, not thrown,
        // and excluded from the returned count.
        if (result.status === 'fulfilled') {
          refreshed++;
        } else {
          onHeartbeatError(a, result.reason);
        }
      }
    }
    return refreshed;
  }

  return { attest, heartbeat: runHeartbeat };
}
