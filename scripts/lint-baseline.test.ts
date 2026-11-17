import { expect, test } from 'bun:test';
import { ESLint } from 'eslint';
import { lintFingerprint, newLintMessages } from './lint-baseline-lib.mjs';
const issue = { line: 1, ruleId: 'example/rule', severity: 2, message: 'Unsafe value\noriginal frame' };
test('lint baseline permits moved existing findings but rejects new code, rules and duplicate occurrences', () => {
  const baseline = { [lintFingerprint('a.ts', 'old()', issue)]: 1 };
  expect(newLintMessages('a.ts', '\nold()', [{ ...issue, line: 2, message: 'Unsafe value\nnew frame' }], baseline)).toEqual([]);
  expect(newLintMessages('a.ts', 'new()', [issue], baseline)).toEqual([issue]);
  expect(newLintMessages('b.ts', 'old()', [issue], baseline)).toEqual([issue]);
  expect(newLintMessages('a.ts', 'old()', [{ ...issue, ruleId: 'another/rule' }], baseline)).toHaveLength(1);
  expect(newLintMessages('a.ts', 'old()\nold()', [issue, { ...issue, line: 2 }], baseline)).toHaveLength(1);
});

test('duplicate import fingerprints survive checkout relocation without conflating modules', () => {
  const source = "import { value } from './module';";
  const duplicate = (root: string, module: string) => ({ ...issue, ruleId: 'import/no-duplicates', message: `'${root}/${module}' imported multiple times.` });
  const localRoot = '/Users/dev/project';
  const ciRoot = '/home/runner/work/project/project';
  const local = lintFingerprint('a.ts', source, duplicate(localRoot, 'module.ts'), localRoot);
  expect(lintFingerprint('a.ts', source, duplicate(ciRoot, 'module.ts'), ciRoot)).toBe(local);
  expect(lintFingerprint('a.ts', source, duplicate(ciRoot, 'other.ts'), ciRoot)).not.toBe(local);
});

test('lint rejects an await inside an object literal that is a branch of ?:', async () => {
  const lint = async (code: string) => (await new ESLint().lintText(code, { filePath: 'services/x.ts' }))[0].messages
    .filter((m) => m.ruleId === 'hermes/conditional-object-await');
  expect(await lint('export const f = async (c: boolean) => c ? 0 : { v: await Promise.resolve(1) };')).toHaveLength(1);
  expect(await lint('export const f = async (c: boolean) => { const v = await Promise.resolve(1); return c ? 0 : { v }; };')).toHaveLength(0);
  expect(await lint('export const f = (c: boolean) => c ? 0 : { run: async () => await Promise.resolve(1) };')).toHaveLength(0);
  expect(await lint('export const f = async (c: boolean) => c ? 0 : { v: await Promise.resolve(1), run: async () => await Promise.resolve(2) };')).toHaveLength(1);
  expect(await lint('export const f = (c: boolean, d: boolean) => c ? { run: async () => d ? { v: await Promise.resolve(1) } : 0 } : 0;')).toHaveLength(1);
});
