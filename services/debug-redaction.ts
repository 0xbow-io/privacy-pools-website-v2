/**
 * Redaction levels for a saved debug recording (Pat, 2026-09-25).
 *
 * A recording carries the account key, every private key and every note
 * (services/debug-snapshots.ts), which is right for debugging on a throwaway
 * test account and wrong for anything else. The save dialog offers four NESTED
 * levels, each removing everything the previous one did:
 *
 *   full              nothing (the spend-grade file)
 *   no-spending-keys  account key, wallet signatures, note / deposit /
 *                     precommitment secrets, root / app secrets, every private
 *                     key except the viewing key          (default)
 *   no-viewing-key    + the viewing key and anything else that decrypts notes
 *   no-tx-details     + amounts, values, hashes, commitments, labels,
 *                     nullifiers, block numbers, times of transactions and every
 *                     EVM address, the user's included
 *
 * The RPC provider key (an Alchemy /v2/<key> path, an api key query param, URL
 * credentials) goes at EVERY level, Full included.
 *
 * How: a structural walk over the entries (message AND payload) and the
 * snapshots. A field is judged by its NAME (case-insensitive) and free text by
 * value PATTERNS. JSON carried inside a string (console payloads, request and
 * response bodies) is parsed and walked the same way, and when it does not
 * parse (a truncated body) a key:value scanner still finds the named fields.
 * Every value found under a secret-named field is also remembered, and a final
 * pass removes each exact occurrence of it anywhere in the file, in hex,
 * decimal or padded form, so a secret echoed inside a message is caught too.
 *
 * From level 2, share links (/import-note, /verify, /pay, /receive, /audit)
 * lose their encoded segment, and any base64 token that decodes to JSON
 * holding a removed field is replaced whole. Strings are only rewritten where
 * something is removed, so Full keeps them byte for byte apart from the RPC key.
 *
 * Fail closed: a field whose name looks secret but is ambiguous is removed at
 * the stricter level (any unknown `...key`, `...signature`, `...secret`).
 *
 * PURE module (no react-native or config imports) so it is bun-testable.
 */

export type RedactionLevel = 'full' | 'no-spending-keys' | 'no-viewing-key' | 'no-tx-details';

export const REDACTION_LEVELS: readonly RedactionLevel[] = ['full', 'no-spending-keys', 'no-viewing-key', 'no-tx-details'];

export const DEFAULT_REDACTION_LEVEL: RedactionLevel = 'no-spending-keys';

/** What the save dialog shows for each level, and what the file says it holds. */
export const REDACTION_LEVEL_INFO: Record<RedactionLevel, { label: string; hint: string; keeps: string; statement: string }> = {
  full: {
    label: 'Full',
    hint: 'Nothing removed',
    keeps: 'Keeps everything except the RPC key',
    statement: '',
  },
  'no-spending-keys': {
    label: 'No spending keys',
    hint: "Can't spend your funds",
    keeps: 'Keeps the viewing key, balances and tx details',
    statement: 'Removed: account key, wallet signatures, note secrets and private keys. Still contains the viewing key, balances, amounts, tx hashes and addresses.',
  },
  'no-viewing-key': {
    label: 'No viewing key',
    hint: "Can't see your balance or incoming notes",
    keeps: 'Keeps amounts, hashes and addresses',
    statement: 'Removed: account key, wallet signatures, note secrets, private keys and the viewing key. Still contains balances, amounts, tx hashes and addresses.',
  },
  'no-tx-details': {
    label: 'No tx details',
    hint: "Can't see your transactions",
    keeps: 'Keeps the app flow, timings and errors',
    statement: 'Removed: all keys and secrets, amounts, tx hashes, commitments, labels, nullifiers and addresses. Still contains the app flow, timings, errors and request routes.',
  },
};

/** What a removed value was, as written into the file. */
export type RedactionClass = 'rpc-key' | 'spend-key' | 'link' | 'viewing-key' | 'tx';

