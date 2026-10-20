/**
 * An SDK error is shown in the units of the asset it is about, or not
 * rewritten at all.
 *
 * Swapping 5 USDC into the ppUSDT vault produced "Deposit value
 * 4765396938345822042 is below the Entrypoint minimum 10000000000000000000".
 * Correct, and unreadable beside an amount field showing 5 (QA, 2026-09-22).
 * Since v2-monorepo#434 the SDK attaches the figures to the error, and this is
 * where they become readable.
 *
 * Fixtures come from the real producer where the SDK exports one
 * (`InfeasibleBatchFee`, `InvalidYieldAmount`), and the SDK's own
 * `hasErrorAmounts` is asked to agree with every structured fixture here, so a
 * change to the contract fails this file rather than the user.
 */
import { describe, expect, test } from 'bun:test';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { hasErrorAmounts, InfeasibleBatchFee, InvalidYieldAmount } from '@privacy-pools-v2/sdk';

import { humanizeSdkAmounts, KNOWN_AMOUNT_CODES, sdkErrorText, sentenceKeys } from '@/services/sdk-error-amounts';

const USDC = { decimals: 6, symbol: 'USDC' };
const PPUSDC = { decimals: 18, symbol: 'ppUSDC' };
const PPUSDT = { decimals: 18, symbol: 'ppUSDT' };
const BSC_USDT = { decimals: 18, symbol: 'USDT' };
const BNB = { decimals: 18, symbol: 'BNB' };

/** An error shaped exactly as the SDK builds it at the throw site. */
function sdkError(message: string, code: string, side: 'spent' | 'received', values: Record<string, bigint>) {
  const err = new Error(message) as Error & { amounts: unknown };
  err.amounts = { code, side, values };
  expect(hasErrorAmounts(err)).toBe(true);
  return err;
}

describe('every code the SDK can send has a sentence here', () => {
  test('derived from the vendored SDK, not restated', () => {
    // The split SDK ships core-sdk's declarations beside index.d.ts, which
    // re-exports them; the union lives there now.
    const dist = join(new URL('.', import.meta.url).pathname, '..', '..', 'node_modules/@privacy-pools-v2/sdk/dist');
    const dts = ['index.d.ts', 'core-sdk.d.ts']
      .filter((f) => existsSync(join(dist, f)))
      .map((f) => readFileSync(join(dist, f), 'utf8'))
      .join('\n');
    const union = /type AmountErrorCode =([^;]+);/.exec(dts)?.[1] ?? '';
    // Any quoted member, not only letters: a code spelled with a digit or an
    // underscore must not slip past this check (review on #122).
    const codes = [...union.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(codes.length).toBeGreaterThan(10);
    expect(codes.filter((c) => !KNOWN_AMOUNT_CODES.includes(c))).toEqual([]);
  });
});

describe('every value key a sentence reads is one the SDK actually sends', () => {
  // Read from the vendored bundle's own throw sites, not restated here. A field
  // the SDK renames would otherwise make the sentence bail out to the raw base
  // units with no test going red (review on #122, and the CLAUDE.md rule that a
  // hand-written expectation is not a check).
  // Every ESM chunk: the build splits shared code out of index.js (batchFee.js
  // carries two of these), and a code that moves to a new chunk must not drop
  // out of the check. A code declared in the type but never thrown is dropped by
  // the bundler entirely (insufficientChangeForFee today) and is skipped below.
  const dist = join(new URL('.', import.meta.url).pathname, '..', '..', 'node_modules/@privacy-pools-v2/sdk/dist');
  const bundle = readdirSync(dist)
    .filter((f) => f.endsWith('.js'))
    .map((f) => readFileSync(join(dist, f), 'utf8'))
    .join('\n');
  const sites = new Map<string, string[][]>();
  for (const m of bundle.matchAll(/code:\s*"([^"]+)",\s*side:\s*"(?:spent|received)",\s*values:\s*\{/g)) {
    let depth = 1;
    let i = m.index! + m[0].length;
    const start = i;
    while (depth > 0 && i < bundle.length) {
      if (bundle[i] === '{') depth++;
      else if (bundle[i] === '}') depth--;
      i++;
    }
    const body = bundle.slice(start, i - 1);
    let d = 0;
    let part = '';
    const parts: string[] = [];
    for (const ch of body) {
      if (ch === '(' || ch === '{' || ch === '[') d++;
      if (ch === ')' || ch === '}' || ch === ']') d--;
      if (ch === ',' && d === 0) { parts.push(part); part = ''; } else part += ch;
    }
    parts.push(part);
    const keys = parts.map((p) => p.trim().split(':')[0].trim()).filter((k) => /^\w+$/.test(k));
    sites.set(m[1], [...(sites.get(m[1]) ?? []), keys]);
  }

  test('the bundle is actually parsed', () => {
    expect(sites.size).toBeGreaterThan(10);
  });

  for (const code of KNOWN_AMOUNT_CODES) {
    test(`${code}`, () => {
      const need = sentenceKeys(code)!;
      const seen = sites.get(code) ?? [];
      // A code no site throws yet is covered by the code-list test above.
      if (seen.length === 0) return;
      for (const keys of seen) {
        expect(need.required.filter((k) => !keys.includes(k))).toEqual([]);
      }
      const union = new Set(seen.flat());
      expect(need.optional.filter((k) => !union.has(k))).toEqual([]);
    });
  }
});

