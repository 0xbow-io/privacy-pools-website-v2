// Stellar testnet integration: the pure pieces behind the PR #166 review fixes.
//   - the account export never persists beyond the tab, and older plaintext
//     copies are purged from localStorage;
//   - Max never offers an amount whose relay fee does not fit;
//   - spendable XLM excludes what open sell offers lock;
//   - SDK note-state errors are not mistaken for an unfunded wallet.

import { describe, expect, test } from 'bun:test';

import {
  accountStorageKey,
  isLegacyStellarAccountKey,
  purgeLegacyStellarAccountCopies,
  readSessionAccount,
  writeSessionAccount,
} from '@/services/stellar/stellar-account-storage';
import { estimateStellarRelayFee, maxStellarWithdrawForInputs, STELLAR_MAX_RELAY_FEE } from '@/config/stellar-deployment';
import { stellarErrorMessage } from '@/services/stellar/stellar-copy';
import { stellarBalanceFromAccount } from '@/hooks/use-stellar-balance';

const G = `G${'A'.repeat(55)}`;
const G2 = `G${'B'.repeat(55)}`;

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => { map.set(k, v); },
    removeItem: (k: string) => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}

describe('Stellar account storage', () => {
  test('recognises both legacy plaintext layouts and nothing else', () => {
    expect(isLegacyStellarAccountKey(`ppv2_stellar_account_202_${G}`)).toBe(true);
    expect(isLegacyStellarAccountKey(`ppv2_stellar_202_${G}_:note-manager-state:x`)).toBe(true);
    expect(isLegacyStellarAccountKey(`ppv2_stellar_label_pending_v2_202_${G}`)).toBe(false);
    expect(isLegacyStellarAccountKey(`ppv2_stellar_label_pending_202_${G}`)).toBe(false);
    expect(isLegacyStellarAccountKey('ppv2_stellar_connected')).toBe(false);
    expect(isLegacyStellarAccountKey(`ppv2_account_export_${G}`)).toBe(false);
  });

  test('purge removes every legacy copy and keeps the retry markers', () => {
    const storage = memoryStorage({
      [`ppv2_stellar_account_202_${G}`]: '{"notes":[{"noteSecret":"0x1"}]}',
      [`ppv2_stellar_202_${G2}_:note-manager-state:abc`]: '{"notes":[]}',
      [`ppv2_stellar_label_pending_v2_202_${G}`]: '[]',
      ppv2_stellar_connected: '1',
    });
    expect(purgeLegacyStellarAccountCopies(storage)).toBe(2);
    expect(storage.keys().sort()).toEqual([`ppv2_stellar_label_pending_v2_202_${G}`, 'ppv2_stellar_connected'].sort());
  });

  test('session round trip under the per-account key', () => {
    const session = memoryStorage();
    writeSessionAccount(202, G, { notes: [1], syncCursor: '0x0' }, session);
    expect(session.keys()).toEqual([accountStorageKey(202, G)]);
    expect(readSessionAccount<{ notes: number[] }>(202, G, session)?.notes).toEqual([1]);
    expect(readSessionAccount(202, G2, session)).toBeNull();
  });

  test('missing or throwing storage degrades to nothing', () => {
    expect(readSessionAccount(202, G, null)).toBeNull();
    expect(() => writeSessionAccount(202, G, {}, null)).not.toThrow();
    const broken = { ...memoryStorage(), getItem: () => { throw new Error('blocked'); } };
    expect(readSessionAccount(202, G, broken)).toBeNull();
  });
});

describe('Stellar withdraw cap', () => {
  test('amount + fee always fits the inputs, and is close to the best', () => {
    for (const inputs of [0n, 1n, 10_000_000n, 123_456_789n, 999_999_999n, 50_000_000_000n, 1_000_000_000_000n]) {
      const max = maxStellarWithdrawForInputs(inputs);
      // Inputs at or under the fee's fixed cost term cannot fund any withdrawal.
      if (max > 0n) expect(max + estimateStellarRelayFee(max)).toBeLessThanOrEqual(inputs);
      if (inputs > 0n) {
        const next = max + 2n;
        expect(next + estimateStellarRelayFee(next)).toBeGreaterThan(inputs);
      }
    }
  });

  test('uses the fee cap once it binds', () => {
    const inputs = 1_000_000_000_000n; // 100k XLM: 0.5% is far above the cap
    expect(maxStellarWithdrawForInputs(inputs)).toBe(inputs - STELLAR_MAX_RELAY_FEE);
  });
});

describe('Stellar spendable balance', () => {
  test('subtracts reserve, fee headroom and selling liabilities', () => {
    const base = { subentry_count: 0 };
    const free = stellarBalanceFromAccount({ ...base, balances: [{ asset_type: 'native', balance: '100.0000000' }] });
    const offered = stellarBalanceFromAccount({
      ...base,
      balances: [{ asset_type: 'native', balance: '100.0000000', selling_liabilities: '40.0000000' }],
    });
    expect(free.total).toBe(1_000_000_000n);
    expect(free.spendable - offered.spendable).toBe(400_000_000n);
  });

  test('never negative', () => {
    const b = stellarBalanceFromAccount({ subentry_count: 3, balances: [{ asset_type: 'native', balance: '1.0000000', selling_liabilities: '0.5' }] });
    expect(b.spendable).toBe(0n);
  });
});

describe('Stellar error copy', () => {
  test('note-state errors are not wallet-funding errors', () => {
    expect(stellarErrorMessage('Insufficient value for transact: available=0x1, requested=0x2')).toMatch(/private notes/);
    expect(stellarErrorMessage('Transact failed: note 0xabc is not ACTIVE')).toMatch(/Sync and try again/);
    expect(stellarErrorMessage(`Recipient ${G} has no on-chain viewing key — pass allowOutOfBandFallback`)).toMatch(/recipient has not set up/i);
    expect(stellarErrorMessage('tx failed: insufficient balance')).toMatch(/Not enough XLM/);
  });

  test('an indexer outage names the indexer, not the ASP', () => {
    expect(stellarErrorMessage('Stellar testnet indexer unreachable: TypeError: Failed to fetch')).toMatch(/indexer is not reachable/);
    expect(stellarErrorMessage('Stellar testnet ASP unreachable at https://x: 502')).toMatch(/ASP is not reachable/);
  });

  test('a contract rejection shows its code, not the diagnostic log', () => {
    const raw = 'Simulation failed: HostError: Error(Contract, #21)\n\nEvent log (newest first):\n   0: [Diagnostic Event] data:["balance", 1]';
    const message = stellarErrorMessage(raw);
    expect(message).toMatch(/error #21/);
    expect(message).not.toMatch(/Diagnostic|Not enough XLM/);
  });

  test('user-facing copy has no em dashes', () => {
    for (const raw of ['Insufficient value for transact', 'is not ACTIVE', 'no on-chain viewing key', 'ASPUnavailable', 'balance']) {
      expect(stellarErrorMessage(raw)).not.toContain('—');
    }
  });
});
