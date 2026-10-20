import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');

/**
 * Source-text ratchets for the one sentence a deposit flow is never allowed to
 * say once it has put a token approval through the user's wallet.
 *
 * These are read off the source rather than exercised, because the paths they
 * cover are the ones nobody runs: the branch where the claim backup disagrees
 * with the prepared note, the branch where the dry run reverts. A behavioural
 * test would need each of those to happen; the claim they must not make is
 * visible in the text either way, and the text is what the user reads.
 *
 * The rule: "Nothing was sent" is true only while the wallet has signed
 * nothing. Past the first approve() it is a statement the user can check
 * against their own wallet history, and finding it false reads as the app
 * having taken their tokens and denied it (QA, 2026-09-21).
 */
describe('no deposit path claims nothing was sent after an approval', () => {
  const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

  /**
   * The window each ratchet covers: from the first approve() this flow can
   * broadcast, to the point the funds transaction has landed. Scoping matters
   * — the same file's form-level guards run before anything is signed and are
   * entitled to the sentence.
   */
  const exposureWindow = (source: string, closes: string) => {
    const opens = source.indexOf("functionName: 'approve'");
    expect(opens).toBeGreaterThan(0);
    const shuts = source.indexOf(closes, opens);
    expect(shuts).toBeGreaterThan(opens);
    return source.slice(opens, shuts);
  };

  test('the deposit flow says nothing of the kind while an approval may be standing', () => {
    const source = read('components/deposit-modal-provider.tsx');
    // Closes at the outer catch: past that the handler is formatting, and it
    // formats through nothingSent().
    const window = exposureWindow(source, '\n    } catch (err');
    expect(window.match(/[Nn]othing was sent/g) ?? []).toEqual([]);
    // The helper that tells the truth instead is still the one in use.
    expect(source).toContain('const nothingSent = ()');
    expect(window).toContain('nothingSent()');
    // And the catch that follows narrates the approval rather than denying it.
    const tail = source.slice(source.indexOf('\n    } catch (err'));
    expect(tail).not.toMatch(/reportDepositError\('Transaction was rejected\.'\)/);
  });

  test('paying a request says nothing of the kind while an approval may be standing', () => {
    const source = read('components/payment-request-modal-provider.tsx');
    // Closes once the payment transaction itself has confirmed.
    const window = exposureWindow(source, 'const finalHash = payOutcome.finalHash;');
    expect(window.match(/[Nn]othing was sent/g) ?? []).toEqual([]);
  });

  test('the swap-deposit flow still routes every abandonment through the allowance cleanup', () => {
    const source = read('services/swap-flows.ts');
    const start = source.indexOf('export async function runSwapAndDeposit');
    const end = source.indexOf('export function hexToBigInt');
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    // Past the first wallet prompt nothing may throw directly: `abandon` and
    // `guarded` are the only exits, because they are the ones that hand the
    // allowance back first. The pre-approval refusals above the spender block
    // are exempt, and that block is where the wallet prompts begin.
    const promptsBegin = body.indexOf('// ── Who gets the allowance');
    expect(promptsBegin).toBeGreaterThan(0);
    const postPrompt = body.slice(promptsBegin);
    expect(postPrompt).not.toMatch(/\bthrow new (SwapDepositPreflightError|UnexpectedSwapTxError)\b/);
    expect(postPrompt).toContain('await abandon(');
  });
});
