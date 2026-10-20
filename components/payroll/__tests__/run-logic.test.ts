import { describe, test, expect } from 'bun:test';

import { buildRunItems, resolvePayrollTransferParams, applyMarkPaid, buildRunsCsv } from '@/components/payroll/io';
import type { Employee, PayrollRun, PayrollRunItem } from '@/services/payroll-store';

function employee(over: Partial<Employee> = {}): Employee {
  return {
    id: 'e1',
    name: 'Ada',
    role: 'Engineer',
    walletAddress: '0x1111111111111111111111111111111111111111',
    network: 'Ethereum',
    salary: 1000,
    currency: 'USDC',
    status: 'active',
    createdAt: 0,
    ...over,
  };
}

function item(over: Partial<PayrollRunItem> = {}): PayrollRunItem {
  return {
    employeeId: 'e1',
    name: 'Ada',
    walletAddress: '0x1111111111111111111111111111111111111111',
    network: 'Ethereum',
    amount: 1000,
    currency: 'USDC',
    status: 'pending',
    ...over,
  };
}

function run(items: PayrollRunItem[], status: PayrollRun['status'] = 'pending'): PayrollRun {
  return { id: 'run1', date: 0, periodLabel: 'July 2026', items, status };
}

describe('buildRunItems', () => {
  test('includes only active employees, mapped to pending items', () => {
    const employees = [
      employee({ id: 'a', status: 'active' }),
      employee({ id: 'b', status: 'onboarding' }),
      employee({ id: 'c', status: 'paused' }),
      employee({ id: 'd', status: 'active' }),
    ];
    const items = buildRunItems(employees);
    expect(items.map((i) => i.employeeId)).toEqual(['a', 'd']);
    expect(items.every((i) => i.status === 'pending')).toBe(true);
  });

  test('carries salary/currency through as the item amount/currency', () => {
    const items = buildRunItems([employee({ id: 'a', salary: 4200, currency: 'ETH' })]);
    expect(items[0].amount).toBe(4200);
    expect(items[0].currency).toBe('ETH');
  });
});

describe('resolvePayrollTransferParams', () => {
  // Stub chain deps: 'Ethereum' resolves to chain 1, which knows the three
  // pool symbols. Everything else is unknown/unsupported.
  const deps = {
    resolveChainId: (network: string) => (network === 'Ethereum' ? 1 : undefined),
    getToken: (symbol: string, chainId: number) =>
      chainId === 1 && ['ETH', 'USDC', 'USDT'].includes(symbol)
        ? { decimals: symbol === 'ETH' ? 18 : 6 }
        : undefined,
  };
  const ok = (r: ReturnType<typeof resolvePayrollTransferParams>) => {
    if ('refusal' in r) throw new Error(`unexpected refusal: ${r.refusal}`);
    return r;
  };

  test('uses the exact amount text, never exponent notation', () => {
    expect(ok(resolvePayrollTransferParams(item({ amount: 1234.5 }), deps)).amount).toBe('1234.5');
    expect(ok(resolvePayrollTransferParams(item({ amount: 1000 }), deps)).amount).toBe('1000');
    // amountText wins over the display number when present.
    expect(ok(resolvePayrollTransferParams(item({ currency: 'ETH', amount: 0.1, amountText: '0.100000000000000001' }), deps)).amount).toBe('0.100000000000000001');
    // tiny legacy number values expand instead of emitting '1e-7'.
    expect(ok(resolvePayrollTransferParams(item({ currency: 'ETH', amount: 1e-7 }), deps)).amount).toBe('0.0000001');
  });

  test('a zero/invalid amount is a refusal, not a 0-value transfer', () => {
    const r = resolvePayrollTransferParams(item({ amount: 0 }), deps);
    expect('refusal' in r).toBe(true);
  });

  // codex: extra fraction digits silently round at parseUnits — 0.0000001
  // USDC is ZERO base units. Refuse instead of executing a different amount.
  test('an amount finer than the token precision is a refusal', () => {
    const r = resolvePayrollTransferParams(item({ currency: 'USDC', amount: 0.1, amountText: '0.0000001' }), deps);
    expect('refusal' in r && /decimal places/.test(r.refusal)).toBe(true);
    const ok18 = resolvePayrollTransferParams(item({ currency: 'ETH', amount: 0.1, amountText: '0.000000000000000001' }), deps);
    expect('refusal' in ok18).toBe(false);
  });

  test('passes a supported pool currency through', () => {
    expect(ok(resolvePayrollTransferParams(item({ currency: 'ETH' }), deps)).tokenSymbol).toBe('ETH');
    expect(ok(resolvePayrollTransferParams(item({ currency: 'USDT' }), deps)).tokenSymbol).toBe('USDT');
    expect(ok(resolvePayrollTransferParams(item({ currency: 'USDC' }), deps)).tokenSymbol).toBe('USDC');
  });

  // codex round 3: the old fallback silently substituted USDC for any
  // unsupported currency — a DAI row would pay a different asset entirely.
  test('an unsupported currency is a REFUSAL, never a silent USDC substitution', () => {
    const dai = resolvePayrollTransferParams(item({ currency: 'DAI' }), deps);
    expect('refusal' in dai && /DAI/.test(dai.refusal)).toBe(true);
    const empty = resolvePayrollTransferParams(item({ currency: '' }), deps);
    expect('refusal' in empty).toBe(true);
  });

  test('an unknown network is a refusal', () => {
    const r = resolvePayrollTransferParams(item({ network: 'Base' }), deps);
    expect('refusal' in r && /Base/.test(r.refusal)).toBe(true);
  });

  test('an explicit item chainId overrides the network lookup', () => {
    const r = ok(resolvePayrollTransferParams(item({ network: 'Base', chainId: 1 }), deps));
    expect(r.tokenSymbol).toBe('USDC');
  });

  test('forwards the wallet address as the recipient', () => {
    const it = item({ walletAddress: '0x2222222222222222222222222222222222222222' });
    expect(ok(resolvePayrollTransferParams(it, deps)).recipient).toBe(it.walletAddress);
  });
});

