// Mobile wallet links for the WalletConnect picker (ConnectKit / AppKit pattern).
// On a phone without an injected wallet there is no QR: each tile opens one
// wallet with the pairing URI, which is created when the picker opens so the
// link can be followed synchronously from the tap.
//
// Links mirror RainbowKit v2.2.11 `mobile.getUri` per wallet connector
// (src/wallets/walletConnectors/<id>/<id>.ts). Where RainbowKit returns the bare
// wc: URI on Android, so do we: Android routes it to the installed app.

import { WALLET_ICONS } from './wallet-icons';

export type MobileOs = 'android' | 'ios' | 'other';

export type MobileWalletLink = {
  id: string;
  name: string;
  /** Builds the link. `uri` is the WalletConnect pairing URI (unused when needsUri is false). */
  href: (uri: string, pageUrl: string, os?: MobileOs) => string;
  /** False for links that do not carry a pairing URI (open this page in the wallet browser). */
  needsUri: boolean;
  /** Inline data URI, vendored. */
  icon?: string;
};

const enc = encodeURIComponent;
const link = (id: string, name: string, build: (uri: string, os: MobileOs) => string): MobileWalletLink => ({
  id, name, needsUri: true, icon: WALLET_ICONS[id], href: (uri, _page, os = 'other') => build(uri, os),
});
/** Scheme link, bare wc: on Android (RainbowKit's `isAndroid() ? uri : ...`). */
const androidBare = (id: string, name: string, prefix: string) =>
  link(id, name, (uri, os) => (os === 'android' ? uri : `${prefix}${enc(uri)}`));

// Ordered by popularity. The first MOBILE_WALLET_PRIMARY_COUNT show up front.
export const MOBILE_WALLET_LINKS: readonly MobileWalletLink[] = [
  // Bare wc: from a real tap raises the Android chooser with every installed
  // wallet. iOS has no chooser for wc:, so the tile is Android only.
  { id: 'other', name: 'Open in installed wallet', needsUri: true, href: (uri) => uri },
  link('metamask', 'MetaMask', (uri) => `https://metamask.app.link/wc?uri=${enc(uri)}`),
  link('coinbase', 'Base / Coinbase Wallet', (uri) => `https://go.cb-w.com/wc?uri=${enc(uri)}`),
  link('trust', 'Trust Wallet', (uri) => `trust://wc?uri=${enc(uri)}`),
  androidBare('okx', 'OKX Wallet', 'okex://main/wc?uri='),
  link('rainbow', 'Rainbow', (uri, os) => (os === 'android' ? uri : os === 'ios' ? `rainbow://wc?uri=${enc(uri)}` : `https://rnbwapp.com/wc?uri=${enc(uri)}`)),
  link('uniswap', 'Uniswap Wallet', (uri) => `uniswap://wc?uri=${enc(uri)}`),
  link('zerion', 'Zerion', (uri, os) => (os === 'ios' ? `zerion://wc?uri=${enc(uri)}` : uri)),
  androidBare('bitget', 'Bitget Wallet', 'bitkeep://wc?uri='),
  androidBare('binance', 'Binance Wallet', 'bnc://app.binance.com/cedefi/wc?uri='),
  androidBare('ledger', 'Ledger Live', 'ledgerlive://wc?uri='),
  link('bybit', 'Bybit Wallet', (uri) => `bybitapp://open/route?targetUrl=by://web3/walletconnect/wc?uri=${enc(uri)}`),
  link('safepal', 'SafePal', (uri) => `safepalwallet://wc?uri=${enc(uri)}`),
  link('imtoken', 'imToken', (uri) => `imtokenv2://wc?uri=${enc(uri)}`),
  // Opens this page inside the Base app's browser, where its wallet is injected.
];

/** Tiles shown before the "More wallets" expander (after the Android-only tile). */
export const MOBILE_WALLET_PRIMARY_COUNT = 6;

/** iPadOS Safari reports a desktop Macintosh UA; touch points tell it apart. */
export function mobileOsFromUserAgent(ua: string | undefined, maxTouchPoints = 0): MobileOs {
  if (!ua) return 'other';
  if (/android/i.test(ua)) return 'android';
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && maxTouchPoints > 1)) return 'ios';
  return 'other';
}

/** A named row that would only hand Android the bare wc: URI, i.e. the generic
 * chooser, not the wallet its label names. */
const BARE_PROBE = 'wc:probe@2?relay-protocol=irn&symKey=0';
function isBareOnAndroid(l: MobileWalletLink): boolean {
  return l.id !== 'other' && l.needsUri && l.href(BARE_PROBE, '', 'android') === BARE_PROBE;
}

/** The links for this phone: the bare wc: chooser tile only on Android, and on
 * Android no named row that would just open that same chooser. */
export function mobileWalletLinksFor(os: MobileOs): readonly MobileWalletLink[] {
  return MOBILE_WALLET_LINKS.filter((l) => (l.id === 'other' ? os === 'android' : os !== 'android' || !isBareOnAndroid(l)));
}

/** A tile is disabled while another connect runs, and a tile that needs the
 * pairing URI is also disabled while that URI is still being prepared: a tap
 * then could not open anything (a link followed after an await is dropped). */
export function isWalletTileDisabled(p: { pendingId: string | null; prepareUid: string; isLink: boolean; needsUri: boolean }): boolean {
  if (!p.pendingId) return false;
  if (p.isLink && !p.needsUri) return false;
  if (p.pendingId === p.prepareUid) return p.isLink;
  return true;
}

/** Page URL handed to another app: origin + path only. The query and fragment
 * can carry app state (claim links keep secrets in the fragment). */
export function shareablePageUrl(loc: { origin: string; pathname: string } | undefined): string {
  if (!loc) return '';
  return `${loc.origin}${loc.pathname}`;
}

/** How long after a tap a still-visible page means the wallet did not open. */
export const WALLET_OPEN_CHECK_MS = 2_000;

/** Pending is per tile: only the tapped option. The shared pairing prepare is
 * not any tile's pending state (it is shown once, separately). */
export function isTilePending(pendingId: string | null, optionUid: string, prepareUid: string): boolean {
  return pendingId !== null && pendingId !== prepareUid && pendingId === optionUid;
}

/** Ids shown up front. Android: only the bare wc: tile (the OS "Open with"
 * sheet lists the installed wallets). Elsewhere: the top wallets. */
export function primaryMobileWalletIds(os: MobileOs): Set<string> {
  const links = mobileWalletLinksFor(os);
  if (os === 'android') return new Set(['other']);
  return new Set(links.slice(0, MOBILE_WALLET_PRIMARY_COUNT).map((l) => l.id));
}

/** Height cap for the wallet tile list in the connect sheet, so an expanded
 * list scrolls inside the sheet instead of running off the screen. */
export function walletListMaxHeight(windowHeight: number): number {
  return Math.max(240, Math.round(windowHeight * 0.55));
}
