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

describe('custom RPC and Tor are reachable before connecting', () => {
  test('both buttons exist in the header', () => {
    expect(HEADER).toContain('testID="header-custom-rpc"');
    expect(HEADER).toContain('testID="header-tor"');
  });

  test('both render only while NOT connected', () => {
    // The dropdown carries the same two settings once connected, so a button
    // that survived `menuActive` would put the same setting on screen twice.
    for (const testId of ['header-custom-rpc', 'header-tor']) {
      expect({ testId, gated: guardFor(testId).startsWith('{!menuActive') })
        .toEqual({ testId, gated: true });
    }
  });

  test('both are EVM-only; custom RPC stays web-only, anon-rpc is web or an Android device', () => {
    // Sui's client is built by dapp-kit from its own config, so neither
    // setting reaches it. Custom RPC lives in localStorage and takes effect on
    // a page reload, which a native build does not have. anon-rpc keeps its
    // choice in SecureStore on a device and restarts the bundle instead, with
    // Arti compiled into the app (@0xbow/anon-rpc-rs-react-native).
    for (const testId of ['header-custom-rpc', 'header-tor']) {
      // activeIsNonEvm = Sui or Stellar selected (components/ui/header.tsx).
      expect({ testId, evmOnly: guardFor(testId).includes('!activeIsNonEvm') }).toEqual({ testId, evmOnly: true });
    }
    expect(guardFor('header-custom-rpc')).toContain("Platform.OS === 'web'");
    expect(guardFor('header-custom-rpc')).not.toContain('TOR_ON_DEVICE');
    expect(guardFor('header-tor')).toContain("(Platform.OS === 'web' || TOR_ON_DEVICE)");
  });

  test('the Tor button opens the form on its Tor view', () => {
    // Opening the full custom RPC form from a button labelled Tor would bury
    // the one setting it is about.
    expect(guardFor('header-tor')).toContain('openCustomRpcModal({ torOnly: true })');
  });

  test('the custom RPC button passes no options, and is wrapped', () => {
    // Passed by reference, the press event arrives as the options argument and
    // its properties are read as flags.
    const guard = guardFor('header-custom-rpc');
    expect(guard).toContain('onPress={() => openCustomRpcModal()}');
  });
});
