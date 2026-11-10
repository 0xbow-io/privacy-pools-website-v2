// Names a crash report must never repeat, derived from the REAL configuration.
//
// A crash message can quote a property the code read by key, and this app keys
// by token symbol and by chain (`prices[symbol]`, `fees[chain]`). So
// "Cannot read properties of undefined (reading 'fdusd')" says which token the
// user had picked, whatever the case it was written in. The structural checks in
// services/error-shape.ts (a bare identifier, no ALL CAPS) cannot see that, so
// the names themselves are refused: every token symbol, share symbol, underlying
// symbol, native currency and chain name of every environment, compared
// case-insensitively, plus anything starting with `pp` (the share prefix).
//
// Read from the registry, not from a hand-written list, so a token or chain added
// to the configuration is covered the day it is added.
//
// The configuration is read LAZILY, on the first crash, never at import: the
// error boundary is imported above every provider, and pulling the config graph in
// at that point would initialise it early (services/error-reports-event.ts and
// config/intent-swaps.ts both note what an early import of this graph has broken).

let cache: ReadonlySet<string> | undefined;

function add(into: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) into.add(value.toLowerCase());
}

/** The lowercase names a crash report may not carry. Built once, on first use. */
export function forbiddenCrashNames(): ReadonlySet<string> {
  if (cache) return cache;
  const names = new Set<string>();
  try {
    const { ENVIRONMENTS } = require('@/config/environments') as typeof import('@/config/environments');
    for (const environment of Object.values(ENVIRONMENTS)) {
      for (const registry of Object.values(environment.tokensByChain ?? {})) {
        for (const token of Object.values(registry)) {
          add(names, token.symbol);
          add(names, (token as { name?: unknown }).name);
        }
      }
      for (const deployments of Object.values(environment.yieldDeployments ?? {})) {
        for (const deployment of deployments) {
          const fields = deployment as unknown as Record<string, unknown>;
          for (const key of ['underlyingSymbol', 'shareSymbol', 'symbol', 'name']) add(names, fields[key]);
        }
      }
      for (const tokens of Object.values(environment.swapOutputTokens ?? {})) {
        for (const token of tokens) add(names, token.symbol);
      }
      for (const deployment of environment.deployments ?? []) {
        add(names, deployment.name);
        add(names, deployment.displayName?.replace(/\s+/g, ''));
        add(names, deployment.nativeCurrency?.symbol);
        add(names, deployment.nativeCurrency?.name);
      }
    }
  } catch {
    // An unreadable configuration must not become a reason to report more: the
    // caller treats an empty set as "unknown" and refuses every name (see isReportableName).
    return new Set<string>();
  }
  cache = names;
  return names;
}

/** Test seam. */
export function resetCrashNameDenylistForTest(): void {
  cache = undefined;
}
