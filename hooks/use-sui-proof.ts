import { loadGroth16 } from '@/services/crypto-runtime';
/**
 * In-browser Groth16 proof generation for the Sui chain.
 *
 * Loads circuit artifacts (wasm + zkey) over fetch from the statically-hosted
 * `/artifacts` directory and runs snarkjs.groth16.fullProve entirely in the
 * browser. snarkjs/ffjavascript are dynamically imported so they are not pulled
 * into the page-load bundle (matching the lazy-load pattern in use-transfer.ts).
 *
 * The raw snarkjs `proof` + `publicSignals` are encoded to the Arkworks BN254
 * byte layout the Sui `sui::groth16` verifier expects via `proofToSuiBytes`
 * (provided by the SDK). For deposit/ragequit the publicSignals are passed as
 * plain Move args by the caller; for transact the wrapper circuit emits a single
 * `publicInputHash` and the proof binds all NxM signals internally (INTL-05).
 *
 * Usage:
 *   const { generateProof, status } = useSuiProof();
 *   const { proofBytes, publicSignals } = await generateProof('deposit', inputs);
 *   // ...then pass proofBytes into useSuiDeposit().deposit({ ... })
 */
import { useState, useCallback } from 'react';
import { getSuiCircuitUrls, type SuiCircuitType } from '@/config/sui-circuits';

// Lazy-loaded to avoid pulling snarkjs/ffjavascript at page load.
const getSnarkjs = loadGroth16;

export type SuiProofStatus = 'idle' | 'loading_artifacts' | 'proving' | 'success' | 'error';

/** snarkjs Groth16 proof object (G1/G2 points as decimal-string coordinates). */
export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
  curve: string;
}

export interface SuiProofResult {
  /** Arkworks-encoded proof bytes accepted by sui::groth16 (proofToSuiBytes). */
  proofBytes: Uint8Array;
  /** Raw snarkjs proof object. */
  proof: Groth16Proof;
  /** Public signals as decimal strings. */
  publicSignals: string[];
}

interface UseSuiProofReturn {
  status: SuiProofStatus;
  error: string | null;
  /**
   * Generate a proof for a Sui circuit.
   * @param circuitType deposit | ragequit | transact
   * @param inputs circuit input signals (all values as decimal strings)
   * @param nm for transact: { n, m, gvkEnabled } selecting the NxM + GVK/plain config
   */
  generateProof: (
    circuitType: SuiCircuitType,
    inputs: Record<string, unknown>,
    nm?: { n: number; m: number; gvkEnabled?: boolean },
  ) => Promise<SuiProofResult>;
  reset: () => void;
}

async function fetchArrayBuffer(url: string, label: string): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to fetch ${label} (${url}): ${resp.status} ${resp.statusText}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

export function useSuiProof(): UseSuiProofReturn {
  const [status, setStatus] = useState<SuiProofStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const generateProof = useCallback(
    async (
      circuitType: SuiCircuitType,
      inputs: Record<string, unknown>,
      nm?: { n: number; m: number; gvkEnabled?: boolean },
    ): Promise<SuiProofResult> => {
      try {
        setError(null);
        setStatus('loading_artifacts');

        const { wasmUrl, zkeyUrl } = getSuiCircuitUrls(circuitType, nm);
        const [wasm, zkey] = await Promise.all([
          fetchArrayBuffer(wasmUrl, 'circuit wasm'),
          fetchArrayBuffer(zkeyUrl, 'proving key'),
        ]);

        setStatus('proving');
        const snarkjs = await getSnarkjs();
        const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasm, zkey);

        // [PROOFDEBUG] off-chain self-verify to isolate proof-gen vs contract-input mismatch.
        try {
          const vkeyUrl = zkeyUrl.replace('groth16_pkey.zkey', 'groth16_vkey.json');
          const vkey = await (await fetch(vkeyUrl)).json();
          const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof);
          console.log('[PROOFDEBUG] circuit=' + circuitType + ' offchain_verify=' + ok + ' nPublic=' + publicSignals.length + ' signals=' + JSON.stringify(publicSignals));
          console.log('[PROOFDEBUG] inputKeys=' + JSON.stringify(Object.keys(inputs)));
        } catch (e: any) { console.log('[PROOFDEBUG] verify err', e?.message); }

        // Encode to the Arkworks BN254 layout the Sui verifier expects.
        const { proofToSuiBytes } = await import('@/services/sui-encoding');
        const proofBytes = proofToSuiBytes(proof);

        setStatus('success');
        return {
          proofBytes,
          proof: proof as unknown as Groth16Proof,
          publicSignals: publicSignals as string[],
        };
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        setStatus('error');
        throw err;
      }
    },
    [],
  );

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
  }, []);

  return { status, error, generateProof, reset };
}
