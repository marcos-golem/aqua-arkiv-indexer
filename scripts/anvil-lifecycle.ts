/**
 * End-to-end local lifecycle harness — PRD §6 "End-to-end (local)".
 *
 * Drives a complete Aqua strategy lifecycle (`ship` → `pull` → `push` → `dock`) against the REAL
 * Aqua contract on an anvil mainnet fork, so the indexer has a live event stream to reduce
 * without needing mainnet funds. Aqua is mainnet-only — there is no testnet — so this fork is the
 * only way to exercise write paths.
 *
 * Two findings this script depends on, both verified empirically (see docs/SDK-SURFACE.md §4):
 *   1. `ship()` accepts a plain EOA as the `app`, so we do not need Aqua's own app contracts.
 *      That is what makes this harness possible at all.
 *   2. `ship()` emits `Shipped` plus one `Pushed` per token, so opening committed amounts are
 *      recoverable from events alone.
 *
 * Prerequisites:
 *   anvil --fork-url <MAINNET_RPC> --port 8545 --silent
 *   (cd contracts && forge build)
 *
 * Usage:
 *   pnpm lifecycle              # run the happy-path lifecycle
 *   pnpm lifecycle --underfund  # also drain the maker's wallet, for the solvency test
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  getAddress,
  http,
  parseEventLogs,
  type Abi,
  type Address as ViemAddress,
  type Hex as ViemHex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { ABI } from '@1inch/aqua-sdk';
import { aquaAddressFor } from '../src/config.js';

const RPC_URL = process.env.ANVIL_RPC_URL ?? 'http://127.0.0.1:8545';
const UNDERFUND = process.argv.includes('--underfund');

/**
 * anvil's deterministic dev accounts. These keys are published in anvil's own startup banner and
 * are worthless outside a local fork — they are safe to commit, and using them keeps the harness
 * reproducible. Never point this script at a real network.
 */
const MAKER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as const;
const APP_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;

const maker = privateKeyToAccount(MAKER_KEY);
/** The "app" is an EOA. Aqua does not require app code — verified on the fork. */
const app = privateKeyToAccount(APP_KEY);

const AQUA = getAddress(aquaAddressFor(1));

const COMMIT_T0 = 100_000_000_000_000_000_000n; // 100e18
const COMMIT_T1 = 200_000_000_000_000_000_000n; // 200e18
const PULL_T0 = 10_000_000_000_000_000_000n; //  10e18
const PUSH_T0 = 4_000_000_000_000_000_000n; //   4e18
const MINT = 1_000_000_000_000_000_000_000n; // 1000e18

const here = dirname(fileURLToPath(import.meta.url));

function loadMockErc20(): { abi: Abi; bytecode: ViemHex } {
  const path = join(here, '..', 'contracts', 'out', 'MockERC20.sol', 'MockERC20.json');
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(
      `MockERC20 artifact not found at ${path}.\nRun: (cd contracts && forge build)`,
    );
  }
  const artifact = JSON.parse(raw) as { abi: Abi; bytecode: { object: string } };
  const object = artifact.bytecode.object;
  return {
    abi: artifact.abi,
    bytecode: (object.startsWith('0x') ? object : `0x${object}`) as ViemHex,
  };
}

/**
 * Safety gate. A `--fork-url mainnet` anvil reports chainId **1**, exactly like real mainnet, so
 * the chain ID cannot tell them apart — and this script signs with publicly-known dev keys. Two
 * independent checks instead: the endpoint must be loopback, and the node must answer
 * `anvil_nodeInfo`, which real nodes do not implement.
 */
