// Human form of raw EVM revert bytes, for the deposit modal's pre-submit
// simulation. Error(string) and the two custom errors an exact-shares yield
// deposit can hit are decoded by name; anything else stays raw hex.
//
// Codex on 0759cc6: the classifier used to recognise only Error(string) and
// TransferFromFailed(), so an ABI-encoded PPRouter_SlippageExceeded (the very
// error an expired quote produces) stayed hex and the expiry copy never fired.
import { decodeErrorResult, type Hex } from 'viem';

const REVERT_REASON_SELECTOR = '0x08c379a0'; // Error(string)
const TRANSFER_FROM_FAILED_SELECTOR = '0x7939f424'; // solady SafeTransferLib TransferFromFailed()

/** Custom errors decoded by name; add here when a flow needs to recognise one. */
export const KNOWN_REVERT_ERRORS_ABI = [
  {
    type: 'error',
    name: 'PPRouter_SlippageExceeded',
    inputs: [{ name: 'underlyingIn', type: 'uint256' }, { name: 'maxUnderlyingIn', type: 'uint256' }],
  },
  {
    type: 'error',
    name: 'ERC20InsufficientAllowance',
    inputs: [{ name: 'spender', type: 'address' }, { name: 'allowance', type: 'uint256' }, { name: 'needed', type: 'uint256' }],
  },
] as const;

/** Best-effort human form of raw revert bytes; falls back to the raw hex. */
export function decodeRevertPayload(raw: string | undefined): string {
  if (!raw) return 'no revert data';
  if (raw.startsWith(REVERT_REASON_SELECTOR)) {
    try {
      const len = parseInt(raw.slice(10 + 64, 10 + 128), 16);
      const strHex = raw.slice(10 + 128, 10 + 128 + len * 2);
      const bytes = strHex.match(/.{2}/g)?.map((b) => parseInt(b, 16)) ?? [];
      return `Error("${String.fromCharCode(...bytes)}")`;
    } catch { /* keep raw */ }
  } else if (raw.startsWith(TRANSFER_FROM_FAILED_SELECTOR)) {
    return 'TransferFromFailed()';
  }
  try {
    const decoded = decodeErrorResult({ abi: KNOWN_REVERT_ERRORS_ABI, data: raw as Hex });
    return `${decoded.errorName}(${(decoded.args ?? []).map(String).join(', ')})`;
  } catch { /* unknown selector: keep raw */ }
  return raw;
}
