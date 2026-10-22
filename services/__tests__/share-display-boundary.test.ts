import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
const providers = ['withdraw', 'transfer', 'swap', 'payment-request', 'ragequit', 'deposit'].map(n => `components/${n}-modal-provider.tsx`);
const amountServices = readdirSync(join(root, 'services')).filter(n => /^(?:relayed-(?:transfer|withdrawal)|withdraw-|transfer-|send-amount|swap-flows|payment-request-deposit|token-amount)/.test(n) && n.endsWith('.ts')).map(n => `services/${n}`);

test('operation providers and amount services never import the underlying display service', () => {
  for (const file of [...providers, ...amountServices]) {
    expect(read(file), file).not.toMatch(/from\s+['"][^'"]*share-balance-display['"]/);
    expect(read(file), file).not.toMatch(/(?:amount|value|fromAmountWei|grossWei|netAmount|feeAmount|amountWei):\s*(?:balanceDisplay|shareBalanceDisplay|shareUsdDisplayExact|amountField\.(?:value|usdValue))/);
    expect(read(file), file).not.toMatch(/(?:parseUnits|parseTokenAmount)\(\s*(?:balanceDisplay|shareBalanceDisplay|shareExactAsUnderlying|shareUsdDisplayExact|amountField\.(?:value|usdValue))/);
  }
});

test('MAX and submitted units remain the original exact share state', () => {
  const hub = read('components/home/action-hub.tsx');
  expect(hub).toContain('formatUnits(withdrawMaxWei, tokenMeta.decimals)');
  expect(hub).toContain('setAmount(next);');
  expect(hub).toContain('pushWithdrawAmount(next)');
  expect(hub).toContain('pushTransferAmount(next)');
  expect(read('components/transfer-modal-provider.tsx')).toContain('amount ? parseUnits(amount, selectedDecimals) : 0n');
  expect(read('components/withdraw-modal-provider.tsx')).toContain('parseTokenAmount(amount, tokenDecimalsForDisplay)');
  expect(read('components/swap-modal-provider.tsx')).toContain('parseTokenAmount(amount, fromToken.decimals)');
  expect(read('components/payment-request-modal-provider.tsx')).toContain('parseUnits(amountInput, selectedToken.decimals)');
  expect(hub).not.toMatch(/setAmount\([^\n]*(?:pageBalanceView|pagePendingView|\.usd)/);
});

test('the only underlying entry boundary is called by the Withdraw/Send field adapter', () => {
  for (const file of [...providers, ...amountServices]) {
    expect(read(file), file).not.toMatch(/shareAmountFromUnderlying\(/);
  }
  expect(read('hooks/use-share-amount-field.ts')).toContain('shareAmountFromUnderlying({');
  expect(read('services/share-amount-entry.ts')).not.toMatch(/Number\(|parseFloat\(|Math\./);
  expect(read('components/home/action-hub.tsx')).toContain("underlyingEntry: action === 'withdraw' || action === 'send'");
});

// Known non-share fallbacks are exact line allowlists. A new raw print fails.
const allowed = new Set([
  'components/pools/my-privacy-pools.tsx:const balanceText = balanceView ? balanceView.text : approxUnderlyingText(pool.balanceToken, pool.name);',
  'components/pools/my-privacy-pools.tsx:const pendingText = pendingView ? pendingView.text : approxUnderlyingText(pool.pendingToken, pool.name);',
]);
test('raw pool balances never bypass the display boundary beside a coin name', () => {
  const files = [
    'components/home/action-hub.tsx', 'components/pools/pool-page-content.tsx',
    'components/pools/my-privacy-pools.tsx', 'components/pools/pool-action-panel.tsx',
    'components/ui/token-select-sheet.tsx', 'components/pools/transactions.tsx',
    'components/home/latest-activity.tsx', 'components/ui/notification-center.tsx',
    'components/payment-requests-card.tsx', 'components/audit-export-modal-provider.tsx',
    'components/consolidation-panel.tsx', 'components/portfolio-provider.tsx',
    'components/portfolio/all-positions.tsx', 'components/portfolio/portfolio-page-content.tsx',
    'app/receive/[encoded].tsx', ...providers,
  ];
  const offenders: string[] = [];
  for (const file of files) {
    for (const line of read(file).split('\n')) {
      if (/(?:approxUnderlyingText|tokenAmountLabel|formatTokenBalance(?:Down)?)\([^\n]*(?:pool\??\.(?:balanceToken|pendingToken)|pageShielded\.(?:balance|pending)|displayAvailableNum|spendableNum)/.test(line)
        && !allowed.has(`${file}:${line.trim()}`)) offenders.push(`${file}:${line.trim()}`);
    }
  }
  expect(offenders).toEqual([]);
  expect(read('hooks/use-balance-display.ts')).toContain('return shareBalanceDisplay({');
  expect(read('hooks/use-balance-display.ts')).not.toMatch(/useQuery|fetch\(|enabled:|refetch/);
});


test('USD entry is gated on real prices and positive edits cannot submit zero silently', () => {
  const field = read('hooks/use-share-amount-field.ts');
  expect(field).toContain("if (denomination === 'usd' && !usdAvailable) return amount;");
  expect(field).toContain("tooSmall: /[1-9]/.test(text) && shares === '0'");
  expect(field).toContain("'Amount is too small.'");
  expect(field).not.toMatch(/useEffect|usdToTokenAmount/);
  const hub = read('components/home/action-hub.tsx');
  expect(hub).toContain("amountField.toShares(text, 'usd')");
  expect(hub).toContain('shareFiatEntry ? amountField.usdValue : usdInput');
  expect(hub).toContain('{amountField.error}');
  expect(hub).toContain("((a === 'withdraw' || a === 'send') && !!amountField.error)");
});
