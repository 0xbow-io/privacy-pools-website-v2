import { describe, expect, test } from 'bun:test';
import { encodeErrorResult } from 'viem';
import { KNOWN_REVERT_ERRORS_ABI, decodeRevertPayload } from '@/services/revert-decode';
import { isExpiredYieldQuoteError } from '@/services/yield-deposit-safety';

describe('revert payload decoding', () => {
  test('the router slippage error and the OZ allowance error decode by name and feed the expiry detector', () => {
    const slippage = encodeErrorResult({ abi: KNOWN_REVERT_ERRORS_ABI, errorName: 'PPRouter_SlippageExceeded', args: [99_500_106n, 99_500_102n] });
    const text = decodeRevertPayload(slippage);
    expect(text).toBe('PPRouter_SlippageExceeded(99500106, 99500102)');
    expect(isExpiredYieldQuoteError(new Error(text))).toBe(true);
    const allowance = encodeErrorResult({
      abi: KNOWN_REVERT_ERRORS_ABI,
      errorName: 'ERC20InsufficientAllowance',
      args: ['0xe76e793d776c1e207ad7a7fa7c57d27420d85110', 99_500_102n, 99_500_106n],
    });
    // viem checksums the decoded address.
    expect(decodeRevertPayload(allowance)).toBe('ERC20InsufficientAllowance(0xe76E793d776c1e207aD7a7fa7C57d27420d85110, 99500102, 99500106)');
    expect(isExpiredYieldQuoteError(new Error(decodeRevertPayload(allowance)))).toBe(true);
  });
  test('Error(string), TransferFromFailed and unknown selectors keep their existing forms', () => {
    // Error("ERC20: transfer amount exceeds allowance")
    const reason = '0x08c379a0' + '0000000000000000000000000000000000000000000000000000000000000020' + '0000000000000000000000000000000000000000000000000000000000000028' + Buffer.from('ERC20: transfer amount exceeds allowance').toString('hex').padEnd(128, '0');
    expect(decodeRevertPayload(reason)).toBe('Error("ERC20: transfer amount exceeds allowance")');
    expect(decodeRevertPayload('0x7939f424')).toBe('TransferFromFailed()');
    expect(decodeRevertPayload('0xdeadbeef')).toBe('0xdeadbeef');
    expect(decodeRevertPayload(undefined)).toBe('no revert data');
  });
});