const LEVEL_RANK: Record<RedactionLevel, number> = { full: 1, 'no-spending-keys': 2, 'no-viewing-key': 3, 'no-tx-details': 4 };
/** `link`: an encoded share link (a note receipt, a payment request), which can carry a note secret. */
const CLASS_RANK: Record<RedactionClass, number> = { 'rpc-key': 1, 'spend-key': 2, link: 2, 'viewing-key': 3, tx: 4 };

export const redactedMarker = (cls: RedactionClass) => `[redacted:${cls}]`;

/**
 * The class a field NAME puts its value in, or null for a field that stays.
 * Case and separators are ignored (`view_key`, `viewingPrivateKey`, `VIEWKEY`).
 */
export function classifyFieldName(name: string): RedactionClass | null {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!n) return null;
  const has = (s: string) => n.includes(s);
  const isPublic = has('pub');

  // The RPC provider's credentials: removed at every level.
  if (has('apikey') || has('alchemykey') || has('rpckey') || has('accesstoken') || has('authtoken')
    || has('authorization') || has('bearer') || has('refreshtoken') || has('idtoken') || n === 'dkey') return 'rpc-key';

  // The viewing key: decrypts notes, cannot spend them. A PUBLIC viewing key is
  // an identifier of the account, so it goes with the transaction details.
  if (has('viewing') || has('viewkey')) return isPublic ? 'tx' : 'viewing-key';

  // Spend grade.
  if (has('secret') || has('mnemonic') || has('password') || has('passphrase') || has('witness')
    || has('circuitinput') || has('accountkey') || has('privkey') || has('signature')
    || n === 'sig' || n.endsWith('sig') || n === 'seed' || n.endsWith('seed') || has('seedphrase')
    || n === 'prf' || n.startsWith('prf')
    // services/passkey-backup.ts: `root` is the passkey account's root secret.
    // A bare `root` elsewhere is usually a merkle root, removed here anyway (fail closed).
    || n === 'root') return 'spend-key';
  if (has('private') && (has('key') || has('scalar') || has('nullif') || has('revocable'))) return 'spend-key';
  if (has('nullifyingkey') && !has('hash') && !isPublic) return 'spend-key';
  if (has('revocablekey') && !has('hash') && !has('index') && !isPublic) return 'spend-key';

  // Anything else that decrypts a note.
  if (has('ecdh') || has('decrypt') || has('scancredential')) return 'viewing-key';

  // Transaction details and identifiers.
  if (has('publickey') || has('pubkey')) return 'tx';
  if (has('amount') || has('value') || has('balance') || has('fee') || has('shares') || has('price')
    || has('cost') || has('wei') || has('total') || has('deposited') || has('withdrawn')) return 'tx';
  if (has('hash') || has('commitment') || has('label') || has('nullif') || has('leaf') || has('leaves')
    || has('merkle') || has('root') || has('ciphertext') || has('encrypted') || has('notedata')) return 'tx';
  if (has('address') || has('owner') || has('recipient') || has('sender') || has('caller') || has('ragequitter')
    || has('depositor') || has('counterparty') || has('wallet') || has('account') || n.endsWith('identity')
    || has('contact') || has('payee') || has('payer') || n === 'ens' || n === 'ensname' || n === 'from' || n === 'to') return 'tx';
  if (n === 'tx' || n === 'txid' || has('digest') || has('transactionid') || has('paymentid') || has('block') || has('timestamp')
    || has('datetime') || n === 'date' || /[a-z]At$/.test(name)) return 'tx';

  // Fail closed: any other key is assumed to be a private one.
  if (n.endsWith('key') && !isPublic) return 'spend-key';
  return null;
}

