/**
 * Public surface of the Arkiv attestation write layer. See the README's "mechanism mismatch"
 * section and the doc comments on `createArkivWriter` / `createHeartbeatRunner` for the
 * heartbeat-expiry semantics this module exists to implement.
 */

export { createArkivWriter, AttestationNotQueryableError, type ArkivWriterDeps } from './writer.js';
export {
  createHeartbeatRunner,
  type HeartbeatRunner,
  type LiveAttestationSupplier,
} from './runner.js';
export {
  createRealArkivEntityClient,
  type ArkivEntityClient,
  type EntityAttribute,
  type EntityRecord,
} from './client.js';
export { ATTR as ARKIV_ATTRIBUTE_KEYS } from './entity.js';
