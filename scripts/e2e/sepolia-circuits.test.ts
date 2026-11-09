import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  FIXTURE_PATH, bytecodeHolds, classifyVerifier, setupElements, transactRouterKey, type CircuitsFixture,
} from './sepolia-circuits';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as CircuitsFixture;
const vkey = (circuit: string) => JSON.parse(readFileSync(join(ROOT, 'public/artifacts', circuit, 'groth16_vkey.json'), 'utf8'));

/** A fake verifier whose bytecode embeds a key's setup elements, the way solc pushes constants. */
const fakeVerifier = (vk: Parameters<typeof setupElements>[0]) => `0x6080${setupElements(vk).map((hex) => `7f${hex.padStart(64, '0')}`).join('5b')}00`;

describe('sepolia circuit fixture', () => {
  test('pins every proof circuit public/artifacts serves, and only those', () => {
    const served = readdirSync(join(ROOT, 'public/artifacts'))
      .filter((name) => statSync(join(ROOT, 'public/artifacts', name, 'groth16_vkey.json'), { throwIfNoEntry: false })?.isFile())
      .filter((name) => name === 'deposit' || name === 'ragequit' || /^transact_\dx\d$/.test(name))
      .sort();
    expect(Object.keys(fixture.circuits).sort()).toEqual(served);
    expect(served).toHaveLength(27);
  });

  test('every pinned file has a CID and a sha256', () => {
    for (const { provingKey, verificationKey } of Object.values(fixture.circuits)) {
      for (const pinned of [provingKey, verificationKey]) {
        expect(pinned.cid).toMatch(/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/);
        expect(pinned.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    expect(fixture.chainId).toBe(11155111);
    for (const gateway of fixture.gateways) expect(gateway).toMatch(/^https:\/\/[^/]+\/ipfs$/);
  });

  // The swap only ever touches a CI or local working copy. If this fails, swapped
  // keys reached public/artifacts: `git checkout -- public/artifacts`.
  test('public/artifacts still holds the production keys, not the pinned Sepolia ones', () => {
    for (const [circuit, { verificationKey }] of Object.entries(fixture.circuits)) {
      const served = createHash('sha256').update(readFileSync(join(ROOT, 'public/artifacts', circuit, 'groth16_vkey.json'))).digest('hex');
      expect({ circuit, served }).not.toEqual({ circuit, served: verificationKey.sha256 });
    }
  });
});

describe('verifier classification', () => {
  const current = vkey('deposit');
  // Another setup of the same circuit: same alpha/beta/gamma, different delta and IC.
  const other = {
    ...current,
    vk_delta_2: current.vk_delta_2.map((pair: string[]) => pair.map((v) => (BigInt(v) + 7n).toString())),
    IC: current.IC.map((point: string[]) => point.map((v) => (BigInt(v) + 11n).toString())),
  };

  test('a verifier built from the checked-out key is classified checked-out', () => {
    expect(bytecodeHolds(current, fakeVerifier(current))).toEqual({ found: setupElements(current).length, total: setupElements(current).length });
    expect(classifyVerifier(fakeVerifier(current), current, other)).toBe('checked-out');
  });

  test('a verifier built from the pinned key is classified pinned', () => {
    expect(classifyVerifier(fakeVerifier(other), current, other)).toBe('pinned');
  });

  test('anything else is unknown, never swapped', () => {
    expect(classifyVerifier('0x6080604052', current, other)).toBe('unknown');
    expect(classifyVerifier(`${fakeVerifier(current)}${fakeVerifier(other).slice(2)}`, current, other)).toBe('unknown');
  });

  test('a constant with leading zero bytes still matches its shortened push', () => {
    const small = { vk_delta_2: [['1', '2'], ['3', '4']], IC: [['255', '65536']] };
    expect(setupElements(small)).toEqual(['01', '02', '03', '04', 'ff', '010000']);
  });

  test('transact router key is keccak256(abi.encode(n, m))', () => {
    expect(transactRouterKey(1, 1)).toBe('0xcc69885fda6bcc1a4ace058b4a62bf5e179ea78fd58a1ccd71c22cc9b688792f');
  });
});

describe('isolation from the app', () => {
  // The swap must stay unreachable from any build: it edits the CI checkout, and
  // nothing the app bundles may know the fixture or the script exist.
  const APP_DIRS = ['app', 'components', 'config', 'constants', 'contexts', 'hooks', 'lib', 'providers', 'services', 'stores', 'utils'];
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name === 'node_modules' || name === '__tests__') return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

  test('no app source references the pinned Sepolia keys', () => {
    const offenders = APP_DIRS
      .map((dir) => join(ROOT, dir))
      .filter((dir) => statSync(dir, { throwIfNoEntry: false })?.isDirectory())
      .flatMap(walk)
      .filter((file) => /\.(ts|tsx|js|mjs|json)$/.test(file))
      .filter((file) => readFileSync(file, 'utf8').includes('sepolia-circuits'));
    expect(offenders).toEqual([]);
  });

  test('only the e2e-sepolia workflow runs the swap', () => {
    const workflows = readdirSync(join(ROOT, '.github/workflows'));
    const callers = workflows.filter((name) => readFileSync(join(ROOT, '.github/workflows', name), 'utf8').includes('scripts/e2e/sepolia-circuits.ts'));
    expect(callers).toEqual(['e2e-sepolia.yml']);
  });
});
