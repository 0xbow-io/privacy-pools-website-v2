/**
 * Chains where the SDK can turn a same-chain swap into a deposit of the plain
 * native coin. `Entrypoint.deposit{value}` needs `msg.value` to equal the cost
 * exactly, so the SDK composes LiFi's Executor (swap, then deposit) itself
 * instead of asking LiFi, and on a chain without a known Executor it throws
 * `NativeSwapDepositUnavailable` (v2-monorepo#477).
 *
 * Mirrors the keys of the SDK's `LIFI_SWAP_EXECUTORS`, which the bundle does
 * not export. services/__tests__/native-swap-executor.test.ts reads the table
 * out of the vendored build so this cannot drift silently.
 */
export const NATIVE_SWAP_EXECUTOR_CHAIN_IDS: readonly number[] = [1, 10, 56, 8453];

export function nativeSwapDepositSupported(chainId: number): boolean {
  return NATIVE_SWAP_EXECUTOR_CHAIN_IDS.includes(chainId);
}

export const NATIVE_SWAP_DEPOSIT_UNAVAILABLE_TEXT =
  'Receiving the native coin from a swap is not available on this network yet. Pick another asset.';

/** The SDK's typed refusal for a native-coin swap deposit it cannot build. */
export function isNativeSwapDepositUnavailable(err: unknown): boolean {
  return err instanceof Error && err.name === 'NativeSwapDepositUnavailable';
}
