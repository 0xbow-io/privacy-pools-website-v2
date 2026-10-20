import { DEPLOYMENTS } from '@privacy-pools-v2/sdk';
import type { Hash } from '@privacy-pools-v2/sdk';
import { verifyAssociationSet } from './association-set-verifier';

type Message =
  | { id: number; type: 'deployment'; chainId: number }
  | { id: number; type: 'verify'; legacy: boolean }
  | { id: number; type: 'read'; value?: Hash[] | Hash; error?: string };

// One outstanding read per verification: the SDK fetches leaves, hashes, then
// reads the registry. Different verification requests have independent IDs.
const reads = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
function read<T>(id: number, kind: 'leaves' | 'root'): Promise<T> {
  return new Promise((resolve, reject) => {
    reads.set(id, { resolve: resolve as (value: unknown) => void, reject });
    self.postMessage({ id, read: kind });
  });
}

self.addEventListener('message', async (event: MessageEvent<Message>) => {
  const msg = event.data;
  if (msg.type === 'read') {
    const pending = reads.get(msg.id);
    reads.delete(msg.id);
    if (msg.error !== undefined) pending?.reject(new Error(msg.error));
    else pending?.resolve(msg.value);
    return;
  }
  try {
    const result = msg.type === 'deployment' ? DEPLOYMENTS[msg.chainId] : await verifyAssociationSet({
      leaves: () => read<Hash[]>(msg.id, 'leaves'),
      root: () => read<Hash>(msg.id, 'root'),
    }, msg.legacy);
    self.postMessage({ id: msg.id, result });
  } catch (error) {
    self.postMessage({ id: msg.id, error: error instanceof Error ? error.message : String(error) });
  }
});
