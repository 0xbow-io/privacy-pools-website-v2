import { describe, expect, test } from 'bun:test';

import { intentLockdownRequestedByEnv } from '@/services/intent-lockdown-rule';

describe('intentLockdownRequestedByEnv', () => {
  // The surface ships ON: a deployment that sets nothing gets it. #73 briefly
  // inverted this and, since the variable is unset in Vercel prod, the Swap tab
  // disappeared for everyone on that deploy.
  test('an absent variable leaves the surface UNLOCKED', () => {
    expect(intentLockdownRequestedByEnv(undefined)).toBe(false);
    expect(intentLockdownRequestedByEnv(null)).toBe(false);
  });

  // Empty is the value the prod capability-matrix harness passes, and it has
  // now meant both things across two commits. A variable that exists but was
  // never given a value must not dark the surface.
  test('an EMPTY variable leaves the surface UNLOCKED', () => {
    expect(intentLockdownRequestedByEnv('')).toBe(false);
    expect(intentLockdownRequestedByEnv('   ')).toBe(false);
  });

  test('an explicit off-ish value is also unlocked', () => {
    for (const value of ['false', 'FALSE', ' False ', '0', 'off', 'no']) {
      expect(intentLockdownRequestedByEnv(value)).toBe(false);
    }
  });

  test('anything else locks it, so a typo fails toward hiding rather than exposing', () => {
    for (const value of ['true', '1', 'on', 'yes', 'yes-please', 'locked']) {
      expect(intentLockdownRequestedByEnv(value)).toBe(true);
    }
  });
});
