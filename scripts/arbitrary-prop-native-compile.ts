/**
 * Arbitrary-property native-compile probe (P5, web-only port).
 *
 * There is a class of NativeWind bug where an *arbitrary-property* Tailwind
 * class — the `[<prop>:<value>]` form, e.g. `[textAlignVertical:top]` — emits
 * a CSS declaration that lightningcss/react-native-css-interop cannot map to a
 * React Native style, so it compiles to NOTHING on native (an empty `d`, plus
 * an `IncompatibleNativeProperty` warning). On web the class still works, so
 * the visual gate never catches it. The P3 review found exactly this with
 * `[textAlignVertical:top]`; those sinks were moved to real `style` props with
 * an `nw-keep(platform-css)` annotation.
 *
 * This probe scans `app/` + `components/` for arbitrary-property classes
 * (inside JSX `className` attributes only — never comments or TS types),
 * reconstructs the CSS each would emit (`.probe { <prop>: <value> }`), runs it
 * through the SAME compiler NativeWind uses at build time
 * (`cssToReactNativeRuntime` from react-native-css-interop), and asserts each
 * produces a non-empty native declaration. Any class that compiles to nothing
 * on native is a port bug: it must instead be a `style` prop carrying an
 * `nw-keep`.
 *
 * Distinct from arbitrary *values* (`p-[20px]`, `bg-[#fff]`, `w-[720px]`),
 * which are a utility prefix + `-[...]` and are NOT scanned — those map fine.
 * The `[` of an arbitrary property is a standalone class token (start of the
 * class string, or after whitespace / a variant `foo:` modifier), never after
 * a `-` or word char.
 *
 * Zero new dependencies: TypeScript compiler API (devDependency) for reliable
 * className extraction + react-native-css-interop (already a transitive dep of
 * nativewind) for the compile.
 *
 * Usage:
 *   bun scripts/arbitrary-prop-native-compile.ts            # human summary, exit 1 on hits
 *   bun scripts/arbitrary-prop-native-compile.ts --json -   # JSON to stdout
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { cssToReactNativeRuntime } from 'react-native-css-interop/dist/css-to-rn';

/** Directories scanned (the web app surface). */
export const SCAN_DIRS = ['app', 'components'];

const IGNORED_DIR_NAMES = new Set(['node_modules', '__tests__', '__fixtures__']);

/**
 * A `[<prop>:<value>]` arbitrary-property class token.
 *
 * The lookbehind `(?<![\w-])` rejects the arbitrary-VALUE idiom (`p-[…]`,
 * `bg-[…]`, `text-[…]`) whose `[` follows a `-` or word char, while still
 * matching a bare `[prop:val]` or a variant-prefixed `dark:[prop:val]`
 * (the `[` follows a `:`, which is neither `\w` nor `-`). The property must be
 * a CSS/RN ident (`[A-Za-z][\w-]*`), a vendor-prefixed ident
 * (`-webkit-line-clamp`), or a custom property (`--my-var`) — all three are
 * spellings Tailwind accepts in the arbitrary-property position and emits
 * verbatim. This also excludes arbitrary VARIANTS like `[&_svg]:…` /
 * `[&:hover]:…` (they start with `&`).
 */
const ARBITRARY_PROP_RE = /(?<![\w-])\[((?:--[\w-]+|-?[A-Za-z][\w-]*))\s*:\s*([^\]]+?)\]/g;

export interface ArbitraryPropHit {
  file: string;
  /** The full `[prop:value]` token as written. */
  raw: string;
  prop: string;
  value: string;
  /** 1-based line of the className the token was found in (best-effort). */
  line: number;
}

/**
 * Extract every class-token-bearing literal from `className` attributes,
 * using the compiler AST. Returns one entry per string literal / template
 * static inside each `className` initializer.
 *
 * Only literal text is collected — never comments, identifiers, or type
 * syntax. This matters: `getText()` on a whole `className={…}` expression
 * spans interior comments, so an `nw-keep` note INSIDE the braces that
 * mentions `[textAlignVertical:top]` (this repo's standard annotation for
 * the moved sink) would be scanned as if it were a live class — a false
 * positive. Walking the AST for literals makes that leak impossible.
 */
