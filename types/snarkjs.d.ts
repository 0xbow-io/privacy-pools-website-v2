/**
 * Ambient type declarations for snarkjs.
 *
 * snarkjs ships no types and is a transitive dependency (bundled by the
 * vendored SDK). The Sui in-browser proof path imports it directly via a
 * dynamic import; these declarations cover only what that path uses.
 * At runtime, Metro/bundler resolves the actual snarkjs module.
 */
declare module 'snarkjs' {
  export interface Groth16Proof {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  }

  export interface FullProveResult {
    proof: Groth16Proof;
    publicSignals: string[];
  }

  export namespace groth16 {
    function fullProve(
      input: Record<string, unknown>,
      wasmFile: string | Uint8Array | ArrayBuffer,
      zkeyFile: string | Uint8Array | ArrayBuffer,
    ): Promise<FullProveResult>;

    function verify(
      vkVerifier: object,
      publicSignals: string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  }
}