describe('structured amounts, from the real producer', () => {
  test('a batch fee reads in the note being withdrawn', () => {
    const err = new InfeasibleBatchFee('1500000', '1000000');
    expect(hasErrorAmounts(err)).toBe(true);
    expect(sdkErrorText(err, { input: USDC })).toBe(
      'One withdrawal in this batch costs 1.5 USDC in fees against the 1 USDC it pays out. Withdraw it on its own or leave it out.',
    );
  });

  test('a router quote reads in the FUNDING asset, not the share', () => {
    // Mainnet ppUSDC: the share is 18 decimals, the USDC funding it is 6.
    // Formatting these at the share's scale is the bug this side exists for.
    const err = new InvalidYieldAmount(
      'router quote 20133906 exceeds the spendable budget 20133905: the rate or fee moved while sizing, size again',
      { code: 'invalidYieldAmount', side: 'spent', values: { quote: 20133906n, budget: 20133905n } },
    );
    expect(hasErrorAmounts(err)).toBe(true);
    expect(sdkErrorText(err, { input: PPUSDC, output: PPUSDC, funding: USDC })).toBe(
      'The vault quoted about 20.1339 USDC against a budget of 20.1339 USDC, over by 0.000001 USDC. The rate moved while sizing. Try again.',
    );
  });
});

describe('each code in the asset it is actually about', () => {
  test('a deposit minimum is the destination pool\'s', () => {
    const err = sdkError(
      'Deposit value 4765396938345822042 is below the Entrypoint minimum 10000000000000000000',
      'depositBelowMinimum', 'received', { value: 4765396938345822042n, minimum: 10000000000000000000n },
    );
    // The share displays under its underlying's name.
    expect(sdkErrorText(err, { input: USDC, output: PPUSDT })).toBe(
      "This would deposit about 4.7653 USDT, below the pool's minimum of 10 USDT. Try a larger amount.",
    );
  });

  test('image 48 from QA, native BNB', () => {
    const err = sdkError(
      'Deposit value 5194630821167384 is below the Entrypoint minimum 20000000000000000',
      'depositBelowMinimum', 'received', { value: 5194630821167384n, minimum: 20000000000000000n },
    );
    expect(sdkErrorText(err, { input: BSC_USDT, output: BNB })).toBe(
      "This would deposit about 0.0051 BNB, below the pool's minimum of 0.02 BNB. Try a larger amount.",
    );
  });

  test('LiFi\'s shortfall is in the redeemed underlying, not the share note', () => {
    const err = sdkError('LiFi needs 20133905 input but only 20100000 available after fee.', 'lifiInputExceedsNet', 'spent', {
      required: 20133905n, available: 20100000n,
    });
    expect(sdkErrorText(err, { input: PPUSDC, swapInput: USDC, output: PPUSDT })).toBe(
      'This route needs 20.1339 USDC but only 20.1 USDC is left after the fee, a shortfall of 0.033905 USDC. Reduce the amount slightly and try again.',
    );
  });

  test('a shortfall of one base unit is stated, not rounded into two identical figures', () => {
    // At four decimals 20133906 and 20133905 both print 20.1339, which made
    // "reduce the amount" read as nonsense (Opus review on #122).
    const err = sdkError('LiFi needs 20133906 input but only 20133905 available after fee.', 'lifiInputExceedsNet', 'spent', {
      required: 20133906n, available: 20133905n,
    });
    const text = sdkErrorText(err, { swapInput: USDC });
    expect(text).toContain('a shortfall of 0.000001 USDC');
  });

  test('a relayer fee comes out of the note', () => {
    const err = sdkError('Relay fee (2500000) exceeds withdrawal amount (2000000).', 'relayFeeConsumesWithdrawal', 'spent', {
      fee: 2500000n, amount: 2000000n,
    });
    expect(sdkErrorText(err, { input: USDC, output: BNB })).toBe(
      'The relayer fee of 2.5 USDC would take all of the 2 USDC. Try a larger amount.',
    );
  });

  test('an amount mismatch says what was reviewed, when the SDK sends it', () => {
    const both = sdkError('mismatch', 'commitmentAmountSentMismatch', 'spent', { amountSent: 1000000n, expected: 2000000n });
    expect(sdkErrorText(both, { input: USDC })).toBe(
      "The relayer's quote would send 1 USDC instead of the 2 USDC you reviewed, a difference of 1 USDC. Review again.",
    );
    const one = sdkError('mismatch', 'commitmentAmountSentMismatch', 'spent', { amountSent: 1000000n });
    expect(sdkErrorText(one, { input: USDC })).toBe("The relayer's quote would send 1 USDC, not what you reviewed. Review again.");
  });
});

