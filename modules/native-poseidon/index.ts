/**
 * circomlib's Poseidon over BN254 (1 to 16 inputs), in Rust on Android and iOS.
 *
 * App code does not call this directly: on native, metro.config.js routes
 * `circomlibjs` to metro-shims/circomlibjs-native.js, whose buildPoseidon()
 * uses this module when the build has it and poseidon-lite when it does not.
 *
 * Wire format: every field element is 64 lowercase-or-uppercase hex
 * characters (32 bytes big-endian, below the BN254 scalar modulus),
 * concatenated with no separator; results come back the same way.
 */
import { requireOptionalNativeModule } from 'expo-modules-core';

export type NativePoseidonModule = {
  /** One hash of inputsHex.length / 64 elements (1 to 16). */
  hash(inputsHex: string): string;
  /** inputsHex.length / (64 * arity) hashes, run back to back in one call. */
  hashBatch(arity: number, inputsHex: string): string;
  /** hashBatch off the JS thread. */
  hashBatchAsync(arity: number, inputsHex: string): Promise<string>;
};

/** null on web, and in a build made before this module existed. */
const NativePoseidon = requireOptionalNativeModule<NativePoseidonModule>('NativePoseidon');
export default NativePoseidon;
