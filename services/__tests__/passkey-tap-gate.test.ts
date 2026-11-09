/**
 * A WebAuthn ceremony starts only from a tap on a passkey button in the unlock
 * dialog (Sign in, Use another passkey, Create a passkey).
 *
 * QA on PR #63, scenario 5: a smart-contract wallet with a remembered passkey
 * and no keys closed the unlock dialog, then opened the Withdraw tab. The
 * session build on open ran the targeted passkey GET by itself, so a real
 * device showed the OS passkey sheet just for opening a tab. Every flow that
 * needs keys reaches the same key build (ensureInitialized), so the gate sits
 * in the plan the build runs, not in each flow.
 *
 * Source-level for the wiring: the providers need Expo, wagmi and the pools
 * tree to render.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PASSKEY_TAP_REQUIRED_MESSAGE,
  PasskeyTapRequiredError,
  resolvePasskeyUnlockPlan,
} from '@/services/passkey-unlock-plan';

const here = new URL('.', import.meta.url).pathname;
const read = (...p: string[]) => readFileSync(join(here, '..', '..', ...p), 'utf8');
const code = (source: string) => source.split('\n')
  .filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
  .join('\n');

describe('no tap, no ceremony', () => {
  test('a remembered passkey without a tap runs nothing (the Withdraw-open case)', () => {
    expect(resolvePasskeyUnlockPlan({ rememberedCredentialId: 'abc' })).toEqual({ kind: 'needs-tap' });
  });
  test('nothing remembered without a tap runs nothing either', () => {
    expect(resolvePasskeyUnlockPlan({})).toEqual({ kind: 'needs-tap' });
  });
  test('a pick without a tap is still no tap', () => {
    expect(resolvePasskeyUnlockPlan({ rememberedCredentialId: 'abc', pick: 'any' })).toEqual({ kind: 'needs-tap' });
    expect(resolvePasskeyUnlockPlan({ pick: 'create' })).toEqual({ kind: 'needs-tap' });
  });
  test('only a literal true counts as a tap', () => {
    for (const tap of [undefined, false, 1, 'true', { nativeEvent: {} }]) {
      expect(resolvePasskeyUnlockPlan({ rememberedCredentialId: 'abc', tap })).toEqual({ kind: 'needs-tap' });
    }
    expect(resolvePasskeyUnlockPlan({ rememberedCredentialId: 'abc', tap: true })).toEqual({ kind: 'targeted', credentialId: 'abc' });
  });
  test('the refusal says where the way on is', () => {
    const err = new PasskeyTapRequiredError();
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(PASSKEY_TAP_REQUIRED_MESSAGE);
    expect(err.message).toContain('Sign in');
  });
});

describe('the key build honours the gate', () => {
  const SDK = code(read('components', 'sdk-provider.tsx'));
  const branch = SDK.slice(SDK.indexOf('const runPasskeyBranch = async'));

  test('the passkey branch checks needs-tap before any WebAuthn call', () => {
    const gate = branch.indexOf("plan.kind === 'needs-tap'");
    expect(gate).toBeGreaterThan(-1);
    expect(branch.indexOf('tap: passkeyTap')).toBeGreaterThan(-1);
    expect(branch.indexOf('tap: passkeyTap')).toBeLessThan(gate);
    for (const call of ['getPasskeyPrf(', 'createPasskey(']) {
      const at = branch.indexOf(call);
      expect(at).toBeGreaterThan(gate);
    }
    expect(branch.slice(gate, branch.indexOf('getPasskeyPrf('))).toContain('throw new PasskeyTapRequiredError()');
  });

  test('ensureInitialized forwards the tap to the key build', () => {
    expect(SDK).toContain('deriveKeystoreManager({ passkeyPick: opts?.passkeyPick, passkeyTap: opts?.passkeyTap })');
  });
});

describe('only the unlock dialog buttons carry a tap', () => {
  const DIALOG = code(read('components', 'seed-derivation-modal-provider.tsx'));
  const WITHDRAW = code(read('components', 'withdraw-modal-provider.tsx'));

  test('the dialog passes the tap from its button presses, not from the auto sign-in', () => {
    expect(DIALOG).toContain('passkeyTap: true');
    expect(DIALOG).toContain('opts?.tap === true');
    expect(DIALOG).toContain('onPress={() => { void handleSign(undefined, { tap: true }); }}');
    expect(DIALOG).toContain('onPress={() => { void handleSign(passkeySecondary.pick, { tap: true }); }}');
    expect(DIALOG).toContain('void handleSignRef.current();');
    expect(DIALOG).not.toMatch(/handleSignRef\.current\([^)]/);
  });

  test('the dialog opens when a key build asked for the tap', () => {
    expect(DIALOG).toContain('passkeyTapRequests');
    expect(DIALOG).toMatch(/if \(!keysReady\) openSeedDerivationModal\(\);/);
  });

  test('opening Withdraw builds the session without a tap', () => {
    const open = WITHDRAW.slice(WITHDRAW.indexOf('Building session on withdraw open'));
    expect(open.slice(0, 200)).toContain('ensureInitialized().catch(');
    expect(open).toContain('err instanceof PasskeyTapRequiredError');
  });

  test('nothing outside the dialog passes passkeyTap', () => {
    const offenders: string[] = [];
    for (const dir of ['components', 'hooks', 'app']) {
      const walk = (rel: string) => {
        for (const entry of readdirSync(join(here, '..', '..', rel), { withFileTypes: true })) {
          const p = join(rel, entry.name);
          if (entry.isDirectory()) { if (entry.name !== '__tests__') walk(p); continue; }
          if (!/\.tsx?$/.test(entry.name)) continue;
          if (p === join('components', 'seed-derivation-modal-provider.tsx') || p === join('components', 'sdk-provider.tsx')) continue;
          if (/passkeyTap\s*:/.test(code(read(p)))) offenders.push(p);
        }
      };
      walk(dir);
    }
    expect(offenders).toEqual([]);
  });
});