describe('applyMarkPaid', () => {
  const two = () => run([item({ employeeId: 'a' }), item({ employeeId: 'b' })]);

  test('marks only the matching employee paid and stamps the txHash', () => {
    const { items } = applyMarkPaid(two(), 'a', '0xabc');
    const a = items.find((i) => i.employeeId === 'a')!;
    const b = items.find((i) => i.employeeId === 'b')!;
    expect(a.status).toBe('paid');
    expect(a.txHash).toBe('0xabc');
    expect(b.status).toBe('pending');
    expect(b.txHash).toBeUndefined();
  });

  test('promotes to confirmed only once the last item pays', () => {
    const first = applyMarkPaid(two(), 'a', '0x1');
    expect(first.status).toBe('pending'); // b still unpaid

    const second = applyMarkPaid(run(first.items), 'b', '0x2');
    expect(second.status).toBe('confirmed');
    expect(second.items.every((i) => i.status === 'paid')).toBe(true);
  });

  test('never reverts an already-paid item', () => {
    const paidA = run([item({ employeeId: 'a', status: 'paid', txHash: '0xkeep' }), item({ employeeId: 'b' })]);
    const { items } = applyMarkPaid(paidA, 'b', '0x2');
    const a = items.find((i) => i.employeeId === 'a')!;
    // Re-marking b leaves a paid, with its original txHash intact.
    expect(a.status).toBe('paid');
    expect(a.txHash).toBe('0xkeep');
  });

  test('keeps the existing txHash when none is supplied', () => {
    const paidA = run([item({ employeeId: 'a', status: 'paid', txHash: '0xkeep' })]);
    const { items, status } = applyMarkPaid(paidA, 'a', undefined);
    expect(items[0].txHash).toBe('0xkeep');
    expect(status).toBe('confirmed');
  });
});

describe('buildRunsCsv', () => {
  test('emits the header and one row per payment (run × recipient)', () => {
    const r = run([item({ employeeId: 'a', name: 'Ada' }), item({ employeeId: 'b', name: 'Bo' })]);
    const lines = buildRunsCsv([r]).split('\n');
    expect(lines[0]).toBe('Period,Date,Payee,Wallet,Network,Amount,Currency,Status,Tx Hash');
    expect(lines).toHaveLength(3); // header + 2 payments
    expect(lines[1]).toContain('Ada');
    expect(lines[2]).toContain('Bo');
  });

  test('renders the run date as an ISO day and the amount as a raw number', () => {
    const r = run([item({ amount: 8260, currency: 'USDC', network: 'sepolia' })]);
    const [, row] = buildRunsCsv([r]).split('\n');
    // date=0 → 1970-01-01; amount stays plain (no symbol, no separator).
    expect(row).toBe('July 2026,1970-01-01,Ada,0x1111111111111111111111111111111111111111,sepolia,8260,USDC,pending,');
  });

  test('quotes a field containing a comma and doubles embedded quotes', () => {
    const r = run([item({ name: 'Doe, Jane "JD"' })]);
    const [, row] = buildRunsCsv([r]).split('\n');
    expect(row).toContain('"Doe, Jane ""JD"""');
  });

  test('leaves the Tx Hash cell empty when a payment has none, filling it when present', () => {
    const withHash = run([item({ txHash: '0xabc' })]);
    const withoutHash = run([item({ txHash: undefined })]);
    expect(buildRunsCsv([withHash]).split('\n')[1].endsWith(',0xabc')).toBe(true);
    expect(buildRunsCsv([withoutHash]).split('\n')[1].endsWith(',')).toBe(true);
  });

  test('is just the header when there are no runs', () => {
    expect(buildRunsCsv([])).toBe('Period,Date,Payee,Wallet,Network,Amount,Currency,Status,Tx Hash');
  });
});