async function assertLocalAnvil(): Promise<number> {
  const host = new URL(RPC_URL).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `Refusing to run against non-loopback host "${host}". This script signs with published ` +
        `anvil dev keys and must never touch a real network.`,
    );
  }
  let body: { result?: unknown; error?: unknown };
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'anvil_nodeInfo', params: [] }),
    });
    body = (await res.json()) as { result?: unknown; error?: unknown };
  } catch (cause) {
    // Nothing listening is the common case (anvil not started, or it exited). Say so plainly
    // instead of letting a raw `fetch failed` TypeError surface.
    throw new Error(
      `Cannot reach ${RPC_URL} — is anvil running?\n` +
        `  anvil --fork-url <MAINNET_RPC> --port 8545 --silent\n` +
        `(underlying: ${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }
  if (body.result === undefined) {
    throw new Error(
      `${RPC_URL} did not answer anvil_nodeInfo, so it is not an anvil node. Refusing to run.\n` +
        `Start one with: anvil --fork-url <MAINNET_RPC> --port 8545 --silent`,
    );
  }
  const bare = createPublicClient({ transport: http(RPC_URL) });
  return bare.getChainId();
}

async function main(): Promise<void> {
  /*
   * Clients are built here, inside main(), rather than at module scope. Two reasons:
   *  - a top-level `await` on the safety gate would surface as an unhandled rejection and print a
   *    stack trace instead of the friendly "is anvil running?" message;
   *  - declaring them as module-level `let`s erases viem's generics (the bound account/chain), so
   *    every writeContract call loses its type inference.
   * Keeping them as local consts preserves both.
   */
  const observedChainId = await assertLocalAnvil();
  // A mainnet fork reports 1, a bare anvil 31337 — either is fine now we know it IS a local anvil.
  const chain = { ...foundry, id: observedChainId };
  const transport = http(RPC_URL);
  const publicClient = createPublicClient({ chain, transport });
  const makerClient = createWalletClient({ account: maker, chain, transport });
  const appClient = createWalletClient({ account: app, chain, transport });

  const confirm = async (hash: ViemHex, label: string): Promise<void> => {
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
      throw new Error(`${label} reverted (tx ${hash})`);
    }
    console.log(`  ${label} ✓  block ${receipt.blockNumber}`);
  };

  const deployToken = async (
    mock: { abi: Abi; bytecode: ViemHex },
    name: string,
    symbol: string,
  ): Promise<ViemAddress> => {
    const hash = await makerClient.deployContract({
      abi: mock.abi,
      bytecode: mock.bytecode,
      args: [name, symbol],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success' || receipt.contractAddress == null) {
      throw new Error(`deploy ${symbol} failed`);
    }
    console.log(`  deployed ${symbol} at ${receipt.contractAddress}`);
    return receipt.contractAddress;
  };

  const aquaCode = await publicClient.getCode({ address: AQUA });
  if (aquaCode === undefined || aquaCode === '0x') {
    throw new Error(
      `No Aqua code at ${AQUA} on this node. Start anvil with --fork-url pointed at mainnet.`,
    );
  }

  const startBlock = await publicClient.getBlockNumber();
  console.log(`Aqua ${AQUA} on fork at block ${startBlock}`);
  console.log(`maker ${maker.address}  app(EOA) ${app.address}\n`);

  const mock = loadMockErc20();
  console.log('1. deploy + fund tokens');
  const t0 = await deployToken(mock, 'TokenA', 'TKA');
  const t1 = await deployToken(mock, 'TokenB', 'TKB');

  for (const [token, symbol] of [
    [t0, 'TKA'],
    [t1, 'TKB'],
  ] as const) {
    await confirm(
      await makerClient.writeContract({
        address: token,
        abi: mock.abi,
        functionName: 'mint',
        args: [maker.address, MINT],
      }),
      `mint ${symbol} to maker`,
    );
    await confirm(
      await makerClient.writeContract({
        address: token,
        abi: mock.abi,
        functionName: 'approve',
        args: [AQUA, MINT],
      }),
      `maker approves Aqua for ${symbol}`,
    );
  }

  // `push` moves tokens from the app back into the maker's committed balance, so the app needs its
  // own approval to Aqua — not just the maker's.
  await confirm(
    await appClient.writeContract({
      address: t0,
      abi: mock.abi,
      functionName: 'approve',
      args: [AQUA, MINT],
    }),
    'app approves Aqua for TKA',
  );

  console.log('\n2. ship');
  // Opaque strategy blob — Aqua only hashes it, so any bytes work; real apps encode their params.
  // Derived from the freshly-deployed token addresses so every run gets a distinct strategyHash:
  // the hash is keccak256(strategy) alone, and Aqua rejects re-shipping a hash it has already seen
  // (`StrategiesMustBeImmutable`), so a fixed blob would make this script single-use per anvil.
  const strategy = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }],
    [t0, t1],
  );
  const shipHash = await makerClient.writeContract({
    address: AQUA,
    abi: ABI.AQUA_ABI,
    functionName: 'ship',
    args: [app.address, strategy, [t0, t1], [COMMIT_T0, COMMIT_T1]],
  });
  const shipReceipt = await publicClient.waitForTransactionReceipt({ hash: shipHash });
  if (shipReceipt.status !== 'success') throw new Error('ship reverted');

  // This is the finding that matters: one ship emits Shipped AND one Pushed per token.
  const shipLogs = parseEventLogs({ abi: ABI.AQUA_ABI, logs: shipReceipt.logs });
  const shipped = shipLogs.find((l) => l.eventName === 'Shipped');
  if (shipped === undefined) throw new Error('no Shipped event in ship receipt');
  const strategyHash = (shipped.args as { strategyHash: ViemHex }).strategyHash;
  console.log(`  ship ✓  block ${shipReceipt.blockNumber}`);
  console.log(`  strategyHash ${strategyHash}`);
  console.log(
    `  events emitted: ${shipLogs.map((l) => l.eventName).join(', ')} ` +
      `<- note the Pushed per token; that is where opening amounts come from`,
  );

  const readRaw = async (token: ViemAddress): Promise<readonly [bigint, number]> =>
    (await publicClient.readContract({
      address: AQUA,
      abi: ABI.AQUA_ABI,
      functionName: 'rawBalances',
      args: [maker.address, app.address, strategyHash, token],
    })) as readonly [bigint, number];

  const [afterShipT0, tokensCount] = await readRaw(t0);
  console.log(`  rawBalances(TKA) = ${afterShipT0} (tokensCount ${tokensCount})`);
  if (afterShipT0 !== COMMIT_T0) throw new Error(`expected ${COMMIT_T0}, got ${afterShipT0}`);

  console.log('\n3. pull (app takes tokens out)');
  await confirm(
    await appClient.writeContract({
      address: AQUA,
      abi: ABI.AQUA_ABI,
      functionName: 'pull',
      args: [maker.address, strategyHash, t0, PULL_T0, app.address],
    }),
    `pull ${PULL_T0} TKA`,
  );

  console.log('\n4. push (app returns tokens)');
  await confirm(
    await appClient.writeContract({
      address: AQUA,
      abi: ABI.AQUA_ABI,
      functionName: 'push',
      args: [maker.address, app.address, strategyHash, t0, PUSH_T0],
    }),
    `push ${PUSH_T0} TKA`,
  );

  // The whole reducer model in one assertion: Pulled subtracts, Pushed adds, against an absolute
  // committed balance. If this drifts, the fold in src/reduce is wrong.
  const expected = COMMIT_T0 - PULL_T0 + PUSH_T0;
  const [afterPushT0] = await readRaw(t0);
  console.log(`  rawBalances(TKA) = ${afterPushT0}, expected ${expected}`);
  if (afterPushT0 !== expected) {
    throw new Error(`committed balance drift: expected ${expected}, got ${afterPushT0}`);
  }

  if (UNDERFUND) {
    // Force the PRD's solvency scenario: commitments stay put, the wallet behind them empties.
    console.log('\n4b. drain maker wallet (--underfund)');
    const walletBalance = (await publicClient.readContract({
      address: t0,
      abi: mock.abi,
      functionName: 'balanceOf',
      args: [maker.address],
    })) as bigint;
    await confirm(
      await makerClient.writeContract({
        address: t0,
        abi: mock.abi,
        functionName: 'burn',
        args: [maker.address, walletBalance],
      }),
      `burn ${walletBalance} TKA from maker wallet`,
    );
    console.log('  maker now has live commitments with an empty wallet — solvency must flag this.');
    console.log(`\nStrategy left LIVE on purpose so the indexer can observe the underfunded state.`);
    console.log(summary(startBlock, t0, t1, strategyHash));
    return;
  }

  console.log('\n5. dock (maker closes all tokens)');
  await confirm(
    await makerClient.writeContract({
      address: AQUA,
      abi: ABI.AQUA_ABI,
      functionName: 'dock',
      args: [app.address, strategyHash, [t0, t1]],
    }),
    'dock',
  );

  const [afterDockT0, dockedCount] = await readRaw(t0);
  console.log(`  rawBalances(TKA) = ${afterDockT0} (tokensCount ${dockedCount})`);
  if (afterDockT0 !== 0n) throw new Error(`expected 0 after dock, got ${afterDockT0}`);
  // 255 is the docked sentinel — distinguishes "closed" from "never existed" (which reads 0, 0).
  if (dockedCount !== 255) {
    console.log(`  note: expected docked sentinel tokensCount 255, got ${dockedCount}`);
  }

  console.log(summary(startBlock, t0, t1, strategyHash));
}

function summary(
  startBlock: bigint,
  t0: ViemAddress,
  t1: ViemAddress,
  strategyHash: ViemHex,
): string {
  return [
    '',
    'Lifecycle complete. Point the indexer at this fork:',
    `  CHAIN_ID=1 RPC_URL=${RPC_URL} START_BLOCK=${startBlock} pnpm index`,
    '',
    `  strategyHash ${strategyHash}`,
    `  maker        ${maker.address}`,
    `  app (EOA)    ${app.address}`,
    `  TKA / TKB    ${t0} / ${t1}`,
  ].join('\n');
}

main().catch((err: unknown) => {
  console.error(`\nlifecycle failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
