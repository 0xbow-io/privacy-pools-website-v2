/**
 * Sui circuit artifact resolution for in-browser Groth16 proof generation.
 *
 * The circuit artifacts (wasm + proving key + verification key) are served
 * statically from `/artifacts/...` (Expo Metro serves the repo `public/`
 * directory at the web root). Layout, per circuit type:
 *
 *   /artifacts/<type>/<type>_js/<type>.wasm   circuit witness generator
 *   /artifacts/<type>/groth16_pkey.zkey       Groth16 proving key
 *   /artifacts/<type>/groth16_vkey.json       verification key (debug/verify)
 *
 * where <type> is "deposit", "ragequit", or "transact_NxM" (N inputs, M outputs).
 *
 * These were rebuilt for the v2-sync deployment at depths 22/18/18 with tagged
 * state-tree leaves; the on-chain verifying keys match these exact artifacts.
 *
 * NOTE (asset hosting): the artifact set is ~890 MB and is currently committed
 * under `public/artifacts/`. For a production web deploy, host these on a CDN /
 * object store and point CIRCUIT_ARTIFACT_BASE_URL at it via
 * EXPO_PUBLIC_SUI_ARTIFACT_BASE_URL instead of bundling them into the build.
 */

/**
 * Base URL where SUI circuit artifacts are hosted. Defaults to same-origin
 * /artifacts/sui — namespaced apart from the EVM circuits at /artifacts (the
 * Sui pool registers DIFFERENT transact VKs: tagged SuiTransact wrappers).
 */
export const CIRCUIT_ARTIFACT_BASE_URL =
  process.env.EXPO_PUBLIC_SUI_ARTIFACT_BASE_URL?.trim().replace(/\/+$/, '') || '/artifacts/sui';

export type SuiCircuitType = 'deposit' | 'ragequit' | 'transact';

export interface CircuitArtifactUrls {
  wasmUrl: string;
  zkeyUrl: string;
  vkeyUrl: string;
}

/**
 * Per-transact options selecting between the GVK (proof_type 1) and plain
 * (proof_type 3, PROOF_TYPE_TRANSACT_PLAIN) wrapper artifacts. The path is
 * chosen from the live `pool.gvk_enabled` flag (see hooks/use-sui-witness +
 * chain-reader.getGvkEnabled), NOT hardcoded.
 *
 * When `gvkEnabled` is false the plain wrapper is used: artifact dir
 * `transact_plain_NxM` (proves the same NxM transaction with an EMPTY ciphertext
 * and publicInputHash = origHash). When true (the default), the GVK wrapper
 * `transact_NxM` is used.
 *
 * NOTE (asset hosting): only the GVK `transact_NxM` artifacts are currently
 * committed under `public/artifacts/`. The `transact_plain_NxM` artifacts must
 * be hosted alongside them (same layout) before the plain path can prove in the
 * browser; until then the plain branch resolves a URL that 404s loudly rather
 * than silently producing a wrong-circuit proof.
 */
export interface SuiTransactArtifactOpts {
  n?: number;
  m?: number;
  /** Live pool.gvk_enabled flag; true => GVK wrapper, false => plain wrapper. */
  gvkEnabled?: boolean;
}

/**
 * Resolve artifact URLs for a circuit. For transact, N and M select the NxM
 * config and `gvkEnabled` selects the GVK vs plain wrapper.
 *
 * @param circuitType deposit | ragequit | transact
 * @param opts for transact: { n, m, gvkEnabled }
 */
export function getSuiCircuitUrls(
  circuitType: SuiCircuitType,
  opts?: SuiTransactArtifactOpts,
): CircuitArtifactUrls {
  const base = CIRCUIT_ARTIFACT_BASE_URL;

  let type: string;
  if (circuitType === 'transact') {
    const nm = requireNxM(opts?.n, opts?.m);
    // gvkEnabled defaults to true (the contract's default) when unspecified.
    type = opts?.gvkEnabled === false ? `transact_plain_${nm}` : `transact_${nm}`;
  } else {
    type = circuitType;
  }

  return {
    wasmUrl: `${base}/${type}/${type}_js/${type}.wasm`,
    zkeyUrl: `${base}/${type}/groth16_pkey.zkey`,
    vkeyUrl: `${base}/${type}/groth16_vkey.json`,
  };
}

/**
 * The transact configs whose artifacts actually ship with the app
 * (public/artifacts/sui). Note selection is capped to match
 * (services/sui-witness/note-selection.ts maxInputs default); keep the two in
 * lockstep when staging more transact_NxM artifact sets.
 */
export const SHIPPED_TRANSACT_CONFIGS = ['1x1', '1x2'] as const;

function requireNxM(n?: number, m?: number): string {
  if (n === undefined || m === undefined) {
    throw new Error('transact circuit requires n and m');
  }
  const nm = `${n}x${m}`;
  // Fail loudly client-side for configs whose artifacts are not staged —
  // resolving a URL that 404s at proving time is a far worse failure mode.
  if (!(SHIPPED_TRANSACT_CONFIGS as readonly string[]).includes(nm)) {
    throw new Error(
      `transact_${nm} circuit artifacts are not shipped (available: ${SHIPPED_TRANSACT_CONFIGS.join(', ')}). `
      + 'Reduce the input/output count or stage the artifact set under public/artifacts/sui.',
    );
  }
  return nm;
}
