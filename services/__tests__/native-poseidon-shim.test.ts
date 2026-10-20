import { describe, expect, test } from 'bun:test';
import { buildPoseidon as buildWasmPoseidon } from 'circomlibjs';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const shim = require('../../metro-shims/circomlibjs-native.js') as {
  buildPoseidon: () => Promise<((inputs: bigint[]) => unknown) & { F: { toObject: (x: unknown) => bigint } }>;
};

// The native shim must give the SDK exactly what circomlibjs gives it on the
// web: poseidonInstance(inputs) then F.toObject(result).
describe('native Poseidon shim matches circomlibjs', () => {
  test('every arity the SDK can call, 1 to 16 inputs', async () => {
    const wasm = await buildWasmPoseidon();
    const lite = await shim.buildPoseidon();
    let seed = 12345n;
    const next = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (2n ** 250n); return seed; };
    for (let n = 1; n <= 16; n++) {
      for (let round = 0; round < 3; round++) {
        const inputs = Array.from({ length: n }, () => next());
        const expected = wasm.F.toObject(wasm(inputs)) as bigint;
        expect(lite.F.toObject(lite(inputs))).toBe(expected);
      }
    }
  });

  test('hashes with no WebAssembly at all, as on Hermes', async () => {
    // Without this, a shim that quietly fell back to circomlibjs would still
    // pass here, because bun has WebAssembly and the phone does not.
    const wasm = await buildWasmPoseidon();
    const expected = wasm.F.toObject(wasm([1n, 2n])) as bigint;
    const saved = globalThis.WebAssembly;
    // @ts-expect-error simulate Hermes
    delete globalThis.WebAssembly;
    try {
      expect(typeof globalThis.WebAssembly).toBe('undefined');
      const lite = await shim.buildPoseidon();
      expect(lite.F.toObject(lite([1n, 2n]))).toBe(expected);
    } finally {
      globalThis.WebAssembly = saved;
    }
  });

  test('zero and small inputs', async () => {
    const wasm = await buildWasmPoseidon();
    const lite = await shim.buildPoseidon();
    for (const inputs of [[0n], [1n, 2n], [0n, 0n, 0n]]) {
      expect(lite.F.toObject(lite(inputs))).toBe(wasm.F.toObject(wasm(inputs)) as bigint);
    }
  });

  test('WASM-only builders fail with a clear reason on the phone', async () => {
    const s = shim as unknown as Record<string, () => Promise<unknown>>;
    await expect(s.buildBabyjub()).rejects.toThrow(/WebAssembly/);
  });

  test('re-exports the rest of circomlibjs', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const real = require('circomlibjs') as Record<string, unknown>;
    expect(Object.keys(shim).sort()).toEqual(Object.keys(real).sort());
  });
});
