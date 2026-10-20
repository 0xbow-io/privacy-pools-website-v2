import { describe, expect, test } from 'bun:test';
import { CLAIM_LINK_INSTRUCTION, CLAIM_LINK_LEAVE, needsLeaveConfirm, receiptLeaveCopy, SUI_RECEIPT_LEAVE } from '../link-leave-guard';

describe('leaving before the one-time link is copied (DEV-491)', () => {
  test('asks only while there is a link and it was not copied', () => {
    expect(needsLeaveConfirm({ link: 'https://x/import-note#r', copied: false })).toBe(true);
    expect(needsLeaveConfirm({ link: 'https://x/import-note#r', copied: true })).toBe(false);
    expect(needsLeaveConfirm({ link: null, copied: false })).toBe(false);
    expect(needsLeaveConfirm({ link: '', copied: false })).toBe(false);
  });

  test('the claim copy names the recovery route and has no em dashes', () => {
    expect(CLAIM_LINK_LEAVE.body).toContain('Recover claim link');
    for (const line of [CLAIM_LINK_LEAVE.title, CLAIM_LINK_LEAVE.body, CLAIM_LINK_INSTRUCTION]) {
      expect(line).not.toContain('—');
    }
  });
});

describe('leaving an uncopied one-time receipt (DEV-487)', () => {
  test('a stored receipt names the history route', () => {
    expect(receiptLeaveCopy(true).body).toContain('Copy payment link');
  });

  test('an unstored receipt never promises a recovery', () => {
    const copy = receiptLeaveCopy(false);
    expect(copy.body).not.toContain('Copy payment link');
    expect(copy.body).toMatch(/cannot be recovered/);
  });

  test('a Sui receipt names its JSON route and promises no recovery', () => {
    expect(SUI_RECEIPT_LEAVE.body).toContain('JSON receipt');
    expect(SUI_RECEIPT_LEAVE.body).toMatch(/cannot be recovered/);
    expect(SUI_RECEIPT_LEAVE.copyLabel).toBe('Copy JSON and close');
  });

  test('no em dashes', () => {
    expect(SUI_RECEIPT_LEAVE.title + SUI_RECEIPT_LEAVE.body).not.toContain('—');
    for (const stored of [true, false]) {
      const { title, body } = receiptLeaveCopy(stored);
      expect(title + body).not.toContain('—');
    }
  });
});
