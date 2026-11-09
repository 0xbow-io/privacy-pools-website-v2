// Prove the Sepolia journeys with the keys the Sepolia verifiers actually hold.
//
// public/artifacts carries the ceremony keys the production verifiers were
// deployed with (since 2026-10-20). The Sepolia pool still runs the verifiers
// from the earlier, pre-ceremony setup, so every proof the app makes from
// public/artifacts is rejected there (deposit: PoolVault_InvalidDepositProof,
// 0x08bf478d) and the whole e2e-sepolia suite fails before anything is spent.
//
// This script runs in CI before the app starts. For every circuit it reads the
// verifier the Sepolia pool routes to, compares its bytecode with the checked-out
// verification key and with the pinned pre-ceremony one
// (fixtures/sepolia-circuits.json), and swaps the pinned zkey + vkey into
// public/artifacts only where the chain holds the pinned key. When Sepolia's
// verifiers are redeployed with the ceremony keys the script finds nothing to
// swap and the suite runs on the checked-out files unchanged.
//
// E2E only. It edits the CI runner's working copy, nothing in the app reads the
// fixture, and no build or env flag reaches it (sepolia-circuits.test.ts).
// Every file is checked against its pinned sha256 before it is used.
//
//   bun scripts/e2e/sepolia-circuits.ts           swap where needed
//   bun scripts/e2e/sepolia-circuits.ts --check   report only, change nothing
//
// Locally the swap leaves public/artifacts modified; `git checkout -- public/artifacts`
// restores it.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, encodeAbiParameters, http, keccak256, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { DEPLOYMENTS } from '@privacy-pools-v2/sdk';
import { rpcUrl } from './funding';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
export const FIXTURE_PATH = join(ROOT, 'scripts/e2e/fixtures/sepolia-circuits.json');
const ARTIFACTS = join(ROOT, 'public/artifacts');
// Outside the checkout by default: Metro crawls the project root.
const CACHE = (process.env.E2E_CIRCUITS_CACHE || '~/.cache/e2e-sepolia-circuits').replace(/^~(?=\/)/, homedir());

type Pinned = { cid: string; sha256: string; size?: number };
export type CircuitsFixture = {
  chainId: number;
  gateways: string[];
  circuits: Record<string, { provingKey: Pinned; verificationKey: Pinned }>;
};

type Vkey = { vk_delta_2: string[][]; IC: string[][] };

/**
 * Pure: the field elements that tell two Groth16 setups of one circuit apart, as
 * minimal big-endian hex. alpha/beta/gamma come from the shared powers of tau and
 * are the same in both setups; delta and the IC points are per setup. Leading zero
 * bytes are dropped because solc pushes a constant with the fewest bytes it can.
 */
export function setupElements(vk: Vkey): string[] {
  const values = [...vk.vk_delta_2[0]!, ...vk.vk_delta_2[1]!, ...vk.IC.flatMap((point) => [point[0]!, point[1]!])];
  return values.map((value) => {
    let hex = BigInt(value).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    return hex;
  });
}

/** Pure: how many of a key's setup elements a verifier's bytecode embeds. */
export function bytecodeHolds(vk: Vkey, code: string): { found: number; total: number } {
  const haystack = code.toLowerCase();
  const elements = setupElements(vk);
  return { found: elements.filter((hex) => haystack.includes(hex)).length, total: elements.length };
}

export type KeySet = 'checked-out' | 'pinned' | 'unknown';

/** Pure: which key a verifier was deployed with. All elements of one and none of the other. */
export function classifyVerifier(code: string, checkedOut: Vkey, pinned: Vkey): KeySet {
  const current = bytecodeHolds(checkedOut, code);
  const old = bytecodeHolds(pinned, code);
  if (current.found === current.total && old.found === 0) return 'checked-out';
  if (old.found === old.total && current.found === 0) return 'pinned';
  return 'unknown';
}

/** Pure: the router key TransactVerifierRouter stores a transact_NxM verifier under. */
export function transactRouterKey(n: number, m: number): Hex {
  return keccak256(encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }], [BigInt(n), BigInt(m)]));
}

const POOL_ABI = [
  { type: 'function', name: 'depositVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'ragequitVerifier', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function', name: 'verifiers', stateMutability: 'view', inputs: [{ type: 'bytes32' }],
    outputs: [{ type: 'tuple', components: [{ name: 'addr', type: 'address' }, { name: 'selector', type: 'bytes4' }] }],
  },
] as const;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

