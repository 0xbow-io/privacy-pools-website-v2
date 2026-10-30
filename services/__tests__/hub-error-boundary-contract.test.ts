/**
 * A render crash in the action card used to replace the WHOLE page (Artem,
 * 2026-10-30, Swap tab Receiving). Source checks, like the root boundary's
 * contract test: mounting the real tree needs a DOM this suite does not have, and
 * what is worth pinning is structural.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');
const BOUNDARY = read('components/home/hub-error-boundary.tsx');

describe('the action card has its own crash boundary', () => {
  test('it implements the React error-boundary contract and offers a retry', () => {
    expect(BOUNDARY).toContain('getDerivedStateFromError');
    expect(BOUNDARY).toContain('componentDidCatch');
    expect(BOUNDARY).toContain('hub-error-boundary-retry');
  });

  test('every ActionHub mount is inside it', () => {
    for (const file of ['components/home/home-screen.tsx', 'components/pools/pool-page-content.tsx']) {
      const source = read(file);
      const open = source.indexOf('<HubErrorBoundary>');
      const hub = source.indexOf('<ActionHub');
      const close = source.indexOf('</HubErrorBoundary>');
      expect({ file, ok: open > -1 && open < hub && hub < close }).toEqual({ file, ok: true });
    }
  });

  test('it reports through the constructed-event path with identifiers only', () => {
    expect(BOUNDARY).toContain("reportErrorReport('client-failed'");
    expect(BOUNDARY).not.toContain('captureException');
    expect(BOUNDARY).toContain('errorShape');
    expect(BOUNDARY).toContain('componentPosition');
    // The raw message stays in the staging-gated diagnostic block.
    expect(BOUNDARY).toContain('detail:');
  });

  test('the root boundary reads names through the shared reader, not its own regex', () => {
    const root = read('components/app-error-boundary.tsx');
    expect(root).toContain("from '@/services/crash-frame'");
    expect(root).not.toContain('(?:at\\s+)?');
  });
});

describe('the modal shells mounted in app/_layout.tsx have the same boundary', () => {
  // These providers render their sheet NEXT TO {children}, above the page, so the
  // boundary around ActionHub does not cover them: a throw in one took the whole
  // page down (Zeeshan, review of #55, the Swap tab's syncSwapForm path).
  const SHELLS: Array<[string, string, string]> = [
    ['components/swap-modal-provider.tsx', '<OpShell', 'closeSwapModal'],
    ['components/swap-modal-provider.tsx', '<TokenNetworkSelector', 'closeSwapModal'],
    ['components/withdraw-modal-provider.tsx', '<OpShell', 'closeWithdrawModal'],
    ['components/withdraw-modal-provider.tsx', '<TokenSelectSheet', 'closeWithdrawModal'],
    ['components/transfer-modal-provider.tsx', '<TransferShell', 'closeTransferModal'],
    ['components/transfer-modal-provider.tsx', '<TokenSelectSheet', 'closeTransferModal'],
    ['components/ragequit-modal-provider.tsx', '<View\n          className={`inset-0 z-[999999]', 'closeRagequitModal'],
    ['components/wallet-connect-modal-provider.tsx', '<View\n          className={`absolute inset-0 z-[9999]', 'close'],
    ['components/deposit-modal-provider.tsx', '<View\n          // justify branches', 'closeDepositModal'],
  ];

  for (const [file, shell, close] of SHELLS) test(`${file}: ${shell.split('\n')[0]} sits inside HubErrorBoundary, retry closes it`, () => {
    const source = read(file);
    const at = source.indexOf(shell);
    expect(at).toBeGreaterThan(-1);
    const open = source.lastIndexOf('<HubErrorBoundary', at);
    const end = source.indexOf('</HubErrorBoundary>', at);
    expect(open).toBeGreaterThan(-1);
    // The boundary opens right before the shell and closes after it.
    expect(end).toBeGreaterThan(at);
    expect(source.slice(open, at)).toContain(`onRetry={${close}}`);
    expect(source.slice(open, at).length).toBeLessThan(120);
  });

  test('the boundary takes an optional onRetry that cannot trap the fallback', () => {
    expect(BOUNDARY).toContain('onRetry?: () => void');
    expect(BOUNDARY).toMatch(/try \{\s*this\.props\.onRetry\?\.\(\);/);
  });
});
