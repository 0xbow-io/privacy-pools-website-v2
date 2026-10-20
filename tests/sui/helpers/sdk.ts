/**
 * Loader for the protocol SDK (source of truth) by ABSOLUTE path.
 *
 * The website intentionally ports the crypto into `services/sui-witness` rather
 * than depending on the Node-oriented SDK at runtime. These tests fold in the
 * spirit of `scripts/sui-witness-crosscheck.mjs`: for the load-bearing values
 * (commitment, label, context, nullifier, GVK ciphertext, origHash) we assert
 * the PORTED browser module computes the SAME bigint the SDK does — so a field /
 * encoding drift in the port is caught here, not on-chain.
 *
 * If the SDK source is not present (e.g. the test is run outside the monorepo
 * checkout), the importing test should `describe.skipIf` on `SDK_AVAILABLE`.
 */
import { existsSync } from 'node:fs';

const SDK_DIR = '/Users/nh2/0xbow/ppv2-sui-v2-sync/sdk/src';

export const SDK_AVAILABLE = existsSync(`${SDK_DIR}/crypto.mjs`);

export async function loadSdkCrypto() {
  return import(`${SDK_DIR}/crypto.mjs`);
}
export async function loadSdkGvk() {
  return import(`${SDK_DIR}/global-view-key.mjs`);
}
export async function loadSdkMerkle() {
  return import(`${SDK_DIR}/merkle.mjs`);
}
export async function loadSdkRelay() {
  return import(`${SDK_DIR}/relay.mjs`);
}
export async function loadSdkSui() {
  return import(`${SDK_DIR}/sui.mjs`);
}
export async function loadSdkWitness() {
  return import(`${SDK_DIR}/witness.mjs`);
}
