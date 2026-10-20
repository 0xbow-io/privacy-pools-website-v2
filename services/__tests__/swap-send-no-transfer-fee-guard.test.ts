import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';

// DEV-514: a swap-send never submits the plain transfer, so the transfer's
// fee-on-top guard must not refuse it. The swap flow and Withdraw net their
// own relayer fee out of the entered amount.
describe('swap-send skips the plain-transfer fee guard', () => {
  const source = readFileSync(join(__dirname, '../../components/transfer-modal-provider.tsx'), 'utf8');
  test('relayFeeExceeds is off for a swap-send', () => {
    expect(source).toContain('const relayFeeExceeds = !isSwapSend && !sendExactActive && relayTotalWithFee != null');
  });
});

// DEV-509 QA (Mike, 2026-10-06): the picker offers the plain coin, the private
// route lands in the pool. Where a chain wraps the asset in a share, the share
// is what is compared and what the swap flow is asked for.
describe('swap-send resolves the pool output of a picked plain asset', () => {
  const source = readFileSync(join(__dirname, '../../components/transfer-modal-provider.tsx'), 'utf8');
  test('the private test compares the deposit target, not the delivery address', () => {
    // The chain the note lands on: the destination for a cross-chain send.
    expect(source).toContain('const privateOutputChainId = crossChainSend ? sendChainId : chainId;');
    expect(source).toContain('conversionDepositTarget(receiveAsset.address, privateOutputChainId, !!receiveAsset.isNative)');
    expect(source).toContain('.some((t) => t.address.toLowerCase() === privateOutputAddress)');
  });
  test('the handoff names that same output', () => {
    expect(source).toContain('...(privateOutputAddress ? { outputTokenAddress: privateOutputAddress } : {})');
  });
});
