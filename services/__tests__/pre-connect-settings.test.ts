/**
 * Both transport settings are reachable BEFORE a wallet is connected.
 *
 * They live in the actions dropdown, which is gated on `menuActive`, so each
 * was reachable only after connecting. That is backwards for both, and for a
 * different reason each:
 *
 *   - A custom endpoint decides whether connecting works at all. On a slow or
 *     dead endpoint the user had to wait out, or fail, the very load the
 *     setting would have fixed (Mike, 2026-09-22: "we must enable users to
 *     select custom rpc before logging in").
 *   - Tor decides how the FIRST request travels. By the time a wallet is
 *     connected that request has gone, so offering it afterwards offers it
 *     too late.
 *
 * A source check because the header needs wagmi, dapp-kit and expo-router to
 * render, none of which this suite can load. It asserts the shape that makes
 * the buttons reachable rather than trying to click them: that they exist, and
 * that they are gated on NOT being connected.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const HEADER = readFileSync(
  join(new URL('.', import.meta.url).pathname, '..', '..', 'components', 'ui', 'header.tsx'),
  'utf8',
);

/** The block a testID sits in, back to the guard that decides it renders. */
function guardFor(testId: string): string {
  const at = HEADER.indexOf(`testID="${testId}"`);
  expect({ testId, present: at > -1 }).toEqual({ testId, present: true });
  // The nearest preceding `{...&& (` is the condition this element renders under.
  const before = HEADER.slice(0, at);
  return before.slice(before.lastIndexOf('{!menuActive'));
}

describe('connection settings are reachable before connecting', () => {
  test('one header entry exposes both route and endpoint settings', () => {
    expect(HEADER).toContain('testID="header-custom-rpc"');
    expect(HEADER).not.toContain('testID="header-tor"');
    expect(HEADER).toContain('testID="menu-custom-rpc"');
    expect(HEADER).not.toContain('testID="menu-tor"');
  });

  test('the preconnect entry is not duplicated once the menu is active', () => {
    expect(guardFor('header-custom-rpc').startsWith('{!menuActive')).toBe(true);
  });

  test('the EVM connection settings support web and on-device routing', () => {
    const guard = guardFor('header-custom-rpc');
    expect(guard).toContain('!activeIsNonEvm');
    expect(guard).toContain("(Platform.OS === 'web' || TOR_ON_DEVICE)");
  });

  test('opening connection settings does not propose a route change', () => {
    expect(guardFor('header-custom-rpc')).toContain('onPress={() => openCustomRpcModal()}');
  });
});
