// asp-v2 PR #92 (issue #91) selectors: median deposit size + in-pool transfers
// count on the public statistics payload.
//
// The load-bearing contract is GRACEFUL ABSENCE: the deployed API does not
// send these fields yet (probed live 2026-07-28 — /global/public/statistics
// carries neither), so every selector must answer null/fallback for a payload
// shaped like today's, and real values for a payload shaped like the PR's
// TimeBasedStatsDto. Nothing may coerce an absent field into a $0.

import { describe, expect, test } from 'bun:test';

import {
  medianDepositUsd,
  medianDepositUsdText,
  resolveTransfersCount,
  serverTransfersCount,
} from '../global-stats';
import type { TimeBasedStats } from '../api-types';

/** The deployed API's allTime block, verbatim shape (no PR #92 fields). */
const DEPLOYED_ALL_TIME: TimeBasedStats = {
  tvl: '0',
  tvlUsd: '454120.38',
  avgDepositSize: '0',
  avgDepositSizeUsd: '647.97',
  totalDepositsCount: 714,
  totalDepositsValue: '0',
  totalDepositsValueUsd: '462650.71',
  totalWithdrawalsCount: 121,
  totalWithdrawalsValue: '0',
  totalWithdrawalsValueUsd: '8262.28',
};

/** The same block once PR #92 deploys (fields per TimeBasedStatsDto). */
const PR92_ALL_TIME: TimeBasedStats = {
  ...DEPLOYED_ALL_TIME,
  medianDepositSize: '0',
  medianDepositSizeUsd: '1800.00',
  totalTransfersCount: 120,
};

describe('medianDepositUsd', () => {
  test('null on the deployed (pre-PR #92) payload. Field absent', () => {
    expect(medianDepositUsd(DEPLOYED_ALL_TIME)).toBeNull();
  });

  test('null on missing stats blocks', () => {
    expect(medianDepositUsd(undefined)).toBeNull();
    expect(medianDepositUsd(null)).toBeNull();
  });

  test('parses the PR #92 USD string', () => {
    expect(medianDepositUsd(PR92_ALL_TIME)).toBe(1800);
  });

  test('a present "0.00" with NO deposits is an EMPTY population. Omitted', () => {
    // Review finding (codex P2): the backend encodes "no deposits in this
    // window" as "0.00" rather than omitting the field. Rendering that as a
    // real $0 median tile is misinformation.
    expect(medianDepositUsd({ medianDepositSizeUsd: '0.00' })).toBeNull();
    expect(medianDepositUsd({ medianDepositSizeUsd: '0.00', totalDepositsCount: 0 })).toBeNull();
  });

  test('a present "0.00" WITH deposits is a genuine (dust) zero', () => {
    expect(medianDepositUsd({ medianDepositSizeUsd: '0.00', totalDepositsCount: 3 })).toBe(0);
    // ...and the display layer renders it as a figure, not an omission.
    expect(medianDepositUsdText({ medianDepositSizeUsd: '0.00', totalDepositsCount: 3 })).toBe('$0');
  });

  test('strict parsing: junk, partial numbers, negatives and separators are REJECTED', () => {
    // Review finding (codex P2 / kimi #3): parseFloat prefix-parsing laundered
    // junk into authoritative figures — "1,800.00" became $1, "12junk" $12,
    // "-5" rendered "$-5". A wrong number is worse than an omission.
    expect(medianDepositUsd({ medianDepositSizeUsd: '1,800.00', totalDepositsCount: 9 })).toBeNull();
    expect(medianDepositUsd({ medianDepositSizeUsd: '12junk', totalDepositsCount: 9 })).toBeNull();
    expect(medianDepositUsd({ medianDepositSizeUsd: '-5', totalDepositsCount: 9 })).toBeNull();
    expect(medianDepositUsd({ medianDepositSizeUsd: '--3', totalDepositsCount: 9 })).toBeNull();
    // Plain whitespace padding is tolerated; the digits must be complete.
    expect(medianDepositUsd({ medianDepositSizeUsd: ' 12.5 ', totalDepositsCount: 9 })).toBe(12.5);
  });

  test('native-only payload (medianDepositSize without the USD field) is omitted', () => {
    expect(medianDepositUsd({ medianDepositSize: '1500000000000000000', totalDepositsCount: 9 })).toBeNull();
  });

  test('null on unparsable values. Never NaN into a formatter', () => {
    expect(medianDepositUsd({ medianDepositSizeUsd: 'oops' })).toBeNull();
    expect(medianDepositUsd({ medianDepositSizeUsd: '' })).toBeNull();
  });
});

