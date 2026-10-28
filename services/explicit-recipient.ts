// A payout goes to the address the user typed or picked, and only there.
//
// Withdraw used to fall back to the connected wallet (or the Sui / Stellar
// account) when the recipient field was empty. That wallet is usually the one
// that deposited, so an empty field quietly linked the deposit and the
// withdrawal on chain, which is the one thing the pool exists to prevent
// (reported by Mike, 2026-10-28). An empty or invalid recipient now blocks the
// action and asks for an address. Typing your own wallet still works: that is
// a choice, not a default.
//
// No react-native import: bun-testable.

export const RECIPIENT_REQUIRED_MESSAGE = 'Enter the address that should receive the funds.';

/**
 * The recipient to pay, or null when there is none to pay. Never substitutes
 * another address: there is deliberately no fallback parameter.
 */
export function explicitRecipient(raw: string | null | undefined, isValid: (address: string) => boolean): string | null {
  const v = (raw ?? '').trim();
  return v && isValid(v) ? v : null;
}
