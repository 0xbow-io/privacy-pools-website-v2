/**
 * The vault-verified yield resolvers decide whether MONEY MAY MOVE. They fail
 * closed and stay 'no' until an on-chain probe says otherwise, which is right
 * for a deposit and wrong for everything else, because the probe only runs at
 * session creation.
 *
 * Twice in one day (2026-09-12) a surface asked them a question they do not
 * answer:
 *   - "which pool does USDC deposit into" -> no answer yet -> the destination
 *     fell through to another pool;
 *   - "is paying USDC into the ppUSDC pool a conversion" -> no answer yet ->
 *     the hub called a plain deposit a swap and refused it;
 *   - "what does this picker row say" -> no answer yet -> "Deposits closed" on
 *     the screen where picking it deposits.
 *
 * Naming, classification and destination read the CONFIGURED resolvers
 * (getConfigured*); money reads the verified ones. This is a source-text guard
 * because nothing else catches it: both wirings compile, both type-check, and
 * the wrong one is only wrong for the seconds before a probe answers - which
 * is exactly the window a user's first page load sits in.
 *
 * If this test fails you have added a call to a verified resolver. Ask what
 * your call site does with the answer:
 *   - deciding whether to BUILD OR SEND a transaction -> verified is correct;
 *     add your file below with a line saying so.
 *   - deciding what to SHOW, what to CALL something, which pool to point at,
 *     or whether an option is offered -> use the getConfigured* twin.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/** Source with comments and string literals removed, so only real code counts. */
function code(relPath: string): string {
  return readFileSync(join(ROOT, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
}

function callCount(relPath: string, name: string): number {
  return (code(relPath).match(new RegExp(`\\b${name}\\s*\\(`, 'g')) ?? []).length;
}

/** References, not calls: a resolver handed to an injectable rule is never called by name. */
function refCount(relPath: string, name: string): number {
  return (code(relPath).match(new RegExp(`\\b${name}\\b`, 'g')) ?? []).length;
}

/**
 * file -> how many times it may CALL a verified resolver, and why. A count,
 * not a boolean: the files below legitimately gate money in several places,
 * and a new call in one of them still has to be justified by bumping this.
 */
const VERIFIED_CALLS: Record<string, Record<string, { calls: number; why: string }>> = {
  'getYieldDepositDeploymentForUnderlying': {
    'components/deposit-modal-provider.tsx': {
      calls: 2,
      why: 'the render-time yield memo and the live re-read at the moment money moves. Both decide whether a deposit is BUILT through the router. The deposit-for refusal reads the memo (native-aware) since 2026-09-18.',
    },
  },
  'getYieldDeploymentForAsset': {
    'components/withdraw-modal-provider.tsx': {
      calls: 3,
      why: 'the review figures read off the vault, the relayed redemption route, and the own-wallet redemption the wallet sends. All three are the money path.',
    },
    // Read-only accrued values now use configured per-vault public rates.
  },
  'getYieldDeploymentsForChain': {
    'components/deposit-modal-provider.tsx': {
      calls: 1,
      why: 'Legacy SDK namespace selection before preparing a yield deposit must have exactly one verified deployment.',
    },
  },
  'isYieldUnderlying': {
    // Hub classifies the selected pay token via the configured native-aware route.
    'components/home/home-pools.tsx': {
      calls: 1,
      why: 'same on-chain read, on the pool list.',
    },
  },
};

/** Everything a surface may reach for instead. Listed so the message can name them. */
const CONFIGURED_TWINS = [
  'getConfiguredYieldDepositDeploymentForUnderlying',
  'getConfiguredYieldDeploymentForAsset',
  'isConfiguredYieldUnderlying',
  'getConfiguredNativeYieldDeployment',
  'getConfiguredDepositRouteForPayToken',
];

const SURFACES = [
  'components/home/action-hub.tsx',
  'components/home/home-pools.tsx',
  'components/ui/token-select-sheet.tsx',
  'components/deposit-modal-provider.tsx',
  'components/withdraw-modal-provider.tsx',
  'services/shield-pools.ts',
  'services/shield-pay-routing.ts',
  'config/tokens.ts',
  'hooks/use-accrued-yield.ts',
  'components/portfolio-provider.tsx',
  'components/pools/pool-page-content.tsx',
];

describe('verified yield resolvers gate money, never naming', () => {
  for (const [resolver, allowed] of Object.entries(VERIFIED_CALLS)) {
    test(`${resolver} is called only where a transaction is decided`, () => {
      for (const file of SURFACES) {
        const found = callCount(file, resolver);
        const expected = allowed[file]?.calls ?? 0;
        expect(
          `${file}: ${found} call(s) to ${resolver}`,
        ).toBe(`${file}: ${expected} call(s) to ${resolver}`);
      }
    });
  }

  test('every allowlisted call site carries a reason, so the next one has to argue for itself', () => {
    for (const byFile of Object.values(VERIFIED_CALLS)) {
      for (const entry of Object.values(byFile)) {
        expect(entry.why.length).toBeGreaterThan(20);
        expect(entry.calls).toBeGreaterThan(0);
      }
    }
  });

  test('the configured twins exist, so there is always somewhere else to go', async () => {
    const yieldModule = await import('@/config/yield') as Record<string, unknown>;
    for (const twin of CONFIGURED_TWINS) {
      expect(typeof yieldModule[twin]).toBe('function');
    }
  });

  test('the shield destination and the pay-routing rule read the configured route', () => {
    // Named explicitly: these two are what broke, and a silent switch back to
    // the verified resolver here is the exact regression.
    expect(refCount('services/shield-pools.ts', 'getConfiguredYieldDepositDeploymentForUnderlying')).toBeGreaterThan(0);
    expect(refCount('services/shield-pay-routing.ts', 'getConfiguredYieldDeploymentForAsset')).toBeGreaterThan(0);
    expect(refCount('config/tokens.ts', 'isConfiguredYieldUnderlying')).toBeGreaterThan(0);
    // By pay token since 2026-09-18: the native coin has no ERC-20 underlying to
    // look up, and the picker said nothing about yield next to ETH.
    expect(refCount('components/ui/token-select-sheet.tsx', 'getConfiguredDepositRouteForPayToken')).toBeGreaterThan(0);
    expect(refCount('components/ui/token-select-sheet.tsx', 'getConfiguredYieldDepositDeploymentForUnderlying')).toBe(0);
  });
});
