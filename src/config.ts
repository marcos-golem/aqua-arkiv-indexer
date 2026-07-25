/**
 * Config resolution. The single place that reads `process.env`, so every other module is a
 * pure function of its arguments and testable without env juggling.
 */

import 'dotenv/config';
import { AQUA_CONTRACT_ADDRESSES } from '@1inch/aqua-sdk';
import { braga } from '@arkiv-network/sdk/chains';
import {
  arbitrum,
  avalanche,
  base,
  bsc,
  gnosis,
  linea,
  mainnet,
  optimism,
  polygon,
  sonic,
  unichain,
  zksync,
  type Chain,
} from 'viem/chains';
import {
  DEFAULT_HEARTBEAT,
  isSupportedChainId,
  type Addr,
  type ChainConfig,
  type HeartbeatConfig,
  type SupportedChainId,
} from './types.js';

/**
 * Approximate mainnet block Aqua went live in (launched 2025-11-17).
 *
 * Derived, not verified: head was 25,608,178 on 2026-07-25, ~250 days back at ~7200 blocks/day.
 * Starting too low only costs backfill time; starting too high silently misses strategies, so
 * this errs low on purpose. Pin it properly by binary-searching for the first `Shipped` log
 * once a keyed archive RPC is available.
 */
const MAINNET_LAUNCH_BLOCK = 23_800_000n;

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env.`);
  }
  return v;
}

function optionalBigInt(name: string, fallback: bigint): bigint {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  return BigInt(v);
}

function optionalInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`env ${name} is not an integer: ${v}`);
  return n;
}

/**
 * Aqua's address for a chain, from the SDK's own constant.
 *
 * Two SDK quirks handled here, which is why this is not a one-liner: the record carries a bogus
 * `"undefined"` key, and its values are `Address` wrapper instances rather than strings.
 */
export function aquaAddressFor(chainId: SupportedChainId): Addr {
  const record = AQUA_CONTRACT_ADDRESSES as unknown as Record<string, { toString(): string }>;
  const entry = record[String(chainId)];
  if (entry === undefined) {
    throw new Error(`Aqua SDK has no address for chain ${chainId}`);
  }
  const addr = entry.toString().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(addr)) {
    throw new Error(`Aqua SDK returned a malformed address for chain ${chainId}: ${addr}`);
  }
  return addr as Addr;
}

/**
 * viem `Chain` objects for every chain Aqua is deployed on, keyed by id.
 *
 * Needed because `reconcile` and the solvency reads batch through `multicall`, and viem resolves
 * multicall3's address from the client's `chain` — a client built without one throws
 * "multicallAddress is required" rather than falling back to individual reads. An anvil mainnet
 * fork reports chain 1 and inherits mainnet's multicall3 deployment, so this works there too.
 */
const VIEM_CHAINS: Readonly<Record<SupportedChainId, Chain>> = {
  1: mainnet,
  10: optimism,
  56: bsc,
  100: gnosis,
  130: unichain,
  137: polygon,
  146: sonic,
  324: zksync,
  8453: base,
  42161: arbitrum,
  43114: avalanche,
  59144: linea,
};

export function viemChainFor(chainId: SupportedChainId): Chain {
  return VIEM_CHAINS[chainId];
}

export function loadChainConfig(): ChainConfig {
  const rawChainId = optionalInt('CHAIN_ID', 1);
  if (!isSupportedChainId(rawChainId)) {
    throw new Error(`CHAIN_ID ${rawChainId} has no Aqua deployment.`);
  }
  return {
    chainId: rawChainId,
    rpcUrl: required('RPC_URL'),
    aquaAddress: aquaAddressFor(rawChainId),
    startBlock: optionalBigInt('START_BLOCK', rawChainId === 1 ? MAINNET_LAUNCH_BLOCK : 0n),
    logChunkSize: optionalBigInt('LOG_CHUNK_SIZE', 2_000n),
    confirmations: optionalBigInt('CONFIRMATIONS', 2n),
  };
}

export function loadHeartbeatConfig(): HeartbeatConfig {
  const cfg: HeartbeatConfig = {
    expirySeconds: optionalInt('HEARTBEAT_EXPIRY_SECONDS', DEFAULT_HEARTBEAT.expirySeconds),
    refreshSeconds: optionalInt('HEARTBEAT_REFRESH_SECONDS', DEFAULT_HEARTBEAT.refreshSeconds),
  };
  // A refresh period at or above half the expiration window makes attestations flicker in and
  // out of existence: one slow sweep and live strategies briefly read as "nobody vouching".
  if (cfg.refreshSeconds * 2 > cfg.expirySeconds) {
    throw new Error(
      `Heartbeat refresh (${cfg.refreshSeconds}s) must be well under half the expiration ` +
        `window (${cfg.expirySeconds}s), or attestations will flicker.`,
    );
  }
  return cfg;
}

export interface ArkivConfig {
  readonly rpcUrl: string;
  readonly privateKey: string;
  readonly chainId: number;
}

/** Everything needed to READ from Arkiv. Deliberately excludes the private key. */
export type ArkivReadConfig = Omit<ArkivConfig, 'privateKey'>;

/**
 * Read-only Arkiv config.
 *
 * Split from {@link loadArkivConfig} because queries genuinely don't need a signing key — Arkiv
 * reads are public. Requiring one would mean the read-only demo server couldn't start without a
 * funded key, which both blocks anyone who just wants to look and pushes people toward putting a
 * real key somewhere it isn't needed.
 */
export function loadArkivReadConfig(): ArkivReadConfig {
  const rpcUrl = process.env.ARKIV_RPC_URL;
  return {
    rpcUrl: rpcUrl === undefined || rpcUrl === '' ? braga.rpcUrls.default.http[0] : rpcUrl,
    chainId: optionalInt('ARKIV_CHAIN_ID', braga.id),
  };
}

/**
 * Defaults come from the SDK's own `braga` chain export rather than literals, so they cannot drift
 * from the network the SDK targets. (An earlier version of this file hardcoded chain id 393530,
 * which was simply wrong — Braga is 60138453102.)
 */
export function loadArkivConfig(): ArkivConfig {
  const rpcUrl = process.env.ARKIV_RPC_URL;
  return {
    rpcUrl: rpcUrl === undefined || rpcUrl === '' ? braga.rpcUrls.default.http[0] : rpcUrl,
    privateKey: required('ARKIV_PRIVATE_KEY'),
    chainId: optionalInt('ARKIV_CHAIN_ID', braga.id),
  };
}