describe('a floor is never shown lower than it is', () => {
  test('a minimum rounds up, so entering the shown figure is enough', () => {
    // 10.00005 truncated to "10" and the user was refused again at 10 (Opus review on #122).
    const err = sdkError('min', 'depositBelowMinimum', 'received', {
      value: 10_000_010_000_000_000_000n, minimum: 10_000_050_000_000_000_000n,
    });
    expect(sdkErrorText(err, { output: BSC_USDT })).toBe(
      "This would deposit about 10 USDT, below the pool's minimum of 10.0001 USDT. Try a larger amount.",
    );
  });

  test('an exact minimum is not bumped', () => {
    const err = sdkError('min', 'depositBelowMinimum', 'received', { value: 5_000_000n, minimum: 10_000_000n });
    expect(sdkErrorText(err, { output: USDC })).toContain("minimum of 10 USDC");
  });

  test('the message-only path rounds the same way', () => {
    expect(sdkErrorText(new Error('Deposit value 10000010 is below the Entrypoint minimum 10000050'), { output: { decimals: 6, symbol: 'USDC' } }))
      .toContain('minimum of 10.0001 USDC');
  });
});

describe('what it refuses to guess', () => {
  test('no units for the side the error is about: the raw message stays', () => {
    const err = sdkError('Deposit value 5 is below the Entrypoint minimum 10', 'depositBelowMinimum', 'received', {
      value: 5n, minimum: 10n,
    });
    // Only the input is known; borrowing it would name the wrong asset.
    expect(sdkErrorText(err, { input: USDC })).toBe('Deposit value 5 is below the Entrypoint minimum 10');
  });

  test('a figure the sentence needs is missing: the raw message, not a sentence with a hole', () => {
    const err = sdkError('Deposit value 5 is below the Entrypoint minimum ?', 'depositBelowMinimum', 'received', { value: 5n });
    expect(sdkErrorText(err, { output: USDC })).toBe('Deposit value 5 is below the Entrypoint minimum ?');
  });

  test('no units at all: the raw message', () => {
    const err = sdkError('Item fee 1 exceeds its withdrawn amount 2', 'infeasibleBatchFee', 'spent', { fee: 1n, amountOut: 2n });
    expect(sdkErrorText(err, null)).toBe('Item fee 1 exceeds its withdrawn amount 2');
  });

  test('a tiny nonzero figure never reads as zero', () => {
    const err = sdkError('fee', 'relayFeeConsumesWithdrawal', 'spent', { fee: 30n, amount: 10n });
    expect(sdkErrorText(err, { input: USDC })).toBe(
      'The relayer fee of less than 0.0001 USDC would take all of the less than 0.0001 USDC. Try a larger amount.',
    );
  });
});

