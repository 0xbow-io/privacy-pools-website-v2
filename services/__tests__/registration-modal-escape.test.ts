import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  describeInsufficientGas,
  describeUnpayableWallet,
  type GaslessRegistrationEligibility,
} from '../gasless-registration';
import { isSessionInitTimeout, withSessionInitTimeout } from '../session-init-timeout';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');
const MODAL = 'components/keystore-registration-modal-provider.tsx';

/**
 * QA, 2026-09-21: a wallet with no BNB was handed the registration transaction,
 * the wallet answered "insufficient funds", and the modal sat on "Registering…"
 * with the X and "Not now" both disabled and a close handler that early-returned
 * while pending. No escape, no explanation.
 *
 * The state machine lives in a .tsx that bun tests cannot import (react-native),
 * so the escape itself is pinned as a source guard — the same shape
 * services/__tests__/session-init-stranding.test.ts uses — and everything that
 * can be a pure function is tested as one.
 */
describe('the registration modal can always be closed', () => {
  test('the close handler no longer refuses while a transaction is pending', () => {
    const source = read(MODAL);
    // The exact line that made the X and "Not now" no-ops.
    expect(source).not.toMatch(/closeKeystoreRegistrationModal = useCallback\(\(\) => \{\s*if \(pending\) return;/);
    // And it clears the spinner itself, so a re-open is not born disabled.
    const close = source.slice(source.indexOf('const closeKeystoreRegistrationModal'));
    const body = close.slice(0, close.indexOf('}, ['));
    expect(body).toContain('setPending(false)');
    expect(body).toContain('setIsOpen(false)');
    // The caller that parked a flow still gets told.
    expect(body).toContain('cancel?.({ registered: false })');
  });

  test('neither exit is disabled by the pending state any more', () => {
    const source = read(MODAL);
    // Both exits used to carry `disabled={pending}`. The primary button still
    // does, and should: pressing Register twice is not an escape.
    const disabledOnPending = source.match(/disabled=\{pending( \|\| txUnconfirmed)?\}/g) ?? [];
    expect(disabledOnPending.length).toBe(1);
    expect(source).toMatch(/onPress=\{handleRegister\}\s*\n\s*disabled=\{pending \|\| txUnconfirmed\}/);
  });

  test('a run the user closed cannot resume the flow that opened it', () => {
    const source = read(MODAL);
    // A second open also orphans a run, but its callbacks are still the right
    // ones to deliver to — only a dismissal must silence them.
    expect(source).toContain('abandonedGenRef');
    expect(source).toMatch(/if \(deliversToCaller\(\)\) runOnSuccess\?\.\(\);/);
    expect(source).not.toMatch(/^\s*runOnSuccess\?\.\(\);/m);
  });
});

describe('the wait on a wallet prompt is bounded', () => {
  test('the send is wrapped in the shared timeout helper', () => {
    const source = read(MODAL);
    expect(source).toContain('withSessionInitTimeout');
    expect(source).toContain('WALLET_PROMPT_TIMEOUT_MS');
    // No bare send left behind: every leg goes through the bounded helper.
    expect(source).not.toMatch(/await sendTransactionAsync\(/);
  });

  test('a wallet that never answers releases the pending flag instead of pinning it', async () => {
    // The handler's shape: bound the send, and clear `pending` in a finally.
    // Without the bound the finally is never reached, which is the bug.
    let pending = false;
    let message = '';
    const neverAnswers = new Promise<string>(() => { /* a suspended wallet */ });

    pending = true;
    try {
      await withSessionInitTimeout(neverAnswers, { timeoutMs: 25 });
    } catch (err) {
      message = isSessionInitTimeout(err) ? 'wallet-timeout' : 'other';
    } finally {
      pending = false;
    }

    expect(message).toBe('wallet-timeout');
    expect(pending).toBe(false);
  });

  test('the copy for a closed-while-pending modal does not claim a cancellation', () => {
    const source = read(MODAL);
    const hint = source.match(/const PENDING_ESCAPE_HINT =\s*\n?\s*'([^']+)'/)?.[1] ?? '';
    expect(hint.length).toBeGreaterThan(0);
    // The transaction may still land. Saying "cancelled" would be a lie.
    expect(hint).not.toMatch(/cancel/i);
    expect(hint).toMatch(/still goes through/i);
    // House rule: sentence breaks, never em dashes.
    expect(hint).not.toContain('—');

    const timeoutCopy = source.match(/const WALLET_PROMPT_TIMEOUT_MESSAGE =\s*\n?\s*'([^']+)'/)?.[1] ?? '';
    expect(timeoutCopy).toMatch(/wallet/i);
    expect(timeoutCopy).not.toMatch(/cancel/i);
    expect(timeoutCopy).not.toContain('—');
  });
});

describe('a wallet that cannot pay is told so before it is asked to sign', () => {
  const eligible: GaslessRegistrationEligibility = { kind: 'eligible', mode: 'register', candidates: [] };
  const ineligible = (
    blocker: 'no-notes' | 'wallet-funded',
    walletCanPay: boolean | null,
  ): GaslessRegistrationEligibility => ({ kind: 'ineligible', blocker, walletCanPay });

  test('the probe is no longer gated on the caller allowing the gasless path', () => {
    const source = read(MODAL);
    // This gate is what made the warning unreachable for deposit and ragequit,
    // the two callers whose comments say they rely on it.
    expect(source).not.toMatch(/if \(!isOpen \|\| !gaslessAllowed/);
    expect(source).toMatch(/if \(!isOpen \|\| !keysReady/);
  });

  test('a caller that forbids the gasless path still gets a warning for a stranded wallet', () => {
    // Deposit / ragequit: the relayer COULD register this wallet, but the flow
    // behind the registration needs the wallet to pay for itself anyway.
    const warning = describeUnpayableWallet(eligible, 'BNB', { gaslessAllowed: false });
    expect(warning).toContain('BNB');
    expect(warning).toMatch(/send a little/i);
    expect(warning).not.toContain('—');
  });

  test('the warning stays silent where the gasless button is the answer', () => {
    expect(describeUnpayableWallet(eligible, 'BNB', { gaslessAllowed: true })).toBeNull();
    // A funded wallet is not stranded on either setting.
    expect(describeUnpayableWallet(ineligible('wallet-funded', true), 'ETH', { gaslessAllowed: false })).toBeNull();
    expect(describeUnpayableWallet(null, 'ETH', { gaslessAllowed: false })).toBeNull();
  });

  test('a dead end the probe already described keeps its own copy', () => {
    const warning = describeUnpayableWallet(ineligible('no-notes', false), 'ETH', { gaslessAllowed: true });
    expect(warning).toMatch(/no ETH for gas/);
  });
});

describe('an insufficient-funds rejection becomes something actionable', () => {
  test('the wallet strings QA saw are recognised, and the answer names the chain', () => {
    for (const raw of [
      'insufficient funds for gas * price + value',
      'You do not have enough BNB in your account to pay for network fees',
      'Insufficient balance for transaction',
    ]) {
      const line = describeInsufficientGas(raw, 'BNB', 'BNB Chain');
      expect(line).toContain('BNB Chain');
      expect(line).toMatch(/^You need BNB/);
      expect(line).toMatch(/add some/i);
      expect(line).not.toContain('—');
      // One short line, not a paragraph.
      expect(line!.split('. ').length).toBeLessThanOrEqual(2);
    }
  });

  test('anything else falls through to the real message', () => {
    expect(describeInsufficientGas('User rejected the request.', 'ETH', 'Ethereum')).toBeNull();
    expect(describeInsufficientGas('Keystore registration reverted on-chain.', 'ETH', 'Ethereum')).toBeNull();
  });
});
