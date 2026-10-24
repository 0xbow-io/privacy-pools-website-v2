import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), 'utf8');

// Mike's QA pass of 2026-09-24, the UI half.
describe('QA 2026-09-24 UI', () => {
  test('the balances card lists every pool, with no "Show all" footer', () => {
    const src = read('components/pools/my-privacy-pools.tsx');
    expect(src).not.toContain('Show all my Privacy Pools');
    expect(src).not.toContain('POOL_ROW_LIMIT');
    expect(src).toContain('const visiblePools = pools;');
  });

  test('the Payment Requests card collapses', () => {
    const src = read('components/payment-requests-card.tsx');
    expect(src).toContain("useCollapsed('payment-requests')");
    expect(src).toContain('owner && !collapsed ?');
  });

  test('the hub asset chips show logos, not dots', () => {
    const src = read('components/home/action-hub.tsx');
    expect(src).toContain('<TokenMark symbol={t.symbol} size={14} />');
    expect(src).not.toContain('token dot uses the runtime per-asset hue');
  });

  test('Send shows no amount limits without an account', () => {
    const src = read('components/transfer-modal-provider.tsx');
    const memo = src.slice(src.indexOf('const amountError = useMemo'), src.indexOf("const recipientError"));
    expect(memo).toContain('if (!connectedAddress) return null;');
    expect(src).toContain('{!!connectedAddress && enteredAmount > 0 && enteredAmountWei > maxSpendableWei && (');
  });
});

describe('QA 2026-09-24 mobile connect', () => {
  test('"Open in installed wallet" follows the wallet link from the tap, not from display_uri', () => {
    const src = read('components/wallet-connect-modal-provider.tsx');
    const handler = src.slice(src.indexOf('const handler = (msg: unknown)'), src.indexOf("option.connector.emitter.on('message', handler)"));
    expect(handler).not.toContain('openURL');
    expect(handler).toContain("setWcView(option.kind === 'wc-deeplink' ? 'wallets' : 'qr')");
    expect(src).toContain('window.location.href = href;');
    expect(src).toContain('https://metamask.app.link/wc?uri=');
  });

  test('a wallet link no app took says so on the list', () => {
    const src = read('components/wallet-connect-modal-provider.tsx');
    expect(src).toContain("if (document.visibilityState === 'visible') setNotOpened(name);");
  });
});
