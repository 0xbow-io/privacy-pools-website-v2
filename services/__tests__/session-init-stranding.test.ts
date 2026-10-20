import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import {
  SESSION_INIT_TIMEOUT_MS,
  SessionInitTimeoutError,
  isSessionInitTimeout,
  withSessionInitTimeout,
} from '../session-init-timeout';

const read = (rel: string) => readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

/**
 * QA, 2026-09-21: idle on the Send form for two minutes, then submit, and the
 * flow sat on "Syncing latest pool state..." with no error and no way out.
 *
 * The shape of it: `ensureInitialized()` hands every caller ONE shared
 * in-flight promise, and every await inside that promise is unbounded. So a
 * single stalled init strands every flow that asks for a session afterwards,
 * forever. These tests pin the bound that makes that impossible.
 */
describe('a stalled session init can no longer strand a flow', () => {
  test('a promise that never settles rejects once the wait budget passes', async () => {
    // The stranding itself: a promise with no settle path, exactly what a
    // suspended wallet extension or a reaped idle connection produces.
    const neverSettles = new Promise<string>(() => { /* deliberately never */ });

    let released = false;
    const waited = withSessionInitTimeout(neverSettles, {
      timeoutMs: 25,
      onTimeout: () => { released = true; },
    });

    await expect(waited).rejects.toBeInstanceOf(SessionInitTimeoutError);
    // The provider drops the shared promise, so the user's retry is a real
    // second attempt rather than a re-attach to the same stalled work.
    expect(released).toBe(true);
  });

  test('the rejection says what the user can do and names no internals', async () => {
    let message = '';
    try {
      await withSessionInitTimeout(new Promise(() => {}), { timeoutMs: 10 });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/try again/i);
    expect(message).toMatch(/wallet/i);
    // House rule: sentence breaks, never em dashes.
    expect(message).not.toContain('—');
    // Nothing about promises, sessions, SDKs or timeouts as machinery.
    expect(message).not.toMatch(/promise|SDK|ensureInitialized/i);
  });

  test('isSessionInitTimeout recognises the rejection the flows branch on', () => {
    expect(isSessionInitTimeout(new SessionInitTimeoutError())).toBe(true);
    expect(isSessionInitTimeout(new Error('Signature cancelled.'))).toBe(false);
    expect(isSessionInitTimeout('nope')).toBe(false);
  });

  test('a healthy init is untouched: it resolves with its own value', async () => {
    const value = await withSessionInitTimeout(Promise.resolve('session'), { timeoutMs: 1_000 });
    expect(value).toBe('session');
  });

  test('a real failure still surfaces as itself, not as a timeout', async () => {
    const boom = new Error('Key source changed during initialization; retry.');
    await expect(
      withSessionInitTimeout(Promise.reject(boom), { timeoutMs: 1_000 }),
    ).rejects.toThrow('Key source changed during initialization; retry.');
  });

  test('a late rejection after an abandoned wait is swallowed, not raised', async () => {
    let rejectLate: (err: Error) => void = () => {};
    const late = new Promise<string>((_, reject) => { rejectLate = reject; });

    await expect(
      withSessionInitTimeout(late, { timeoutMs: 10 }),
    ).rejects.toBeInstanceOf(SessionInitTimeoutError);

    // The wallet finally answers, with a refusal, after nobody is waiting.
    // Abandoning a wait must not turn into an unhandled rejection.
    rejectLate(new Error('user rejected the request'));
    await new Promise((r) => setTimeout(r, 20));
  });

  test('the shared in-flight promise no longer strands a later caller', async () => {
    // A faithful miniature of the provider: one in-flight promise, reused by
    // everyone who asks while it is running. Caller A starts it (the idle
    // page); caller B is the Send press two minutes later.
    let inFlight: Promise<string> | null = null;
    const ensure = () => {
      if (inFlight) {
        const held = inFlight;
        return withSessionInitTimeout(held, {
          timeoutMs: 25,
          onTimeout: () => { if (inFlight === held) inFlight = null; },
        });
      }
      const started = new Promise<string>(() => { /* stalls */ });
      inFlight = started;
      return withSessionInitTimeout(started, {
        timeoutMs: 25,
        onTimeout: () => { if (inFlight === started) inFlight = null; },
      });
    };

    const settled = await Promise.allSettled([ensure(), ensure()]);
    for (const outcome of settled) {
      expect(outcome.status).toBe('rejected');
      expect(isSessionInitTimeout((outcome as PromiseRejectedResult).reason)).toBe(true);
    }
    // And the retry is a fresh attempt, not the stalled one again.
    expect(inFlight).toBeNull();
  });

  test('the default budget is bounded and generous enough for a wallet prompt', () => {
    expect(SESSION_INIT_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(SESSION_INIT_TIMEOUT_MS).toBeLessThanOrEqual(180_000);
  });
});

describe('every flow that asks for a session is covered', () => {
  const provider = read('components/sdk-provider.tsx');

  test('ensureInitialized bounds the fresh init AND the reused in-flight one', () => {
    // Two return paths, and the reuse path is the one that stranded Send.
    const wraps = provider.match(/withSessionInitTimeout\(/g) ?? [];
    expect(wraps.length).toBeGreaterThanOrEqual(2);
    expect(provider).toContain('const inFlight = ensureInitPromiseRef.current;');
    expect(provider).toContain('return withSessionInitTimeout(inFlight, { onTimeout: abandonWait(inFlight) });');
    expect(provider).toContain('return withSessionInitTimeout(initPromise, { onTimeout: abandonWait(initPromise) });');
  });

  test('an abandoned wait releases the shared promise and the initializing flag', () => {
    const abandon = provider.slice(
      provider.indexOf('const abandonWait ='),
      provider.indexOf('if (ensureInitPromiseRef.current) {'),
    );
    expect(abandon).toContain('ensureInitPromiseRef.current = null;');
    expect(abandon).toContain('setIsInitializing(false);');
    // Only its own promise, never a newer caller's.
    expect(abandon).toContain('if (ensureInitPromiseRef.current === waited)');
  });

  test('the bound sits in ensureInitialized, so no flow has to add its own', () => {
    // Deposit, withdraw, send, swap, payment requests, ragequit, note import
    // and gasless registration all reach a session through this one function.
    for (const file of [
      'components/deposit-modal-provider.tsx',
      'components/withdraw-modal-provider.tsx',
      'components/transfer-modal-provider.tsx',
      'components/swap-modal-provider.tsx',
      'components/payment-request-modal-provider.tsx',
      'components/ragequit-modal-provider.tsx',
    ]) {
      expect(read(file)).toContain('ensureInitialized()');
    }
  });
});

describe('the transfer flow returns the user to a screen they can act on', () => {
  const transfer = read('components/transfer-modal-provider.tsx');
  const handler = transfer.slice(
    transfer.indexOf("setLoadingMessage('Syncing latest pool state...')"),
    transfer.indexOf('// DEV-237: when "Hide my address" is unchecked'),
  );

  test('the init failure path reports, returns to review, and releases the tx pause', () => {
    expect(handler).toContain('isSessionInitTimeout(initErr)');
    expect(handler).toContain("setStep('review');");
    // beginTx() pauses background polling before the await; every exit from
    // here has to undo it or polling stays paused for the life of the page.
    expect(handler).toContain('endTx();');
    const beginAt = handler.indexOf('beginTx();');
    const endAt = handler.indexOf('endTx();');
    expect(beginAt).toBeGreaterThanOrEqual(0);
    expect(endAt).toBeGreaterThan(beginAt);
  });

  test('the timeout message reaches the user unchanged, not wrapped in internals', () => {
    // "Couldn't initialize the SDK: ..." is the generic wrapper; the timeout
    // already reads as advice, so it must not be wrapped in that.
    const branch = handler.slice(handler.indexOf('reportTransferError('), handler.indexOf("setStep('review');"));
    expect(branch).toContain('isSessionInitTimeout(initErr)');
    expect(branch.indexOf('isSessionInitTimeout(initErr)'))
      .toBeLessThan(branch.indexOf("Couldn't initialize the SDK"));
  });
});

describe('an ASP request cannot stall without end', () => {
  const client = read('services/api-client.ts');

  test('every request carries an abort budget covering the body read', () => {
    expect(client).toContain('const abort = new AbortController();');
    expect(client).toContain('ASP_REQUEST_TIMEOUT_MS');
    expect(client).toContain('signal: abort.signal,');
    expect(client).toContain('clearTimeout(abortTimer);');
  });

  test('a caller-supplied signal still aborts the request', () => {
    expect(client).toContain("init.signal.addEventListener('abort'");
  });
});

describe('the Send amount is inert while the transfer is in flight', () => {
  const hub = read('components/home/action-hub.tsx');

  test('zoneBusy includes a Send term', () => {
    expect(hub).toContain('const zoneBusy = shieldBusy || withdrawBusy || sendBusy || swapBusy;');
  });

  test('Send is busy on every step past the form, inline only', () => {
    expect(hub).toMatch(
      /const sendBusy = a === 'send' && \(\(transferInline && transferStep !== 'select-notes'\)[\s\S]*?\|\| swapInlineSend\);/,
    );
  });

  test('the form step is the one step that stays editable', () => {
    // If the provider renames or adds steps, this is the list to revisit.
    const provider = read('components/transfer-modal-provider.tsx');
    expect(provider).toContain(
      // 'choose-asset' is consolidation's asset list, which never draws inline.
      "type TransferStep = 'choose-asset' | 'select-notes' | 'unregistered-confirm' | 'review' | 'loading' | 'success';",
    );
  });

  test('every busy zone still gates the input and the fiat toggle', () => {
    expect(hub).toContain("editable={!zoneBusy && !requestFrozen && !requestOverlayOwns}");
    expect(hub).toContain("pointerEvents={zoneBusy ? 'none' : 'auto'}");
  });
});
