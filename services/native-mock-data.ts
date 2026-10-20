/**
 * Web build of the native mock data: nothing. The data lives in
 * native-mock-data.native.ts so none of it ships in the web bundle.
 */
import type { NativeMockPoolsValue, NativeMockSession, NativeMockWallet } from './native-mock-types';

export function getNativeMockPoolsValue(): NativeMockPoolsValue | null {
  return null;
}
export function getNativeMockSession(): NativeMockSession | null {
  return null;
}
export function getNativeMockWallet(): NativeMockWallet | null {
  return null;
}
export function getNativeMockWalletBalance(_symbol: string): string | null {
  return null;
}
