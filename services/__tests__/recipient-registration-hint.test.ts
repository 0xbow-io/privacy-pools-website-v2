import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  isCheckableRecipient,
  LEARN_MORE_UNREGISTERED_LABEL,
  recipientDepositConflict,
  recipientRegistrationHint,
  UNREGISTERED_DEPOSIT_DOCS_URL,
} from '../recipient-registration-hint';

describe('recipientRegistrationHint', () => {
  test('a registered recipient explains access, while an empty field stays quiet', () => {
    expect(recipientRegistrationHint('registered')?.text).toContain('recipient must sign in');
    expect(recipientRegistrationHint('idle')).toBeNull();
  });

  test('an unregistered recipient explains the claim link and offers to learn more', () => {
    const hint = recipientRegistrationHint('unregistered');
    expect(hint?.learnMore).toBe(true);
    expect(hint?.tone).toBe('warning');
    expect(hint?.text).toContain('one-time claim link');
  });

  test('the unregistered line names the network that was checked', () => {
    expect(recipientRegistrationHint('unregistered', 'Ethereum')?.text)
      .toBe('This address hasn’t set up Privacy Pools on Ethereum yet. You’ll get a one-time claim link to send them.');
    expect(recipientRegistrationHint('unregistered')?.text).not.toContain(' on ');
  });

  test('checking and unknown are quiet states without a link', () => {
    expect(recipientRegistrationHint('checking')).toEqual({ text: 'Checking whether this address is registered…', learnMore: false, tone: 'muted' });
    expect(recipientRegistrationHint('unknown')?.learnMore).toBe(false);
  });

  test('the docs link is the live user-facing page, with the app-wide label', () => {
    expect(UNREGISTERED_DEPOSIT_DOCS_URL).toBe('https://privacy-pools-v2-docs.vercel.app/using/deposit-to-unregistered');
    expect(LEARN_MORE_UNREGISTERED_LABEL).toBe('Learn more about deposits to unregistered addresses');
  });
});

describe('recipientDepositConflict', () => {
  test('a wallet session can deposit for someone else, yield pools included (DEV-451)', () => {
    expect(recipientDepositConflict({})).toBeNull();
    expect(recipientDepositConflict({ keySession: false })).toBeNull();
  });

  test('an account-key session is told it needs a wallet, not that the token is wrong', () => {
    const text = recipientDepositConflict({ keySession: true });
    expect(text).toContain('needs a wallet sign-in');
    expect(text).not.toContain('pool’s own token');
  });
});

describe('isCheckableRecipient', () => {
  test('only a complete, non-zero address triggers a lookup', () => {
    expect(isCheckableRecipient('0x996B67014AfaDf86A9b2026fD7C0fA71b10BA25e')).toBe(true);
    expect(isCheckableRecipient('  0x996b67014afadf86a9b2026fd7c0fa71b10ba25e ')).toBe(true);
    expect(isCheckableRecipient('0x996B')).toBe(false);
    expect(isCheckableRecipient('0x0000000000000000000000000000000000000000')).toBe(false);
    expect(isCheckableRecipient('')).toBe(false);
  });
});

describe('the hub and the Send flow link to the explainer', () => {
  test('the Shield card checks the recipient while typing and shows the hint', () => {
    const src = readFileSync(fileURLToPath(new URL('../../components/home/action-hub.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('recipientRegistrationHint(');
    expect(src).toContain('hub-shield-recipient-hint');
    // The conflict is shown on the form AND stops the launch.
    expect(src).toContain('hub-shield-recipient-conflict');
    expect(src).toContain("toast({ title: shieldRecipientConflict, variant: 'destructive' })");
    expect(src).not.toContain('placeholder="0x… (a registered address)"');
  });

  test('the Recipient Not Registered screen offers the same page', () => {
    const src = readFileSync(fileURLToPath(new URL('../../components/transfer-modal-provider.tsx', import.meta.url)), 'utf8');
    expect(src).toContain('UNREGISTERED_DEPOSIT_DOCS_URL');
  });
});

describe('DEV-489: paying with another token or network can deposit for someone else', () => {
  const hub = readFileSync(fileURLToPath(new URL('../../components/home/action-hub.tsx', import.meta.url)), 'utf8');
  const deposit = readFileSync(fileURLToPath(new URL('../../components/deposit-modal-provider.tsx', import.meta.url)), 'utf8');

  test('the hub no longer passes the conversion into the conflict check', () => {
    expect(hub).toContain("recipientDepositConflict({ keySession: identityMode === 'key' })");
    expect(hub).not.toContain('conversion: crossPayShield');
  });

  test('a converting shield launches WITH the recipient instead of refusing it', () => {
    expect(hub).not.toContain('works only as a plain deposit into this network');
    const start = hub.indexOf('const depositTarget = sizeConvertingDeposit(');
    const call = hub.slice(start, hub.indexOf("} else if (Platform.OS === 'web')", start));
    expect(call).toContain('payTokenAddress: payTokenAddr');
    expect(call).toContain('recipientAddress: shieldFor');
  });

  test('the deposit flow drops the pay-with refusal but keeps the account-key one', () => {
    expect(deposit).not.toContain('works only with the pool\\u2019s own token');
    expect(deposit).not.toContain('crossChainThisRun || (swapDepositActive && !!payToken)');
    expect(deposit).toContain('if (keyOwnedDeposit) throw new Error(`${KEY_SESSION_DEPOSIT_FOR_COPY} Nothing was sent.`);');
  });

  test('the swap-and-deposit carries the recipient to the SDK', () => {
    const swap = deposit.slice(deposit.indexOf('await runSwapAndDeposit('));
    expect(swap.slice(0, 2000)).toContain('recipient: swapRecipient');
  });
});
