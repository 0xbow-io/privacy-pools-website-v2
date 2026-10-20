/**
 * Yield earned must stay a READ of data the app already fetches on its own
 * schedule. These pin the property rather than a code shape: the hook cannot
 * fetch a feed, cannot be gated on a screen, and is mounted app-wide, so no
 * portfolio interaction can put a request on the wire or change its timing.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import ts from 'typescript';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === '__tests__' || name === 'node_modules') continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...sources(rel));
    else if (/\.(ts|tsx)$/.test(name)) out.push(rel);
  }
  return out;
}

describe('yield earned reads, it does not fetch', () => {
  const hook = code('hooks/use-yield-earned.ts');

  test('the hook has no query, no enabled, no refetch, no API client', () => {
    expect(hook).not.toMatch(/useQuery|useInfiniteQuery/);
    expect(hook).not.toMatch(/\benabled\b/);
    expect(hook).not.toMatch(/\brefetch/);
    expect(hook).not.toMatch(/api-client|apiClient|fetch\(/);
    // It reads the grid's cache and never declares a feed of its own.
    expect(hook).toContain('publicFeeds.read');
    expect(hook).not.toContain('publicFeeds.register');
  });

  test('its cadence does not pause for a transaction', () => {
    expect(hook).not.toMatch(/txPending|useTxActivity|isSyncing|busy/);
    expect(hook).toMatch(/setInterval\(/);
  });

  test('the feeds it reads are grid feeds, registered from build config', () => {
    const feeds = code('services/public-feeds.ts');
    expect(feeds).toMatch(/key: feedYieldDeposits\(chainId\)/);
    expect(feeds).toMatch(/key: feedYieldRateHistory\(chainId, share\)/);
    expect(feeds).toMatch(/getConfiguredYieldDeployments\(chainId\)/);
    // The deposits feed takes no filter: not an asset, not a commitment.
    const grid = code('services/yield-feed-grid.ts');
    expect(grid).toMatch(/apiClient\.getYieldDeposits\(chainId, cursor\)/);
  });

  test('mounted once, app-wide, by PoolsProvider, never by a screen', () => {
    // By import, not by call text, so an alias (`import { useYieldEarned as
    // useEarned }`, a namespace import, a dynamic import or a require) is
    // caught too.
    const importers = APP_DIRS.flatMap(sources)
      .filter((rel) => rel !== HOOK)
      .filter((rel) => importsOf(rel).some((i) => i.target === HOOK));
    expect(importers).toEqual([PROVIDER]);
    // And the one importer calls it exactly once, under whatever name it bound.
    expect(hookCallCount(PROVIDER)).toBe(1);
  });

  test('no component computes earned itself', () => {
    const computing = ['app', 'components'].flatMap(sources).filter(computesEarned);
    expect(computing).toEqual([]);
  });

  test('the guards see through aliases', () => {
    const aliased = `
      import { useYieldEarned as useEarned } from '@/hooks/use-yield-earned';
      import * as sdk from '@privacy-pools-v2/sdk';
      export function A(ns: any) {
        useEarned({});
        const { earned: e } = ns;
        const r = e.compute({});
        return sdk.computeYieldEarned ? r : null;
      }`;
    const f = ts.createSourceFile('components/x.tsx', aliased, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(importsIn(f, 'components/x.tsx').map((i) => i.target)).toContain(HOOK);
    expect(callsOf(f, 'components/x.tsx')).toBe(1);
    expect(computesEarnedIn(f)).toBe(true);
    const plain = ts.createSourceFile('components/y.tsx', 'export const y = (m: any) => m.compute();', ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    expect(computesEarnedIn(plain)).toBe(false);
  });
});

// ── AST helpers ─────────────────────────────────────────────────────────────

const HOOK = join('hooks', 'use-yield-earned.ts');
const PROVIDER = join('components', 'pools-provider.tsx');
const APP_DIRS = ['app', 'components', 'hooks', 'services', 'config', 'constants', 'api', 'types'];

function parse(rel: string): ts.SourceFile {
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** A module specifier as a repo-relative source path (extension-less specifiers resolved). */
function resolveSpecifier(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = spec.slice(2);
  else if (spec.startsWith('.')) base = join(dirname(from), spec);
  else return null;
  base = normalize(base);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(join(ROOT, candidate)) && statSync(join(ROOT, candidate)).isFile()) return candidate;
  }
  return base;
}

type Imported = { target: string | null; names: string[]; namespaces: string[] };

function importsIn(file: ts.SourceFile, rel: string): Imported[] {
  const out: Imported[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const names: string[] = [];
      const namespaces: string[] = [];
      const clause = node.importClause;
      if (clause?.name) names.push(clause.name.text);
      const bindings = clause?.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.push(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) if ((el.propertyName ?? el.name).text === 'useYieldEarned') names.push(el.name.text);
      }
      out.push({ target: resolveSpecifier(rel, node.moduleSpecifier.text), names, namespaces });
    } else if (
      ts.isCallExpression(node)
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
      && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
    ) {
      out.push({ target: resolveSpecifier(rel, node.arguments[0].text), names: [], namespaces: [] });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push({ target: resolveSpecifier(rel, node.moduleSpecifier.text), names: [], namespaces: [] });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return out;
}

const importsOf = (rel: string) => importsIn(parse(rel), rel);

/** Calls of the hook under the names this file bound it to. */
function callsOf(file: ts.SourceFile, rel: string): number {
  const bound = importsIn(file, rel).filter((i) => i.target === HOOK);
  const names = new Set(bound.flatMap((i) => i.names));
  const namespaces = new Set(bound.flatMap((i) => i.namespaces));
  let count = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && names.has(callee.text)) count += 1;
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression)
        && namespaces.has(callee.expression.text) && callee.name.text === 'useYieldEarned') count += 1;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return count;
}

const hookCallCount = (rel: string) => callsOf(parse(rel), rel);

/** The SDK entry points of the computation, by their exported names. */
const EARNED_EXPORTS = new Set(['computeYieldEarned', 'yieldEarnedEventsFromSnapshot', 'PoolSessionYieldEarned']);

/**
 * Does this file compute earned? Any mention of the SDK's entry points by
 * name (an aliased import still names the export; a namespace access names
 * the member), or a `.compute(` on a yield namespace's `earned`, directly or
 * through a local bound from it.
 */
function computesEarnedIn(file: ts.SourceFile): boolean {
  const aliases = new Set<string>();
  let found = false;
  const isEarnedRef = (expr: ts.Expression): boolean => {
    let e: ts.Expression = expr;
    while (ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    if (ts.isPropertyAccessExpression(e)) return e.name.text === 'earned';
    if (ts.isElementAccessExpression(e)) return ts.isStringLiteral(e.argumentExpression) && e.argumentExpression.text === 'earned';
    return ts.isIdentifier(e) && aliases.has(e.text);
  };
  const collect = (node: ts.Node) => {
    if (ts.isBindingElement(node) && ((node.propertyName && ts.isIdentifier(node.propertyName) && node.propertyName.text === 'earned')
      || (!node.propertyName && ts.isIdentifier(node.name) && node.name.text === 'earned'))
      && ts.isIdentifier(node.name)) aliases.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isEarnedRef(node.initializer)) aliases.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(file);
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && EARNED_EXPORTS.has(node.text)) found = true;
    if (ts.isStringLiteral(node) && EARNED_EXPORTS.has(node.text)) found = true;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'compute' && isEarnedRef(node.expression.expression)) found = true;
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const computesEarned = (rel: string) => computesEarnedIn(parse(rel));
