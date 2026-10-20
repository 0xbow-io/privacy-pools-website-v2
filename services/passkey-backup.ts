import type { Hex } from 'viem';

// Versioned, portable root backup for a passkey-derived account — the
// "account-key-v2" shape for the passkey scheme. The root IS the WebAuthn PRF
// identity output; re-importing it reconstructs the same account on any device
// or origin WITHOUT the passkey, which is the deliberate cross-device /
// domain-loss lifeboat (a synced passkey only covers same-ecosystem device
// loss). Spend-grade — treat like cash.
//
// Producing the backup should be gated behind a FRESH user-verified passkey
// assertion (the export flow re-runs the PRF with userVerification:'required'),
// so a background script can't silently export it. This module is only the
// codec + a browser download helper; it never derives or stores keys.

export const PASSKEY_BACKUP_SCHEME = 'ppv2-passkey-root';
export const PASSKEY_BACKUP_VERSION = 1;

export type PasskeyBackup = {
  scheme: typeof PASSKEY_BACKUP_SCHEME;
  v: number;
  /** PRF identity secret used as the derivation root (32-byte hex). */
  root: Hex;
  /** Revocable rotation index; 0x0 until rotation is wired. */
  revocableKeyIndex: Hex;
};

const HEX32_RE = /^0x[0-9a-fA-F]{64}$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

function toBase64Url(value: string): string {
  if (typeof btoa === 'function') {
    return btoa(value).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(value, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  throw new Error('Base64 encoding is unavailable in this environment.');
}

function fromBase64Url(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  if (typeof atob === 'function') return atob(padded);
  if (typeof Buffer !== 'undefined') return Buffer.from(padded, 'base64').toString('utf8');
  throw new Error('Base64 decoding is unavailable in this environment.');
}

export function encodePasskeyBackup(params: { root: Hex; revocableKeyIndex?: Hex }): string {
  // Validate before emitting — never produce a backup file that decode would
  // reject or that can't reproduce the intended account.
  if (!HEX32_RE.test(params.root)) {
    throw new Error('encodePasskeyBackup: root must be a 32-byte 0x-hex secret.');
  }
  const revocableKeyIndex = params.revocableKeyIndex ?? ('0x0' as Hex);
  if (!HEX_RE.test(revocableKeyIndex)) {
    throw new Error('encodePasskeyBackup: revocableKeyIndex must be 0x-hex.');
  }
  const payload: PasskeyBackup = {
    scheme: PASSKEY_BACKUP_SCHEME,
    v: PASSKEY_BACKUP_VERSION,
    root: params.root,
    revocableKeyIndex,
  };
  return toBase64Url(JSON.stringify(payload));
}

/**
 * Decode + validate a pasted backup. Returns null on anything malformed so the
 * caller shows a clean "invalid backup" state rather than throwing. Accepts a
 * bare encoded payload or one with surrounding whitespace.
 */
export function decodePasskeyBackup(encoded: string): PasskeyBackup | null {
  try {
    const parsed = JSON.parse(fromBase64Url(encoded.trim())) as Partial<PasskeyBackup> | null;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.scheme !== PASSKEY_BACKUP_SCHEME) return null;
    // Reject unknown versions outright — a future v2 backup must not be silently
    // misread by v1 code. Add a migration path here when the format changes.
    if (parsed.v !== PASSKEY_BACKUP_VERSION) return null;
    if (typeof parsed.root !== 'string' || !HEX32_RE.test(parsed.root)) return null;
    // The index must be present and well-formed; default only when truly absent.
    if (parsed.revocableKeyIndex !== undefined &&
        (typeof parsed.revocableKeyIndex !== 'string' || !HEX_RE.test(parsed.revocableKeyIndex))) {
      return null;
    }
    return {
      scheme: PASSKEY_BACKUP_SCHEME,
      v: PASSKEY_BACKUP_VERSION,
      root: parsed.root as Hex,
      revocableKeyIndex: (parsed.revocableKeyIndex as Hex) ?? ('0x0' as Hex),
    };
  } catch {
    return null;
  }
}

/** Web-only: trigger a download of the backup payload. Returns false off-web. */
export function downloadPasskeyBackup(encoded: string, filename = 'privacy-pools-passkey-backup.txt'): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined' || typeof URL === 'undefined') {
    return false;
  }
  try {
    const blob = new Blob([encoded], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}
