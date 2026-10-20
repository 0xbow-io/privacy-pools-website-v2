/**
 * The Base / Coinbase app cannot sign the sign-in message yet (base/account-sdk#387:
 * a bogus "not enough funds" error on eth_signTypedData), does not pair reliably
 * over WalletConnect, and its in-app browser has no WebAuthn. So for a Base /
 * Coinbase app signer (its in-app browser, or its WalletConnect peer) the only
 * message is to use another wallet, on the first failed sign. No device or
 * passkey sign-in is offered. The Coinbase Wallet browser EXTENSION signs fine
 * and is never treated as the app. Decisions here are local only.
 */

export const BASE_APP_NOTICE_TITLE = "Base app can't sign in here yet";
export const BASE_APP_NOTICE_BODY = 'Please use another wallet.';
export const BASE_APP_USE_ANOTHER_WALLET = 'Use another wallet';

/** The Base / Coinbase app failed the sign-in request. The dialog shows the notice. */
export class BaseAppCannotSignError extends Error {
  constructor() {
    super(BASE_APP_NOTICE_TITLE);
    this.name = 'BaseAppCannotSignError';
  }
}

export function isBaseAppCannotSign(err: unknown): boolean {
  return err instanceof BaseAppCannotSignError || (err instanceof Error && err.name === 'BaseAppCannotSignError');
}
