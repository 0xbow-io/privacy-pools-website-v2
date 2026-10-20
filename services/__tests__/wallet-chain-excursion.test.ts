import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  beginWalletChainExcursion,
  cancelWalletChainExcursion,
  subscribeWalletChainExcursion,
  walletChainExcursionHome,
} from '../wallet-chain-excursion';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/**
 * Staging e2e, 2026-09-23: a cross-chain swap from OP asked to "Register on
 * Ethereum first". The modal switched the wallet to Ethereum, the app followed
 * it (ChainProvider's reconcile and the connector-first session chain), the
 * session re-initialised, the swap form reset, and the modal's target session
 * came back null in that gap: "Could not reach Ethereum to register there."
 * Any wallet does this, not just the test one.
 */
describe('wallet chain excursion store', () => {
  test('pins the home chain until ended, and ending twice is harmless', () => {
    expect(walletChainExcursionHome()).toBeNull();
    const e = beginWalletChainExcursion(10);
    expect(walletChainExcursionHome()).toBe(10);
    e.end();
    expect(walletChainExcursionHome()).toBeNull();
    e.end();
    expect(walletChainExcursionHome()).toBeNull();
  });

  test('an older excursion ending does not release a newer one', () => {
    const older = beginWalletChainExcursion(10);
    const newer = beginWalletChainExcursion(1);
    older.end();
    expect(walletChainExcursionHome()).toBe(1);
    newer.end();
    expect(walletChainExcursionHome()).toBeNull();
  });

  test('a chosen chain cancels the excursion, and its run sees it is no longer current', () => {
    const e = beginWalletChainExcursion(10);
    expect(e.isCurrent()).toBe(true);
    cancelWalletChainExcursion();
    expect(walletChainExcursionHome()).toBeNull();
    expect(e.isCurrent()).toBe(false);
    // Ending it afterwards changes nothing, and cancelling with none open is a no-op.
    e.end();
    cancelWalletChainExcursion();
    expect(walletChainExcursionHome()).toBeNull();
  });

  test('subscribers hear the start and the end', () => {
    let calls = 0;
    const off = subscribeWalletChainExcursion(() => { calls += 1; });
    const e = beginWalletChainExcursion(10);
    e.end();
    off();
    beginWalletChainExcursion(10).end();
    expect(calls).toBe(2);
  });
});

