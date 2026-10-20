import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * Ratchet for the `fromAddress` field of a display-only LiFi price request.
 *
 * services/lifi-quote.ts sends `fromAddress` to li.quest on every request,
 * and the callers fire it from a debounced effect while the user types an
 * amount. Three of the four call sites pass the swap processor's address
 * (`getSwapProcessorAddress(chainId)`), a contract address out of config.
 * The remaining one passes the connected wallet address, so a third party
 * receives that address together with each typed amount before anything is
 * confirmed. It is listed below as debt; a new call site must use the
 * processor address, and fixing the listed one means removing it here.
 *
 * Source guard, not a traffic proof: it reads the `fromAddress:` line that
 * follows each call and resolves ONE local `const`, so a value routed
 * through anything deeper is invisible to it.
 */
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const SCANNED_DIRS = ['components', 'hooks', 'app'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '__tests__', 'workflows']);

// Call sites only: the `function useSwapPreview(` declaration is not one.
const CALLS = /(?<!function\s)\b(fetchLifiExactInQuote|fetchLifiContractCallDeliverable|useSwapPreview)\s*\(/g;
// `fromAddress: <expr>` or the shorthand `fromAddress,` (the hook forwarding its own parameter).
const FIELD = /\bfromAddress\s*(?::\s*([^,\n]+)|(?=\s*[,}]))/;
/** The hook forwards the caller's value; the caller is where it is checked. */
const PASS_THROUGH_FILE = 'hooks/use-swap-preview.ts';

/** Sites allowed to send something other than the processor address, by file and expression. */
const REMAINING: Record<string, { expressions: string[]; blockedOn: string }> = {
  'components/home/action-hub.tsx': {
    expressions: ['connectedAddress'],
    blockedOn: 'The shield conversion preview prices a swap the wallet itself will send, so the '
      + 'estimate is requested as that wallet. Switching the preview to the processor address needs '
      + 'a check that li.quest returns the same route for a different sender, since the deposit is '
      + 'sized off this estimate (services/cross-pay-sizing.ts).',
  },
};

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

type Site = { file: string; call: string; fromAddress: string | null };

function scan(): Site[] {
  const sites: Site[] = [];
  for (const dir of SCANNED_DIRS) {
    for (const file of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, file);
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(CALLS)) {
        // The argument object follows the call; take the first `fromAddress:`
        // line inside a bounded window so one site cannot read the next one's.
        const window = source.slice(match.index, match.index + 1500);
        const field = FIELD.exec(window);
        let fromAddress = field ? (field[1] ?? 'fromAddress').trim() : null;
        // One level of local indirection: `fromAddress: someConst` where the
        // same file declares `const someConst = <expr>;`. Deeper chains stay
        // invisible, which the header says.
        if (fromAddress && /^[A-Za-z_$][\w$]*$/.test(fromAddress) && fromAddress !== 'fromAddress') {
          const decl = new RegExp(String.raw`\bconst\s+${fromAddress}\s*=\s*([^;\n]+)`).exec(source);
          if (decl) fromAddress = decl[1].trim();
        }
        sites.push({ file: rel, call: match[1], fromAddress });
      }
    }
  }
  return sites;
}

describe('LiFi price requests send the processor address, not the wallet', () => {
  const sites = scan();

  test('every call site is found', () => {
    // The four sites known at the time of writing. A drop means the scan
    // stopped seeing one, which is a broken guard, not a fixed site.
    expect(sites.length).toBeGreaterThanOrEqual(4);
    const unread = sites.filter((site) => site.fromAddress === null).map((site) => `${site.file}: ${site.call}`);
    expect(unread).toEqual([]);
  });

  test('a site that is not listed as debt derives fromAddress from getSwapProcessorAddress', () => {
    const offenders = sites.filter((site) => {
      const expr = site.fromAddress ?? '';
      if (expr.includes('getSwapProcessorAddress(')) return false;
      if (site.file === PASS_THROUGH_FILE && expr === 'fromAddress') return false;
      const listed = REMAINING[site.file]?.expressions ?? [];
      return !listed.includes(expr);
    });
    expect(offenders.map((s) => `${s.file}: ${s.call}(... fromAddress: ${s.fromAddress})`)).toEqual([]);
  });

  test('the debt list names only sites that still exist', () => {
    const stale: string[] = [];
    for (const [file, entry] of Object.entries(REMAINING)) {
      for (const expr of entry.expressions) {
        if (!sites.some((s) => s.file === file && s.fromAddress === expr)) {
          stale.push(`${file} no longer sends fromAddress: ${expr}; remove it from REMAINING`);
        }
      }
      expect(entry.blockedOn.length).toBeGreaterThan(20);
    }
    expect(stale).toEqual([]);
  });
});
