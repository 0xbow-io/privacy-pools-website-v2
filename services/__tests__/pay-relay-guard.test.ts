import { afterEach, describe, expect, test } from 'bun:test';
import {
  forgetPayRelayLatches,
  isPayRelayIndeterminate,
  latchPayRelay,
  leavePaymentLabel,
  leavePaymentWarning,
  onPayRelayLatchChange,
  PAY_RELAY_LATCH_MS,
  PayRelayDeadlineError,
  payRelayLatch,
  payRelayUnknownMessage,
  releasePayRelay,
  withRelayDeadline,
} from '../pay-relay-guard';

afterEach(() => forgetPayRelayLatches());

describe('the relay wait is bounded (DEV-486)', () => {
  test('a relay that never answers ends with a deadline error', async () => {
    const never = new Promise<string>(() => {});
    await expect(withRelayDeadline(never, 5)).rejects.toBeInstanceOf(PayRelayDeadlineError);
  });

  test('an answer before the deadline passes through, and so does a failure', async () => {
    expect(await withRelayDeadline(Promise.resolve('0xabc'), 50)).toBe('0xabc');
    await expect(withRelayDeadline(Promise.reject(new Error('Relay failed: nope')), 50)).rejects.toThrow('Relay failed: nope');
  });
});

describe('which failures may still have paid', () => {
  test('nothing can be unknown before the relay was handed over', () => {
    expect(isPayRelayIndeterminate('Pay relay deadline passed', false)).toBe(false);
  });

  test('a deadline or a dropped connection after hand-over is unknown', () => {
    expect(isPayRelayIndeterminate(new PayRelayDeadlineError().message, true)).toBe(true);
    expect(isPayRelayIndeterminate('Failed to fetch', true)).toBe(true);
  });

  test('every relayer answer that means "not sent" is known', () => {
    for (const msg of [
      'PoolVault transact failed: The contract function "transact" reverted. (PoolVault_InvalidASPRoot).',
      'Relay failed: The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account',
      'All configured relayers failed to quote: Fast Relay: HTTP 429: Too Many Requests',
      'Transaction reverted on-chain. Your notes were NOT spent.',
      'User rejected the request.',
    ]) {
      expect(isPayRelayIndeterminate(msg, true)).toBe(false);
    }
  });
});

describe('a request whose relay may still land cannot be paid again', () => {
  test('latched until the window passes, case-insensitively', () => {
    latchPayRelay('0xABC', false, 1_000);
    expect(payRelayLatch('0xabc', 1_001)).toEqual({ heard: false, until: 1_000 + PAY_RELAY_LATCH_MS.unheard });
    expect(payRelayLatch('0xabc', 1_000 + PAY_RELAY_LATCH_MS.unheard)).toBeNull();
  });

  test('a relay the relayer answered holds longer, and never downgrades', () => {
    latchPayRelay('r1', true, 0);
    latchPayRelay('r1', false, 1);
    expect(payRelayLatch('r1', PAY_RELAY_LATCH_MS.unheard + 5)?.heard).toBe(true);
  });

  test('released by a settled outcome, and listeners hear both', () => {
    let calls = 0;
    const stop = onPayRelayLatchChange(() => { calls += 1; });
    latchPayRelay('r2', false);
    releasePayRelay('r2');
    stop();
    expect(payRelayLatch('r2')).toBeNull();
    expect(calls).toBe(2);
  });

  test('survives a reload: the latch is read back from storage', () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    try {
      forgetPayRelayLatches(true);
      latchPayRelay('reload-me', true);
      // A fresh page: memory gone, storage kept.
      forgetPayRelayLatches(true);
      expect(payRelayLatch('reload-me')?.heard).toBe(true);
      releasePayRelay('reload-me');
      forgetPayRelayLatches(true);
      expect(payRelayLatch('reload-me')).toBeNull();
    } finally {
      g.localStorage = prev;
      forgetPayRelayLatches(true);
    }
  });

  test('a stale tab never erases another tab\'s latch', () => {
    const store = new Map<string, string>();
    const g = globalThis as { localStorage?: unknown };
    const prev = g.localStorage;
    g.localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    try {
      forgetPayRelayLatches(true);
      latchPayRelay('tab-b-request', false); // this tab, loaded before A wrote
      // Tab A writes its own latch straight to storage.
      const raw = JSON.parse(store.get('ppv2:pay-relay-latches') ?? '{}') as Record<string, unknown>;
      raw['tab-a-request'] = { until: Date.now() + 60_000, heard: true };
      store.set('ppv2:pay-relay-latches', JSON.stringify(raw));
      latchPayRelay('tab-b-other', false);
      forgetPayRelayLatches(true);
      expect(payRelayLatch('tab-a-request')?.heard).toBe(true);
    } finally {
      g.localStorage = prev;
      forgetPayRelayLatches(true);
    }
  });

  test('no key, no latch', () => {
    expect(payRelayLatch(null)).toBeNull();
  });
});

describe('Leave payment says what is running', () => {
  test('a private transfer before its relay leaves freely, as Cancel', () => {
    expect(leavePaymentWarning('preparing')).toBeNull();
    expect(leavePaymentLabel('preparing')).toBe('Cancel payment');
  });

  test('only the wallet path talks about the wallet', () => {
    expect(leavePaymentWarning('wallet')).toMatch(/wallet/);
    for (const phase of ['relaying', 'handed-over'] as const) {
      expect(leavePaymentWarning(phase)).not.toMatch(/wallet/i);
      expect(leavePaymentWarning(phase)).toMatch(/activity/);
    }
  });

  test('no em dashes in any of it', () => {
    const copy = [
      ...(['wallet', 'relaying', 'handed-over'] as const).map((p) => leavePaymentWarning(p) ?? ''),
      payRelayUnknownMessage(true),
      payRelayUnknownMessage(false),
    ];
    for (const line of copy) expect(line).not.toContain('—');
  });
});
