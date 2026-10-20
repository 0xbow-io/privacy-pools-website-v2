import { describe, expect, test } from 'bun:test';
import {
  MOBILE_WALLET_LINKS, isTilePending, primaryMobileWalletIds, walletListMaxHeight, mobileOsFromUserAgent, mobileWalletLinksFor, shareablePageUrl,
} from '../wc-mobile-links';

const URI = 'wc:abc@2?relay-protocol=irn&symKey=k';
const E = encodeURIComponent(URI);
const PAGE = 'https://v2.privacypools.com/';
const link = (id: string) => MOBILE_WALLET_LINKS.find((l) => l.id === id)!;
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/130 Mobile Safari/537.36';

describe('mobile wallet links', () => {
  test('links carry the encoded pairing URI (RainbowKit getUri)', () => {
    expect(link('metamask').href(URI, PAGE, 'ios')).toBe(`https://metamask.app.link/wc?uri=${E}`);
    expect(link('coinbase').href(URI, PAGE, 'ios')).toBe(`https://go.cb-w.com/wc?uri=${E}`);
    expect(link('trust').href(URI, PAGE, 'ios')).toBe(`trust://wc?uri=${E}`);
    expect(link('okx').href(URI, PAGE, 'ios')).toBe(`okex://main/wc?uri=${E}`);
    expect(link('rainbow').href(URI, PAGE, 'ios')).toBe(`rainbow://wc?uri=${E}`);
    expect(link('rainbow').href(URI, PAGE, 'other')).toBe(`https://rnbwapp.com/wc?uri=${E}`);
    expect(link('uniswap').href(URI, PAGE, 'ios')).toBe(`uniswap://wc?uri=${E}`);
    expect(link('zerion').href(URI, PAGE, 'ios')).toBe(`zerion://wc?uri=${E}`);
    expect(link('bitget').href(URI, PAGE, 'ios')).toBe(`bitkeep://wc?uri=${E}`);
    expect(link('binance').href(URI, PAGE, 'ios')).toBe(`bnc://app.binance.com/cedefi/wc?uri=${E}`);
    expect(link('ledger').href(URI, PAGE, 'ios')).toBe(`ledgerlive://wc?uri=${E}`);
    expect(link('safepal').href(URI, PAGE, 'ios')).toBe(`safepalwallet://wc?uri=${E}`);
    expect(link('imtoken').href(URI, PAGE, 'ios')).toBe(`imtokenv2://wc?uri=${E}`);
    expect(link('bybit').href(URI, PAGE, 'ios')).toBe(`bybitapp://open/route?targetUrl=by://web3/walletconnect/wc?uri=${E}`);
  });
  test('the URI is fully encoded, never raw in a query', () => {
    for (const l of MOBILE_WALLET_LINKS.filter((x) => x.needsUri && x.id !== 'other')) {
      expect(l.href(URI, PAGE, 'ios')).not.toContain('symKey=k');
    }
  });
  test('Android gets the bare wc: URI where RainbowKit does', () => {
    for (const id of ['okx', 'rainbow', 'zerion', 'bitget', 'binance', 'ledger']) {
      expect(link(id).href(URI, PAGE, 'android')).toBe(URI);
    }
  });
  test('every wallet tile has a vendored data URI icon', () => {
    for (const l of MOBILE_WALLET_LINKS.filter((x) => x.id !== 'other')) {
      expect(l.icon?.startsWith('data:image/svg+xml,')).toBe(true);
    }
  });
  test('the Installed wallets tile is Android only', () => {
    expect(mobileOsFromUserAgent(ANDROID_UA)).toBe('android');
    expect(mobileOsFromUserAgent(IOS_UA)).toBe('ios');
    expect(mobileWalletLinksFor('android')[0].id).toBe('other');
    expect(link('other').href(URI, PAGE, 'android')).toBe(URI);
    expect(mobileWalletLinksFor('ios').some((l) => l.id === 'other')).toBe(false);
    expect(mobileWalletLinksFor('other').some((l) => l.id === 'other')).toBe(false);
  });
  test('the page URL drops query and fragment', () => {
    expect(shareablePageUrl({ origin: 'https://a.b', pathname: '/claim' })).toBe('https://a.b/claim');
    expect(shareablePageUrl(undefined)).toBe('');
  });
});