// The consumers are .tsx / react hooks that bun tests cannot import, so the
// wiring is pinned as source guards, like registration-modal-escape.test.ts.
describe('the app stays put while the wallet registers on another chain', () => {
  test('the session chain returns the home chain during an excursion', () => {
    const source = read('hooks/use-session-chain-id.ts');
    expect(source).toContain('useWalletChainExcursionHome()');
    expect(source).toMatch(/if \(excursionHome !== null\) return excursionHome;\s*return isConnected/);
  });

  test('the selection does not follow the wallet during an excursion', () => {
    const source = read('components/chain-provider.tsx');
    const effect = source.slice(source.indexOf('if (!evmConnected) return;'));
    const body = effect.slice(0, effect.indexOf('}, ['));
    expect(body).toContain('if (excursionHome !== null) return;');
    expect(effect).toContain('}, [evmConnected, wagmiChainId, excursionHome]);');
  });

  test('the modal opens the excursion before switching and returns home before the caller resumes', () => {
    const source = read('components/keystore-registration-modal-provider.tsx');
    const run = source.slice(source.indexOf('const handleRegisterUnlocked'));
    const begin = run.indexOf('excursion = beginWalletChainExcursion(activeChainId)');
    const firstSwitch = run.indexOf('await switchChainAsync({ chainId });');
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(firstSwitch);
    // A run the user closed before reaching the wallet stops before the switch.
    expect(run).toMatch(/if \(!deliversToCaller\(\)\) return;\s*if \(chainId && isSupportedEvmChainId\(chainId\)\) \{\s*if \(crossChainTarget && !excursion\)/);
    // Only for a registration on ANOTHER chain.
    expect(run).toContain('if (crossChainTarget && !excursion) excursion = beginWalletChainExcursion(activeChainId);');
    // A landed registration is recorded BEFORE the switch back, and the wallet
    // goes back before the caller resumes.
    const marked = run.indexOf('keystoreManager?.markRegistered(chainId)');
    const home = run.indexOf('const home = await returnHome();', marked);
    const resumed = run.indexOf('deliverRegistered(home);', marked);
    expect(marked).toBeGreaterThan(firstSwitch);
    expect(run.indexOf("setStatus('registered')", marked)).toBeLessThan(home);
    expect(home).toBeLessThan(resumed);
    // The failure path shows its error first and goes home in finally.
    expect(run).not.toMatch(/\} catch \(err\) \{\s*await returnHome\(\);/);
    expect(run).toMatch(/\} finally \{[\s\S]*?await returnHome\(\);[\s\S]*?setPending\(false\)/);
    // returnHome is bounded, skips a cancelled excursion, and always ends it.
    const helper = run.slice(run.indexOf('const returnHome = async'), run.indexOf('try {', run.indexOf('const returnHome = async') + 400));
    expect(helper).toContain('if (!open.isCurrent()) {');
    expect(helper).toMatch(/withSessionInitTimeout\(\s*switchChainAsync\(\{ chainId: open\.homeChainId \}\),\s*\{ timeoutMs: WALLET_PROMPT_TIMEOUT_MS \}/);
    expect(run).toMatch(/const returnHome = async \(\): Promise<boolean> => \{[\s\S]*?finally \{\s*open\.end\(\);/);
  });

  test('a caller resumes only when the wallet is back home, otherwise it gets the cancel path', () => {
    const source = read('components/keystore-registration-modal-provider.tsx');
    const run = source.slice(source.indexOf('const handleRegisterUnlocked'));
    expect(run).toMatch(/const deliverRegistered = \(home: boolean\) => \{\s*if \(!deliversToCaller\(\)\) return;\s*const stillHome = runHome === null \|\| activeChainIdRef\.current === runHome;\s*if \(home && stillHome\) runOnSuccess\?\.\(\);\s*else runOnCancel\?\.\(\{ registered: true \}\);/);
    // The home is the chain at OPEN, not at this run: a retry after a stranded
    // failure must not treat the target it was left on as home.
    expect(run).toContain('const runHome = openHomeRef.current;');
    const open = source.slice(source.indexOf('const openKeystoreRegistrationModal = useCallback'));
    expect(open.slice(0, open.indexOf('}, ['))).toContain('openHomeRef.current = activeChainIdRef.current;');
    // Every success after a possible excursion goes through it: the landed
    // registration, the already-registered race and the policy-already-set catch.
    expect(run.match(/const home = await returnHome\(\);[\s\S]{0,120}?deliverRegistered\(home\);/g)?.length).toBe(3);
    // A declined or unanswered switch back, or a cancelled excursion, strands the run.
    const helper = run.slice(run.indexOf('const returnHome = async'), run.indexOf('const deliverRegistered'));
    expect(helper.match(/stranded = true;/g)?.length).toBe(2);
  });

  test('closing the modal mid-run drops the excursion, so the orphaned run never switches back', () => {
    const source = read('components/keystore-registration-modal-provider.tsx');
    const close = source.slice(source.indexOf('const closeKeystoreRegistrationModal = useCallback'));
    const body = close.slice(0, close.indexOf('}, ['));
    expect(body).toMatch(/if \(pendingRef\.current\) \{\s*abandonedGenRef\.current = openGenRef\.current;[\s\S]*?cancelWalletChainExcursion\(\);\s*\}/);
  });

  test('picking a chain cancels an open excursion only when the pick commits', () => {
    const source = read('components/chain-provider.tsx');
    const select = source.slice(source.indexOf('const selectChain = useCallback'));
    const body = select.slice(0, select.indexOf('}, [wagmiChainId'));
    // One place cancels, and it also commits the selection.
    expect(body.match(/cancelWalletChainExcursion\(\);/g)?.length).toBe(1);
    expect(body).toMatch(/const commit = \(\) => \{\s*cancelWalletChainExcursion\(\);\s*setSelectedChainId\(chainId\);\s*\};/);
    // Every committed path goes through it, and nothing else sets the selection
    // to the pick, so a declined or superseded pick leaves the excursion pinned.
    expect(body.match(/commit\(\);\s*return 'committed';/g)?.length).toBe(3);
    expect(body.match(/setSelectedChainId\(chainId\)/g)?.length).toBe(1);
    // The connected path commits only after the wallet accepted and the pick is still current.
    expect(body).toMatch(/await switchChainAsync\(\{ chainId, addEthereumChainParameter \}\);\s*if \(switchReqRef\.current === req\) \{\s*commit\(\);/);
  });
});
