/**
 * NativeWind-port AST audit tool — v3, FAIL MODE BY DEFAULT (P4).
 *
 * Inventories, per source file, every styling signal the port has to migrate
 * or classify:
 *   - StyleSheet.create usage + every other StyleSheet reference
 *     (absoluteFill, flatten, hairlineWidth, compose, absoluteFillObject);
 *   - every style sink: JSX `style` props (incl. Pressable-style function
 *     values), JSX spread attributes (`<View {...props} />` — spreads CAN
 *     carry `style`, so a spread-only file still needs a classification
 *     decision, typically nw-keep(forwarded-style-contract)),
 *     `contentContainerStyle`-family props (any prop ending in
 *     `Style`), navigation-options style keys inside object literals
 *     (tabBarStyle, headerStyle, ...), `createElement(..., { style })`,
 *     raw `React.CSSProperties` type references;
 *   - visual color props (SVG fill/stroke/stopColor, icon `color`,
 *     placeholderTextColor, ...);
 *   - raw color literals inside static style objects;
 *   - `nw-keep(<category>): <reason>` annotations, validated against the
 *     plan's category taxonomy (workflows/plans/nativewind-port.md).
 *
 * Output: machine-readable JSON (`--json <path>` or `--json -` for stdout)
 * plus a human summary. ENFORCEMENT (fail mode, the default): exit code 1
 * when the migration-debt tree contains any StyleSheet.create, any inline
 * style sink (object/array/function/conditional, incl. `cond && {...}`)
 * without an adjacent categorized nw-keep, any invalid nw-keep (unknown
 * category / empty reason), any raw-DOM border-width without border-style,
 * or any co-active conflicting-class pattern. Evidence-fixture harness files
 * (scripts/visual/gallery-*) stay in the report but are exempt. `--report`
 * keeps the historical informational-only behavior (never exits non-zero).
 *
 * Zero new dependencies: uses the TypeScript compiler API (devDependency).
 *
 * Usage:
 *   bun scripts/audit-nativewind.ts                  # human summary, exit 1 on violations
 *   bun scripts/audit-nativewind.ts --report         # informational only, never fails
 *   bun scripts/audit-nativewind.ts --json report.json
 *   bun scripts/audit-nativewind.ts --json -         # JSON to stdout
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

export const AUDIT_TOOL_VERSION = 3;

/** nw-keep category taxonomy — mirrors workflows/plans/nativewind-port.md. */
export const NW_KEEP_CATEGORIES = [
  'animated',
  'measured-or-inset',
  'floating-ui',
  'platform-css',
  'third-party-style-api',
  'forwarded-style-contract',
  'svg-or-canvas',
  'data-color',
  'navigation-options',
  'root-vars',
] as const;
export type NwKeepCategory = (typeof NW_KEEP_CATEGORIES)[number];

/** Directories scanned relative to the repo root. */
export const AUDIT_DIRS = ['app', 'components', 'constants', 'hooks', 'config', 'services', 'api'];

/**
 * Evidence fixtures: files that render BOTH idioms (StyleSheet vs className)
 * side by side as harness ground truth for the visual diff. Their StyleSheet
 * halves are the fixture, not migration debt — "porting" them would destroy
 * what they measure. They STAY in the audit report (classification:
 * 'evidence-fixture') so the ownership gate sees them, but are excluded from
 * every migration-debt total. Each must be harness-owned (never under a
 * production route tree) and carries an owner + lifecycle rule in
 * workflows/plans/nativewind-manifest.json `evidenceFixtures`.
 */
export const EVIDENCE_FIXTURES = new Set([
  'scripts/visual/gallery-app/_layout.tsx',
  'scripts/visual/gallery-app/index.tsx',
  'scripts/visual/gallery-src/floating-probe.tsx',
  'scripts/visual/gallery-src/floating-probe.web.tsx',
]);

/** Navigation-options style keys (object-literal properties, not JSX props). */
const NAV_STYLE_KEYS = new Set([
  'tabBarStyle',
  'tabBarLabelStyle',
  'tabBarIconStyle',
  'tabBarItemStyle',
  'tabBarBadgeStyle',
  'headerStyle',
  'headerTitleStyle',
  'headerTitleContainerStyle',
  'headerLeftContainerStyle',
  'headerRightContainerStyle',
  'headerBackgroundContainerStyle',
  'contentStyle',
  'sceneStyle',
  'sceneContainerStyle',
  'cardStyle',
  'drawerStyle',
]);

/** JSX props that carry a raw visual color (SVG, icons, RN text inputs...). */
const COLOR_PROP_NAMES = new Set([
  'fill',
  'stroke',
  'stopColor',
  'color',
  'tintColor',
  'placeholderTextColor',
  'selectionColor',
  'underlayColor',
  'thumbColor',
  'trackColor',
  'minimumTrackTintColor',
  'maximumTrackTintColor',
  'backgroundColor',
  'shadowColor',
  'highlightColor',
]);

const NAMED_CSS_COLORS = new Set([
  'transparent', 'black', 'white', 'red', 'green', 'blue', 'gray', 'grey',
  'yellow', 'orange', 'purple', 'pink', 'brown', 'cyan', 'magenta', 'silver',
  'gold', 'navy', 'teal', 'lime', 'maroon', 'olive', 'aqua', 'fuchsia',
]);

