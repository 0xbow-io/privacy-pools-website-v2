/**
 * The Swap surface is always private to private.
 *
 * Product rule, not a default (Pat, 2026-09-22): "swap tab should always be
 * private to private, always always, only withdraw is allowed to swap to public
 * wallet". Withdraw publishes and is named for it; Swap that could also publish
 * put the two one toggle apart, and a cross-chain swap left the pool and settled
 * in a wallet on BNB Chain (bsc 0x13cb8a50) because the modal opened on the
 * payout and nobody pressed the toggle.
 *
 * So this asserts the absence of a public path, not the choice of a default:
 * the surface sets reshield unconditionally, nothing hands it 'wallet', and
 * there is no toggle to reach one.
 *
 * Source-level: the modal needs Expo, wagmi and the pools tree to render.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const here = new URL('.', import.meta.url).pathname;
const read = (...p: string[]) => readFileSync(join(here, '..', '..', ...p), 'utf8');
const SWAP = read('components', 'swap-modal-provider.tsx');
const TRANSFER = read('components', 'transfer-modal-provider.tsx');
const HANDOFF = read('services', 'swap-handoff.ts');
const HUB = read('components', 'home', 'action-hub.tsx');

describe('the swap surface has one mode', () => {
  test('it sets reshield unconditionally, with no caller override', () => {
    expect(SWAP).toContain("setMode('reshield');");
    expect(SWAP).not.toContain("setMode(options?.mode");
  });

  test('nothing in the app hands the swap modal a wallet mode', () => {
    for (const [name, source] of [['swap', SWAP], ['transfer', TRANSFER], ['handoff', HANDOFF], ['hub', HUB]] as const) {
      // Comments may still describe the old shape; code must not contain it.
      const code = source.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
      if (code.includes("mode: 'wallet'")) throw new Error(`${name} still passes mode: 'wallet'`);
    }
  });

  test('there is no mode toggle to reach a payout', () => {
    expect(SWAP).not.toContain("swap-mode-wallet");
    expect(SWAP).not.toContain("'To my wallet'");
    expect(SWAP).not.toContain('const editMode');
  });
});

describe('the public route lives in Withdraw', () => {
  test('a third-party swap-send opens Withdraw, not Swap', () => {
    expect(TRANSFER).toContain('openWithdrawModal(undefined, {');
    expect(TRANSFER).toContain('targetAddress: recipientAddress,');
  });

  test('the reshield handoff may name a recipient, for the private route only (DEV-510)', () => {
    const start = HANDOFF.indexOf('export type SwapTabHandoffRequest = {');
    expect(start).toBeGreaterThan(-1);
    expect(HANDOFF.slice(start, HANDOFF.indexOf('};', start))).toContain('recipient?: string;');
  });
});
