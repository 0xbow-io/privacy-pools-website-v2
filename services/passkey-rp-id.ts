// The passkey's relying-party id decides which pages can use it: an origin may
// request its own effective domain or any registrable-domain suffix of it, with
// no well-known file involved. Requesting the hostname (the old behaviour)
// scoped a passkey to v2.privacypools.com, so moving the app to
// privacypools.com, or to a v3 subdomain, would have minted a new passkey and
// an empty account. Requesting the apex makes one passkey serve every
// *.privacypools.com page (Pat, 2026-09-05).
//
// Origins OUTSIDE privacypools.com may still request the apex RP ID through
// WebAuthn Related Origin Requests (L3 §5.11): https://privacypools.com/
// .well-known/webauthn lists them (privacy-pools-website PR #232). Only the
// hosts listed there are allowed to ask for the apex here; any other host keeps
// its own hostname, as the spec requires. The passkey feature itself stays
// behind EXPO_PUBLIC_PASSKEY_PREVIEW.

export const PASSKEY_APEX_DOMAIN = 'privacypools.com';

/** Hosts listed in https://privacypools.com/.well-known/webauthn (keep the two in sync). */
export const PASSKEY_RELATED_ORIGIN_HOSTS: readonly string[] = [
  'privacy-pools-website-v2-git-feat-passkey-smart-wallets-0xbow.vercel.app',
  'privacy-pools-website-v2.vercel.app',
];

export function passkeyRpIdFor(hostname: string | null | undefined): string {
  const host = (hostname ?? '').trim().toLowerCase();
  if (!host) return 'localhost';
  if (host === PASSKEY_APEX_DOMAIN || host.endsWith(`.${PASSKEY_APEX_DOMAIN}`)) return PASSKEY_APEX_DOMAIN;
  if (PASSKEY_RELATED_ORIGIN_HOSTS.includes(host)) return PASSKEY_APEX_DOMAIN;
  return host;
}
