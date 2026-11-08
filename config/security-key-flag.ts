// Security-key (FIDO / YubiKey) sign-in for ordinary wallets is OFF unless the
// tab was opened with `?enable-security-key=1`. Smart-contract wallets, and
// wallets that already failed the signature determinism check, can pick a
// security key without it (services/passkey-choice.ts).
//
// Why a flag: an EOA that unlocks with a security key gets a different private
// account than the one its wallet signature derives. Offering that to every
// wallet up front means people can end up with two accounts and have to
// remember which unlock they used (Pat, 2026-09-05). The flag lets the users who
// asked for it (hardware wallets that sign non-deterministically) skip the
// failed sign-ins without changing the dialog for everyone else.
//
// The choice sticks to the tab (sessionStorage) so in-app navigation that drops
// the query keeps it; `?enable-security-key=0` clears it. Resolved once per page
// load. EXPO_PUBLIC_PASSKEY_PREVIEW=0 turns it off for a build.

import { getUiParam } from '@/components/ui-url-events';

export const SECURITY_KEY_PARAM = 'enable-security-key';
const SECURITY_KEY_SESSION_KEY = 'ppv2_security_key_signin_v1';

/** Pure: what a raw query value means. null = not present or unrecognised. */
export function parseSecurityKeyFlag(raw: string | null): boolean | null {
  if (raw === null) return null;
  const v = raw.trim().toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === '') return true;
  if (v === '0' || v === 'false' || v === 'no' || v === 'off') return false;
  return null;
}

function buildAllowsPasskey(): boolean {
  return !(typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_PASSKEY_PREVIEW === '0');
}

/** Pure core, so the rules are testable without a browser. */
export function resolveSecurityKeyFlag(deps: {
  fromUrl: string | null;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  buildAllows: boolean;
}): boolean {
  if (!deps.buildAllows) return false;
  const parsed = parseSecurityKeyFlag(deps.fromUrl);
  try {
    if (parsed === true) deps.storage?.setItem(SECURITY_KEY_SESSION_KEY, '1');
    if (parsed === false) deps.storage?.removeItem(SECURITY_KEY_SESSION_KEY);
    if (parsed !== null) return parsed;
    return deps.storage?.getItem(SECURITY_KEY_SESSION_KEY) === '1';
  } catch {
    return parsed === true;
  }
}

let resolved: boolean | null = null;

/** Has this tab asked for security-key sign-in on ordinary wallets? Fixed per page load. */
export function securityKeySignInEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  if (resolved !== null) return resolved;
  let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = null;
  try {
    storage = window.sessionStorage ?? null;
  } catch {
    storage = null;
  }
  resolved = resolveSecurityKeyFlag({ fromUrl: getUiParam(SECURITY_KEY_PARAM), storage, buildAllows: buildAllowsPasskey() });
  return resolved;
}
