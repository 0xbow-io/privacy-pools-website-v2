import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Static guard for the passkey EOA key rules (services/passkey-eoa/derivation.ts):
// no logging anywhere in the feature, no key in React state/context/storage,
// no hex/string form of key material, and only withPasskeyEoaKey may hold a key.
// Files are discovered recursively, so a new file in the feature is covered automatically.

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const SERVICE_DIR = 'services/passkey-eoa';

const walk = (dir: string): string[] =>
  readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === '__tests__' || e.name === 'node_modules' ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e.name) ? [p] : [];
  });

const serviceFiles = walk(SERVICE_DIR);
const uiFiles = walk('components').filter((f) => /(^|\/)passkey-[\w.-]*\.(ts|tsx)$/.test(f));
const featureFiles = [...serviceFiles, ...uiFiles];

// store.ts persists the PUBLIC record (address, credential id) and imports no
// key code; every other service file is held to the key-file rules.
const PUBLIC_STORE = `${SERVICE_DIR}/store.ts`;
const KEY_FILES = serviceFiles.filter((f) => f !== PUBLIC_STORE);

const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');
/** Source without comments, so the rules comment itself does not trip the checks. */
const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('passkey EOA key hygiene', () => {
  test('the feature files are where we expect', () => {
    for (const f of ['derivation.ts', 'signer.ts', 'sign-in.ts', 'prf-response.ts', 'prf-source.ts', 'prf-source.native.ts', 'connector.ts']) {
      expect(KEY_FILES).toContain(`${SERVICE_DIR}/${f}`);
    }
    expect(uiFiles).toContain('components/passkey-account-provider.native.tsx');
    expect(uiFiles).toContain('components/passkey-sign-in-panel.tsx');
  });

  test('the public store never touches key code', () => {
    expect(read(PUBLIC_STORE)).not.toMatch(/passkey-eoa\/(derivation|signer|prf-[\w.-]+|sign-in)['"]|(?:from |import\(\s*|require\(\s*)['"]\.\/(derivation|signer|prf-[\w.-]+|sign-in)['"]/);
  });

  test('no logger, console, Sentry or debug capture in any feature file', () => {
    const banned = [
      /\bconsole\./,
      /from ['"]@sentry\//,
      /from ['"]@\/components\/debug-provider['"]/,
      /\buseDebug\b/,
      /from ['"]@\/services\/(debug-[\w-]+|log-coalescer|sentry[\w-]*)['"]/,
      /\blogger\b/i,
      /\baddBreadcrumb\b|\bcaptureException\b|\bcaptureMessage\b/,
    ];
    for (const f of featureFiles) {
      const src = code(f);
      for (const re of banned) expect({ f, hit: re.test(src) }).toEqual({ f, hit: false });
    }
  });

  test('key files hold no React state, context, refs or storage', () => {
    const banned = [
      /\buse(State|Ref|Context|Memo|Callback|Reducer)\b/,
      /\bcreateContext\b/,
      /\blocalStorage\b|\bsessionStorage\b|AsyncStorage|SecureStore/,
    ];
    for (const f of KEY_FILES) {
      const src = code(f);
      for (const re of banned) expect({ f, re: re.source, hit: re.test(src) }).toEqual({ f, re: re.source, hit: false });
    }
  });

  test('key bytes never become hex, strings or a long-lived account', () => {
    const banned = [
      /\bprivateKeyToAccount\b/,
      /\btoAccount\b/,
      /\bbytesToHex\b/,
      /\btoHex\s*\(/,
      /\bBuffer\.from\b/,
      /\bJSON\.stringify\b/,
      /\bString\.fromCharCode\(\s*\.\.\.\s*(key|prf|okm|prk)\b/,
    ];
    // prf-source.native.ts builds a random challenge with fromCharCode; that
    // is not key material, and the PRF there is never stringified.
    for (const f of KEY_FILES) {
      const src = code(f);
      for (const re of banned) expect({ f, re: re.source, hit: re.test(src) }).toEqual({ f, re: re.source, hit: false });
    }
  });

  test('only withPasskeyEoaKey derives a key, and the UI never sees the key API', () => {
    for (const f of featureFiles) {
      if (f === `${SERVICE_DIR}/derivation.ts`) continue;
      expect({ f, hit: /\bderivePasskeyEoaKey\s*\(/.test(code(f)) }).toEqual({ f, hit: false });
    }
    for (const f of uiFiles) {
      const src = code(f);
      expect({ f, hit: /passkey-eoa\/(derivation|signer)['"]/.test(src) }).toEqual({ f, hit: false });
      expect({ f, hit: /\bwithPasskeyEoaKey\b|\brequestPasskeyEoaPrf\s*\(/.test(src) }).toEqual({ f, hit: false });
    }
  });

  test('every key buffer is wiped in a finally', () => {
    const src = code(`${SERVICE_DIR}/derivation.ts`);
    expect(src).toMatch(/finally\s*\{\s*wipe\(prk\);/);
    expect(src).toMatch(/finally\s*\{\s*wipe\(key, prf\);/);
    expect(src).toMatch(/finally\s*\{\s*wipe\(d\);/);
  });

  test('errors carry fixed copy, never interpolated values', () => {
    for (const f of featureFiles) {
      const src = code(f);
      expect({ f, hit: /new \w*Error\(\s*`[^`]*\$\{/.test(src) }).toEqual({ f, hit: false });
    }
  });

  test('the web build stays untouched: the native passkey library is imported from .native files only', () => {
    const offenders = [...featureFiles, 'config/wagmi.ts', 'config/wagmi.web.ts', 'components/wallet-connect-modal-provider.tsx']
      .filter((f) => !f.includes('.native.') && /from ['"]react-native-passkey['"]/.test(read(f)));
    expect(offenders).toEqual([]);
    expect(read('config/wagmi.web.ts')).not.toContain('passkey-eoa');
  });
});
