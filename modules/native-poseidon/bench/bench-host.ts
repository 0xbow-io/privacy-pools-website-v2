#!/usr/bin/env bun
// Host-side JS numbers (bun, JavaScriptCore; not Hermes): poseidon-lite and
// circomlibjs's WASM Poseidon in hashes per second, and what each wire format
// costs the JS side per field element (encode a bigint, decode a result).
//   bun modules/native-poseidon/bench/bench-host.ts
import { buildPoseidon } from 'circomlibjs';
import { poseidon1, poseidon2, poseidon3, poseidon4, poseidon8, poseidon16 } from 'poseidon-lite';

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

function rate(fn: () => number, minMs = 400): number {
  const start = performance.now();
  let n = 0;
  while (performance.now() - start < minMs) n += fn();
  return Math.round((n * 1000) / (performance.now() - start));
}

const lites: Record<number, (x: bigint[]) => bigint> = { 1: poseidon1, 2: poseidon2, 3: poseidon3, 4: poseidon4, 8: poseidon8, 16: poseidon16 };
const wasm = await buildPoseidon();

console.log('arity  poseidon-lite/s  circomlibjs-wasm/s');
for (const arity of [1, 2, 3, 4, 8, 16]) {
  const inputs = Array.from({ length: arity }, (_, i) => P - BigInt(i + 1));
  const lite = rate(() => (lites[arity](inputs), 1));
  const w = rate(() => (wasm.F.toObject(wasm(inputs)), 1));
  console.log(`${String(arity).padStart(5)}  ${String(lite).padStart(15)}  ${String(w).padStart(18)}`);
}

// Wire format, per element, 2000 elements per round.
const xs = Array.from({ length: 2000 }, (_, i) => (P - 1n) / BigInt(i + 2));
const ZEROS = '0'.repeat(64);
const hexOut = xs.map((x) => x.toString(16).padStart(64, '0')).join('');
const decOut = xs.map((x) => x.toString(10)).join(',');
const per = (fn: () => void) => rate(() => (fn(), xs.length));
const hexEncode = per(() => { let s = ''; for (const x of xs) { const h = x.toString(16); s += ZEROS.slice(h.length) + h; } return s; });
const decEncode = per(() => xs.map((x) => x.toString(10)).join(','));
const bytesEncode = per(() => {
  const out = new Uint8Array(xs.length * 32);
  xs.forEach((x, i) => { const h = x.toString(16).padStart(64, '0'); for (let j = 0; j < 32; j++) out[i * 32 + j] = parseInt(h.slice(2 * j, 2 * j + 2), 16); });
});
const hexDecode = per(() => { for (let i = 0; i < xs.length; i++) BigInt('0x' + hexOut.slice(i * 64, i * 64 + 64)); });
const decDecode = per(() => { for (const d of decOut.split(',')) BigInt(d); });
console.log('\nwire format, elements/s on the JS side');
console.log(`hex    encode ${hexEncode}  decode ${hexDecode}`);
console.log(`dec    encode ${decEncode}  decode ${decDecode}`);
console.log(`bytes  encode ${bytesEncode} (Uint8Array via hex, decode not measured)`);
