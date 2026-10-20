import { describe, expect, test } from 'bun:test';

import { sessionResuming } from '../session-resume';

const A = '0x00000000000000000000000000000000000000aa';
// The gap after a switch to chain 56: torn down, nothing building yet, and the
// effect last started a build for chain 1.
const gap = {
  isInitialized: false,
  isInitializing: false,
  error: null,
  evmChain: true,
  identityMode: 'wallet' as const,
  keysReady: false,
  address: A,
  chainId: 56,
  provenAddress: A,
  startedTarget: `${A}:1`,
};

describe('sessionResuming', () => {
  test('a wallet that proved its signature in this tab resumes on a new chain', () => {
    expect(sessionResuming(gap)).toBe(true);
    // Back to a chain it built before, after building another in between.
    expect(sessionResuming({ ...gap, chainId: 1, startedTarget: `${A}:56` })).toBe(true);
  });

  test('a target the effect already started is locked: it builds once per target', () => {
    expect(sessionResuming({ ...gap, startedTarget: `${A}:56` })).toBe(false);
  });

  test('a wallet that has not signed in this tab, or signed with a passkey, is locked', () => {
    // A passkey unlock never records a proved signature.
    expect(sessionResuming({ ...gap, provenAddress: null })).toBe(false);
    // A disconnected wallet: no address and no proof is not a match.
    expect(sessionResuming({ ...gap, address: null, provenAddress: null })).toBe(false);
    expect(sessionResuming({ ...gap, provenAddress: '0x00000000000000000000000000000000000000bb' })).toBe(false);
  });

  test('not resuming once the build starts, lands or fails, off EVM, or for an account key', () => {
    expect(sessionResuming({ ...gap, isInitializing: true })).toBe(false);
    expect(sessionResuming({ ...gap, isInitialized: true })).toBe(false);
    expect(sessionResuming({ ...gap, error: 'HTTP 403' })).toBe(false);
    expect(sessionResuming({ ...gap, evmChain: false })).toBe(false);
    expect(sessionResuming({ ...gap, identityMode: 'key' })).toBe(false);
  });

  test('keys already held with no session is the export state, not a resume', () => {
    expect(sessionResuming({ ...gap, keysReady: true })).toBe(false);
  });
});
