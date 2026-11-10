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
  //
  // The boundary sits INSIDE the shell, around its children, so the fallback is
  // drawn where the card was (the hub's inline portal, or the sheet / modal
  // overlay). Around the shell from the provider it would land in the page flow.
  const OP = read('components/op-shell.tsx');
  const CONSOLIDATION = read('components/consolidation-shell.tsx');

  test('OpShell and ConsolidationShell wrap their children, inside the portal / overlay', () => {
    for (const source of [OP, CONSOLIDATION]) {
      const open = source.indexOf('<HubErrorBoundary');
      expect(open).toBeGreaterThan(-1);
      expect(source.indexOf('{children}', open)).toBeGreaterThan(open);
    }
    // inline branch: the boundary is below InlineOpPortal; overlay: below the card.
    // inline branch renders the already-wrapped children inside the portal.
    expect(OP.indexOf('<InlineOpPortal>')).toBeLessThan(OP.lastIndexOf('{children}'));
    expect(OP.indexOf('children = (')).toBeLessThan(OP.indexOf('<InlineOpPortal>'));
    expect(OP).toContain('retryable={!closeBlocked}');
    expect(OP).toContain('onCrashClose ?? onClose');
  });

  test('providers do not wrap the whole shell from outside any more', () => {
    for (const file of ['components/swap-modal-provider.tsx', 'components/withdraw-modal-provider.tsx', 'components/transfer-modal-provider.tsx']) {
      const source = read(file);
      const shell = source.search(/<(OpShell|TransferShell)\b/);
      expect(shell).toBeGreaterThan(-1);
      const before = source.slice(Math.max(0, shell - 200), shell);
      expect(before).not.toContain('HubErrorBoundary');
    }
  });

  test('a blocked close hides the retry and says to reload', () => {
    expect(read('components/swap-modal-provider.tsx')).toContain("closeBlocked={step === 'executing'}");
    expect(read('components/withdraw-modal-provider.tsx')).toContain("closeBlocked={step === 'loading'}");
    expect(BOUNDARY).toContain('retryable?: boolean');
    expect(BOUNDARY).toContain('Reload the page');
    expect(BOUNDARY).toMatch(/\{retryable && \(\s*<Pressable/);
  });

  test('a crash in a picker closes only the picker, never the whole flow', () => {
    expect(read('components/swap-modal-provider.tsx')).toContain('<HubErrorBoundary onRetry={() => setSelectorOpen(false)}>');
    expect(read('components/withdraw-modal-provider.tsx')).toContain('<HubErrorBoundary onRetry={() => setReceiveSelectorOpen(false)}>');
    expect(read('components/transfer-modal-provider.tsx')).toContain('<HubErrorBoundary onRetry={() => setReceiveSelectorOpen(false)}>');
  });

  // These three draw their own fixed overlay View, not OpShell: the boundary is
  // INSIDE that View so the fallback keeps the overlay.
  for (const [file, close] of [
    ['components/ragequit-modal-provider.tsx', 'closeRagequitModal'],
    ['components/wallet-connect-modal-provider.tsx', 'close'],
    ['components/deposit-modal-provider.tsx', 'closeDepositModal'],
  ] as Array<[string, string]>) test(`${file}: boundary is inside the fixed overlay View`, () => {
    const source = read(file);
    const boundary = source.indexOf(`<HubErrorBoundary onRetry={${close}}>`);
    expect(boundary).toBeGreaterThan(-1);
    const before = source.slice(Math.max(0, boundary - 700), boundary);
    expect(before).toContain('WEB_FIXED_POSITION');
    expect(source.indexOf('</HubErrorBoundary>', boundary)).toBeGreaterThan(boundary);
  });

  test('the boundary takes an optional onRetry that cannot trap the fallback', () => {
    expect(BOUNDARY).toContain('onRetry?: () => void');
    expect(BOUNDARY).toMatch(/try \{\s*this\.props\.onRetry\?\.\(\);/);
  });
});
