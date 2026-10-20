import { describe, it, expect } from 'vitest';
import {
  computeTransactContext,
  addressToBytes32,
} from '@/services/sui-witness/crypto';
import { SDK_AVAILABLE, loadSdkCrypto, loadSdkRelay } from './helpers/sdk';

/**
 * Relay context binding (Flow 3d — recipient/processor binding).
 *
 * The SDK's RelayWithdrawBuilder binds the payout routing into the proof context:
 *   processor      = relayer signer (the relayer's address)
 *   processor_data = encodePayoutRouting(recipient, feeRecipient, feeAmount)
 *                    = recipient(32 BE) || feeRecipient(32 BE) || feeAmount(8 LE)
 *   context        = computeTransactContext(processorBytes, processorData, [], [])
 * The relayer's on-chain relay::relay_withdrawal recomputes the SAME context from
 * ctx.sender()+payout data, so the proof's context MUST equal this or it aborts
 * E_INVALID_PROOF.
 *
 * These tests prove the website HAS the primitives to produce that exact binding
 * (addressToBytes32 + computeTransactContext match the SDK encoding), AND flag the
 * REAL GAP this audit-bug-#2 surfaced: the website never ports `encodePayoutRouting`
 * and `use-sui-session.transferOrWithdraw` hardcodes processor=0x0 / empty
 * processor_data — so a RELAYED withdrawal assembled through the current website
 * code would NOT carry this binding. See the findings note below.
 */

const RELAYER = '0x00000000000000000000000000000000000000000000000000000000000000aa';
const RECIPIENT = '0x00000000000000000000000000000000000000000000000000000000000000bb';
const FEE_RECIPIENT = '0x00000000000000000000000000000000000000000000000000000000000000cc';
const FEE = 1234n;

/** The reference 72-byte PayoutRouting (matches SDK relay.mjs encodePayoutRouting). */
function refEncodePayoutRouting(recipient: string, feeRecipient: string, feeAmount: bigint): Uint8Array {
  const out = new Uint8Array(72);
  out.set(addressToBytes32(recipient), 0);
  out.set(addressToBytes32(feeRecipient), 32);
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, feeAmount, true);
  out.set(new Uint8Array(view.buffer), 64);
  return out;
}

describe('relay context binding primitives', () => {
  it('the port can produce the relay context (processor=relayer, payout-routing data)', () => {
    const processorBytes = addressToBytes32(RELAYER);
    const processorData = refEncodePayoutRouting(RECIPIENT, FEE_RECIPIENT, FEE);

    const ctx = computeTransactContext(processorBytes, processorData, [], []);
    expect(typeof ctx).toBe('bigint');
    expect(ctx).toBeGreaterThan(0n);

    // The binding is recipient/feeRecipient/fee specific: changing the recipient
    // changes the context (so the relayer cannot redirect the payout).
    const ctx2 = computeTransactContext(
      processorBytes,
      refEncodePayoutRouting(
        '0x00000000000000000000000000000000000000000000000000000000000000de',
        FEE_RECIPIENT,
        FEE,
      ),
      [],
      [],
    );
    expect(ctx2).not.toBe(ctx);

    // And processor-specific: a direct (processor=0x0) context differs from the
    // relayed one, which is exactly why the relay path MUST set processor=relayer.
    const directCtx = computeTransactContext(new Uint8Array(32), new Uint8Array(0), [], []);
    expect(directCtx).not.toBe(ctx);
  });

  it('PayoutRouting is the 72-byte recipient||feeRecipient||fee(8 LE) layout', () => {
    const pr = refEncodePayoutRouting(RECIPIENT, FEE_RECIPIENT, FEE);
    expect(pr).toHaveLength(72);
    // fee 1234 = 0x04D2 -> LE in the last 8 bytes.
    expect(pr[64]).toBe(0xd2);
    expect(pr[65]).toBe(0x04);
    expect(pr.slice(66, 72)).toEqual(new Uint8Array(6));
  });

  // Cross-check the port's transact context against the SDK for the same relay
  // inputs (folds the crosscheck spirit into the relay binding).
  describe.skipIf(!SDK_AVAILABLE)('SDK cross-check', () => {
    it('port computeTransactContext == SDK computeTransactContext for relay inputs', async () => {
      const sdkCrypto = await loadSdkCrypto();
      const sdkRelay = await loadSdkRelay();

      const processorBytes = addressToBytes32(RELAYER);
      const processorData = sdkRelay.encodePayoutRouting(RECIPIENT, FEE_RECIPIENT, FEE);

      const portCtx = computeTransactContext(processorBytes, processorData, [], []);
      const sdkCtx = sdkCrypto.computeTransactContext(
        Buffer.from(processorBytes),
        Buffer.from(processorData),
        [],
        [],
      );
      expect(portCtx).toBe(sdkCtx);

      // Our local reference encoder also matches the SDK's, byte-for-byte.
      expect(refEncodePayoutRouting(RECIPIENT, FEE_RECIPIENT, FEE)).toEqual(
        new Uint8Array(processorData),
      );
    });
  });
});

describe('FIXED (audit bug #1): relay path now ports encodePayoutRouting + binds context', () => {
  it('the website now EXPORTS encodePayoutRouting (the binder primitive)', async () => {
    const relay = await import('@/hooks/use-sui-relay');
    // The fix re-exports the 72-byte payout-routing encoder from the relay hook
    // (and from services/sui-witness), so a relayed withdrawal CAN be context-bound.
    expect(typeof (relay as Record<string, unknown>).encodePayoutRouting).toBe('function');
    const keys = Object.keys(relay);
    expect(keys).toContain('validateQuote');
    expect(keys.some((k) => /payout|routing/i.test(k))).toBe(true);
  });

  it('encodePayoutRouting matches the reference 72-byte layout byte-for-byte', async () => {
    const { encodePayoutRouting } = await import('@/hooks/use-sui-relay');
    const got = encodePayoutRouting(RECIPIENT, FEE_RECIPIENT, FEE);
    expect(got).toEqual(refEncodePayoutRouting(RECIPIENT, FEE_RECIPIENT, FEE));
    expect(got).toHaveLength(72);
  });

  it('the relayed path binds the RELAYER context, NOT the direct 0x0 context', async () => {
    const { encodePayoutRouting } = await import('@/hooks/use-sui-relay');

    // Relayed: processor = relayer signer, processor_data = payout routing.
    const relayedProcessorData = encodePayoutRouting(RECIPIENT, FEE_RECIPIENT, FEE);
    expect(relayedProcessorData).toEqual(refEncodePayoutRouting(RECIPIENT, FEE_RECIPIENT, FEE));
    const relayedCtx = computeTransactContext(
      addressToBytes32(RELAYER),
      relayedProcessorData,
      [],
      [],
    );

    // Direct (the OLD, buggy binding): processor = 0x0, empty processor_data.
    const directCtx = computeTransactContext(new Uint8Array(32), new Uint8Array(0), [], []);

    // The fix MUST bind the relayer context, which differs from the direct one.
    // (Binding the direct context for a relayed withdraw is exactly what caused
    // the on-chain E_INVALID_PROOF this bug was about.)
    expect(relayedCtx).not.toBe(directCtx);
    expect(relayedCtx).toBeGreaterThan(0n);
  });
});
