import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SECURE_STORE_KEY, legacyMigratedKey, legacyRowsForEnvironment, payrollKey } from '../payroll-scope';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

describe('payroll storage scope', () => {
  test('keys differ per environment and per identity, case-insensitively', () => {
    const a = payrollKey('emp', { envId: 'prod', owner: '0xAbC' });
    expect(a).toBe(payrollKey('emp', { envId: 'prod', owner: '0xabc' }));
    expect(a).not.toBe(payrollKey('emp', { envId: 'staging', owner: '0xabc' }));
    expect(a).not.toBe(payrollKey('emp', { envId: 'prod', owner: '0xdef' }));
    expect(legacyMigratedKey('prod')).not.toBe(legacyMigratedKey('staging'));
  });

  test('every key fits native SecureStore (no colons)', () => {
    for (const k of [
      payrollKey('ppv2_payroll_employees_v2', { envId: 'staging', owner: '0xAbCdEf0123456789aBcDeF0123456789ABCDEF01' }),
      payrollKey('ppv2_payroll_runs_v2', { envId: 'prod', owner: null }),
      legacyMigratedKey('prod'),
    ]) expect(k).toMatch(SECURE_STORE_KEY);
  });

  // prod serves Ethereum + BSC; staging serves Sepolia + Ethereum + OP.
  const prod = { network: (n: string) => ['Ethereum', 'BNB Chain'].includes(n), chain: (id: number) => [1, 56].includes(id) };
  const staging = { network: (n: string) => ['Sepolia', 'Ethereum', 'Optimism'].includes(n), chain: (id: number) => [11155111, 1, 10].includes(id) };
  const employees = [{ network: 'Sepolia' }, { network: 'Ethereum' }, { network: 'Optimism' }, { network: 'BNB Chain' }, {}];
  const runs = [{ chainId: 11155111 }, { chainId: 1 }, { chainId: 10 }, { items: [{ network: 'Sepolia' }] }, { items: [] }];

  test('prod takes the chains only it serves plus every overlap', () => {
    const r = legacyRowsForEnvironment(employees, runs, prod, staging, true);
    expect(r.employees).toEqual([{ network: 'Ethereum' }, { network: 'BNB Chain' }]);
    expect(r.runs).toEqual([{ chainId: 1 }]);
  });

  test('staging takes only what prod cannot serve, so no row lands in both', () => {
    const r = legacyRowsForEnvironment(employees, runs, staging, prod, false);
    expect(r.employees).toEqual([{ network: 'Sepolia' }, { network: 'Optimism' }]);
    expect(r.runs).toEqual([{ chainId: 11155111 }, { chainId: 10 }, { items: [{ network: 'Sepolia' }] }]);
    const both = r.employees.filter((e) => legacyRowsForEnvironment([e], [], prod, staging, true).employees.length > 0);
    expect(both).toEqual([]);
  });

  test('the store never reads or writes the shared legacy keys outside the one-time migration', () => {
    const src = readFileSync(join(ROOT, 'services/payroll-store.ts'), 'utf8');
    for (const key of ['EMP_KEY', 'RUNS_KEY', 'SETTINGS_KEY']) {
      expect(src).not.toContain(`rawSet(${key}`);
      const reads = src.split(`rawGet(${key})`).length - 1;
      expect(reads).toBe(1);
    }
    expect(src).toContain('function migrateLegacy');
  });

  test('the payroll hook scopes by the session identity, not the wagmi address alone', () => {
    const src = readFileSync(join(ROOT, 'hooks/use-payroll.ts'), 'utf8');
    expect(src).toContain('sessionAddress ?? connectedAddress');
    expect(src).toContain('getSnapshotFor(owner)');
  });

  test('payroll refusals are shown in the app, not with a browser alert', () => {
    const src = readFileSync(join(ROOT, 'components/payroll/run.tsx'), 'utf8');
    expect(src).not.toContain('window.alert');
    expect(src).toContain('payroll-run-notice');
  });
});
