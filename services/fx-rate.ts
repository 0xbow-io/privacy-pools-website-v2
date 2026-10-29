// USD→EUR reference rate for the payroll display-currency toggle.
//
// Source: Frankfurter (https://frankfurter.dev), a free, no-key wrapper over the
// European Central Bank's daily reference rates. The ECB publishes once per
// business day (~16:00 CET), so this rate is a display-only convenience, never a
// settlement figure: payroll amounts are token-denominated on-chain, and every
// internal price stays in USD. Callers cache the result (react-query) rather
// than refetching per render.

import { routedFetch } from '@/services/tor-fetch';

const FRANKFURTER_URL = 'https://api.frankfurter.dev/v1/latest?base=USD&symbols=EUR';

/** Fetch the latest USD→EUR rate. Throws on a network error or a malformed
 *  response so the caller (react-query) can retain the last good cached value
 *  and surface the failure, rather than silently formatting with a bad rate. */
export async function getUsdToEurRate(): Promise<number> {
  const res = await routedFetch('web')(FRANKFURTER_URL);
  if (!res.ok) throw new Error(`FX rate request failed: ${res.status}`);
  const json = (await res.json()) as { rates?: { EUR?: number } };
  const rate = json?.rates?.EUR;
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    throw new Error('FX rate missing or invalid in response');
  }
  return rate;
}
