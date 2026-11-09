// @ts-nocheck - playwright page plumbing; the rules it runs are typed and unit
// tested in share-name-rules.ts.
//
// The share-name guard for every browser run.
//
// It also fails a run that paints a raw count under a coin label ("≈ 4.94
// USDT") or a stablecoin figure with more than two decimals (DEV-621): the
// rules are in share-name-rules.ts.
//
// Installed once per page, it scans what the user can read: document.body
// innerText plus every aria-label, title, placeholder and alt. It scans on
// every DOM change (debounced), so a toast, modal or dialog that is up for one
// second is caught even when no step looks at it, and on every explicit
// `checkpoint(step)`. A hit is reported to node the moment it is painted, so
// `failures()` holds it even when the page is gone, and `checkpoint` throws
// with the snippet that matched.
import type { Page } from 'playwright';
import { findShareNames, type ShareNameHit } from './share-name-rules.ts';

export type GuardHit = ShareNameHit & { source: string; url: string; step: string };

const pageScan = `(() => {
  const findShareNames = (${findShareNames.toString()});
  const attrs = ['aria-label', 'title', 'placeholder', 'alt'];
  window.__shareNameScan = () => {
    const out = [];
    const body = document.body;
    if (!body) return out;
    // A scoped guard reads only the surface a smoke owns (a selector); the
    // default is the whole page.
    const scope = window.__shareNameScope;
    // A hovered (i) hint paints its bubble in a portal (role=tooltip), outside
    // any scope: a scoped smoke only hovers hints inside its own surface.
    const roots = scope ? Array.from(body.querySelectorAll(scope + ', [role="tooltip"]')) : [body];
    // The debug log panel (ppv2_debug) prints raw app logs, which name tokens
    // by their on-chain symbol. It is a developer surface, not copy.
    let debug = document.querySelector('[aria-label="Close debug logs"]');
    while (debug && debug !== body && getComputedStyle(debug).zIndex !== '999998') debug = debug.parentElement;
    if (debug === body) debug = null;
    const sel = attrs.map((a) => '[' + a + ']').join(',');
    for (const root of roots) {
      if (debug && debug.contains(root)) continue;
      let text = root.innerText || '';
      if (debug && root.contains(debug)) text = text.split(debug.innerText || '').join('\\n');
      for (const h of findShareNames(text)) out.push({ ...h, source: 'text' });
      for (const el of [root, ...root.querySelectorAll(sel)]) {
        if (debug && debug.contains(el)) continue;
        for (const a of attrs) {
          const v = el.getAttribute && el.getAttribute(a);
          if (v) for (const h of findShareNames(v)) out.push({ ...h, source: a });
        }
      }
      // A text field's typed value is the user's, not the app's copy, but a
      // prefilled read-only value is the app talking.
      for (const el of root.querySelectorAll('input[readonly],textarea[readonly],input[disabled]')) {
        for (const h of findShareNames(el.value || '')) out.push({ ...h, source: 'value' });
      }
    }
    return out;
  };
  let timer = null;
  const report = () => {
    timer = null;
    try {
      const hits = window.__shareNameScan();
      if (hits.length && window.__shareNameHit) window.__shareNameHit(JSON.stringify(hits));
    } catch {}
  };
  const start = () => {
    new MutationObserver(() => { if (!timer) timer = setTimeout(report, 120); })
      .observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: attrs });
    report();
  };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
})();`;

export type ShareNameGuard = {
  /** Scan now and throw on any hit seen since the last checkpoint. */
  checkpoint: (step: string) => Promise<void>;
  /** Every hit this guard has seen, deduplicated. */
  failures: () => GuardHit[];
};

const all: GuardHit[] = [];
let exitHooked = false;

/** Every hit any guard in this process has seen. */
export function shareNameFailures(): GuardHit[] {
  return all.slice();
}

export function formatHits(hits: GuardHit[]): string {
  return hits.map((h) => `"${h.match}" in ${h.source} at ${h.step} (${h.url}): ...${h.snippet}...`).join('\n  ');
}

export async function installShareNameGuard(page: Page, opts: {
  label?: string;
  /** CSS selector: scan only inside these elements. The whole page when omitted. */
  scope?: string;
} = {}): Promise<ShareNameGuard> {
  const seen = new Set<string>();
  const mine: GuardHit[] = [];
  let unreported = 0;
  let step = 'load';
  const record = (hits: (ShareNameHit & { source: string })[]) => {
    let url = '';
    try { url = new URL(page.url()).pathname + new URL(page.url()).search; } catch {}
    for (const h of hits) {
      const key = `${h.source}|${h.snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hit = { ...h, url, step };
      mine.push(hit);
      all.push(hit);
      unreported += 1;
      console.log(`  [share-name] ${opts.label ? `${opts.label}: ` : ''}${formatHits([hit])}`);
    }
  };
  await page.exposeBinding('__shareNameHit', (_src, json: string) => record(JSON.parse(json)));
  if (opts.scope) await page.addInitScript(`window.__shareNameScope = ${JSON.stringify(opts.scope)};`);
  await page.addInitScript(pageScan);
  if (!exitHooked) {
    exitHooked = true;
    // A hit painted between checkpoints, or after the last one, still fails the
    // run: nothing a journey does afterwards can make it not have been shown.
    process.on('exit', () => {
      if (all.length && !process.exitCode) {
        console.error(`\nshare-name guard: ${all.length} share name(s) reached the screen:\n  ${formatHits(all)}`);
        process.exitCode = 1;
      }
    });
  }
  return {
    async checkpoint(name: string) {
      step = name;
      const hits = await page.evaluate(() => (window.__shareNameScan ? window.__shareNameScan() : [])).catch(() => []);
      record(hits);
      if (unreported > 0) {
        const fresh = mine.slice(-unreported);
        unreported = 0;
        throw new Error(`share name on screen at "${name}":\n  ${formatHits(fresh)}`);
      }
    },
    failures: () => mine.slice(),
  };
}