export function extractClassNameTexts(fileName: string, source: string): { text: string; pos: number }[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, /*setParentNodes*/ true, kind);
  const out: { text: string; pos: number }[] = [];

  const pushIfNonEmpty = (text: string, pos: number): void => {
    if (text) out.push({ text, pos });
  };

  // Collect the literal text a class token can live in: string literals and
  // template statics (head + span literals), recursing into interpolations.
  const collectLiteralText = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) {
      pushIfNonEmpty(node.text, node.getStart(sf));
      return;
    }
    if (ts.isTemplateExpression(node)) {
      pushIfNonEmpty(node.head.text, node.head.getStart(sf));
      for (const span of node.templateSpans) {
        collectLiteralText(span.expression);
        pushIfNonEmpty(span.literal.text, span.literal.getStart(sf));
      }
      return;
    }
    ts.forEachChild(node, collectLiteralText);
  };

  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'className' && node.initializer) {
      // Covers both `className="…"` (StringLiteral initializer) and
      // `className={…}` (JsxExpression — collectLiteralText walks through it).
      collectLiteralText(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Tailwind decodes an unescaped `_` to a space inside an arbitrary value. */
function decodeArbitraryValue(value: string): string {
  return value.replace(/_/g, ' ').trim();
}

/**
 * Compile a single arbitrary property through the native compiler and report
 * whether it produces a non-empty native declaration.
 *
 * Mirrors NativeWind's build step: Tailwind emits `.<cls> { <prop>: <value> }`
 * for `[<prop>:<value>]`, then react-native-css-interop compiles that CSS for
 * native. A property RN can't map yields an empty `d` (declarations) array and
 * an `IncompatibleNativeProperty` warning.
 */
export function compilesToNativeDeclaration(prop: string, value: string): {
  ok: boolean;
  warnings: unknown[];
} {
  const css = `.probe { ${prop}: ${decodeArbitraryValue(value)} }`;
  let compiled: any;
  try {
    compiled = cssToReactNativeRuntime(css);
  } catch {
    return { ok: false, warnings: [{ type: 'CompileThrew' }] };
  }
  const rule = compiled?.rules?.probe;
  if (!rule) return { ok: false, warnings: [] };
  const nodes: any[] = rule.n ?? [];
  // Minified runtime key is `d`; the public type calls it `declarations`.
  const decls = nodes.flatMap((n) => n?.d ?? n?.declarations ?? []);
  const warnings = nodes.flatMap((n) => n?.warnings ?? []).concat(rule.warnings ?? []);
  const nonEmpty = decls.some((d: unknown) => (Array.isArray(d) ? d.length > 0 : d != null));
  return { ok: nonEmpty, warnings };
}

/** Find `[prop:value]` arbitrary-property tokens inside a className text. */
export function findArbitraryProps(classText: string): { raw: string; prop: string; value: string }[] {
  const found: { raw: string; prop: string; value: string }[] = [];
  ARBITRARY_PROP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARBITRARY_PROP_RE.exec(classText))) {
    found.push({ raw: m[0], prop: m[1], value: m[2] });
  }
  return found;
}

function* walk(dir: string): Generator<string> {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile() && /\.(ts|tsx)$/.test(full) && !full.endsWith('.d.ts') && !/\.test\.(ts|tsx)$/.test(full)) {
      yield full;
    }
  }
}

/**
 * Scan the repo for arbitrary-property classes that compile to NOTHING on
 * native. Returns one hit per offending `[prop:value]` occurrence (empty when
 * the tree is clean).
 */
export function scanRepo(root: string): ArbitraryPropHit[] {
  const hits: ArbitraryPropHit[] = [];
  for (const dir of SCAN_DIRS) {
    for (const filePath of walk(path.join(root, dir))) {
      const rel = path.relative(root, filePath).split(path.sep).join('/');
      const source = fs.readFileSync(filePath, 'utf8');
      for (const { text, pos } of extractClassNameTexts(rel, source)) {
        for (const { raw, prop, value } of findArbitraryProps(text)) {
          if (!compilesToNativeDeclaration(prop, value).ok) {
            const line = source.slice(0, pos).split('\n').length;
            hits.push({ file: rel, raw, prop, value, line });
          }
        }
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
// Bun sets `import.meta.main`; the field isn't in the ambient ImportMeta type.
if ((import.meta as ImportMeta & { main?: boolean }).main) {
  const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
  const hits = scanRepo(root);
  if (process.argv.includes('--json') || process.argv.includes('-')) {
    process.stdout.write(JSON.stringify(hits, null, 2) + '\n');
  } else if (hits.length === 0) {
    process.stdout.write('arbitrary-prop native-compile probe: OK — 0 arbitrary-property classes compile to nothing on native.\n');
  } else {
    process.stderr.write(`arbitrary-prop native-compile probe: ${hits.length} FAIL\n`);
    for (const h of hits) {
      process.stderr.write(`  ${h.file}:${h.line}  ${h.raw}  (property "${h.prop}" is not css-interop-mappable → drops on native; move to a style prop with nw-keep)\n`);
    }
  }
  process.exit(hits.length === 0 ? 0 : 1);
}