describe('medianDepositUsdText', () => {
  test('null (omit the tile/row) while the field is absent', () => {
    expect(medianDepositUsdText(DEPLOYED_ALL_TIME)).toBeNull();
    expect(medianDepositUsdText(undefined)).toBeNull();
  });

  test('formats through the canonical USD formatter', () => {
    expect(medianDepositUsdText(PR92_ALL_TIME)).toBe('$1,800');
    expect(medianDepositUsdText({ medianDepositSizeUsd: '12345.67' })).toBe('$12.35k');
  });
});

describe('serverTransfersCount', () => {
  test('null on the deployed (pre-PR #92) payload. Field absent', () => {
    expect(serverTransfersCount(DEPLOYED_ALL_TIME)).toBeNull();
    expect(serverTransfersCount(undefined)).toBeNull();
  });

  test('passes the PR #92 count through', () => {
    expect(serverTransfersCount(PR92_ALL_TIME)).toBe(120);
    expect(serverTransfersCount({ totalTransfersCount: 0 })).toBe(0);
  });

  test('rejects a negative count (server bug guard)', () => {
    expect(serverTransfersCount({ totalTransfersCount: -3 })).toBeNull();
  });
});

describe('serverTransfersCount. Schema-exact (review hardening)', () => {
  test('fractional counts are a server bug, not data. Fall back', () => {
    // Was Math.round(3.7) -> 4; a laundered figure suppressed the honest
    // client fallback (codex P2).
    expect(serverTransfersCount({ totalTransfersCount: 3.7 })).toBeNull();
  });
  test('string-typed counts are rejected (the schema says bare int)', () => {
    expect(serverTransfersCount({ totalTransfersCount: '120' as unknown as number })).toBeNull();
  });
  test('negative and unsafe-integer counts are rejected', () => {
    expect(serverTransfersCount({ totalTransfersCount: -1 })).toBeNull();
    expect(serverTransfersCount({ totalTransfersCount: 2 ** 53 })).toBeNull();
  });
  test('zero is a real count', () => {
    expect(serverTransfersCount({ totalTransfersCount: 0 })).toBe(0);
  });
  test('every rejected server value falls back to the client count', () => {
    for (const bad of [3.7, -1, 2 ** 53, '120' as unknown as number, NaN, Infinity]) {
      expect(resolveTransfersCount({ totalTransfersCount: bad as number }, 7)).toBe(7);
    }
  });
});

describe('scope (review P1): pool cards must be fed PER-ASSET stats', () => {
  test('the resolver itself is source-agnostic. Scope is the CALLER contract', () => {
    // The pool card passes assetStats.allTime (pool-scoped) and never the
    // global aggregate; this pins the arithmetic either way.
    const perAsset = { totalTransfersCount: 5 };
    expect(resolveTransfersCount(perAsset, 7)).toBe(5);
    expect(resolveTransfersCount(undefined, 7)).toBe(7);
  });
});

describe('resolveTransfersCount', () => {
  test('client-computed fallback while the server field is absent', () => {
    expect(resolveTransfersCount(DEPLOYED_ALL_TIME, 7)).toBe(7);
    expect(resolveTransfersCount(undefined, 7)).toBe(7);
  });

  test('server figure supersedes the client fallback once present', () => {
    expect(resolveTransfersCount(PR92_ALL_TIME, 7)).toBe(120);
    // A genuine server zero must win over a non-zero client undercount/overcount.
    expect(resolveTransfersCount({ totalTransfersCount: 0 }, 7)).toBe(0);
  });
});
