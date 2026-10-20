// The Poseidon that metro-shims/circomlibjs-native.js hands the SDK on the
// phone: the Rust module (modules/native-poseidon) when the build has it,
// poseidon-lite otherwise. Plain CommonJS so bun tests run it as Metro does.
//
// Same contract as circomlibjs's: poseidon(inputs) for 1 to 16 inputs, then
// poseidon.F.toObject(result). The result here is already the field element
// (a bigint), so F.toObject and F.e are BigInt.
//
// The native wire format is hex: each element 64 hex characters, concatenated.
// A bigint becomes hex with one toString(16), and parsing hex in Rust is a
// table lookup, where decimal would cost a bigint multiply per digit on both
// sides (modules/native-poseidon/bench/bench-host.ts).

const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const MAX_INPUTS = 16;
const ZEROS = '0'.repeat(64);

// circomlibjs's poseidon([1, 2, ..., n]) for n = 1..16. A build whose native
// library disagrees on any of them is not used: a wrong hash here is a wrong
// commitment, so the check runs before the first real hash, not after.
// services/__tests__/native-poseidon-module.test.ts recomputes these with
// circomlibjs.
const KNOWN_ANSWERS = [
  '29176100eaa962bdc1fe6c654d6a3c130e96a4d1168b33848b897dc502820133',
  '115cc0f5e7d690413df64c6b9662e9cf2a3617f2743245519e19607a4417189a',
  '0e7732d89e6939c0ff03d5e58dab6302f3230e269dc5b968f725df34ab36d732',
  '299c867db6c1fdd79dcefa40e4510b9837e60ebb1ce0663dbaa525df65250465',
  '0dab9449e4a1398a15224c0b15a49d598b2174d305a316c918125f8feeb123c0',
  '2d1a03850084442813c8ebf094dea47538490a68b05f2239134a4cca2f6302e1',
  '1c2f3482dbb140c4ebb9ada49abdbc374a9a85fcfc6533ec2e9df45b4921c318',
  '2921ab9bd0140cbc98e40395c0fefb40337a4d54fbbecd9a4d43b3d8d0c4d8d1',
  '1e0b893aa2ad802275e749d260330b7675b22bb3aaa4461d204af32e60cd9078',
  '0816126a09c29ecfcc0628461dacfb9459816fc60d6738b78db9ad07206fdc21',
  '07e5b070aa2dba008f30a6b785b6c5ae2429e211f71cacdbdae0e07fc05b47a8',
  '058814945232937db248a01e7cc55b3d681cc08702c8168494e856c1ef7693b5',
  '0f918939632fadca6456a2fe6e65a124828d4c3920d379cc744e90a666887806',
  '1278779aaafc5ca58bf573151005830cdb4683fb26591c85a7464d4f0e527776',
  '094ae33b67a845998abb55e917642d4022d078d96f7c36ea11da4273ecf20f50',
  '16159a551cbb66108281a48099fff949ae08afd7f1f2ec06de2ffb96b919b765',
];

/** A field element as 64 hex characters, reduced mod p as circomlibjs's F.e does. */
function hex64(x) {
  let v = typeof x === 'bigint' ? x : BigInt(x);
  if (v < 0n || v >= P) v = ((v % P) + P) % P;
  const h = v.toString(16);
  return h.length === 64 ? h : ZEROS.slice(h.length) + h;
}

function checkArity(n) {
  if (!(n >= 1 && n <= MAX_INPUTS)) throw new Error(`Poseidon: ${n} inputs are not supported (1 to 16)`);
}

function encodeBatch(inputsList) {
  const arity = inputsList[0].length;
  checkArity(arity);
  let s = '';
  for (const inputs of inputsList) {
    if (inputs.length !== arity) throw new Error('Poseidon batch: every hash must have the same number of inputs');
    for (let i = 0; i < arity; i++) s += hex64(inputs[i]);
  }
  return { arity, hex: s };
}

function decodeBatch(out, count) {
  if (out.length !== count * 64) throw new Error(`Poseidon batch: expected ${count} results, got ${out.length / 64}`);
  const results = new Array(count);
  for (let i = 0; i < count; i++) results[i] = BigInt('0x' + out.slice(i * 64, i * 64 + 64));
  return results;
}