/** Numbers a debug reader needs and that name no transaction (timings, counts). */
function isHarmlessNumber(key: string | undefined, v: number): boolean {
  const n = (key ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (n && (n.endsWith('ms') || /duration|elapsed|since|count|length|size|bytes|index|chainid|status|code|attempt|retry|decimals|version|bps|line|column|port|limit|depth|page|width|height/.test(n))) return true;
  return Number.isInteger(v) && Math.abs(v) < 100_000;
}

// `{"kind":"ppv2-account-key",` is 27 bytes, a whole number of base64 groups,
// so every account key (services/account-key.ts encodeAccountKey) starts with
// exactly this text.
export const ACCOUNT_KEY_BASE64_PREFIX = 'eyJraW5kIjoicHB2Mi1hY2NvdW50LWtleSIs';

/** RPC credentials inside a URL: path keys, query keys, basic auth. */
const RPC_URL_PATTERNS: RegExp[] = [
  /(\/v[23]\/)([A-Za-z0-9_-]{16,})/g, // Alchemy /v2/<key>, Infura /v3/<key>
  /(\.quiknode\.pro\/)([A-Za-z0-9_-]{8,})/g,
  /(rpc\.ankr\.com\/[a-z0-9_]+\/)([A-Za-z0-9]{16,})/g,
  /([?&](?:api[_-]?key|apikey|key|dkey|token|access[_-]?token|auth)=)([^&\s"'#\\]+)/gi,
  /(https?:\/\/)([^/\s:@"']+:[^/\s@"']+)(?=@)/g, // user:password@host
];

/** The app routes whose fragment (or, in older links, path segment) is an encoded share payload. */
const ENCODED_ROUTE = /(\/(?:pay|receive|import-note|audit|verify)(?:\?[^#\s"'\\]*)?[/#])([^/?#\s"'\\]+)/g;

/**
 * A base64 / base64url token whose text starts with `{` or `[`, optionally with
 * a disclosure prefix. Standard base64 carries `/`, so the token may too; when
 * the whole match does not decode, the replacer retries up to each `/` (a URL
 * path after the token).
 */
const ENCODED_JSON_TOKEN = /(?<![A-Za-z0-9_+\-.])(?:(?:pvkb?1|pvo1)\.)?(?:ey|W[0-9A-Za-z])[A-Za-z0-9_+/-]{14,}={0,2}(?![A-Za-z0-9_+/-])/g;

/** A Sui transaction digest: 32 bytes in base58. */
const BASE58_DIGEST = /(?<![A-Za-z0-9])[1-9A-HJ-NP-Za-km-z]{43,44}(?![A-Za-z0-9])/g;

function decodeBase64Json(token: string): unknown {
  try {
    const b64 = token.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
    let text: string;
    if (typeof Buffer !== 'undefined') text = Buffer.from(padded, 'base64').toString('utf8');
    else {
      const bin = atob(padded);
      text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
    }
    const t = text.trim();
    if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
    const parsed = JSON.parse(t) as unknown;
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const SYMBOL_AMOUNT = /(?<![\w.])\d[\d,]*(?:\.\d+)?\s*(?:ETH|WETH|USDC|USDT|DAI|BNB|SUI|cBTC|WBTC|BTC|pp[A-Z]{2,6}|USD|\$)(?![A-Za-z])/g;

/** Shortest secret value that is also removed wherever else it appears. */
const MIN_SECRET_LENGTH = 4;
/** Numeric secrets from 2^32 up (9 hex digits): smaller numbers are indices and counts. */
const MIN_SECRET_HEX_DIGITS = 9;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normHex(hex: string): string {
  const h = hex.toLowerCase().replace(/^0x/, '').replace(/^0+/, '');
  return h || '0';
}

class Redactor {
  private readonly rank: number;
  /** Non-numeric secret values (an account key, a password), longest first when applied. */
  private readonly literals = new Map<string, RedactionClass>();
  /** Numeric secret values, as normalised hex (no 0x, no leading zeros). */
  private readonly numeric = new Map<string, RedactionClass>();
  /** Same, padded to one 32-byte word, to find a secret inside calldata. */
  private readonly padded = new Map<string, RedactionClass>();

  constructor(readonly level: RedactionLevel) {
    this.rank = LEVEL_RANK[level];
  }

  private active(cls: RedactionClass | null): cls is RedactionClass {
    return cls !== null && CLASS_RANK[cls] <= this.rank;
  }

  // ---- collection -------------------------------------------------------

  private remember(raw: string, cls: RedactionClass): void {
    const s = raw.trim().replace(/^["']|["']$/g, '');
    // Every secret value counts, short ones too, except the few that would
    // erase ordinary text (a flag, an empty or one-letter value).
    if (s.length < MIN_SECRET_LENGTH || s.startsWith('[redacted:') || /^(true|false|null|undefined|none)$/i.test(s)) return;
    if (/^(0x)?[0-9a-fA-F]+$/.test(s) && (s.startsWith('0x') || /[a-fA-F]/.test(s) || !/^\d+$/.test(s))) {
      this.addNumeric(normHex(s), cls);
      return;
    }
    if (/^\d+$/.test(s)) {
      try { this.addNumeric(BigInt(s).toString(16), cls); } catch { /* not a number */ }
      // A decimal id could also be hex digits.
      this.addNumeric(normHex(s), cls);
      return;
    }
    this.literals.set(s, cls);
    if (s.startsWith(ACCOUNT_KEY_BASE64_PREFIX)) this.rememberAccountKey(s, cls);
  }

  private addNumeric(norm: string, cls: RedactionClass): void {
    if (norm.length < MIN_SECRET_HEX_DIGITS) return; // below 2^32: an index, a count, not a key
    this.numeric.set(norm, cls);
    if (norm.length <= 64) this.padded.set(norm.padStart(64, '0'), cls);
  }

  /** An account key holds the wallet signature: remember that too. */
  private rememberAccountKey(encoded: string, cls: RedactionClass): void {
    try {
      const text = typeof atob === 'function' ? atob(encoded) : Buffer.from(encoded, 'base64').toString('utf8');
      const parsed = JSON.parse(text) as { signature?: unknown; legacySignature?: unknown };
      if (typeof parsed.signature === 'string') this.remember(parsed.signature, cls);
      if (typeof parsed.legacySignature === 'string') this.remember(parsed.legacySignature, cls);
    } catch { /* not decodable: the literal itself is still removed */ }
  }

  /** Every value inside a removed field. A `[hash, secret]` pair list keeps only the secrets. */
  private collect(v: unknown, cls: RedactionClass): void {
    if (v === null || v === undefined || typeof v === 'boolean') return;
    if (typeof v === 'string') {
      this.remember(v, cls);
      // A JSON or free-text blob: remember its long hex and decimal tokens too.
      for (const m of v.matchAll(/0x[0-9a-fA-F]{16,}|\b\d{20,}\b/g)) this.remember(m[0], cls);
      if (v.includes(ACCOUNT_KEY_BASE64_PREFIX)) {
        for (const m of v.matchAll(new RegExp(`${ACCOUNT_KEY_BASE64_PREFIX}[A-Za-z0-9+/=]*`, 'g'))) this.remember(m[0], cls);
      }
      return;
    }
    if (typeof v === 'number' || typeof v === 'bigint') {
      this.remember(String(v), cls);
      return;
    }
    if (Array.isArray(v)) {
      const pairs = v.length > 0 && v.every((e) => Array.isArray(e) && e.length === 2);
      for (const e of v) this.collect(pairs ? (e as unknown[])[1] : e, cls);
      return;
    }
    if (typeof v === 'object') {
      for (const e of Object.values(v as Record<string, unknown>)) this.collect(e, cls);
    }
  }

  // ---- first pass: structure --------------------------------------------

  walk(v: unknown, inherited: RedactionClass | null = null, key?: string): unknown {
    if (v === null || v === undefined || typeof v === 'boolean') return v;
    if (this.active(inherited) && inherited !== 'tx') {
      // Key material: the whole value goes, whatever its shape.
      this.collect(v, inherited);
      return redactedMarker(inherited);
    }
    const inTx = this.active(inherited);
    if (typeof v === 'string') return inTx ? redactedMarker('tx') : this.text(v);
    if (typeof v === 'number') {
      if (inTx) return redactedMarker('tx');
      return this.rank >= 4 && !isHarmlessNumber(key, v) ? redactedMarker('tx') : v;
    }
    if (typeof v === 'bigint') return inTx || this.rank >= 4 ? redactedMarker('tx') : v;
    if (Array.isArray(v)) return v.map((e) => this.walk(e, inherited, key));
    if (typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const own = classifyFieldName(k);
        // The stronger of the field's own class and its parent's.
        const eff = this.active(own) && (!this.active(inherited) || CLASS_RANK[own] < CLASS_RANK[inherited]) ? own : inherited;
        out[this.uniqueKey(out, /^\d{1,10}$/.test(k) ? k : this.text(k))] = this.walk(val, this.active(eff) ? eff : null, k);
      }
      return out;
    }
    return v;
  }

  private uniqueKey(obj: Record<string, unknown>, k: string): string {
    if (!(k in obj)) return k;
    let i = 2;
    while (`${k}#${i}` in obj) i += 1;
    return `${k}#${i}`;
  }

  /** A string: JSON inside is walked as structure, anything else as free text. */
  /**
   * A string, rewritten only where something is removed: JSON inside it is
   * scanned as text (never parsed and re-serialised, which would reformat it
   * and round big numbers), so everything the level keeps stays byte for byte.
   */
  text(s: string): string {
    return this.patterns(this.keyValues(this.encodedPayloads(s)));
  }

  /**
   * Share links and other encoded payloads (level 2 and up).
   *
   * The link routes carry a whole note or payment request in their path
   * segment (services/note-receipt.ts buildSentReceiptUrl and
   * buildRecoveredClaimUrl on /import-note, services/audit-receipt.ts on
   * /verify, services/payment-request-codec.ts on /pay and /receive), some of
   * it packed binary that cannot be inspected, so the segment always goes.
   * Anywhere else, a base64 or base64url token that decodes to JSON is walked
   * with the same rules and replaced whole if the level removes any field of
   * it (a passkey backup, a disclosure bundle pasted into a message).
   */
  private encodedPayloads(s: string): string {
    if (this.rank < 2) return s;
    let r = s.replace(ENCODED_ROUTE, (_all, pre: string, seg: string) => {
      this.judgeEncoded(seg);
      return `${pre}${redactedMarker('link')}`;
    });
    r = r.replace(ENCODED_JSON_TOKEN, (tok: string) => {
      // Longest candidate first: the whole match, then up to each `/`.
      for (let end = tok.length; end > 0; end = tok.lastIndexOf('/', end - 1)) {
        const head = tok.slice(0, end);
        const cls = this.judgeEncoded(head);
        if (cls) return redactedMarker(cls) + tok.slice(end);
      }
      return tok;
    });
    return r;
  }

  /** The strongest class the level removes from a decoded payload, or null. Its secrets are remembered. */
  private judgeEncoded(token: string): RedactionClass | null {
    const decoded = decodeBase64Json(token.replace(/^(?:pvkb?1|pvo1)\./, ''));
    if (decoded === undefined) return null;
    const walked = JSON.stringify(this.walk(decoded));
    let best: RedactionClass | null = null;
    for (const m of walked.matchAll(/\[redacted:([a-z-]+)\]/g)) {
      const cls = m[1] as RedactionClass;
      if (cls in CLASS_RANK && (best === null || CLASS_RANK[cls] < CLASS_RANK[best])) best = cls;
    }
    return best;
  }

  /**
   * `name: value`, `name=value`, `"name":"value"` and `\"name\":\"value\"` in
   * free text or in JSON that did not parse (a truncated body).
   */
  private keyValues(s: string): string {
    const re = /(\\?["'])?([A-Za-z_$][\w$]*)\1?\s*[:=]\s*/g;
    let out = '';
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      const cls = classifyFieldName(m[2]);
      if (!this.active(cls)) continue;
      const start = m.index + m[0].length;
      const span = valueSpan(s, start);
      if (!span) continue;
      const raw = s.slice(start, span.end);
      if (/^(true|false|null|undefined)$/.test(raw)) continue;
      if (cls !== 'tx') this.collect(raw, cls);
      const marker = redactedMarker(cls);
      const replacement = span.kind === 'escaped' ? `\\"${marker}\\"`
        : span.kind === 'quoted' ? `${raw[0]}${marker}${raw[0]}`
          : span.kind === 'bracket' ? `"${marker}"` : marker;
      out += s.slice(last, start) + replacement;
      last = span.end;
      re.lastIndex = span.end;
    }
    return last === 0 ? s : out + s.slice(last);
  }

  /** Value patterns: removed whatever field they sit in. */
  private patterns(s: string): string {
    let r = s;
    for (const p of RPC_URL_PATTERNS) {
      r = r.replace(p, (_all, pre: string, secret: string) => {
        this.remember(secret, 'rpc-key');
        return `${pre}${redactedMarker('rpc-key')}`;
      });
    }
    if (this.rank >= 2) {
      r = r.replace(new RegExp(`${ACCOUNT_KEY_BASE64_PREFIX}[A-Za-z0-9+/=]*`, 'g'), (key) => {
        this.remember(key, 'spend-key');
        return redactedMarker('spend-key');
      });
      // 64 or 65-byte hex: an ECDSA signature.
      r = r.replace(/\b0x(?:[0-9a-fA-F]{128}|[0-9a-fA-F]{130}|[0-9a-fA-F]{132})\b/g, (sig) => {
        this.remember(sig, 'spend-key');
        return redactedMarker('spend-key');
      });
    }
    if (this.rank >= 4) {
      const tx = redactedMarker('tx');
      r = r
        .replace(/\b0x[0-9a-fA-F]{5,}\b/g, tx) // addresses, hashes, hex amounts, calldata
        .replace(BASE58_DIGEST, tx) // Sui tx digests
        .replace(SYMBOL_AMOUNT, tx) // "1.5 ETH"
        .replace(/(?<![\w.:])\d+\.\d+(?![\w.])/g, tx) // other decimals
        .replace(/(?<![\w])\d{6,}(?![\w])/g, tx); // raw amounts, block numbers, field elements
    }
    return r;
  }

  // ---- second pass: every remembered value, everywhere ------------------

  sweep(v: unknown): unknown {
    if (typeof v === 'string') return this.sweepText(v);
    if (Array.isArray(v)) return v.map((e) => this.sweep(e));
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[this.uniqueKey(out, this.sweepText(k))] = this.sweep(val);
      return out;
    }
    return v;
  }

  private sweepText(s: string): string {
    let r = s;
    if (this.literals.size > 0) {
      for (const [lit, cls] of [...this.literals].sort((a, b) => b[0].length - a[0].length)) {
        if (!r.includes(lit)) continue;
        // A short value only as a whole word, so "abcd" does not cut "abcdef".
        r = lit.length >= 8
          ? r.split(lit).join(redactedMarker(cls))
          : r.replace(new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(lit)}(?![A-Za-z0-9_])`, 'g'), redactedMarker(cls));
      }
    }
    if (this.numeric.size === 0) return r;
    return r.replace(/\b(?:0x)?[0-9a-fA-F]{9,}\b/g, (tok) => {
      const found = this.lookupToken(tok);
      if (found) return redactedMarker(found);
      const hex = tok.replace(/^0x/, '').toLowerCase();
      if (hex.length <= 64 || this.padded.size === 0) return tok;
      // A secret inside calldata: check every 32-byte window.
      let outHex = '';
      let i = 0;
      let hit = false;
      while (i <= hex.length - 64) {
        const cls = this.padded.get(hex.slice(i, i + 64));
        if (cls) {
          outHex += redactedMarker(cls);
          i += 64;
          hit = true;
        } else {
          outHex += hex[i];
          i += 1;
        }
      }
      outHex += hex.slice(i);
      return hit ? (tok.startsWith('0x') ? `0x${outHex}` : outHex) : tok;
    });
  }

  private lookupToken(tok: string): RedactionClass | undefined {
    const byHex = this.numeric.get(normHex(tok));
    if (byHex) return byHex;
    if (/^\d+$/.test(tok)) {
      try { return this.numeric.get(BigInt(tok).toString(16)); } catch { return undefined; }
    }
    return undefined;
  }
}

/** Where a value starts at `i` ends, and how it was written. */
function valueSpan(s: string, i: number): { end: number; kind: 'escaped' | 'quoted' | 'bracket' | 'bare' } | null {
  if (i >= s.length) return null;
  if (s.startsWith('\\"', i)) {
    const close = s.indexOf('\\"', i + 2);
    return { end: close < 0 ? s.length : close + 2, kind: 'escaped' };
  }
  const c = s[i];
  if (c === '"' || c === "'") {
    let j = i + 1;
    while (j < s.length && s[j] !== c) j += s[j] === '\\' ? 2 : 1;
    return { end: Math.min(s.length, j + 1), kind: 'quoted' };
  }
  if (c === '{' || c === '[') {
    let depth = 0;
    let j = i;
    let quote: string | null = null;
    for (; j < s.length; j += 1) {
      const ch = s[j];
      if (quote) {
        if (ch === '\\') j += 1;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"') quote = ch;
      else if (ch === '{' || ch === '[') depth += 1;
      else if (ch === '}' || ch === ']') {
        depth -= 1;
        if (depth === 0) return { end: j + 1, kind: 'bracket' };
      }
    }
    return { end: s.length, kind: 'bracket' };
  }
  const bare = /^[^\s,;&}\])"'\\]+/.exec(s.slice(i));
  return bare ? { end: i + bare[0].length, kind: 'bare' } : null;
}

/**
 * Redact any JSON-safe value (a recording's entries, snapshots, or a single
 * payload) at `level`. Returns a new value, the input is untouched.
 */
export function redactValue<T>(value: T, level: RedactionLevel): T {
  const r = new Redactor(level);
  return r.sweep(r.walk(value)) as T;
}

/**
 * Redact the parts of a recording document that carry user data: every
 * entry's message and payload, the snapshots and the page URL. The envelope
 * (times, levels, tags, counts, environment) is kept as is.
 */
export function redactRecordingParts<P extends { entries: Array<{ message: string; data?: unknown }>; snapshots: unknown; url?: string }>(parts: P, level: RedactionLevel): P {
  const r = new Redactor(level);
  const entries = parts.entries.map((e) => ({
    ...e,
    message: r.text(e.message),
    ...(e.data !== undefined ? { data: r.walk(e.data) } : {}),
  }));
  // Snapshot NAMES (`identity`, `pools`, ...) are registry names, not fields:
  // each snapshot is walked from its own top, so the name cannot mark it all.
  const snapshots = isPlainObject(parts.snapshots)
    ? Object.fromEntries(Object.entries(parts.snapshots).map(([phase, byName]) => [
      phase,
      isPlainObject(byName)
        ? Object.fromEntries(Object.entries(byName).map(([name, snap]) => [name, r.walk(snap)]))
        : r.walk(byName),
    ]))
    : r.walk(parts.snapshots);
  const url = parts.url !== undefined ? r.text(parts.url) : undefined;
  return {
    ...parts,
    entries: entries.map((e) => ({
      ...e,
      message: r.sweep(e.message) as string,
      ...(e.data !== undefined ? { data: r.sweep(e.data) } : {}),
    })),
    snapshots: r.sweep(snapshots),
    ...(url !== undefined ? { url: r.sweep(url) as string } : {}),
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
