/**
 * Turns a page of raw logs into normalised, ordered `AquaEventRecord`s.
 *
 * Pulled out of `AquaIngestor` so it's testable without a network client: build fixture logs
 * (real ones, encoded via viem against `ABI.AQUA_ABI`), call `toRecords`, assert on the output.
 */
import { compareProvenance, type AquaEventRecord, type SupportedChainId } from '../types.js';
import { decodeLog } from './decode.js';
import { provenanceFromLog, type RawLog } from './provenance.js';

/**
 * Decode a page of logs into event records, ordered per {@link compareProvenance}.
 *
 * Two failure modes are handled without aborting the batch:
 *  - a pending/unconfirmed log (nullable viem fields) is skipped, never emitted.
 *  - a log whose shape doesn't match any Aqua event decoder is counted and surfaced via
 *    `console.warn`, but the rest of the batch still comes through.
 */
export function toRecords(logs: readonly RawLog[], chainId: SupportedChainId): AquaEventRecord[] {
  const records: AquaEventRecord[] = [];
  let skipped = 0;

  for (const log of logs) {
    const provenance = provenanceFromLog(log, chainId);
    if (provenance === undefined) continue; // pending/unconfirmed — never emit it

    const outcome = decodeLog(log, provenance);
    if (outcome.ok) {
      records.push(outcome.record);
    } else {
      skipped += 1;
      console.warn(
        `[ingest] skipped log at block ${provenance.blockNumber} idx ${provenance.logIndex}: ${outcome.reason}`,
      );
    }
  }

  if (skipped > 0) {
    console.warn(`[ingest] ${skipped} log(s) in this page failed to decode and were skipped`);
  }

  // Canonical order matters: downstream reduction drifts if this isn't sorted per-batch.
  records.sort((a, b) => compareProvenance(a.provenance, b.provenance));
  return records;
}
