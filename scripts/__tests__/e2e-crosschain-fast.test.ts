// Guards for the headless cross-chain e2e (scripts/e2e/crosschain-swap-fast.ts)
// and its workflow. The run spends real mainnet funds with account A's key, so
// the workflow must never run for a pull request, and the script must keep the
// Across pin and close what it opened before it exits.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const WORKFLOW = read('../../.github/workflows/e2e-crosschain-fast.yml');
const SLOW_WORKFLOW = read('../../.github/workflows/e2e-crosschain.yml');
const SCRIPT = read('../e2e/crosschain-swap-fast.ts');

/** The YAML without comment lines, so prose about pull_request cannot match. */
const uncommented = (yaml: string) => yaml.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const timeoutMinutes = (yaml: string) => Number(/timeout-minutes:\s*(\d+)/.exec(yaml)?.[1]);

describe('e2e-crosschain-fast workflow', () => {
  const wf = uncommented(WORKFLOW);

  test('runs on pushes to dev and main and by hand, never on a pull request', () => {
    expect(wf).toMatch(/^on:\s*\n\s+push:\s*\n\s+branches:\s*\[dev, main\]/m);
    expect(wf).toMatch(/^\s+workflow_dispatch:/m);
    for (const trigger of ['pull_request', 'pull_request_target', 'schedule', 'workflow_run', 'workflow_call']) {
      expect(wf).not.toMatch(new RegExp(`^\\s*${trigger}\\s*:`, 'm'));
    }
  });

  test('sits in the e2e-mainnet environment, which only dev and main may deploy to', () => {
    expect(wf).toMatch(/environment:\s*e2e-mainnet/);
  });

  test('queues behind the browser run on the same account', () => {
    expect(wf).toMatch(/concurrency:\s*\n\s+group:\s*e2e-crosschain-accounts\s*\n\s+cancel-in-progress:\s*false/);
    expect(uncommented(SLOW_WORKFLOW)).toContain('group: e2e-crosschain-accounts');
  });

  test('times out below the browser run, and fetches the circuit artifacts', () => {
    const fast = timeoutMinutes(wf);
    expect(fast).toBeGreaterThan(0);
    expect(fast).toBeLessThan(timeoutMinutes(uncommented(SLOW_WORKFLOW)));
    expect(wf).toMatch(/lfs:\s*true/);
  });

  test('pins the bridge to Across', () => {
    expect(wf).toMatch(/LIFI_ALLOW_BRIDGES:\s*across/);
  });
});

describe('crosschain-swap-fast script', () => {
  test('defaults the LiFi bridge allowlist to Across and hands it to the provider', () => {
    expect(SCRIPT).toContain("process.env.LIFI_ALLOW_BRIDGES ?? process.env.EXPO_PUBLIC_LIFI_ALLOW_BRIDGES ?? 'across'");
    expect(SCRIPT).toContain('allowBridges: ALLOW_BRIDGES');
  });

  test('never exits before the finally that closes resources', () => {
    const finallyAt = SCRIPT.indexOf('} finally {');
    expect(finallyAt).toBeGreaterThan(0);
    const closeAt = SCRIPT.indexOf('await closeResources()', finallyAt);
    expect(closeAt).toBeGreaterThan(finallyAt);
    const exits = [...SCRIPT.matchAll(/process\.exit\(/g)].map((m) => m.index!);
    for (const at of exits) expect(at).toBeGreaterThan(closeAt);
  });

  test('dry run is an explicit opt-in', () => {
    expect(SCRIPT).toContain("const DRY_RUN = process.env.DRY_RUN === '1';");
  });
});
