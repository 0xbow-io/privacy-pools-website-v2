/**
 * Recognising "the wallet connection is not live yet".
 *
 * A wagmi connection restored from storage names its connector by id, and an
 * EIP-6963 wallet (MetaMask and friends) only becomes a real connector once
 * the page receives its announcement. Any wagmi call in that window runs
 * against a plain rehydrated object and throws
 * "<var>.connector.<method> is not a function" (QA hit getChainId).
 *
 * The guard for this existed and MISSED IN PRODUCTION: it tested for the
 * literal `connection.connector.` prefix, but a minified bundle renames the
 * variable — the shipped error reads `u.connector.getChainId is not a
 * function` — so the reconnect-and-retry never fired exactly where users see
 * it, and refreshes randomly painted the raw TypeError (Pat, 2026-08-28,
 * recurring). Match on the invariant part instead: `.connector.<method> is
 * not a function`, whatever the receiver variable was renamed to.
 *
 * PURE module so the regex is pinned by tests against the real minified
 * message, not hoped about.
 */
export function isStaleConnectorError(message: string | null | undefined): boolean {
  if (!message) return false;
  return /(?:^|[^\w$])[\w$]*\.?connector\.[\w$]+ is not a function/.test(message);
}

/**
 * The slice of wagmi's persisted state this helper touches.
 */
export type WagmiConnectionState = {
  connections: Map<string, { connector: unknown }>;
  current: string | null;
  status: 'connected' | 'connecting' | 'disconnected' | 'reconnecting';
};

/**
 * Remove a restored connection whose connector rehydrated as a bare record.
 *
 * wagmi's own disconnect cannot do it: the action calls connector.disconnect()
 * before it touches the store, and on a bare `{ id, name, type, uid }` record
 * that is "connector.disconnect is not a function", so the record survives and
 * the user meets the same failure on every attempt (codex on 5e58d71).
 *
 * Identity-guarded: nothing happens unless the CURRENT connection is the one
 * whose connector demonstrably has no methods. Then every bare record goes and
 * only a live connector can be promoted. A live current connector (a reconnect
 * repaired the record between the failure and this call) is left alone and
 * null is returned, so a repaired session is never disconnected.
 */
export function pruneBareRestoredConnection<S extends WagmiConnectionState>(state: S): S | null {
  const isBare = (c: unknown) => !c || typeof (c as { getChainId?: unknown }).getChainId !== 'function';
  const key = state.current;
  const current = key ? state.connections.get(key) : undefined;
  if (!key || !current || !isBare(current.connector)) return null;
  // Every restored record is bare, not only the current one: promoting the
  // next bare record would meet the same TypeError on the next attempt
  // (codex on 49f41bf). Only a live connector instance can become current.
  const connections = new Map(state.connections);
  for (const [k, conn] of state.connections) if (isBare(conn.connector)) connections.delete(k);
  const next = connections.keys().next();
  const nextCurrent = next.done ? null : next.value;
  return { ...state, connections, current: nextCurrent, status: nextCurrent ? state.status : 'disconnected' };
}
