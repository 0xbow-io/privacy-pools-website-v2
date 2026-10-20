import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { buildPoseidon as buildWasmPoseidon } from 'circomlibjs';
import { buildConstants, buildVectors } from '../../modules/native-poseidon/scripts/poseidon-data';

type Hasher = ((inputs: (bigint | string | number)[]) => bigint) & {
  F: { toObject: (x: unknown) => bigint; e: (x: unknown) => bigint };
  hashBatch: (list: (bigint | string)[][]) => bigint[];
  hashBatchAsync: (list: (bigint | string)[][]) => Promise<bigint[]>;
  backend: 'native' | 'poseidon-lite';
  fallbackReason?: string;
};
type Native = {
  hash(hex: string): string;
  hashBatch(arity: number, hex: string): string;
  hashBatchAsync(arity: number, hex: string): Promise<string>;
};

/* eslint-disable @typescript-eslint/no-require-imports */
const impl = require('../../metro-shims/poseidon-native.js') as {
  createPoseidon: (deps: { native: Native | null; lite: unknown }) => Hasher;
  KNOWN_ANSWERS: string[];
  P: bigint;
};
const lite = require('poseidon-lite') as Record<string, (inputs: bigint[]) => bigint>;
/* eslint-enable @typescript-eslint/no-require-imports */

const crate = resolve(__dirname, '..', '..', 'modules', 'native-poseidon', 'rust');
const P = impl.P;

/**
 * Stands in for the Expo module with the wire format the Rust code enforces
 * (64 hex characters per element, below p, lowercase out). The Rust side is
 * held to circomlibjs by its own cargo test over rust/tests/vectors.json,
 * which the first test below proves is circomlibjs's output.
 */
function wireNative(calls: { hash: number; batch: number }): Native {
  const parse = (hex: string, arity: number) => {
    expect(hex.length % (64 * arity)).toBe(0);
    expect(hex).toMatch(/^[0-9a-f]*$/);
    const out: string[] = [];
    for (let at = 0; at < hex.length; at += 64 * arity) {
      const inputs = Array.from({ length: arity }, (_, i) => BigInt('0x' + hex.slice(at + i * 64, at + i * 64 + 64)));
      for (const x of inputs) expect(x < P).toBe(true);
      out.push(lite[`poseidon${arity}`](inputs).toString(16).padStart(64, '0'));
    }
    return out.join('');
  };
  return {
    hash: (hex) => { calls.hash++; return parse(hex, hex.length / 64); },
    hashBatch: (arity, hex) => { calls.batch++; return parse(hex, arity); },
    hashBatchAsync: async (arity, hex) => { calls.batch++; return parse(hex, arity); },
  };
}

describe('native Poseidon module data comes from circomlibjs', () => {
  test('rust/src/constants.bin is circomlibjs poseidon_constants_opt', () => {
    const committed = new Uint8Array(readFileSync(resolve(crate, 'src', 'constants.bin')));
    const fresh = buildConstants();
    expect(committed.length).toBe(fresh.length);
    expect(Buffer.from(committed).equals(Buffer.from(fresh))).toBe(true);
  });

  test('rust/tests/vectors.json is circomlibjs output for every arity 1..16', async () => {
    const committed = JSON.parse(readFileSync(resolve(crate, 'tests', 'vectors.json'), 'utf8'));
    const fresh = await buildVectors();
    expect(committed).toEqual(fresh);
    for (let n = 1; n <= 16; n++) expect(fresh.filter((v) => v.inputs.length === n).length).toBe(6);
  });

  test('the known answers checked at startup are circomlibjs poseidon([1..n])', async () => {
    const wasm = await buildWasmPoseidon();
    expect(impl.KNOWN_ANSWERS.length).toBe(16);
    for (let n = 1; n <= 16; n++) {
      const inputs = Array.from({ length: n }, (_, i) => BigInt(i + 1));
      expect(impl.KNOWN_ANSWERS[n - 1]).toBe(wasm.F.toObject(wasm(inputs)).toString(16).padStart(64, '0'));
    }
  });
});