async function fetchPinned(gateways: string[], pinned: Pinned, label: string): Promise<Uint8Array> {
  const errors: string[] = [];
  for (const gateway of gateways) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(`${gateway}/${pinned.cid}`, { redirect: 'follow', signal: AbortSignal.timeout(180_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const bytes = new Uint8Array(await res.arrayBuffer());
        const digest = sha256(bytes);
        if (digest !== pinned.sha256) throw new Error(`sha256 ${digest} != pinned ${pinned.sha256}`);
        return bytes;
      } catch (error) {
        errors.push(`${gateway} #${attempt}: ${(error as Error).message}`);
        await new Promise((resolve) => setTimeout(resolve, 2_000 * attempt));
      }
    }
  }
  throw new Error(`${label} (${pinned.cid}) could not be fetched:\n  ${errors.join('\n  ')}`);
}

/** The pinned file from the cache, fetched (and cached) when missing or wrong. */
async function cached(fixture: CircuitsFixture, pinned: Pinned, label: string): Promise<string> {
  mkdirSync(CACHE, { recursive: true });
  const path = join(CACHE, pinned.sha256);
  if (existsSync(path) && sha256(readFileSync(path)) === pinned.sha256) return path;
  const bytes = await fetchPinned(fixture.gateways, pinned, label);
  writeFileSync(`${path}.part`, bytes);
  renameSync(`${path}.part`, path);
  return path;
}

async function main() {
  const checkOnly = process.argv.includes('--check');
  const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as CircuitsFixture;
  const pool = DEPLOYMENTS[fixture.chainId]?.poolAddress as Address | undefined;
  if (!pool) throw new Error(`the SDK has no pool deployment for chain ${fixture.chainId}`);
  const client = createPublicClient({ chain: sepolia, transport: http(rpcUrl()) });

  const verifierOf = async (circuit: string): Promise<Address> => {
    if (circuit === 'deposit') return client.readContract({ address: pool, abi: POOL_ABI, functionName: 'depositVerifier' });
    if (circuit === 'ragequit') return client.readContract({ address: pool, abi: POOL_ABI, functionName: 'ragequitVerifier' });
    const shape = circuit.match(/^transact_(\d+)x(\d+)$/);
    if (!shape) throw new Error(`unknown circuit ${circuit}`);
    const route = await client.readContract({
      address: pool, abi: POOL_ABI, functionName: 'verifiers', args: [transactRouterKey(Number(shape[1]), Number(shape[2]))],
    });
    return route.addr;
  };

  const swaps: string[] = [];
  const unknown: string[] = [];
  for (const [circuit, pinned] of Object.entries(fixture.circuits)) {
    const verifier = await verifierOf(circuit);
    const code = await client.getCode({ address: verifier });
    if (!code || code === '0x') throw new Error(`${circuit}: no code at verifier ${verifier}`);
    const checkedOut = JSON.parse(readFileSync(join(ARTIFACTS, circuit, 'groth16_vkey.json'), 'utf8')) as Vkey;
    const pinnedVk = JSON.parse(readFileSync(await cached(fixture, pinned.verificationKey, `${circuit} vkey`), 'utf8')) as Vkey;
    const keySet = classifyVerifier(code, checkedOut, pinnedVk);
    console.log(`${circuit.padEnd(13)} ${verifier} holds the ${keySet} key`);
    if (keySet === 'pinned') swaps.push(circuit);
    if (keySet === 'unknown') unknown.push(circuit);
  }

  if (unknown.length) {
    throw new Error(
      `Sepolia verifiers hold neither the checked-out nor the pinned key for: ${unknown.join(', ')}. ` +
      'Pin the keys they were deployed with in scripts/e2e/fixtures/sepolia-circuits.json.',
    );
  }
  if (!swaps.length) {
    console.log('Sepolia verifies with the checked-out keys: nothing to swap.');
    return;
  }
  if (checkOnly) {
    console.log(`--check: would swap ${swaps.length} circuits to the pinned keys.`);
    return;
  }
  for (const circuit of swaps) {
    const { provingKey, verificationKey } = fixture.circuits[circuit]!;
    copyFileSync(await cached(fixture, provingKey, `${circuit} zkey`), join(ARTIFACTS, circuit, 'groth16_pkey.zkey'));
    copyFileSync(await cached(fixture, verificationKey, `${circuit} vkey`), join(ARTIFACTS, circuit, 'groth16_vkey.json'));
  }
  console.log(`Swapped ${swaps.length} circuits to the keys Sepolia verifies with: ${swaps.join(', ')}`);
}

// Bun sets import.meta.main for the entry module; the test imports this file without running it.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
