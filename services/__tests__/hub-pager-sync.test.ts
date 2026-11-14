import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pagerResyncTarget } from '../hub-pager-sync';

const HUB = readFileSync(join(new URL('.', import.meta.url).pathname, '..', '..', 'components', 'home', 'action-hub.tsx'), 'utf8');

describe('hub pager follows the selected tab', () => {
  test('a pager drifted onto the Withdraw page while Shield is selected is put back', () => {
    expect(pagerResyncTarget({ offsetX: 400, actionIndex: 0, stride: 400, userScrolling: false })).toBe(0);
  });
  test('already on the selected page: nothing to do', () => {
    expect(pagerResyncTarget({ offsetX: 800.4, actionIndex: 2, stride: 400, userScrolling: false })).toBeNull();
  });
  test('a user gesture may move it', () => {
    expect(pagerResyncTarget({ offsetX: 400, actionIndex: 0, stride: 400, userScrolling: true })).toBeNull();
  });
  test('the hub pager scroll handler uses it for non-gesture scrolls', () => {
    expect(HUB).toContain('pagerResyncTarget(');
  });
  test('off-screen pages are inert so focus cannot scroll the pager onto them', () => {
    expect(HUB).toMatch(/\.inert = x\.key !== action/);
  });
});
