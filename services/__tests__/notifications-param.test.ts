import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { notificationsParamAction } from '@/services/notifications-param';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

describe('notificationsParamAction (DEV-454)', () => {
  test('signed out and settled: the param is dropped, no sheet', () => {
    expect(notificationsParamAction({ requested: true, sessionActive: false, walletSettling: false })).toBe('strip');
  });
  test('a wallet still reconnecting on reload keeps the param and waits', () => {
    expect(notificationsParamAction({ requested: true, sessionActive: false, walletSettling: true })).toBe('wait');
  });
  test('with a session it still opens, and no param does nothing', () => {
    expect(notificationsParamAction({ requested: true, sessionActive: true, walletSettling: false })).toBe('show');
    expect(notificationsParamAction({ requested: false, sessionActive: false, walletSettling: false })).toBe('none');
  });
  test('the root sheet renders only on show', () => {
    const src = readFileSync(join(ROOT, 'components/global-sheets.tsx'), 'utf8');
    expect(src).toContain("notificationsAction === 'show' && width <= NOTIFICATIONS_SHEET_MAX_WIDTH");
    expect(src).not.toContain('{notifications && width');
    // The strip waits out a late Sui or Stellar reconnect.
    expect(src).toMatch(/setTimeout\(\(\) => \{\s*retireUiParamEntry\('notifications'\)/);
  });
});