describe('robust to how the error arrives', () => {
  test('a wrapped error is read through its cause', () => {
    const inner = sdkError('Deposit value 5000000 is below the Entrypoint minimum 10000000', 'depositBelowMinimum', 'received', {
      value: 5000000n, minimum: 10000000n,
    });
    const outer = new Error('Swap failed', { cause: inner });
    expect(sdkErrorText(outer, { output: USDC })).toBe(
      "This would deposit about 5 USDC, below the pool's minimum of 10 USDC. Try a larger amount.",
    );
  });

  test('an unknown code converts a figure that ends the sentence too', () => {
    // A trailing "." used to block the match, leaving one raw figure beside a
    // converted one (review on #122).
    const err = sdkError('Thing cost 1500000, allowed 1000000.', 'someFutureCode', 'spent', {
      cost: 1500000n, allowed: 1000000n,
    });
    expect(sdkErrorText(err, { input: USDC })).toBe('Thing cost 1.5 USDC, allowed 1 USDC.');
  });

  test('a relayer amount off by one base unit states the difference', () => {
    const err = sdkError('m', 'commitmentAmountSentMismatch', 'spent', { amountSent: 20133906n, expected: 20133905n });
    expect(sdkErrorText(err, { input: USDC })).toContain('a difference of 0.000001 USDC');
  });

  test('a code this file does not know keeps its wording, with its figures made readable', () => {
    const err = sdkError('Thing cost 1500000 against 1000000 allowed', 'someFutureCode', 'spent', {
      cost: 1500000n, allowed: 1000000n,
    });
    expect(sdkErrorText(err, { input: USDC })).toBe('Thing cost 1.5 USDC against 1 USDC allowed');
  });

  test('the fields lost on the way: the message rules still apply', () => {
    // A plain Error with only the text, as when a boundary re-throws the message.
    expect(sdkErrorText(new Error('Deposit value 4765396 is below the Entrypoint minimum 10000000'), { output: USDC })).toBe(
      "This would deposit about 4.7653 USDC, below the pool's minimum of 10 USDC. Try a larger amount.",
    );
    expect(humanizeSdkAmounts(
      'Invalid yield amount: router quote 20133906 exceeds the spendable budget 20133905: the rate or fee moved while sizing, size again',
      { output: PPUSDC, funding: USDC },
    )).toBe('The vault quoted about 20.1339 USDC against a budget of 20.1339 USDC, over by 0.000001 USDC. The rate moved while sizing. Try again.');
  });

  test('an unrelated long integer is never reformatted as money', () => {
    const commitment = 'Commitment 18446744073709551616123 not found';
    expect(sdkErrorText(new Error(commitment), { input: USDC, output: USDC })).toBe(commitment);
  });

  test('a non-Error falls back without throwing', () => {
    expect(sdkErrorText(undefined, { input: USDC }, 'The swap failed.')).toBe('The swap failed.');
    expect(sdkErrorText('plain text', { input: USDC })).toBe('plain text');
  });

  test('a caller\'s own fallback beats String(err) for a non-Error rejection', () => {
    // "[object Object]" replaced "Failed to pay via private transfer." (review on #122).
    expect(sdkErrorText({ code: 4001 }, { input: USDC }, 'Failed to pay via private transfer.'))
      .toBe('Failed to pay via private transfer.');
  });

  test('a rejection that is neither an Error nor a string still has a reason', () => {
    // Every site printed String(err) before; an empty reason after "Withdrawal
    // failed: " is worse (Opus review on #122).
    expect(sdkErrorText({ code: 4001 }, { input: USDC })).toBe('[object Object]');
    expect(sdkErrorText(42, { input: USDC })).toBe('42');
    expect(sdkErrorText(null, { input: USDC })).toBe('');
  });
});

describe('copy rules', () => {
  test('no sentence uses an em dash', () => {
    const src = readFileSync(join(new URL('.', import.meta.url).pathname, '..', 'sdk-error-amounts.ts'), 'utf8');
    const sentences = [...src.matchAll(/`([^`]*\$\{[^`]*)`/g)].map((m) => m[1]);
    expect(sentences.length).toBeGreaterThan(15);
    for (const s of sentences) expect(s).not.toContain('—');
  });
});
