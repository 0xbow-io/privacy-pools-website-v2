// Complete public event sweeps only. This module has no account-keyed reader
// and no UI entry point. Partial or failed sweeps never authorize a miss.
import { alignLogScanStart } from '@/services/log-scan-alignment';
export const BULK_REGISTRY_MAX_AGE_MS = 11 * 60_000;
export const BULK_REGISTRY_PAGE_BUDGET = 8;
export type RegistryEvent = {
  kind: 'auth' | 'viewing'; account: string; value: string;
  blockNumber: bigint; logIndex: number;
};
type Snapshot = { hashes: Record<string, string>; viewing: Record<string, string>; at: number };
type Checkpoint = { hashes: Record<string, string>; viewing: Record<string, string>; from: bigint; head: bigint; headHash: string };
type Sweep = Snapshot & { next: bigint; head: bigint; headHash: string; resumeAt: bigint; checkpoint?: Checkpoint; previous?: Checkpoint };
const snapshots = new Map<string, Snapshot>();
const sweeps = new Map<string, Sweep>();
const completed = new Map<string, Checkpoint>();
const running = new Map<string, Promise<boolean>>();
const scope = (chain: number, keystore: string) => `${chain}:${keystore.toLowerCase()}`;
export function readBulkRegistry(chain: number, keystore?: string, now = Date.now()): Snapshot | null {
  const held = keystore ? snapshots.get(scope(chain, keystore)) : undefined;
  return held && now >= held.at && now - held.at <= BULK_REGISTRY_MAX_AGE_MS ? held : null;
}
export interface BulkRegistryReads {
  head(): Promise<bigint>;
  blockHash(block: bigint): Promise<string>;
  events(from: bigint, to: bigint): Promise<RegistryEvent[]>;
}
/** Called only on the fixed feed grid. Inputs are deployment configuration. */
export function sweepBulkRegistry(chain: number, keystore: string, deployment: bigint, window: bigint, reads: BulkRegistryReads): Promise<boolean> {
  const key = scope(chain, keystore);
  const active = running.get(key);
  if (active) return active;
  const task = (async () => {
    try {
      if (window <= 0n || deployment < 0n) throw new Error('Invalid log range configuration');
      let sweep = sweeps.get(key);
      if (!sweep) {
        const head = await reads.head();
        if (head < deployment) throw new Error('Keystore deployment is ahead of chain');
        const previous = completed.get(key);
        const reusable = previous && head >= previous.head && await reads.blockHash(previous.head) === previous.headHash ? previous : undefined;
        if (previous && !reusable) snapshots.delete(key);
        sweep = { hashes: { ...reusable?.hashes }, viewing: { ...reusable?.viewing }, at: Date.now(), next: reusable?.from ?? deployment, head, headHash: await reads.blockHash(head), resumeAt: alignLogScanStart(head, deployment), previous: reusable };
        sweeps.set(key, sweep);
      }
      for (let page = 0; page < BULK_REGISTRY_PAGE_BUDGET && sweep.next <= sweep.head; page++) {
        const from = sweep.next;
        if (from === sweep.resumeAt) sweep.checkpoint = { hashes: { ...sweep.hashes }, viewing: { ...sweep.viewing }, from, head: sweep.head, headHash: sweep.headHash };
        let to = from + window - 1n < sweep.head ? from + window - 1n : sweep.head;
        if (from < sweep.resumeAt && to >= sweep.resumeAt) to = sweep.resumeAt - 1n;
        const events = await reads.events(from, to);
        events.sort((a, b) => a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1);
        for (const event of events) {
          if (!/^0x[0-9a-f]{40}$/i.test(event.account) || !/^0x[0-9a-f]{64}$/i.test(event.value)
            || event.blockNumber < from || event.blockNumber > to || !Number.isSafeInteger(event.logIndex) || event.logIndex < 0) throw new Error('Malformed keystore event');
          const account = event.account.toLowerCase();
          const value = event.value.toLowerCase();
          if (event.kind === 'auth') {
            if (BigInt(value) === 0n) throw new Error('Zero auth policy hash');
            sweep.hashes[account] = value;
          } else if (event.kind === 'viewing') {
            if (BigInt(value) === 0n) delete sweep.viewing[account];
            else sweep.viewing[account] = value;
          } else throw new Error('Unknown keystore event');
        }
        sweep.next = to + 1n;
      }
      if (sweep.next <= sweep.head) return false;
      // Detect reorgs across a multi-tick sweep before exposing any answer.
      if (await reads.blockHash(sweep.head) !== sweep.headHash) throw new Error('Keystore sweep reorganized');
      if (sweep.previous && await reads.blockHash(sweep.previous.head) !== sweep.previous.headHash) throw new Error('Keystore checkpoint reorganized');
      if (!sweep.checkpoint) throw new Error('Keystore sweep lacks aligned checkpoint');
      snapshots.set(key, { hashes: sweep.hashes, viewing: sweep.viewing, at: sweep.at });
      completed.set(key, sweep.checkpoint);
      sweeps.delete(key);
      return readBulkRegistry(chain, keystore) !== null;
    } catch (error) {
      sweeps.delete(key);
      snapshots.delete(key);
      completed.delete(key);
      throw error;
    }
  })();
  running.set(key, task);
  void task.finally(() => running.delete(key)).catch(() => undefined);
  return task;
}
export function resetBulkRegistriesForTests(): void { snapshots.clear(); sweeps.clear(); completed.clear(); running.clear(); }
