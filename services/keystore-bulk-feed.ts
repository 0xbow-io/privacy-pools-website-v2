import { createPublicClient, fallback, parseAbi } from 'viem';
import { getChainConfig } from '@/config/chains';
import { policedHttp } from '@/services/egress-transport';
import { readBulkRegistry, sweepBulkRegistry, type RegistryEvent } from '@/services/keystore-bulk-fallback';
import { isAspHashRegistryFresh } from '@/services/nullifying-key-hash-cache';
import { isAspViewingRegistryFresh } from '@/services/viewing-key-cache';
import { notifyRegistrySynced } from '@/services/keystore-registry-events';

// IKeystore.sol events. No indexed account filter is ever supplied.
const EVENTS = parseAbi([
  'event AuthPolicySet(address indexed _account, uint256 _nullifyingKeyHash, uint256 _authDigest)',
  'event ViewingKeySet(address indexed _account, bytes32 _oldViewingKey, bytes32 _newViewingKey)',
]);
export const BULK_REGISTRY_INTERVAL_MS = 30_000;
/** Fixed background tick for every configured keystore, including before unlock. */
export async function refreshBulkKeystoreRegistry(chainId: number, keystore?: string): Promise<string> {
  if (isAspHashRegistryFresh(chainId, keystore) && isAspViewingRegistryFresh(chainId, keystore)) return 'asp-current';
  const held = readBulkRegistry(chainId, keystore);
  if (held && Date.now() - held.at < 5 * 60_000) return 'chain-current';
  const config = getChainConfig(chainId);
  if (!config?.contracts || !keystore) return 'no-keystore';
  const client = createPublicClient({ transport: fallback((config.rpcUrls ?? [config.rpcUrl]).map(url => policedHttp(url, { retryCount: 0 }))) });
  // An explicitly selected legacy keystore may predate the current deployment.
  // Without its own configured deployment floor, scan from genesis rather than
  // skipping old registrations and calling them absent.
  const deployment = keystore.toLowerCase() === config.contracts.keystoreAddress.toLowerCase()
    ? config.contracts.keystoreFromBlock ?? config.contracts.fromBlock ?? 0n : 0n;
  const current = await sweepBulkRegistry(chainId, keystore, deployment, config.logsMaxBlockRange ?? 100_000n, {
    head: () => client.getBlockNumber({ cacheTime: 0 }),
    blockHash: async blockNumber => {
      // Public chain head bound to the sweep, never a transaction/note hash.
      const block = await client.getBlock({ blockNumber });
      if (!block.hash) throw new Error('Keystore sweep block has no hash');
      return block.hash;
    },
    events: async (fromBlock, toBlock) => {
      const logs = await client.getLogs({ address: keystore as `0x${string}`, events: EVENTS, fromBlock, toBlock });
      return logs.map(log => {
        const args = log.args as { _account?: string; _nullifyingKeyHash?: bigint; _newViewingKey?: string };
        if (log.removed || log.blockNumber == null || log.logIndex == null || !args._account) throw new Error('Incomplete keystore log');
        const auth = log.eventName === 'AuthPolicySet';
        if (auth ? args._nullifyingKeyHash == null : args._newViewingKey == null) throw new Error('Undecodable keystore log');
        return { kind: auth ? 'auth' : 'viewing', account: args._account, value: auth ? `0x${args._nullifyingKeyHash!.toString(16).padStart(64, '0')}` : args._newViewingKey!, blockNumber: log.blockNumber, logIndex: log.logIndex } satisfies RegistryEvent;
      });
    },
  });
  if (current) notifyRegistrySynced();
  return current ? 'chain-current' : 'scanning';
}
