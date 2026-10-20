/**
 * Browser-safe Sui Privacy Pools witness construction.
 *
 * Ported from the protocol SDK (ppv2-sui-v2-sync/sdk/src) — the pure-crypto
 * pieces needed to build circuit witnesses in the browser, without importing
 * Node-only SDK code. Field/encoding semantics are kept identical to the SDK so
 * the witnesses match the on-chain contract + circuits.
 *
 * Entry points:
 *   buildDepositWitness  -> deposit circuit inputs + derived commitment/context
 *   buildTransactWitness -> SuiTransact wrapper inputs + nullifiers/commitments/ciphertext
 *   buildRagequitWitness -> ragequit circuit inputs + nullifier/commitment
 */

export * from './constants';
export * from './crypto';
export * from './merkle';
export * from './global-view-key';
export * from './witness';
export * from './reconstruct';
export * as noteCrypto from './note-crypto';
