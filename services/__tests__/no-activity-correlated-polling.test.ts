import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

/**
 * Ratchet for transaction-dependent request timing. These exemptions require
 * proof/root pinning and local event reconciliation before their pauses can
 * safely go. This is a source guard, not a traffic-analysis proof: it follows
 * local declarations/functions, not arbitrary inter-module data flow (an
 * import cannot be resolved here, so a helper in ANOTHER module returning
 * txPending-derived state is invisible to it), it taints only the literal
 * name `txPending` (a renamed or second activity signal is invisible), and a
 * poll keyed to flow-local state that is not lexically txPending (a bridge
 * status watch, a post-deposit resync timer) is invisible too. The
 * request-journey tests remain necessary.
 */
const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const SCANNED_DIRS = ['services', 'components', 'hooks', 'app', 'config'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', '__tests__', 'workflows']);

// Options through which activity can steer WHEN a request fires. The poll
// gates are the disclosed class; the rest are the same channel through other
// knobs: a freshness or focus/reconnect trigger that depends on activity
// schedules a request, a retry policy that consults activity times retries
// by it, and a queryFn that reads activity can skip the network entirely.
const SCHEDULING_OPTIONS = new Set([
  'refetchInterval', 'enabled', 'refetchOnMount', 'refetchOnWindowFocus',
  'refetchOnReconnect', 'refetchIntervalInBackground', 'retry', 'retryDelay',
  'staleTime', 'queryFn',
]);

// Effects that fetch only once activity flips are the pause inverted: the
// request HAPPENS because a transaction settled. Flag an effect whose body
// holds both an activity-tainted guard and a lexical network call. Calls
// reached through local indirection (a `resync()` defined elsewhere in the
// file) stay invisible on purpose — precision over recall, the e2e gate sees
// the traffic either way.
const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect', 'useFocusEffect']);
const NETWORK_PROPERTIES = new Set(['invalidateQueries', 'refetchQueries', 'fetchQuery', 'prefetchQuery', 'refetch']);

// Stable call-site identities, not file-wide counts: removing one gate cannot
// make room for a different gate in the same file. Whitespace/line shifts do
// not change a site's identity. The two enabled gates were missed by the old
// single-line refetchInterval regex; they are existing debt, not new pauses.
const REMAINING: Record<string, { sites: string[]; blockedOn: string }> = {
  // components/pools-provider.tsx has NO remaining sites. Its wallet reads
  // (ethWalletBalance, erc20Balances) poll on a fixed cadence with the display
  // latched (hooks/use-latched-while.ts). Its feeds (eventsResponse,
  // suiApprovedSet, eventSnapshot) poll on a fixed cadence too, since the
  // local reconciliation they were blocked on landed in
  // services/feed-reconciliation.ts: our own pending operation is a local
  // ledger entry keyed by (chain, tx hash, row type), never a row inside a feed
  // cache, and the merge yields it to any feed row for the same operation, so
  // a feed returning our in-flight transaction cannot count it twice. The Sui
  // approved set and the event snapshot derive everything from what this
  // account owns and were paused defensively. The file is deliberately absent
  // rather than listed empty: an entry here is a debt, and there is none.
  // components/sdk-provider.tsx has NO remaining sites. The label decisions
  // and the association set (root and leaves) are scheduled public feeds now
  // (services/label-decision-feed.ts, services/public-asp-cache.ts), so there
  // is no poll left to pause while a transaction is in flight. Promotion
  // against a changed root is still held back by the promotion effect's own
  // txPending guard, which is a compute gate, not a request.
  // components/deposit-modal-provider.tsx has NO remaining sites. Its three
  // (nativeBalance, erc20BalanceRaw, feeData) were the wallet-balance and
  // gas-fee reads, and they now poll on a fixed cadence with the display
  // latched while a transaction is in flight. The file is deliberately absent
  // rather than listed empty: an entry here is a debt, and there is none.
};

function walk(dir: string, out: string[] = []): string[] {
  // Missing scan roots are an error, not a vacuous pass.
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function parse(sources: Map<string, string>) {
  const options: ts.CompilerOptions = { noResolve: true, noLib: true, target: ts.ScriptTarget.Latest };
  const host = ts.createCompilerHost(options);
  const files = new Map([...sources].map(([name, source]) => [name,
    ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true,
      name.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
  ]));
  host.getSourceFile = (name) => files.get(name);
  const program = ts.createProgram([...files.keys()], options, host);
  return { files, checker: program.getTypeChecker() };
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node)) return node.text;
  if (ts.isComputedPropertyName(node) && ts.isStringLiteral(node.expression)) return node.expression.text;
  return undefined;
}