describe('native shim path matches circomlibjs', () => {
  test('every arity 1..16, single and batch, including inputs outside [0, p)', async () => {
    const wasm = await buildWasmPoseidon();
    const calls = { hash: 0, batch: 0 };
    const poseidon = impl.createPoseidon({ native: wireNative(calls), lite });
    expect(poseidon.backend).toBe('native');
    let seed = 777n;
    const next = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 256n); return seed; };
    for (let n = 1; n <= 16; n++) {
      const list = [
        ...Array.from({ length: 3 }, () => Array.from({ length: n }, () => next() % P)),
        Array.from({ length: n }, (_, i) => (i % 2 ? P + BigInt(i) : -BigInt(i + 1))),
        Array.from({ length: n }, () => next()),
      ];
      const expected = list.map((inputs) => wasm.F.toObject(wasm(inputs)) as bigint);
      list.forEach((inputs, i) => expect(poseidon.F.toObject(poseidon(inputs))).toBe(expected[i]));
      expect(poseidon.hashBatch(list)).toEqual(expected);
      expect(await poseidon.hashBatchAsync(list)).toEqual(expected);
    }
    expect(calls.hash).toBeGreaterThan(16 * 5);
  });

  test('accepts what the SDK passes: 0x hex strings', async () => {
    const wasm = await buildWasmPoseidon();
    const poseidon = impl.createPoseidon({ native: wireNative({ hash: 0, batch: 0 }), lite });
    const inputs = ['0x01', '0x' + 'ab'.repeat(31)];
    expect(poseidon.F.toObject(poseidon(inputs))).toBe(wasm.F.toObject(wasm(inputs.map(BigInt))) as bigint);
  });

  test('a batch is one native call', () => {
    const calls = { hash: 0, batch: 0 };
    const poseidon = impl.createPoseidon({ native: wireNative(calls), lite });
    const before = { ...calls };
    expect(poseidon.hashBatch(Array.from({ length: 500 }, (_, i) => [BigInt(i), BigInt(i + 1)])).length).toBe(500);
    expect(calls.batch - before.batch).toBe(1);
    expect(calls.hash - before.hash).toBe(0);
    expect(poseidon.hashBatch([])).toEqual([]);
  });

  test('arity limits and mixed-arity batches throw like the lite path', () => {
    for (const native of [wireNative({ hash: 0, batch: 0 }), null]) {
      const poseidon = impl.createPoseidon({ native, lite });
      expect(() => poseidon([])).toThrow(/0 inputs are not supported/);
      expect(() => poseidon(Array.from({ length: 17 }, () => 1n))).toThrow(/17 inputs/);
      expect(() => poseidon.hashBatch([[1n], [1n, 2n]])).toThrow(/same number of inputs/);
    }
  });
});

// The real Rust code behind the same shim, when the host binary has been built
// (cargo build --release --example wire, which the native-poseidon workflow does).
// A plain conditional rather than describe.if: the app's bun:test typings do
// not model it.
const wire = resolve(crate, 'target', 'release', 'examples', 'wire');
const describeWire = existsSync(wire) ? describe : (_name: string, _fn: () => void) => {};
describeWire('native shim path over the real Rust code', () => {
  const run = (args: string[], hex: string) => {
    const proc = spawnSync(wire, args, { input: hex, encoding: 'utf8' });
    if (proc.status !== 0) throw new Error(proc.stderr);
    return proc.stdout;
  };
  const rust: Native = {
    hash: (hex) => run(['single'], hex),
    hashBatch: (arity, hex) => run(['batch', String(arity)], hex),
    hashBatchAsync: async (arity, hex) => run(['batch', String(arity)], hex),
  };

  test('every arity 1..16 agrees with circomlibjs, single and batch', async () => {
    const wasm = await buildWasmPoseidon();
    const poseidon = impl.createPoseidon({ native: rust, lite });
    expect(poseidon.backend).toBe('native');
    for (const v of await buildVectors()) {
      const inputs = v.inputs.map((x) => BigInt('0x' + x));
      expect(poseidon(inputs)).toBe(wasm.F.toObject(wasm(inputs)) as bigint);
    }
    let seed = 99n;
    const next = () => { seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 256n); return seed; };
    for (let n = 1; n <= 16; n++) {
      const list = Array.from({ length: 20 }, () => Array.from({ length: n }, () => next()));
      expect(poseidon.hashBatch(list)).toEqual(list.map((inputs) => wasm.F.toObject(wasm(inputs)) as bigint));
    }
  });
});

describe('falls back to poseidon-lite', () => {
  const pair = [1n, 2n];
  const expected = BigInt('0x' + '115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a');

  test('when the build has no native module', () => {
    const poseidon = impl.createPoseidon({ native: null, lite });
    expect(poseidon.backend).toBe('poseidon-lite');
    expect(poseidon(pair)).toBe(expected);
    expect(poseidon.hashBatch([pair, pair])).toEqual([expected, expected]);
  });

  test('when the native library fails to load', () => {
    const broken: Native = {
      hash: () => { throw new Error('UnsatisfiedLinkError: libnative_poseidon.so'); },
      hashBatch: () => { throw new Error('unreachable'); },
      hashBatchAsync: async () => { throw new Error('unreachable'); },
    };
    const poseidon = impl.createPoseidon({ native: broken, lite });
    expect(poseidon.backend).toBe('poseidon-lite');
    expect(poseidon.fallbackReason).toMatch(/UnsatisfiedLinkError/);
    expect(poseidon(pair)).toBe(expected);
  });

  test('when the native library gives a wrong hash for any arity', () => {
    const good = wireNative({ hash: 0, batch: 0 });
    const wrongAt16: Native = { ...good, hash: (hex) => (hex.length === 64 * 16 ? '00'.repeat(32) : good.hash(hex)) };
    const poseidon = impl.createPoseidon({ native: wrongAt16, lite });
    expect(poseidon.backend).toBe('poseidon-lite');
    expect(poseidon.fallbackReason).toBe('wrong hash for 16 inputs');
  });
});