describe('tile pending state', () => {
  const PREP = 'wc:prepare';
  const uids = MOBILE_WALLET_LINKS.map((l) => `wc-uid:${l.id}`);
  test('the shared prepare marks no tile pending', () => {
    expect(uids.filter((u) => isTilePending(PREP, u, PREP))).toEqual([]);
  });
  test('only the tapped tile is pending', () => {
    expect(uids.filter((u) => isTilePending('wc-uid:trust', u, PREP))).toEqual(['wc-uid:trust']);
    expect(uids.filter((u) => isTilePending(null, u, PREP))).toEqual([]);
  });
});

describe('primary tiles', () => {
  test('Android shows only the native chooser tile up front', () => {
    expect([...primaryMobileWalletIds('android')]).toEqual(['other']);
  });
  test('iOS shows the top six wallets, no bare wc: tile', () => {
    expect([...primaryMobileWalletIds('ios')]).toEqual(['metamask', 'coinbase', 'trust', 'okx', 'rainbow', 'uniswap']);
  });
});

describe('iPadOS', () => {
  const IPAD_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
  test('desktop-style iPad UA with touch is iOS, a real Mac is not', () => {
    expect(mobileOsFromUserAgent(IPAD_UA, 5)).toBe('ios');
    expect(mobileOsFromUserAgent(IPAD_UA, 0)).toBe('other');
  });
});

describe('expanded list height', () => {
  test('the full list does not fit a phone, the cap keeps it inside the screen', () => {
    const phone = 667;
    expect(MOBILE_WALLET_LINKS.length * 76).toBeGreaterThan(phone);
    expect(walletListMaxHeight(phone)).toBeLessThan(phone);
    expect(walletListMaxHeight(300)).toBe(240);
  });
});

describe('cubic review on #295 (picker)', () => {
  test('Android: no named row opens the generic wc: chooser', async () => {
    const { mobileWalletLinksFor } = await import('../wc-mobile-links');
    const uri = 'wc:abc@2?relay-protocol=irn&symKey=1';
    const android = mobileWalletLinksFor('android');
    for (const l of android) {
      if (l.id === 'other' || !l.needsUri) continue;
      expect(l.href(uri, 'https://x', 'android')).not.toBe(uri);
    }
    const ids = android.map((l) => l.id);
    expect(ids).toContain('other');
    expect(ids).toContain('metamask');
    for (const gone of ['okx', 'rainbow', 'zerion', 'bitget', 'binance', 'ledger']) expect(ids).not.toContain(gone);
    // iOS keeps them all.
    expect(mobileWalletLinksFor('ios').map((l) => l.id)).toContain('okx');
  });

  test('URI rows are disabled while the pairing is being prepared, so a tap is never swallowed', async () => {
    const { isWalletTileDisabled } = await import('../wc-mobile-links');
    const prep = { pendingId: '__prepare__', prepareUid: '__prepare__' };
    expect(isWalletTileDisabled({ ...prep, isLink: true, needsUri: true })).toBe(true);
    expect(isWalletTileDisabled({ ...prep, isLink: true, needsUri: false })).toBe(false);
    expect(isWalletTileDisabled({ ...prep, isLink: false, needsUri: true })).toBe(false);
    expect(isWalletTileDisabled({ pendingId: null, prepareUid: '__prepare__', isLink: true, needsUri: true })).toBe(false);
    expect(isWalletTileDisabled({ pendingId: 'x', prepareUid: '__prepare__', isLink: false, needsUri: true })).toBe(true);
  });
});