/** Why `native` cannot be used, or null when it passes every known answer. */
function nativeProblem(native) {
  if (!native || typeof native.hash !== 'function' || typeof native.hashBatch !== 'function') return 'not in this build';
  try {
    let inputs = '';
    for (let n = 1; n <= MAX_INPUTS; n++) {
      inputs += hex64(BigInt(n));
      if (native.hash(inputs) !== KNOWN_ANSWERS[n - 1]) return `wrong hash for ${n} inputs`;
    }
    const pair = hex64(1n) + hex64(2n);
    if (native.hashBatch(2, pair + pair) !== KNOWN_ANSWERS[1] + KNOWN_ANSWERS[1]) return 'wrong batch hash';
    return null;
  } catch (error) {
    return `failed: ${error && error.message ? error.message : String(error)}`;
  }
}

function litePoseidon(lite) {
  const byArity = [];
  for (let n = 1; n <= MAX_INPUTS; n++) byArity[n] = lite[`poseidon${n}`];
  return (inputs) => {
    checkArity(inputs.length);
    return byArity[inputs.length](inputs.map((x) => BigInt(x)));
  };
}

/**
 * The poseidon function circomlibjs's buildPoseidon resolves to, plus
 * hashBatch / hashBatchAsync (many same-arity hashes in one native call),
 * `backend` ('native' or 'poseidon-lite') and, on fallback, `fallbackReason`.
 */
function createPoseidon({ native, lite }) {
  const problem = nativeProblem(native);
  let poseidon;
  if (problem === null) {
    poseidon = (inputs) => {
      const n = inputs.length;
      checkArity(n);
      let s = '';
      for (let i = 0; i < n; i++) s += hex64(inputs[i]);
      return BigInt('0x' + native.hash(s));
    };
    poseidon.hashBatch = (inputsList) => {
      if (inputsList.length === 0) return [];
      const { arity, hex } = encodeBatch(inputsList);
      return decodeBatch(native.hashBatch(arity, hex), inputsList.length);
    };
    poseidon.hashBatchAsync = async (inputsList) => {
      if (inputsList.length === 0) return [];
      const { arity, hex } = encodeBatch(inputsList);
      return decodeBatch(await native.hashBatchAsync(arity, hex), inputsList.length);
    };
    poseidon.backend = 'native';
  } else {
    const one = litePoseidon(lite);
    poseidon = (inputs) => one(inputs);
    poseidon.hashBatch = (inputsList) => inputsList.map((inputs) => {
      if (inputs.length !== inputsList[0].length) throw new Error('Poseidon batch: every hash must have the same number of inputs');
      return one(inputs);
    });
    poseidon.hashBatchAsync = async (inputsList) => poseidon.hashBatch(inputsList);
    poseidon.backend = 'poseidon-lite';
    poseidon.fallbackReason = problem;
  }
  poseidon.F = {
    toObject: (x) => BigInt(x),
    e: (x) => BigInt(x),
  };
  return poseidon;
}

function rate(fn, minMs) {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const start = now();
  let n = 0;
  while (now() - start < minMs) n += fn();
  return Math.round((n * 1000) / (now() - start));
}

/**
 * Hashes per second for 2 inputs (the Merkle pair): poseidon-lite, the native
 * module one call per hash, and the native module batched. Dev only, see
 * circomlibjs-native.js.
 */
function benchPoseidon({ native, lite, minMs = 500, batchSize = 2000 }) {
  const inputs = [123456789n, 987654321n];
  const pairs = Array.from({ length: batchSize }, (_, i) => [BigInt(i + 1), P - BigInt(i + 1)]);
  const result = { arity: 2, liteSingle: rate(() => (lite.poseidon2(inputs), 1), minMs) };
  if (nativeProblem(native) === null) {
    const fast = createPoseidon({ native, lite });
    result.nativeSingle = rate(() => (fast(inputs), 1), minMs);
    result.nativeBatch = rate(() => fast.hashBatch(pairs).length, minMs);
    // The bridge alone: the same batch with the encoding done once, outside.
    const { hex } = encodeBatch(pairs);
    result.nativeBatchPrencoded = rate(() => native.hashBatch(2, hex).length / 64, minMs);
  }
  return result;
}

module.exports = { createPoseidon, benchPoseidon, hex64, KNOWN_ANSWERS, P };
