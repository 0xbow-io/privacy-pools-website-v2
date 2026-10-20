/**
 * BN254 + circuit constants for Sui Privacy Pools witness construction.
 * Ported verbatim from the protocol SDK's `constants.mjs` (source of truth).
 * These values MUST match the on-chain contract + circuits or proofs fail.
 */

/** BN254 scalar field modulus (Fr) — circuit arithmetic field. */
export const SNARK_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** BN254 base field modulus (Fq) — curve coordinate field. */
export const BN254_BASE_FIELD =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// Circuit max depths — MUST match the compiled SuiTransact wrapper the web
// serves + the on-chain-registered VK. The deployed (tagged) transact circuits
// are SuiTransact(n, m, 22, 18, 18) (state 22, keystore 18, asp 18); the witness
// pads siblings to these, so a mismatched value overflows the circuit signal
// ("Too many values for input signal keystoreSiblings"). These equal the
// on-chain tree max sizes; the live testnet trees are far smaller, so proofs fit.
export const STATE_MAX_DEPTH = 22;
export const KEYSTORE_MAX_DEPTH = 18;
export const ASP_MAX_DEPTH = 18;

/**
 * State-tree leaf domain-separation tags (match v2-monorepo utils/Constants.sol +
 * Transact.circom). Commitment vs nullifier leaves use distinct tags (G1, v2-sync).
 */
export const COMMITMENT_LEAF_TAG =
  3791694183000795315792098099581407680958131641292811872617553086713867485913n;
export const NULLIFIER_LEAF_TAG =
  1480564842420020354887207755615370381236762558448265256256653429412951563031n;

/** Auth type for direct-key authorization. */
export const AUTH_TYPE_DIRECT_KEY = 0n;
