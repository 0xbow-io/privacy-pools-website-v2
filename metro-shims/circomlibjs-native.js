// Native only (see metro.config.js). Hermes has no WebAssembly, and
// circomlibjs's buildPoseidon builds a WASM bn128 curve through ffjavascript,
// so on a phone it threw "Failed to initialize Poseidon hash service:
// undefined is not a function" the first time a session was built.
//
// buildPoseidon returns circomlib's Poseidon over BN254 from the Rust module
// (modules/native-poseidon) when this build has it and it passes the known
// answers, else poseidon-lite, the same function in plain BigInt. Either way
// the result is the field element itself, not the Montgomery form, so
// F.toObject is the identity (see poseidon-native.js). The tests in
// services/__tests__/native-poseidon-*.test.ts check both against circomlibjs.
const real = require('circomlibjs');
const lite = require('poseidon-lite');
const { createPoseidon, benchPoseidon } = require('./poseidon-native');

function loadNative() {
  try {
    return require('../modules/native-poseidon').default ?? null;
  } catch {
    return null;
  }
}

let built = null;

async function buildPoseidon() {
  if (!built) {
    const native = loadNative();
    built = createPoseidon({ native, lite });
    // Dev builds only: EXPO_PUBLIC_POSEIDON_BENCH=1 logs hashes per second.
    if (typeof __DEV__ !== 'undefined' && __DEV__ && process.env.EXPO_PUBLIC_POSEIDON_BENCH === '1') {
      setTimeout(() => {
        console.log('[poseidon]', built.backend, built.fallbackReason ?? '', JSON.stringify(benchPoseidon({ native, lite })));
      }, 3000);
    }
  }
  return built;
}

// The rest of circomlibjs that builds the same WASM curve cannot work on
// Hermes either. Only Sui's witness code uses BabyJub (services/sui-witness),
// and Sui is not offered in the mobile app, so fail with a clear reason
// instead of the WASM loader's "undefined is not a function".
const wasmOnly = (name) => async () => {
  throw new Error(`${name} needs WebAssembly, which the mobile app does not have. Sui private actions are not supported in the app yet.`);
};

module.exports = {
  ...real,
  buildPoseidon,
  buildBabyjub: wasmOnly('BabyJub'),
  buildEddsa: wasmOnly('EdDSA'),
  buildPedersenHash: wasmOnly('Pedersen hash'),
  buildMimc7: wasmOnly('MiMC7'),
  buildMimcSponge: wasmOnly('MiMC sponge'),
};
