/**
 * Attach provenance to a decoded event. The SDK's decoded event classes carry no block/tx info
 * (`LogLike` is only `{data, topics}`), so the ingestor supplies it here from the underlying
 * viem log.
 */
import type { Hex, Provenance, SupportedChainId } from '../types.js';
import type { DecodableLog } from './decode.js';

/**
 * What we need out of a viem log beyond `{data, topics}`. Typed nullable on purpose — viem
 * types these fields as non-null for a confirmed block range, but a pending/unconfirmed log (or
 * a stray RPC quirk) can still hand back `null`, and coercing that would fabricate provenance.
 */
export interface RawLog extends DecodableLog {
  readonly blockNumber: bigint | null;
  readonly blockHash: Hex | null;
  readonly transactionHash: Hex | null;
  readonly logIndex: number | null;
}

/**
 * Build provenance from a raw log, or `undefined` for one that should be skipped.
 *
 * `null` block/tx/log-index fields mean a pending, unconfirmed log. We never query the
 * `'pending'` block tag ourselves, so this should be rare — but trusting that instead of
 * checking would be exactly the kind of silent coercion that hands a downstream consumer a
 * phantom event after a reorg.
 */
export function provenanceFromLog(
  log: RawLog,
  chainId: SupportedChainId,
): Provenance | undefined {
  if (
    log.blockNumber === null ||
    log.blockHash === null ||
    log.transactionHash === null ||
    log.logIndex === null
  ) {
    return undefined;
  }
  return {
    chainId,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  };
}
