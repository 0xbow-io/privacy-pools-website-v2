/**
 * Viewing key overview: what the app tells a user about their viewing key.
 *
 * PURE module (no react-native imports) so it is bun-testable.
 *
 * The viewing key is the X25519 pair the SDK derives from the sign-in
 * signature. Its PUBLIC half is published on-chain (Keystore.setViewingKey) so
 * senders can encrypt note announcements to it; its PRIVATE half decrypts every
 * note this account ever received or will receive. There is exactly one such
 * key today: the app derives revocable index 0x0 everywhere and rotation is
 * phase 2. Copy therefore has to say, plainly:
 *   - static: one key, cannot be rotated in this app yet;
 *   - whole history and forward-only: anyone holding the private key reads
 *     everything, past and future, and that cannot be revoked;
 *   - the public key is safe to show and is what senders use.
 */

export type ViewingKeyStatus =
  /** Derived public key equals the one published on-chain. */
  | 'published'
  /** Nothing published yet (zero key): registration pending. */
  | 'unpublished'
  /** Published key differs from the derived one (another device/scheme registered it). */
  | 'mismatch'
  /** On-chain read failed or session not ready. */
  | 'unknown';

export type ViewingKeyOverview = {
  status: ViewingKeyStatus;
  /** Derived public key, lowercase 0x hex, or null before the session is built. */
  publicKey: string | null;
  /** Short display form of the public key. */
  shortKey: string | null;
  /** One-line status copy. */
  statusText: string;
};

const ZERO = /^0x0*$/;

export function shortHex(hex: string, head = 10, tail = 6): string {
  if (hex.length <= head + tail + 1) return hex;
  return `${hex.slice(0, head)}…${hex.slice(-tail)}`;
}

/**
 * Compare the derived public viewing key with the on-chain published one.
 * `onChain` is null when the read failed (unknown), or the zero key when
 * nothing is published.
 */
export function resolveViewingKeyStatus(derivedPublicKey: string | null | undefined, onChain: string | null | undefined): ViewingKeyStatus {
  if (!derivedPublicKey) return 'unknown';
  if (onChain === null || onChain === undefined) return 'unknown';
  if (ZERO.test(onChain)) return 'unpublished';
  return onChain.toLowerCase() === derivedPublicKey.toLowerCase() ? 'published' : 'mismatch';
}

export const VIEWING_KEY_STATUS_COPY: Record<ViewingKeyStatus, string> = {
  published: 'Published on-chain. Senders encrypt to this key.',
  unpublished: 'Not published yet. Register this wallet so senders can find it.',
  mismatch: 'A different key is published for this wallet. Notes sent to it are read by the device that registered it.',
  unknown: 'Could not read the published key right now.',
};

/** The copy discipline for the static key, one sentence each, no promises. */
export const VIEWING_KEY_FACTS: readonly string[] = [
  'One static key for this account. This app cannot rotate it today.',
  'Whoever holds the private viewing key can read every note for this account, past and future. Sharing it cannot be undone.',
  'This page shows only the public key, which senders use to encrypt notes for you. An account key or passkey backup can recreate the private key, so share those only with someone you trust with full read and spend access.',
];

export function buildViewingKeyOverview(derivedPublicKey: string | null | undefined, onChain: string | null | undefined): ViewingKeyOverview {
  const publicKey = derivedPublicKey ? derivedPublicKey.toLowerCase() : null;
  const status = resolveViewingKeyStatus(publicKey, onChain);
  return {
    status,
    publicKey,
    shortKey: publicKey ? shortHex(publicKey) : null,
    statusText: VIEWING_KEY_STATUS_COPY[status],
  };
}
