/**
 * Sui Groth16 proof encoding (browser-safe TypeScript port).
 *
 * Ported faithfully from the Sui SDK's `sui.mjs` (proofToSuiBytes) so the
 * website does not depend on the (un-vendored) Node-oriented Sui SDK at runtime.
 * Uses Uint8Array (no Node Buffer) so it runs in the browser.
 *
 * Converts a snarkjs Groth16 proof to the Arkworks BN254 compressed byte layout
 * the on-chain `sui::groth16` verifier expects:
 *   A (G1 compressed, 32) || B (G2 compressed, 64) || C (G1 compressed, 32) = 128 bytes.
 *
 * Critical convention (see ppv2-sui Lessons Learned): the Arkworks compressed
 * sign bit means "y is in the lexicographic upper half" (y > (p-1)/2), NOT parity.
 */

// BN254 base field modulus (Fq).
const BN254_BASE_FIELD =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// Arkworks compressed sign bit: set when y > (p-1)/2.
const HALF_P = (BN254_BASE_FIELD - 1n) / 2n;

interface SnarkjsProof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
}

/** Encode a bigint as a 32-byte little-endian Uint8Array. */
function bigintToBytes32LE(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * Compress a BN254 G1 point to Arkworks format (32 bytes).
 * x in little-endian; flag 0x80 in the MSB of the last byte if y > (p-1)/2.
 */
function g1Compress(x: bigint, y: bigint): Uint8Array {
  const buf = bigintToBytes32LE(x);
  if (y > HALF_P) {
    buf[31] |= 0x80;
  }
  return buf;
}

/**
 * Compress a BN254 G2 point to Arkworks format (64 bytes).
 * x = (c0, c1) as c0 (32 LE) || c1 (32 LE). Sign flag in MSB of c1[31].
 * Fq2 lexicographic sign: compare y.c1 first, fall back to y.c0 when c1 == 0.
 */
function g2Compress(x: [bigint, bigint], y: [bigint, bigint]): Uint8Array {
  const xc0 = bigintToBytes32LE(x[0]);
  const xc1 = bigintToBytes32LE(x[1]);

  const yForSign = y[1] !== 0n ? y[1] : y[0];
  if (yForSign > HALF_P) {
    xc1[31] |= 0x80;
  }

  const out = new Uint8Array(64);
  out.set(xc0, 0);
  out.set(xc1, 32);
  return out;
}

/**
 * Convert a snarkjs Groth16 proof to Sui proof_points bytes (128 bytes).
 */
export function proofToSuiBytes(proof: SnarkjsProof): Uint8Array {
  const a = g1Compress(BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1]));
  const b = g2Compress(
    [BigInt(proof.pi_b[0][0]), BigInt(proof.pi_b[0][1])],
    [BigInt(proof.pi_b[1][0]), BigInt(proof.pi_b[1][1])],
  );
  const c = g1Compress(BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1]));

  const out = new Uint8Array(128);
  out.set(a, 0);
  out.set(b, 32);
  out.set(c, 96);
  return out;
}

/**
 * Convert public signals to Sui public_proof_inputs bytes.
 * Each signal is a 32-byte LITTLE-ENDIAN field element, concatenated.
 * (deposit: 3 signals, ragequit: 7 signals; transact uses a single hash.)
 */
export function publicSignalsToSuiBytes(publicSignals: string[]): Uint8Array {
  const out = new Uint8Array(publicSignals.length * 32);
  publicSignals.forEach((s, i) => {
    out.set(bigintToBytes32LE(BigInt(s)), i * 32);
  });
  return out;
}
