/**
 * The interval-drivable piece the orchestrator (src/main.ts, owned by another agent) wires up.
 * This module starts no timer of its own — `tick()` runs one heartbeat sweep and returns; the
 * caller decides the cadence (typically `heartbeat.refreshSeconds` from src/config.ts) and calls
 * it on its own `setInterval` or event-loop equivalent.
 */

import type { AttestationWriter, StrategyAttestation } from '../types.js';

export type LiveAttestationSupplier = () =>
  | readonly StrategyAttestation[]
  | Promise<readonly StrategyAttestation[]>;

export interface HeartbeatRunner {
  /** The writer this runner drives. Exposed so the orchestrator can also call `attest()` directly
   * for one-off writes (e.g. right after observing a new `Shipped` event) using the same
   * underlying Arkiv client, rather than constructing a second one. */
  readonly writer: AttestationWriter;
  /** Runs one heartbeat sweep over whatever `supplyLive` currently reports and returns the
   * refreshed count. Call this on your own interval. */
  tick(): Promise<{ refreshed: number }>;
}

/**
 * @param writer - An {@link AttestationWriter}, typically from `createArkivWriter`.
 * @param supplyLive - Returns the strategies to refresh *right now*. Called fresh on every
 *   `tick()` — nothing here caches a snapshot, so a strategy that docks between ticks is simply
 *   absent from the next call's list and stops being refreshed (see writer.ts's `heartbeat` doc
 *   comment for why that omission is the correct close signal).
 */
export function createHeartbeatRunner(
  writer: AttestationWriter,
  supplyLive: LiveAttestationSupplier,
): HeartbeatRunner {
  return {
    writer,
    async tick() {
      const live = await supplyLive();
      const refreshed = await writer.heartbeat(live);
      return { refreshed };
    },
  };
}
