// Passkey sign-in failures, each with short user copy. Messages are fixed
// strings: no native detail, no key material, nothing user-derived.

export type PasskeyFailure =
  | 'no-passkey'
  | 'prf-unsupported'
  | 'cancelled'
  | 'not-associated'
  | 'unsupported'
  | 'not-verified'
  | 'wrong-account'
  | 'failed';

const COPY: Record<PasskeyFailure, string> = {
  'no-passkey': 'No Privacy Pools passkey on this device. Create one to continue.',
  'prf-unsupported': 'This passkey cannot sign here. Use a device passkey (iOS 18+ or Google Password Manager).',
  cancelled: 'Passkey cancelled.',
  'not-associated': 'This app build is not linked to privacypools.com yet.',
  unsupported: 'Passkeys are not available on this device.',
  'not-verified': 'Passkey did not verify you. Try again.',
  'wrong-account': 'That passkey belongs to a different account.',
  failed: 'Passkey failed. Try again.',
};

export class PasskeyEoaError extends Error {
  readonly failure: PasskeyFailure;
  constructor(failure: PasskeyFailure) {
    super(COPY[failure]);
    this.failure = failure;
    this.name = 'PasskeyEoaError';
  }
}

export class PasskeyWrongAccountError extends PasskeyEoaError {
  constructor() {
    super('wrong-account');
  }
}

export function passkeyFailureCopy(e: unknown): string {
  return e instanceof PasskeyEoaError ? e.message : COPY.failed;
}

/**
 * Map a react-native-passkey error ({ error, message }) to a failure. Reads
 * only the library's fixed error code and checks the message for the RP-ID
 * hint, never forwards either.
 */
export function classifyNativePasskeyError(e: unknown): PasskeyFailure {
  const code = typeof (e as { error?: unknown })?.error === 'string' ? (e as { error: string }).error : '';
  const message = typeof (e as { message?: unknown })?.message === 'string' ? (e as { message: string }).message : '';
  if (/rp ?id|relying party|asset ?links|associated domain|cannot be validated|webcredentials|not associated/i.test(message)) {
    return 'not-associated';
  }
  switch (code) {
    case 'UserCancelled':
    case 'TimedOut':
    case 'Interrupted':
      return 'cancelled';
    case 'NoCredentials':
      return 'no-passkey';
    case 'NotSupported':
    case 'NoCreateOption':
      return 'unsupported';
    case 'BadConfiguration':
      return 'not-associated';
    default:
      return 'failed';
  }
}
