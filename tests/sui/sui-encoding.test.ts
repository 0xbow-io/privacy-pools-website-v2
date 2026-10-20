import { describe, it, expect } from 'vitest';
import {
  proofToSuiBytes,
  publicSignalsToSuiBytes,
} from '@/services/sui-encoding';
import { SDK_AVAILABLE, loadSdkSui } from './helpers/sdk';

/**
 * Sui Groth16 proof / public-signal encoding (Arkworks BN254 compressed layout).
 * The on-chain sui::groth16 verifier accepts ONLY this exact byte layout, so an
 * encoding drift here = silent E_INVALID_PROOF on every tx. We assert the layout
 * invariants AND cross-check byte-for-byte against the SDK (source of truth).
 */

const BN254_BASE_FIELD =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const HALF_P = (BN254_BASE_FIELD - 1n) / 2n;

// A deterministic, structurally-valid snarkjs proof object. The coordinates need
// not be on-curve for an ENCODING test (we assert byte layout, not verification).
const PROOF = {
  pi_a: ['1', '2', '1'],
  pi_b: [
    ['3', '4'],
    ['5', '6'],
    ['1', '0'],
  ],
  pi_c: ['7', '8', '1'],
};

describe('proofToSuiBytes (Arkworks compressed)', () => {
  it('produces exactly 128 bytes (A:32 || B:64 || C:32)', () => {
    const bytes = proofToSuiBytes(PROOF);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(128);
  });

  it('encodes G1.x little-endian in the first 32 bytes', () => {
    const bytes = proofToSuiBytes(PROOF);
    // pi_a.x = 1 -> first byte 0x01, rest zero (within the low bits).
    expect(bytes[0]).toBe(1);
    // y = 2 <= HALF_P -> sign bit clear in byte 31.
    expect(bytes[31] & 0x80).toBe(0);
  });

  it('sets the Arkworks sign bit when y > (p-1)/2 (NOT parity)', () => {
    // y in the upper half -> sign bit set; an EVEN such y proves it is not parity.
    const upperEven = HALF_P + 2n; // > HALF_P and even
    const proof = { ...PROOF, pi_a: ['1', upperEven.toString(), '1'] };
    const bytes = proofToSuiBytes(proof);
    expect(bytes[31] & 0x80).toBe(0x80); // set despite even y
  });

  it('clears the sign bit for a y in the lower half even if odd', () => {
    const lowerOdd = 3n; // < HALF_P and odd
    const proof = { ...PROOF, pi_a: ['1', lowerOdd.toString(), '1'] };
    const bytes = proofToSuiBytes(proof);
    expect(bytes[31] & 0x80).toBe(0); // clear despite odd y
  });
});

describe('publicSignalsToSuiBytes', () => {
  it('encodes each signal as a 32-byte little-endian field element', () => {
    const bytes = publicSignalsToSuiBytes(['1', '256']);
    expect(bytes.length).toBe(64);
    expect(bytes[0]).toBe(1); // signal 0 = 1
    expect(bytes[32]).toBe(0); // signal 1 = 256 -> LE: byte0=0
    expect(bytes[33]).toBe(1); // byte1 = 1
  });

  it('handles the deposit (3) and ragequit (7) signal counts', () => {
    expect(publicSignalsToSuiBytes(['1', '2', '3']).length).toBe(96);
    expect(publicSignalsToSuiBytes(['1', '2', '3', '4', '5', '6', '7']).length).toBe(224);
  });
});

describe.skipIf(!SDK_AVAILABLE)('SDK cross-check (byte-for-byte)', () => {
  it('proofToSuiBytes matches the SDK', async () => {
    const sdk = await loadSdkSui();
    const port = proofToSuiBytes(PROOF);
    const ref = sdk.proofToSuiBytes(PROOF);
    expect(Array.from(port)).toEqual(Array.from(ref));
  });

  it('publicSignalsToSuiBytes matches the SDK', async () => {
    const sdk = await loadSdkSui();
    const signals = ['12345', '67890', '11111'];
    const port = publicSignalsToSuiBytes(signals);
    const ref = sdk.publicSignalsToSuiBytes(signals);
    expect(Array.from(port)).toEqual(Array.from(ref));
  });
});