export function isColorLiteral(value: string): boolean {
  const v = value.trim();
  if (/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(v)) return true;
  if (/^(rgb|rgba|hsl|hsla)\(/.test(v)) return true;
  return NAMED_CSS_COLORS.has(v.toLowerCase());
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type SinkKind =
  | 'jsx-style'
  | 'jsx-style-callback'
  | 'jsx-namedStyle'
  | 'jsx-spread'
  | 'navigation-options'
  | 'createElement-style'
  | 'css-properties-type';

export type SinkValueKind =
  | 'object-literal'
  | 'array-literal'
  | 'reference'
  | 'function'
  | 'conditional'
  | 'string'
  | 'other'
  | 'none';

export interface StyleSink {
  kind: SinkKind;
  /** Prop / property name (`style`, `contentContainerStyle`, `tabBarStyle`, ...). */
  name: string;
  /** JSX element tag for JSX sinks (`View`, `Animated.View`, `Svg`, ...). */
  element?: string;
  line: number;
  valueKind: SinkValueKind;
  /**
   * Enforcement (fail mode): whether an INLINE style value
   * (object/array/function/conditional — incl. an inline object behind
   * `cond && ...`) carries an adjacent `nw-keep` annotation — inside the
   * enclosing JSX element's opening tag (incl. a leading comment) or in the
   * comment-only gap right before it (bounded by the previous real sibling,
   * so a keep written for one element cannot classify its siblings/children)
   * for JSX sinks, or inside the value's own span for
   * createElement/navigation-options sinks. `undefined` for non-inline sinks
   * (reference/string/none): their justification lives at the referenced
   * definition (typed CSSProperties / StyleSheet / props), which the audit
   * does not resolve, so they are never treated as unclassified debt here.
   */
  classified?: boolean;
}

export interface ColorProp {
  name: string;
  element: string;
  line: number;
  /** Set when the value is a plain color string literal. */
  literal?: string;
}

export interface ColorLiteral {
  value: string;
  line: number;
  context: 'stylesheet-create' | 'inline-style' | 'navigation-options';
}

export interface NwKeepAnnotation {
  category: string;
  reason: string;
  line: number;
  valid: boolean;
}

export interface StyleSheetRef {
  kind: string; // create | absoluteFill | absoluteFillObject | flatten | hairlineWidth | compose | other:<name>
  line: number;
}

export interface RawDomBorderIssue {
  element: string;
  line: number;
  className: string;
}

/**
 * Co-active-conflicting-class issue (kimi P3 §7). A className string where a
 * conditional segment (`${cond ? 'x' : 'y'}` / `${cond && 'x'}`) sets a
 * utility whose CSS property is ALSO set by the string's UNCONDITIONAL
 * (base) part. Both classes are then live simultaneously and, on web, the
 * winner is generated-CSS emission order — not class-string order — so the
 * base can silently beat the conditional override (the deposit/ragequit
 * sheet bugs). The fix is to make the branches mutually exclusive (move the
 * base utility into the conditional). Targeted to the highest-risk property
 * families (justify/items/padding/margin/width/max-width) to stay
 * low-false-positive; see CLASS_FAMILY_PATTERNS.
 */
export interface ClassConflict {
  element: string;
  line: number;
  /** The shared CSS longhand (e.g. `justify-content`, `pt`). */
  property: string;
  /** The unconditional token that also sets `property`. */
  baseToken: string;
  /** The token inside a `${...}` branch that collides on `property`. */
  conditionalToken: string;
}

export interface FileAudit {
  file: string;
  styleSheetCreateCount: number;
  styleSheetRefs: StyleSheetRef[];
  sinks: StyleSink[];
  colorProps: ColorProp[];
  colorLiterals: ColorLiteral[];
  nwKeep: NwKeepAnnotation[];
  /**
   * Preflight-OFF invariant (CONFIG-02): a lowercase (raw-DOM) JSX element
   * whose className carries a width-bearing border/divide utility without an
   * explicit border style renders NO visible border (the browser default is
   * border-style: none once preflight's reset is gone).
   */
  rawDomBorderIssues: RawDomBorderIssue[];
  /** Co-active conflicting-class issues (CSS-emission-order trap). */
  classConflicts: ClassConflict[];
  /** Any styling signal at all — the manifest must own every such file. */
  hasStyles: boolean;
  /**
   * 'app' = migration scope; 'evidence-fixture' = harness ground truth,
   * owned via the manifest's evidenceFixtures section and excluded from
   * migration-debt totals (but NOT from the report).
   */
  classification: 'app' | 'evidence-fixture';
}

export interface AuditReport {
  toolVersion: number;
  root: string;
  scannedDirs: string[];
  fileCount: number;
  files: FileAudit[];
  totals: {
    filesWithStyles: number;
    filesWithStyleSheetCreate: number;
    styleSheetCreateCalls: number;
    sinksByKind: Record<string, number>;
    colorProps: number;
    colorLiterals: number;
    uniqueColorLiterals: number;
    nwKeepAnnotations: number;
    invalidNwKeepAnnotations: number;
    rawDomBorderIssues: number;
    /** Inline style sinks lacking an adjacent nw-keep (unclassified debt). */
    unclassifiedStyleSinks: number;
    /** Co-active conflicting-class occurrences. */
    classConflicts: number;
    /** Count of evidence-fixture files present in the report (not debt). */
    evidenceFixtureFiles: number;
  };
}

// ---------------------------------------------------------------------------
// Co-active-conflicting-class rule (kimi P3 §7)
//
// Each targeted utility maps to exactly ONE canonical CSS property key. Two
// tokens conflict when they share a key with DIFFERENT values (so the base
// and the conditional both try to own it, and on web emission order — not
// class-string order — silently decides). Prefixes are exact (`p-` never
// matches `px-`/`pt-`), so pattern order does not affect correctness.
//
// DELIBERATE LIMITATIONS (kept conservative — the P3-reviewed money-modal
// sheets rely on these idioms and rewriting them is capture-gated):
//   * Keys are SIDE-SPECIFIC: shorthand `p-`/`m-` do NOT collide with the
//     longhands `pt-`/`pb-`/... A `p-[24px] ${sheet ? 'pt-[26px]' : ''}`
//     refinement is a common intentional pattern, so it is NOT flagged. The
//     rule catches SAME-key different-value overrides (`justify-center` vs
//     `justify-end`, `pt-[10px]` vs `pt-[20px]`) — the exact shape of the
//     P3 sheet bugs.
//   * KEYWORD RESETS in the conditional (`max-w-full`, `w-screen`, ...) are
//     exempt: they switch layout MODE and, per the kimi P3 review, reliably
//     win by emission order over an arbitrary base (`max-w-[560px]`).
// ---------------------------------------------------------------------------

const CLASS_FAMILY_PATTERNS: readonly (readonly [RegExp, string])[] = [
  [/^justify-/, 'justify-content'],
  [/^items-/, 'align-items'],
  [/^max-w-/, 'max-width'],
  [/^min-w-/, 'min-width'],
  [/^w-/, 'width'],
  [/^-?px-/, 'padding-x'],
  [/^-?py-/, 'padding-y'],
  [/^-?pt-/, 'padding-top'],
  [/^-?pr-/, 'padding-right'],
  [/^-?pb-/, 'padding-bottom'],
  [/^-?pl-/, 'padding-left'],
  [/^-?ps-/, 'padding-inline-start'],
  [/^-?pe-/, 'padding-inline-end'],
  [/^-?p-/, 'padding'],
  [/^-?mx-/, 'margin-x'],
  [/^-?my-/, 'margin-y'],
  [/^-?mt-/, 'margin-top'],
  [/^-?mr-/, 'margin-right'],
  [/^-?mb-/, 'margin-bottom'],
  [/^-?ml-/, 'margin-left'],
  [/^-?ms-/, 'margin-inline-start'],
  [/^-?me-/, 'margin-inline-end'],
  [/^-?m-/, 'margin'],
];

/** Conditional keyword mode-switches that reliably win by emission order. */
const CLASS_KEYWORD_RESET_RE = /^(?:max-w|min-w|w|max-h|min-h|h)-(?:full|screen|min|max|fit|auto|none|px)$/;

/**
 * The single canonical CSS property a utility token owns, or null when the
 * token is outside the guarded families. Leading responsive/state variant
 * prefixes (`hover:`, `sm:`, ...) are stripped first.
 */
export function classNameTokenCssProp(raw: string): string | null {
  const token = raw.replace(/^(?:[a-z0-9-]+:)+/, '');
  for (const [re, prop] of CLASS_FAMILY_PATTERNS) {
    if (re.test(token)) return prop;
  }
  return null;
}

/**
 * Conflicts where a conditional-branch token collides on the SAME canonical
 * CSS property an unconditional (base) token already owns, with a different
 * value. Identical tokens and keyword mode-switches are exempt. Pure +
 * unit-tested.
 */
export function findCoActiveClassConflicts(
  baseTokens: readonly string[],
  conditionalTokens: readonly string[],
): { property: string; baseToken: string; conditionalToken: string }[] {
  const baseByProp = new Map<string, string>();
  for (const tok of baseTokens) {
    const p = classNameTokenCssProp(tok);
    if (p && !baseByProp.has(p)) baseByProp.set(p, tok);
  }
  const out: { property: string; baseToken: string; conditionalToken: string }[] = [];
  const seen = new Set<string>();
  for (const tok of conditionalTokens) {
    const p = classNameTokenCssProp(tok);
    if (!p) continue;
    const baseToken = baseByProp.get(p);
    if (baseToken === undefined || baseToken === tok) continue;
    if (CLASS_KEYWORD_RESET_RE.test(tok)) continue;
    const key = `${p}|${baseToken}|${tok}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ property: p, baseToken, conditionalToken: tok });
  }
  return out;
}

const tokenize = (text: string): string[] => text.split(/\s+/).filter(Boolean);

/** Collect className tokens from every string literal reachable in a `${}` branch. */
function collectBranchTokens(expr: ts.Expression, out: string[]): void {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    out.push(...tokenize(expr.text));
  } else if (ts.isConditionalExpression(expr)) {
    collectBranchTokens(expr.whenTrue, out);
    collectBranchTokens(expr.whenFalse, out);
  } else if (ts.isParenthesizedExpression(expr)) {
    collectBranchTokens(expr.expression, out);
  } else if (ts.isBinaryExpression(expr)) {
    // `cond && 'classes'` / `a || 'classes'` — the operand(s) that can render.
    const op = expr.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      collectBranchTokens(expr.right, out);
    } else if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      collectBranchTokens(expr.left, out);
      collectBranchTokens(expr.right, out);
    }
  }
}

/** Base (unconditional) + conditional tokens of a className template literal. */
export function splitTemplateClassName(tpl: ts.TemplateExpression): {
  baseTokens: string[];
  conditionalTokens: string[];
} {
  const baseTokens = [
    ...tokenize(tpl.head.text),
    ...tpl.templateSpans.flatMap((s) => tokenize(s.literal.text)),
  ];
  const conditionalTokens: string[] = [];
  for (const span of tpl.templateSpans) collectBranchTokens(span.expression, conditionalTokens);
  return { baseTokens, conditionalTokens };
}

// ---------------------------------------------------------------------------
// Raw-DOM border invariant (CONFIG-02, preflight OFF)
// ---------------------------------------------------------------------------

// Width-bearing border/divide utilities (incl. arbitrary values), NOT colors
// (`border-gray-300`), NOT radius (`rounded-*`), NOT table utilities
// (`border-collapse`/`border-separate`/`border-spacing-*`).
const BORDER_WIDTH_UTILITY_RE =
  /^(?:border(?:-(?:[trblxyse]|\d+(?:\.\d+)?|\[[^\]]+\]|[trblxyse]-(?:\d+(?:\.\d+)?|\[[^\]]+\])))?|divide-(?:[xy](?:-(?:\d+(?:\.\d+)?|\[[^\]]+\]))?))$/;
const BORDER_STYLE_UTILITY_RE = /^(?:border|divide)-(?:solid|dashed|dotted|double|hidden|none)$/;

/**
 * True when `classNameText` sets a border/divide WIDTH but no border STYLE —
 * invisible on raw DOM with preflight off. Variant prefixes (`hover:` etc.)
 * are stripped before matching; arbitrary properties are ignored.
 */
export function rawDomBorderMissingStyle(classNameText: string): boolean {
  const tokens = classNameText.split(/\s+/).filter(Boolean).map((t) => t.replace(/^(?:[a-z-]+:)+/, ''));
  const hasWidth = tokens.some((t) => BORDER_WIDTH_UTILITY_RE.test(t));
  if (!hasWidth) return false;
  const hasStyle = tokens.some((t) => BORDER_STYLE_UTILITY_RE.test(t));
  return !hasStyle;
}

/** Raw-DOM JSX = lowercase tag name (div, button, span, ...). */
function isRawDomElement(tagName: string): boolean {
  return /^[a-z]/.test(tagName) && !tagName.includes('.');
}

// ---------------------------------------------------------------------------
// Per-file classifier
// ---------------------------------------------------------------------------

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Style-value kinds that are INLINE: their justification must be an adjacent nw-keep. */
const INLINE_VALUE_KINDS = new Set<SinkValueKind>(['object-literal', 'array-literal', 'function', 'conditional']);

function classifyValue(expr: ts.Expression | undefined): SinkValueKind {
  if (!expr) return 'none';
  if (ts.isJsxExpression(expr)) return classifyValue(expr.expression);
  if (ts.isObjectLiteralExpression(expr)) return 'object-literal';
  if (ts.isArrayLiteralExpression(expr)) return 'array-literal';
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) return 'function';
  if (ts.isConditionalExpression(expr)) return 'conditional';
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return 'string';
  if (ts.isIdentifier(expr) || ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr) || ts.isCallExpression(expr)) return 'reference';
  if (ts.isParenthesizedExpression(expr)) return classifyValue(expr.expression);
  if (ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr)) return classifyValue(expr.expression);
  if (ts.isBinaryExpression(expr)) {
    const op = expr.operatorToken.kind;
    // `cond && { ... }` renders the right operand inline — the same
    // enforcement surface as a ternary.
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return classifyValue(expr.right);
    // `a || { ... }` / `a ?? { ... }` can render either side: an inline value
    // on either side means the sink needs a classification.
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      const l = classifyValue(expr.left);
      const r = classifyValue(expr.right);
      return INLINE_VALUE_KINDS.has(l) || INLINE_VALUE_KINDS.has(r) ? 'conditional' : l;
    }
  }
  return 'other';
}

function jsxElementName(attr: ts.JsxAttribute | ts.JsxSpreadAttribute): string {
  const attrs = attr.parent;
  const opening = attrs?.parent;
  if (opening && (ts.isJsxOpeningElement(opening) || ts.isJsxSelfClosingElement(opening))) {
    return opening.tagName.getText();
  }
  return '<unknown>';
}

/** Collect color string literals inside an expression (recursively). */
function collectColorLiterals(
  sf: ts.SourceFile,
  node: ts.Node,
  context: ColorLiteral['context'],
  out: ColorLiteral[],
): void {
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (isColorLiteral(n.text)) {
        out.push({ value: n.text, line: lineOf(sf, n.getStart(sf)), context });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
}

const NW_KEEP_RE = /nw-keep\(([a-zA-Z0-9-]+)\)\s*:\s*([^\n*]*)/g;

function collectNwKeep(source: string): NwKeepAnnotation[] {
  const out: NwKeepAnnotation[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    NW_KEEP_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NW_KEEP_RE.exec(lines[i])) !== null) {
      const category = m[1];
      const reason = m[2].trim();
      out.push({
        category,
        reason,
        line: i + 1,
        // The plan's shape is `nw-keep(<category>): <reason>` — a known
        // category with an EMPTY reason is not a justification.
        valid: (NW_KEEP_CATEGORIES as readonly string[]).includes(category) && reason.length > 0,
      });
    }
  }
  return out;
}

/** Audit a single source text. Pure — unit-testable on fixture snippets. */
export function auditSource(fileName: string, source: string): FileAudit {
  const scriptKind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, scriptKind);

  const styleSheetRefs: StyleSheetRef[] = [];
  const sinks: StyleSink[] = [];
  const colorProps: ColorProp[] = [];
  const colorLiterals: ColorLiteral[] = [];
  const rawDomBorderIssues: RawDomBorderIssue[] = [];
  const classConflicts: ClassConflict[] = [];
  let styleSheetCreateCount = 0;

  // Computed up-front so inline sinks can be checked for an adjacent nw-keep
  // during the AST walk. Line-based (annotations are comments, not AST nodes).
  const nwKeep = collectNwKeep(source);
  const keepLines = new Set(nwKeep.map((k) => k.line));

  // A JSX comment written as `{/* nw-keep(...) */}` on the line above an
  // element is a SIBLING child node, not the element's leading trivia, so
  // getFullStart() does not reach it. This look-back window catches that
  // placement, including a multi-line comment block whose `nw-keep(` line sits
  // a few lines above the element. The window is bounded by adjacencyFloor
  // below so it cannot reach keeps that belong to a different element.
  const PRECEDING_KEEP_LINES = 5;
  const hasKeepInRange = (startLine: number, endLine: number): boolean => {
    for (const l of keepLines) if (l >= startLine && l <= endLine) return true;
    return false;
  };

  /**
   * First line an nw-keep may occupy for `node`. The look-back must stop at
   * the previous REAL sibling — a JSX element, non-empty JSX text, or an
   * expression-bearing `{...}` child (for JSX sinks), or the previous
   * property (for object-literal sinks: navigation options, createElement
   * props). A JSX-expression child that holds only a comment (the nw-keep
   * placement described above) and whitespace JSX text are transparent: that
   * gap is exactly what the look-back exists for. Without
   * this floor a keep written for element A would also "classify" the
   * siblings below it (or the children of the element it annotates), letting
   * a genuinely unclassified sink slip through — a fail-mode FALSE NEGATIVE,
   * worse than a false positive.
   */
  const adjacencyFloor = (node: ts.Node): number => {
    const parent = node.parent;
    if (!parent) return 1;
    if (
      (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) &&
      (ts.isJsxElement(parent) || ts.isJsxFragment(parent))
    ) {
      const children = parent.children;
      for (let i = children.indexOf(node) - 1; i >= 0; i--) {
        const c = children[i];
        const transparent =
          (ts.isJsxText(c) && c.getText().trim().length === 0) ||
          (ts.isJsxExpression(c) && c.expression === undefined);
        if (!transparent) return lineOf(sf, c.getEnd());
      }
      const openEnd = ts.isJsxElement(parent) ? parent.openingElement.getEnd() : parent.openingFragment.getEnd();
      return lineOf(sf, openEnd);
    }
    if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(parent)) {
      const props = parent.properties;
      const idx = props.indexOf(node);
      if (idx > 0) return lineOf(sf, props[idx - 1].getEnd());
      return lineOf(sf, parent.getStart(sf));
    }
    return 1;
  };

  /**
   * The JSX element carrying an attribute's style prop, or null when the
   * attribute is not on a JSX opening/self-closing element.
   */
  const jsxAttrElement = (attr: ts.JsxAttribute): ts.JsxElement | ts.JsxSelfClosingElement | null => {
    const opening = attr.parent?.parent;
    if (opening && ts.isJsxOpeningElement(opening)) return opening.parent;
    if (opening && ts.isJsxSelfClosingElement(opening)) return opening;
    return null;
  };
  /** classified boolean for a sink, or undefined when the value isn't inline. */
  const classifyInline = (valueKind: SinkValueKind, range: [number, number] | null, floor = 1): boolean | undefined => {
    if (!INLINE_VALUE_KINDS.has(valueKind)) return undefined;
    return range ? hasKeepInRange(Math.max(range[0] - PRECEDING_KEEP_LINES, floor), range[1]) : false;
  };
  /**
   * classified boolean for a JSX-attribute sink. The accepted nw-keep span:
   * from the enclosing element's leading trivia (captures a comment directly
   * above the element) through the end of its opening tag (captures a comment
   * between attributes or inside the style object), bounded below by the
   * element's adjacency floor and the look-back window.
   */
  const classifyJsxAttr = (attr: ts.JsxAttribute, valueKind: SinkValueKind): boolean | undefined => {
    const el = jsxAttrElement(attr);
    if (!el) return classifyInline(valueKind, null);
    const opening = ts.isJsxElement(el) ? el.openingElement : el;
    return classifyInline(
      valueKind,
      [lineOf(sf, el.getFullStart()), lineOf(sf, opening.getEnd())],
      adjacencyFloor(el),
    );
  };

  const visit = (node: ts.Node) => {
    // --- StyleSheet.<member> references ---
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'StyleSheet'
    ) {
      const member = node.name.text;
      const line = lineOf(sf, node.getStart(sf));
      if (member === 'create') {
        styleSheetCreateCount++;
        styleSheetRefs.push({ kind: 'create', line });
        // Color literals inside the create arg.
        const call = node.parent;
        if (ts.isCallExpression(call) && call.expression === node && call.arguments.length > 0) {
          collectColorLiterals(sf, call.arguments[0], 'stylesheet-create', colorLiterals);
        }
      } else if (['absoluteFill', 'absoluteFillObject', 'flatten', 'hairlineWidth', 'compose'].includes(member)) {
        styleSheetRefs.push({ kind: member, line });
      } else {
        styleSheetRefs.push({ kind: `other:${member}`, line });
      }
    }

    // --- JSX style-family props ---
    if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name)) {
      const name = node.name.text;
      const line = lineOf(sf, node.getStart(sf));
      const element = jsxElementName(node);
      const initExpr = node.initializer && ts.isJsxExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer && ts.isStringLiteral(node.initializer)
          ? node.initializer
          : undefined;
      const valueKind = classifyValue(initExpr);

      if (name === 'style') {
        sinks.push({
          kind: valueKind === 'function' ? 'jsx-style-callback' : 'jsx-style',
          name,
          element,
          line,
          valueKind,
          classified: classifyJsxAttr(node, valueKind),
        });
        if (initExpr) collectColorLiterals(sf, initExpr, 'inline-style', colorLiterals);
      } else if (/Style$/.test(name)) {
        // contentContainerStyle, containerStyle, imageStyle, labelStyle, ...
        sinks.push({ kind: 'jsx-namedStyle', name, element, line, valueKind, classified: classifyJsxAttr(node, valueKind) });
        if (initExpr) collectColorLiterals(sf, initExpr, 'inline-style', colorLiterals);
      } else if (name === 'className') {
        // CONFIG-02: raw-DOM border invariant. Narrow by design: only string
        // literals on lowercase JSX elements; RN components are unaffected
        // (RNW defaults border-style to solid).
        const text =
          initExpr && (ts.isStringLiteral(initExpr) || ts.isNoSubstitutionTemplateLiteral(initExpr))
            ? initExpr.text
            : undefined;
        if (text !== undefined && isRawDomElement(element) && rawDomBorderMissingStyle(text)) {
          rawDomBorderIssues.push({ element, line, className: text });
        }
        // Co-active conflicting-class rule (kimi P3 §7): only template literals
        // can hold a `${...}` conditional segment, so plain-string classNames
        // are trivially conflict-free.
        if (initExpr && ts.isTemplateExpression(initExpr)) {
          const { baseTokens, conditionalTokens } = splitTemplateClassName(initExpr);
          for (const c of findCoActiveClassConflicts(baseTokens, conditionalTokens)) {
            classConflicts.push({ element, line, ...c });
          }
        }
      } else if (COLOR_PROP_NAMES.has(name)) {
        let literal: string | undefined;
        if (initExpr && (ts.isStringLiteral(initExpr) || ts.isNoSubstitutionTemplateLiteral(initExpr)) && isColorLiteral(initExpr.text)) {
          literal = initExpr.text;
        }
        colorProps.push({ name, element, line, ...(literal !== undefined ? { literal } : {}) });
      }
    }

    // --- JSX spread attributes: `{...props}` CAN carry style, so a file whose
    // only styling signal is a spread still needs a classification decision
    // (typically nw-keep(forwarded-style-contract)). Never silently styleless.
    if (ts.isJsxSpreadAttribute(node)) {
      sinks.push({
        kind: 'jsx-spread',
        name: '{...spread}',
        element: jsxElementName(node),
        line: lineOf(sf, node.getStart(sf)),
        valueKind: classifyValue(node.expression),
      });
    }

    // --- Navigation-options style keys in plain object literals ---
    if (
      ts.isPropertyAssignment(node) &&
      (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name)) &&
      NAV_STYLE_KEYS.has(ts.isIdentifier(node.name) ? node.name.text : node.name.text)
    ) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.text;
      const navKind = classifyValue(node.initializer);
      sinks.push({
        kind: 'navigation-options',
        name,
        line: lineOf(sf, node.getStart(sf)),
        valueKind: navKind,
        classified: classifyInline(navKind, [lineOf(sf, node.getFullStart()), lineOf(sf, node.initializer.getEnd())], adjacencyFloor(node)),
      });
      collectColorLiterals(sf, node.initializer, 'navigation-options', colorLiterals);
    }

    // --- createElement(..., { style: ... }) ---
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isCreateElement =
        (ts.isIdentifier(callee) && callee.text === 'createElement') ||
        (ts.isPropertyAccessExpression(callee) && callee.name.text === 'createElement');
      if (isCreateElement && node.arguments.length >= 2) {
        const props = node.arguments[1];
        if (ts.isObjectLiteralExpression(props)) {
          for (const p of props.properties) {
            if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && (p.name.text === 'style' || /Style$/.test(p.name.text))) {
              const ceKind = classifyValue(p.initializer);
              sinks.push({
                kind: 'createElement-style',
                name: p.name.text,
                line: lineOf(sf, p.getStart(sf)),
                valueKind: ceKind,
                classified: classifyInline(ceKind, [lineOf(sf, p.getFullStart()), lineOf(sf, p.initializer.getEnd())], adjacencyFloor(p)),
              });
              collectColorLiterals(sf, p.initializer, 'inline-style', colorLiterals);
            }
          }
        }
      }
    }

    // --- raw React.CSSProperties type references ---
    if (ts.isTypeReferenceNode(node)) {
      const typeName = node.typeName.getText();
      if (typeName === 'CSSProperties' || typeName.endsWith('.CSSProperties')) {
        sinks.push({
          kind: 'css-properties-type',
          name: typeName,
          line: lineOf(sf, node.getStart(sf)),
          valueKind: 'none',
        });
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  const hasStyles =
    styleSheetRefs.length > 0 || sinks.length > 0 || colorProps.length > 0 || colorLiterals.length > 0;

  return {
    file: fileName,
    styleSheetCreateCount,
    styleSheetRefs,
    sinks,
    colorProps,
    colorLiterals,
    nwKeep,
    rawDomBorderIssues,
    classConflicts,
    hasStyles,
    classification: 'app',
  };
}

// ---------------------------------------------------------------------------
// Repo walk + report
// ---------------------------------------------------------------------------

const IGNORED_DIR_NAMES = new Set(['node_modules', '__tests__', '__fixtures__', 'sui-witness']);

function isAuditedFile(filePath: string): boolean {
  if (!/\.(ts|tsx)$/.test(filePath)) return false;
  if (filePath.endsWith('.d.ts')) return false;
  if (/\.test\.(ts|tsx)$/.test(filePath)) return false;
  return true;
}

function* walk(dir: string): Generator<string> {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIR_NAMES.has(e.name)) continue;
      yield* walk(full);
    } else if (e.isFile() && isAuditedFile(full)) {
      yield full;
    }
  }
}

export function auditRepo(root: string): AuditReport {
  const files: FileAudit[] = [];
  for (const dir of AUDIT_DIRS) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const filePath of walk(abs)) {
      const rel = path.relative(root, filePath).split(path.sep).join('/');
      const source = fs.readFileSync(filePath, 'utf8');
      files.push({
        ...auditSource(rel, source),
        file: rel,
        classification: EVIDENCE_FIXTURES.has(rel) ? 'evidence-fixture' : 'app',
      });
    }
  }
  // Evidence fixtures live OUTSIDE the audited dirs (harness-owned) but stay
  // in the report so the ownership gate sees them — audit them explicitly.
  for (const rel of [...EVIDENCE_FIXTURES].sort()) {
    if (files.some((f) => f.file === rel)) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    const source = fs.readFileSync(abs, 'utf8');
    files.push({ ...auditSource(rel, source), file: rel, classification: 'evidence-fixture' });
  }
  files.sort((a, b) => a.file.localeCompare(b.file));

  // Migration-DEBT totals exclude evidence fixtures (their StyleSheet halves
  // are the fixture); ownership/report coverage does NOT exclude them.
  const debtFiles = files.filter((f) => f.classification !== 'evidence-fixture');
  const sinksByKind: Record<string, number> = {};
  let colorPropsTotal = 0;
  let colorLiteralsTotal = 0;
  const uniqueColors = new Set<string>();
  let createCalls = 0;
  let nwKeepTotal = 0;
  let nwKeepInvalid = 0;
  let rawDomBorderTotal = 0;
  let unclassifiedSinks = 0;
  let classConflictTotal = 0;
  for (const f of debtFiles) {
    createCalls += f.styleSheetCreateCount;
    for (const s of f.sinks) {
      sinksByKind[s.kind] = (sinksByKind[s.kind] ?? 0) + 1;
      if (s.classified === false) unclassifiedSinks++;
    }
    colorPropsTotal += f.colorProps.length;
    colorLiteralsTotal += f.colorLiterals.length;
    for (const c of f.colorLiterals) uniqueColors.add(c.value.toLowerCase());
    nwKeepTotal += f.nwKeep.length;
    nwKeepInvalid += f.nwKeep.filter((k) => !k.valid).length;
    rawDomBorderTotal += f.rawDomBorderIssues.length;
    classConflictTotal += f.classConflicts.length;
  }

  return {
    toolVersion: AUDIT_TOOL_VERSION,
    root: path.basename(root),
    scannedDirs: AUDIT_DIRS,
    fileCount: files.length,
    files,
    totals: {
      filesWithStyles: debtFiles.filter((f) => f.hasStyles).length,
      filesWithStyleSheetCreate: debtFiles.filter((f) => f.styleSheetCreateCount > 0).length,
      styleSheetCreateCalls: createCalls,
      sinksByKind,
      colorProps: colorPropsTotal,
      colorLiterals: colorLiteralsTotal,
      uniqueColorLiterals: uniqueColors.size,
      nwKeepAnnotations: nwKeepTotal,
      invalidNwKeepAnnotations: nwKeepInvalid,
      rawDomBorderIssues: rawDomBorderTotal,
      unclassifiedStyleSinks: unclassifiedSinks,
      classConflicts: classConflictTotal,
      evidenceFixtureFiles: files.filter((f) => f.classification === 'evidence-fixture').length,
    },
  };
}

// ---------------------------------------------------------------------------
// Enforcement (fail mode)
// ---------------------------------------------------------------------------

export type ViolationKind =
  | 'stylesheet-create'
  | 'invalid-nw-keep'
  | 'unclassified-style-sink'
  | 'raw-dom-border'
  | 'co-active-class-conflict';

export interface Violation {
  kind: ViolationKind;
  file: string;
  line: number;
  detail: string;
}

/**
 * Every UNCLASSIFIED-styling violation in the report (migration-debt files
 * only; evidence fixtures and the gallery harness are exempt). An empty array
 * means the tree is fully classified — the fail-mode gate passes. Rules:
 *   - any StyleSheet.create (the port migrated all of them to className);
 *   - an inline style sink (object/array/function/conditional) with no
 *     adjacent nw-keep;
 *   - an invalid nw-keep (unknown category or empty reason);
 *   - a raw-DOM width-bearing border/divide utility with no border-style
 *     (invisible under preflight-off — CONFIG-02);
 *   - a co-active conflicting-class pattern (CSS-emission-order trap).
 */
export function collectViolations(report: AuditReport): Violation[] {
  const out: Violation[] = [];
  for (const f of report.files) {
    if (f.classification === 'evidence-fixture') continue;
    for (const ref of f.styleSheetRefs) {
      if (ref.kind === 'create') {
        out.push({ kind: 'stylesheet-create', file: f.file, line: ref.line, detail: 'StyleSheet.create — migrate to className' });
      }
    }
    for (const s of f.sinks) {
      if (s.classified === false) {
        out.push({
          kind: 'unclassified-style-sink',
          file: f.file,
          line: s.line,
          detail: `${s.kind} on <${s.element ?? '?'}> (${s.valueKind}) has no adjacent nw-keep — classify it or move statics to className`,
        });
      }
    }
    for (const k of f.nwKeep) {
      if (!k.valid) {
        out.push({ kind: 'invalid-nw-keep', file: f.file, line: k.line, detail: `invalid nw-keep(${k.category})${k.reason ? '' : ': empty reason'}` });
      }
    }
    for (const b of f.rawDomBorderIssues) {
      out.push({ kind: 'raw-dom-border', file: f.file, line: b.line, detail: `raw-DOM <${b.element}> border width without border-style: "${b.className}"` });
    }
    for (const c of f.classConflicts) {
      out.push({
        kind: 'co-active-class-conflict',
        file: f.file,
        line: c.line,
        detail: `<${c.element}> className: base "${c.baseToken}" and conditional "${c.conditionalToken}" both set ${c.property} (make the branches mutually exclusive)`,
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printSummary(report: AuditReport): void {
  const t = report.totals;
  console.log(`NativeWind audit v${report.toolVersion} — ${report.fileCount} files scanned (${report.scannedDirs.join(', ')})`);
  console.log(`  files with any styling signal : ${t.filesWithStyles}`);
  console.log(`  files with StyleSheet.create  : ${t.filesWithStyleSheetCreate} (${t.styleSheetCreateCalls} calls)`);
  console.log('  style sinks by kind:');
  for (const [kind, count] of Object.entries(t.sinksByKind).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${kind.padEnd(24)} ${count}`);
  }
  console.log(`  visual color props            : ${t.colorProps}`);
  console.log(`  raw color literals in styles  : ${t.colorLiterals} (${t.uniqueColorLiterals} unique)`);
  console.log(`  nw-keep annotations           : ${t.nwKeepAnnotations} (${t.invalidNwKeepAnnotations} invalid)`);
  console.log(`  raw-DOM border-style issues   : ${t.rawDomBorderIssues}`);
  console.log(`  unclassified inline sinks     : ${t.unclassifiedStyleSinks}`);
  console.log(`  co-active class conflicts     : ${t.classConflicts}`);
  console.log(`  evidence-fixture files        : ${t.evidenceFixtureFiles} (excluded from debt, not from ownership)`);
  const top = [...report.files]
    .filter((f) => f.hasStyles)
    .sort((a, b) => (b.sinks.length + b.styleSheetRefs.length) - (a.sinks.length + a.styleSheetRefs.length))
    .slice(0, 10);
  console.log('  heaviest files (sinks + StyleSheet refs):');
  for (const f of top) {
    console.log(`    ${String(f.sinks.length + f.styleSheetRefs.length).padStart(4)}  ${f.file}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  // P4: enforce (fail on any unclassified violation) by default; `--report`
  // keeps the historical informational-only behavior (never exits non-zero).
  const reportMode = args.includes('--report');
  let jsonOut: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') jsonOut = args[++i] ?? '-';
  }
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const report = auditRepo(root);
  if (jsonOut === '-') {
    console.log(JSON.stringify(report, null, 2));
    // JSON-to-stdout stays pure (machine-readable); enforcement is silent here
    // but still governs the exit code below.
  } else if (jsonOut) {
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n');
    console.log(`wrote ${jsonOut}`);
    printSummary(report);
  } else {
    printSummary(report);
  }

  const violations = collectViolations(report);
  if (jsonOut !== '-') {
    if (violations.length === 0) {
      console.log(reportMode ? '  (report mode: informational only, never fails)' : '  OK — no unclassified styling debt (fail mode)');
    } else {
      console.error(`\n${violations.length} unclassified styling violation(s)${reportMode ? ' (report mode — not failing)' : ''}:`);
      for (const v of violations) console.error(`  ${v.file}:${v.line}  [${v.kind}] ${v.detail}`);
    }
  }
  if (!reportMode && violations.length > 0) process.exit(1);
}

// Bun sets `import.meta.main`; the field isn't in the ambient ImportMeta type.
if ((import.meta as ImportMeta & { main?: boolean }).main) main();
