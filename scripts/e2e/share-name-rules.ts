/**
 * What the share-name guard looks for on screen.
 *
 * A pool share is an implementation detail: the user holds ETH, USDC or USDT,
 * and the share token's own symbol (the "pp" prefixed one) and the noun "share"
 * must never reach a sentence, a label, a toast or a placeholder. This is the
 * browser half of services/__tests__/share-symbol-render-guard.test.ts: that
 * test reads the source, this reads what was actually painted.
 *
 * `findShareNames` is self-contained on purpose: the e2e guard ships its source
 * into the page (`Function.prototype.toString`) and runs it on every DOM change,
 * so it may not reference anything outside its own body.
 *
 * The verb is not a share name. "Share this request", "Share a link, get paid
 * privately", "Never share this code" and a bare "Share" button are copy about
 * sharing a link, and a literal /\bshares?\b/ would fail every page that offers
 * one. The noun is caught by its shape instead: the plural always, and the
 * singular after a determiner or before a unit word ("a pool share", "the share
 * amount", "share count"). scripts/e2e/__tests__/share-name-rules.test.ts pins
 * both sides.
 */
export type ShareNameHit = { match: string; snippet: string };

export function findShareNames(text: string): ShareNameHit[] {
  const SYMBOL = /\bpp(ETH|USDC|USDT|BNB)\b/gi;
  const PLURAL = /\bshares\b/gi;
  const SINGULAR = /\bshare\b/gi;
  // A noun phrase: "1 share", "a share", "the share", "pool share", "per share", "your share".
  const NOUN_BEFORE = /(\d|\b(a|an|the|one|each|per|every|pool|vault|yield|your|this|that|its|their|of|in|as))\s+$/i;
  // A unit after it: "share count", "share amount", "share balance", "share rate".
  const NOUN_AFTER = /^\s+(counts?|amounts?|balances?|rates?|prices?|tokens?|values?|units?|figures?|symbols?|names?|class|of\b)/i;
  // DEV-621: a raw count under a coin label. The old fallback printed the count
  // marked "≈" ("≈ 4.94 USDT"); a converted estimate is written "~", and a
  // figure still loading is a shimmer, so a "≈" before a coin figure is a count.
  const COUNT = /≈\s*<?\d[\d,]*(?:\.\d+)?[KMB]?\s+(ETH|USDC|USDT)\b/g;
  // DEV-621: a stablecoin figure always has exactly two decimals ("4.97 USDT"),
  // so more is a count or an unformatted value ("4.918123 USDT").
  const STABLE_DIGITS = /(?<![\d.])\d[\d,]*\.\d{3,}\s+(USDC|USDT)\b/g;
  // DEV-621: a dollar figure with decimals has exactly two ("$4.97"), so "$4.9"
  // and "$4.9694" are an unformatted value. An abbreviated figure ("$10.82k",
  // "$1.5M") and a "<$0.01" threshold are the other shapes. A whole-dollar
  // amount ("$100") is not judged here: the Shield presets are whole dollars on
  // purpose. figures.smoke.ts checks the pages that hold balances for it.
  const USD_DIGITS = /(?<![\d.])\$\d[\d,]*(?:\.\d{3,}|\.\d(?![\d.,kKmMbB]))/g;
  const hits: ShareNameHit[] = [];
  const snip = (at: number, len: number) =>
    text.slice(Math.max(0, at - 40), Math.min(text.length, at + len + 40)).replace(/\s+/g, ' ').trim();
  for (const re of [SYMBOL, PLURAL, COUNT, STABLE_DIGITS, USD_DIGITS]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      hits.push({ match: m[0], snippet: snip(m.index, m[0].length) });
    }
  }
  SINGULAR.lastIndex = 0;
  for (let m = SINGULAR.exec(text); m; m = SINGULAR.exec(text)) {
    const before = text.slice(Math.max(0, m.index - 24), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (NOUN_BEFORE.test(before) || NOUN_AFTER.test(after)) hits.push({ match: m[0], snippet: snip(m.index, m[0].length) });
  }
  return hits;
}
