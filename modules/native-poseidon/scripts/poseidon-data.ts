// Shared by generate.ts and the bun test that checks the committed files.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { buildPoseidon } from 'circomlibjs';

const require = createRequire(import.meta.url);

export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const N_ROUNDS_F = 8;
export const N_ROUNDS_P = [56, 57, 56, 60, 60, 63, 64, 63, 60, 66, 60, 65, 70, 60, 64, 68];

type Opt = { C: string[][]; S: string[][]; M: string[][][]; P: string[][][] };

function loadOpt(): Opt {
  // The package's exports map hides src/, so walk from its main entry.
  const path = join(dirname(require.resolve('circomlibjs')), '..', 'src', 'poseidon_constants_opt.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Opt;
}

function le32(x: bigint): Uint8Array {
  if (x < 0n || x >= P) throw new Error(`constant out of field: ${x}`);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

/**
 * Layout, per t = 2..17 in order: C (t*8 + RP), S (RP*(2t-1)), M (t*t,
 * M[row][col] row-major), P (t*t). The Rust side derives the same offsets
 * from t and N_ROUNDS_P.
 */
export function buildConstants(): Uint8Array {
  const opt = loadOpt();
  const parts: Uint8Array[] = [];
  for (let i = 0; i < 16; i++) {
    const t = i + 2;
    const rp = N_ROUNDS_P[i];
    const c = opt.C[i], s = opt.S[i], m = opt.M[i], p = opt.P[i];
    if (c.length !== t * N_ROUNDS_F + rp) throw new Error(`C[${i}] has ${c.length}`);
    if (s.length !== rp * (2 * t - 1)) throw new Error(`S[${i}] has ${s.length}`);
    if (m.length !== t || p.length !== t) throw new Error(`M/P[${i}] not ${t} rows`);
    for (const x of c) parts.push(le32(BigInt(x)));
    for (const x of s) parts.push(le32(BigInt(x)));
    for (const row of m) { if (row.length !== t) throw new Error('M row'); for (const x of row) parts.push(le32(BigInt(x))); }
    for (const row of p) { if (row.length !== t) throw new Error('P row'); for (const x of row) parts.push(le32(BigInt(x))); }
  }
  const out = new Uint8Array(parts.length * 32);
  parts.forEach((part, i) => out.set(part, i * 32));
  return out;
}

export type Vector = { inputs: string[]; output: string };

export const hex64 = (x: bigint) => x.toString(16).padStart(64, '0');

/** Fixed inputs for every arity, hashed by circomlibjs's own WASM Poseidon. */
export async function buildVectors(): Promise<Vector[]> {
  const poseidon = await buildPoseidon();
  let seed = 0x0b0e_2026n;
  const next = () => {
    seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 256n);
    return seed % P;
  };
  const vectors: Vector[] = [];
  for (let n = 1; n <= 16; n++) {
    const sets: bigint[][] = [
      Array.from({ length: n }, (_, i) => BigInt(i + 1)),
      Array.from({ length: n }, () => 0n),
      Array.from({ length: n }, () => P - 1n),
      ...Array.from({ length: 3 }, () => Array.from({ length: n }, () => next())),
    ];
    for (const inputs of sets) {
      const output = poseidon.F.toObject(poseidon(inputs));
      vectors.push({ inputs: inputs.map(hex64), output: hex64(output) });
    }
  }
  return vectors;
}
