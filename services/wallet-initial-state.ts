import { deserialize, type State } from 'wagmi';
import { version } from '@wagmi/core';

// Match Wagmi's persisted schema version so initialState cannot bypass migration.
const storageVersion = Number.parseInt(version.startsWith('0.0.0-canary-')
  ? version.replace('0.0.0-canary-', '') : version.split('.')[0], 10);
const validChainId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const validAddress = (value: unknown): boolean => typeof value === 'string' && /^0x[\da-f]{40}$/i.test(value);

/** Restore saved identity before rendering; reconnect still verifies the wallet. */
export function readWalletInitialState(getItem: (key: string) => string | null): State | undefined {
  try {
    const raw = getItem('wagmi.store');
    if (!raw) return undefined;
    const saved = deserialize<{ version?: number; state?: State }>(raw);
    const state = saved.state;
    if (saved.version !== storageVersion || !state || !validChainId(state.chainId)
      || !(state.connections instanceof Map) || typeof state.current !== 'string'
      || !state.connections.has(state.current)) return undefined;
    // Hydration persists every entry synchronously, including secondary wallets.
    // Validate their metadata too, before Wagmi can destructure a broken entry.
    for (const [uid, connection] of state.connections) {
      if (typeof uid !== 'string' || !connection || !validChainId(connection.chainId)
        || !Array.isArray(connection.accounts) || !connection.accounts.length
        || !connection.accounts.every(validAddress) || !connection.connector
        || !['id', 'name', 'type', 'uid'].every(key =>
          typeof connection.connector[key as keyof typeof connection.connector] === 'string')) return undefined;
    }
    return { chainId: state.chainId, current: state.current, connections: state.connections, status: 'reconnecting' };
  } catch {
    // Blocked storage, malformed data, and signed-out users start normally.
    return undefined;
  }
}
