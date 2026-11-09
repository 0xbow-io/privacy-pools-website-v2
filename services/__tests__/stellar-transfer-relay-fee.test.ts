import { describe, expect, test } from 'bun:test';

import {
  STELLAR_TRANSFER_RELAY_FEE_ESTIMATE,
  maxStellarTransferForInputs,
  stellarTransferRelayFee,
} from '@/config/stellar-deployment';
import type { Note } from '@/services/sdk-types';
import { maxCoverableTransfer, selectGreedyTransferInputs } from '@/services/transfer-note-selection';

const XLM = 10_000_000n;
const note = (value: bigint, label: string, i: number) =>
  ({ commitment: `0x${i.toString(16)}`, value: value.toString(), label, status: 'ACTIVE' }) as unknown as Note;

describe('Stellar transfer relay fee (DEV-498)', () => {
  test('the fee comes off; a one-time link stays self-submitted', () => {
    expect(stellarTransferRelayFee()).toBe(STELLAR_TRANSFER_RELAY_FEE_ESTIMATE);
    expect(stellarTransferRelayFee({ oneTime: true })).toBe(0n);
    expect(maxStellarTransferForInputs(10n * XLM, stellarTransferRelayFee({ oneTime: true }))).toBe(10n * XLM);
    expect(maxStellarTransferForInputs(STELLAR_TRANSFER_RELAY_FEE_ESTIMATE, STELLAR_TRANSFER_RELAY_FEE_ESTIMATE)).toBe(0n);
    expect(maxStellarTransferForInputs(1n, STELLAR_TRANSFER_RELAY_FEE_ESTIMATE)).toBe(0n);
  });

  test('Max is exactly what submit can cover with the fee, one stroop more is not', () => {
    const notes = [note(10n * XLM, 'a', 1), note(3n * XLM, 'b', 2), note(2n * XLM, 'c', 3)];
    const fee = stellarTransferRelayFee();
    const max = maxStellarTransferForInputs(maxCoverableTransfer(notes, 5, 2), fee);
    expect(selectGreedyTransferInputs(notes, max + fee, 5, 2).covered).toBe(true);
    expect(selectGreedyTransferInputs(notes, max + 1n + fee, 5, 2).covered).toBe(false);
  });
});
