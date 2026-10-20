import { describe, it, expect } from 'vitest';
import { poseidonHashN } from '@/services/sui-witness/crypto';
import { buildDepositWitness } from '@/services/sui-witness/witness';

/**
 * Toolchain smoke test: confirms vitest resolves the REAL ported modules
 * (circomlibjs Poseidon over WASM, the witness builder) and the `@/` alias.
 * If this fails, the runner setup is broken (not the logic under test).
 */
describe('toolchain smoke', () => {
  it('runs circomlibjs Poseidon over the BN254 field', async () => {
    const h = await poseidonHashN([1n, 2n]);
    expect(typeof h).toBe('bigint');
    expect(h).toBeGreaterThan(0n);
  });

  it('builds a deposit witness end to end', async () => {
    const w = await buildDepositWitness({
      value: 1_000_000n,
      tokenId: 9999n,
      noteSecret: 11n,
      depositSecret: 22n,
      ownerAddress: 12345n,
    });
    expect(w.commitment).toBeGreaterThan(0n);
    expect(w.label).toBeGreaterThan(0n);
  });
});