function scan(sources: Map<string, string>): Map<string, string[]> {
  const { files, checker } = parse(sources);
  const result = new Map<string, string[]>();
  function dependsOnActivity(node: ts.Node, seen = new Set<ts.Node>()): boolean {
    if (seen.has(node)) return false;
    seen.add(node);
    if (ts.isIdentifier(node)) {
      if (node.text === 'txPending') return true;
      const symbol = ts.isShorthandPropertyAssignment(node.parent)
        ? checker.getShorthandAssignmentValueSymbol(node.parent)
        : checker.getSymbolAtLocation(node);
      for (const declaration of symbol?.declarations ?? []) {
        if (ts.isVariableDeclaration(declaration) && declaration.initializer
          && dependsOnActivity(declaration.initializer, seen)) return true;
        if (ts.isBindingElement(declaration)) {
          if (declaration.propertyName && propertyName(declaration.propertyName) === 'txPending') return true;
          const owner = declaration.parent.parent;
          // A hook's returned data is not the hook's options. Following the
          // entire useQuery call would taint data/root-readiness gates merely
          // because that query's separate refetchInterval uses txPending.
          if (ts.isVariableDeclaration(owner) && owner.initializer
            && !ts.isCallExpression(owner.initializer)
            && dependsOnActivity(owner.initializer, seen)) return true;
        }
        if (ts.isFunctionDeclaration(declaration) && declaration.body
          && dependsOnActivity(declaration.body, seen)) return true;
      }
    }
    return ts.forEachChild(node, (child) => dependsOnActivity(child, seen) || undefined) ?? false;
  }
  for (const [name, file] of files) {
    const sites: string[] = [];
    // The variable a gated option/effect belongs to, so removing one gate
    // cannot make room for a different gate under the same identity.
    function identityFor(node: ts.Node): string {
      let owner: ts.Node = node;
      while (owner.parent && !ts.isVariableDeclaration(owner)) owner = owner.parent;
      const binding = ts.isVariableDeclaration(owner) ? owner.name : undefined;
      const first = binding && !ts.isIdentifier(binding) ? binding.elements[0] : undefined;
      const found = first && ts.isBindingElement(first) ? first.name : binding;
      return found?.getText(file).replace(/\s/g, '') ?? '<inline>';
    }
    function isNetworkCall(node: ts.Node): boolean {
      if (!ts.isCallExpression(node)) return false;
      const callee = node.expression;
      if (ts.isIdentifier(callee)) return callee.text === 'fetch' || callee.text === 'apiClient';
      if (ts.isPropertyAccessExpression(callee)) {
        if (NETWORK_PROPERTIES.has(callee.name.text)) return true;
        if (ts.isIdentifier(callee.expression)
          && (callee.expression.text === 'apiClient' || callee.expression.text === 'queryClient')) return true;
      }
      return false;
    }
    function scanEffect(node: ts.CallExpression): void {
      const callee = node.expression;
      if (!ts.isIdentifier(callee) || !EFFECT_HOOKS.has(callee.text)) return;
      const callback = node.arguments[0];
      if (!callback || !(ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) return;
      let taintedGuard = false;
      let network = false;
      function walk(inner: ts.Node) {
        if (ts.isIfStatement(inner) && dependsOnActivity(inner.expression)) taintedGuard = true;
        else if (ts.isConditionalExpression(inner) && dependsOnActivity(inner.condition)) taintedGuard = true;
        else if (ts.isBinaryExpression(inner)
          && (inner.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
            || inner.operatorToken.kind === ts.SyntaxKind.BarBarToken)
          && (dependsOnActivity(inner.left) || dependsOnActivity(inner.right))) taintedGuard = true;
        if (isNetworkCall(inner)) network = true;
        if (taintedGuard && network) return;
        ts.forEachChild(inner, walk);
      }
      walk(callback.body);
      if (taintedGuard && network) sites.push(`${identityFor(node)}:effect`);
    }
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const option = propertyName(node.name);
        const value = ts.isPropertyAssignment(node) ? node.initializer : node.name;
        if (option !== undefined && SCHEDULING_OPTIONS.has(option) && dependsOnActivity(value)) {
          sites.push(`${identityFor(node)}:${option}`);
        }
      } else if ((ts.isGetAccessor(node) || ts.isMethodDeclaration(node)) && node.body) {
        // The same options written as a getter or shorthand method: the gate
        // is in the body instead of an initializer.
        const option = propertyName(node.name);
        if (option !== undefined && SCHEDULING_OPTIONS.has(option) && dependsOnActivity(node.body)) {
          sites.push(`${identityFor(node)}:${option}`);
        }
      } else if (ts.isCallExpression(node)) {
        scanEffect(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(file);
    if (sites.length) result.set(name, sites.sort());
  }
  return result;
}

const sources = new Map(SCANNED_DIRS.flatMap((dir) => walk(join(ROOT, dir)))
  .map((file) => [relative(ROOT, file), readFileSync(file, 'utf8')]));
const found = scan(sources);

describe('privacy: transaction activity must not control request scheduling', () => {
  test('scan roots contain the application', () => {
    expect(sources.size).toBeGreaterThan(100);
  });

  test('only the exact remaining call sites are exempt, with no stale exemptions', () => {
    expect(Object.fromEntries(found)).toEqual(Object.fromEntries(Object.entries(REMAINING)
      .map(([file, entry]) => [file, [...entry.sites].sort()])));
  });

  test('every remaining offender says what blocks it', () => {
    for (const entry of Object.values(REMAINING)) {
      expect(entry.sites.length).toBeGreaterThan(0);
      expect(entry.blockedOn.length).toBeGreaterThan(80);
    }
  });

  test('multiline gates, enabled gates, callbacks, local aliases, other scheduling options and effects cannot evade the scan', () => {
    const fixtures = new Map([['fixture.tsx', `
      const { txPending: busy } = useTxActivity();
      const paused = busy;
      const interval = paused ? false : 1000;
      function cadence() { return interval; }
      const first = useQuery({ refetchInterval:\n /* split */ txPending ? false : 1000 });
      const second = useQuery({ enabled: !paused });
      const third = useQuery({ refetchInterval: cadence });
      const refetchInterval = interval;
      const fourth = useQuery({ refetchInterval });
      const fifth = useQuery({ ['enabled']: () => !busy });
      const sixth = useQuery({ "refetchInterval": () => txPending ? false : 1000 });
      const seventh = useQuery({ refetchOnWindowFocus: () => !txPending });
      const eighth = useQuery({ staleTime: txPending ? 0 : 60_000 });
      const ninth = useQuery({ retry: () => !busy });
      const tenth = useQuery({ queryFn: txPending ? skipToken : loadFeed });
      const eleventh = useQuery({ get refetchInterval() { return txPending ? false : 1000; } });
      const twelfth = useQuery({ refetchInterval() { return interval; } });
      useEffect(() => { if (txPending) return; fetch('/feed'); }, [txPending]);
      useEffect(() => { if (!busy) { queryClient.invalidateQueries({ queryKey: ['k'] }); } }, [busy]);
      // refetchInterval: txPending ? false : 1000
      const text = 'enabled: !txPending';
      function unrelated() { const busy = false; const safe = useQuery({ enabled: !busy }); }
      useEffect(() => { if (txPending) return; setLabel('no network in here'); }, [txPending]);
      useEffect(() => { if (!isOpen) return; fetch('/fine: the guard is not activity'); }, [isOpen]);
      const clean = useQuery({ refetchOnMount: !isOpen, staleTime: 1000 });
    `]]);
    expect(scan(fixtures).get('fixture.tsx')).toEqual([
      'fifth:enabled', 'first:refetchInterval', 'fourth:refetchInterval',
      'second:enabled', 'sixth:refetchInterval', 'third:refetchInterval',
      'seventh:refetchOnWindowFocus', 'eighth:staleTime', 'ninth:retry',
      'tenth:queryFn', 'eleventh:refetchInterval', 'twelfth:refetchInterval',
      '<inline>:effect', '<inline>:effect',
    ].sort());
  });

  test('replacing an exempt gate with a different one in the same file changes the result', () => {
    const before = scan(new Map([['fixture.ts', 'const oldFeed = useQuery({ enabled: !txPending });']]));
    const after = scan(new Map([['fixture.ts', 'const newFeed = useQuery({ enabled: !txPending });']]));
    expect(after).not.toEqual(before);
  });

  test('the migrated HTTP methods are only called by the static public feed list', () => {
    const callers: string[] = [];
    for (const [name, file] of parse(sources).files) {
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
          && ['getAssetsStats', 'getGlobalStatistics'].includes(node.expression.name.text)) {
          callers.push(`${name}:${node.expression.name.text}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(file);
    }
    expect(callers.sort()).toEqual([
      'services/public-feeds.ts:getAssetsStats',
      'services/public-feeds.ts:getGlobalStatistics',
    ]);
    for (const file of ['hooks/use-global-statistics.ts', 'components/pools-provider.tsx']) {
      expect(sources.get(file)).toContain('usePublicFeed');
      expect(sources.get(file)).not.toMatch(/queryKey:\s*\[\s*['"](?:assetsStats|globalStatistics)['"]/);
    }
    expect(sources.get('services/cache.ts')).not.toMatch(/queryKey:\s*\[\s*['"](?:assetsStats|globalStatistics)['"]/);
  });

  test('the three no-interval feeds moved to the grid, so focus cannot pull them', () => {
    // These had NO refetchInterval, so their only refresh triggers were mount,
    // window FOCUS and invalidation. Focus is the one that matters: the
    // withdrawal flow sends the user to their wallet to sign and back, and
    // returning refetched every stale query in a burst bracketing the
    // signature. Entrypoints in particular really did reach the network —
    // its own client cache is 60s and a signing round trip exceeds that.
    const provider = sources.get('components/pools-provider.tsx')!;
    for (const marker of ['FEED_ENTRYPOINTS', 'feedTokenPrices', 'feedPriceMap']) {
      expect(provider).toContain(marker);
    }
    for (const key of ['entrypoints', 'tokenPricesRaw', 'tokenPricesAll']) {
      expect(provider).not.toMatch(new RegExp(`queryKey:\\s*\\[\\s*['"]${key}['"]`));
    }
    // And nothing may poke the grid-owned ones on a confirmed write: an
    // invalidation timed to OUR transaction is the positive-signal version of
    // the same channel. tokenPricesAll keeps its poke — screen-scoped
    // observers still exist for it.
    const cache = sources.get('services/cache.ts')!;
    for (const key of ['entrypoints', 'tokenPricesRaw']) {
      expect(cache).not.toMatch(new RegExp(`queryKey:\\s*\\[\\s*['"]${key}['"]`));
    }
  });
});
