import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { requestWalletRefusal } from '@/services/request-wallet-rule';

// DEV-422: the page said "Wallet payment is not available for this yield pool"
// while "Pay via Wallet" stayed live. Both buttons and the handler must take the
// decision from the one helper. (config/tokens cannot load under bun, so the
// wiring is checked in source and the rule itself below.)
const root = join(new URL('.', import.meta.url).pathname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

test('a yield-pool request is refused for wallet payment', () => {
  expect(requestWalletRefusal({ symbol: 'ppUSDC', isNative: false, yieldShare: true }, false)).toContain('not available for this yield pool');
  expect(requestWalletRefusal({ symbol: 'USDC', isNative: false }, false)).toBeNull();
});

test('the /pay page hides Pay via Wallet behind the shared refusal', () => {
  const src = read('app/pay/[encoded].tsx');
  expect(src).toContain('requestWalletRefusalFor(request)');
  const gate = src.indexOf("identityMode !== 'key' && walletRefusal ?");
  expect(gate).toBeGreaterThan(-1);
  expect(gate).toBeLessThan(src.indexOf("onPress={() => launchPay('wallet')}"));
});

test('the modal hides Pay via Wallet behind the same refusal the handler throws', () => {
  const src = read('components/payment-request-modal-provider.tsx');
  expect(src).toContain('const walletRefusal = requestWalletRefusalFor(request);');
  expect(src).toContain('if (walletRefusal) throw new Error(walletRefusal);');
  expect(src).toContain('requestWalletRefusalFor(previewPayRequest)');
  const gate = src.indexOf('{!walletAddress ? null : previewWalletRefusal ? (');
  expect(gate).toBeGreaterThan(-1);
  expect(gate).toBeLessThan(src.indexOf('onPress={handlePayRequest}'));
  expect(src).not.toContain('requestWalletRefusal(');
});
