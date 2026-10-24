/** Unknown registration is safe for discovery, never for authorizing a deposit. */
export function assertDepositUnlock(status: 'unknown' | 'unregistered' | 'compatible' | 'partial' | 'incompatible'): void {
  if (status === 'unknown') {
    throw new Error('Could not verify this unlock. Nothing was deposited. Try again.');
  }
  if (status === 'incompatible') {
    throw new Error('This account is registered with a different unlock. Use your original wallet or passkey.');
  }
}
