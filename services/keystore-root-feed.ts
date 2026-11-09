/**
 * The grid feed behind services/keystore-root-guard.ts: wires its injected
 * reads to the chain's own RPC endpoints and to the leaves the grid holds.
 *
 * Only the public feed grid calls `refreshKeystoreRoot` (services/public-feeds.ts).
 * Its reads are Keystore.currentRoot() and the pool-wide LeafInserted /
 * LeafUpdated log range, neither of which names a note or an account, and they
 * run on wall-clock instants nothing a user does can move.
 */
import { createPublicClient, fallback, parseAbi } from 'viem';
import { getChainConfig } from '@/config/chains';
import { policedHttp } from '@/services/egress-transport';
import { alignLogScanStart } from '@/services/log-scan-alignment';
import { createRangeWindow, sweepLogRange } from '@/services/rpc-log-chunking';
import { resolveConfiguredEntrypoint } from '@/services/pool-entrypoint';
import { loadPoolLeaves } from '@/services/snapshot-source';
import {
  checkKeystoreRoot,
  type KeystoreEvent,
  type KeystoreLeafRowLike,
  type KeystoreRootVerdict,
} from '@/services/keystore-root-guard';

export const KEYSTORE_ROOT_INTERVAL_MS = 2 * 60_000;

export function feedKeystoreRoot(chainId: number): string {
  return `keystore-root:${chainId}`;
}

const KEYSTORE_ABI = parseAbi([
  'function currentRoot() view returns (uint256)',
  'event LeafInserted(uint256 _newLeaf, uint256 _root, uint256 _leafIndex)',
  'event LeafUpdated(uint256 _newLeaf, uint256 _root, uint256 _leafIndex)',
]);

const EVENTS = KEYSTORE_ABI.filter((item) => item.type === 'event');

/**
 * One grid instant for one chain. Resolves to a short status string the grid
 * holds as the feed's value. A chain with no keystore configured is a no-op.
 */
export async function refreshKeystoreRoot(chainId: number): Promise<string> {
  const chain = getChainConfig(chainId);
  const keystore = chain?.contracts?.keystoreAddress as `0x${string}` | undefined;
  if (!chain || !keystore) return 'no keystore';
  const fromBlock = chain.contracts?.keystoreFromBlock ?? chain.contracts?.fromBlock ?? 0n;
  const client = createPublicClient({
    transport: fallback((chain.rpcUrls ?? [chain.rpcUrl]).map((url) => policedHttp(url))),
  });
  const window = createRangeWindow(chain.logsMaxBlockRange);

  const verdict: KeystoreRootVerdict = await checkKeystoreRoot({
    chainId,
    keystoreAddress: keystore,
    fromBlock,
    readHead: () => client.getBlockNumber(),
    readRoot: (block) => client.readContract({ address: keystore, abi: KEYSTORE_ABI, functionName: 'currentRoot', blockNumber: block }),
    // The copy the grid holds; reading it never sends a request.
    heldRows: async () => {
      try {
        const entrypoint = await resolveConfiguredEntrypoint(chainId);
        const held = await loadPoolLeaves(chainId, entrypoint ? { entrypoint } : undefined);
        const rows = held?.keystoreLeaves;
        return Array.isArray(rows) ? (rows as KeystoreLeafRowLike[]) : null;
      } catch {
        return null;
      }
    },
    getEvents: async (from, to) => {
      const logs = await sweepLogRange({
        from: alignLogScanStart(from, fromBlock),
        to,
        window,
        fetch: (start, end) => client.getLogs({ address: keystore, events: EVENTS, fromBlock: start, toBlock: end }),
      });
      const events: KeystoreEvent[] = [];
      for (const log of logs) {
        const args = log.args as { _newLeaf?: bigint; _root?: bigint; _leafIndex?: bigint };
        if (log.blockNumber == null || log.logIndex == null
          || args._newLeaf === undefined || args._root === undefined || args._leafIndex === undefined) {
          // A log we cannot read is a log we do not have: the rebuild then
          // fails its root check instead of silently skipping it.
          throw new Error('keystore log without decoded fields');
        }
        events.push({
          kind: log.eventName === 'LeafInserted' ? 'inserted' : 'updated',
          leafIndex: args._leafIndex,
          leaf: args._newLeaf,
          root: args._root,
          blockNumber: log.blockNumber,
          logIndex: log.logIndex,
        });
      }
      return events;
    },
    computeRoot: async (leaves) => {
      const { createHashService, createMerkleService } = await import('@/services/sdk-runtime');
      const merkle = createMerkleService(await createHashService());
      return BigInt(await merkle.computeRoot([...leaves]));
    },
    onDecision: (line) => { try { console.log(`[perf] · ${line}`); } catch { /* ignore */ } },
  });
  return verdict.status === 'repaired' ? `repaired:${verdict.tier}` : verdict.status;
}
