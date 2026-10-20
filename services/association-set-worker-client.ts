import type { DEPLOYMENTS, Hash } from '@privacy-pools-v2/sdk';
import type { AssociationSetReads } from './association-set-verifier';

export class AssociationSetWorkerUnavailable extends Error {}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  read?: AssociationSetReads;
};

/** Keeps networking and the shared public cache on the main thread. */
export class AssociationSetWorkerClient {
  private worker: Worker | undefined;
  private nextId = 0;
  private pending = new Map<number, Pending>();

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    try {
      this.worker = new Worker('/association-set-worker.js');
    } catch (error) {
      throw new AssociationSetWorkerUnavailable(String(error));
    }
    const worker = this.worker;
    const failed = () => { if (this.worker === worker) this.dispose(); };
    worker.addEventListener('error', failed);
    worker.addEventListener('messageerror', failed);
    worker.addEventListener('message', async (event: MessageEvent) => {
      const { id, read, result, error } = event.data as {
        id: number; read?: 'leaves' | 'root'; result?: unknown; error?: string;
      };
      const pending = this.pending.get(id);
      if (!pending) return;
      if (read && pending.read) {
        try {
          const value = await pending.read[read]();
          worker.postMessage({ id, type: 'read', value });
        } catch (cause) {
          worker.postMessage({ id, type: 'read', error: cause instanceof Error ? cause.message : String(cause) });
        }
      } else {
        this.pending.delete(id);
        if (error !== undefined) pending.reject(new Error(error));
        else pending.resolve(result);
      }
    });
    return worker;
  }

  private request<T>(message: object, read?: AssociationSetReads): Promise<T> {
    return new Promise((resolve, reject) => {
      const worker = this.getWorker();
      const id = this.nextId++;
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, read });
      try {
        worker.postMessage({ ...message, id });
      } catch (error) {
        this.pending.delete(id);
        reject(new AssociationSetWorkerUnavailable(String(error)));
      }
    });
  }

  deployment(chainId: number): Promise<(typeof DEPLOYMENTS)[number] | undefined> {
    return this.request({ type: 'deployment', chainId });
  }

  verify(read: AssociationSetReads, legacy: boolean): Promise<Hash[]> {
    return this.request({ type: 'verify', legacy }, read);
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = undefined;
    for (const pending of this.pending.values()) {
      pending.reject(new AssociationSetWorkerUnavailable('Association-set worker unavailable'));
    }
    this.pending.clear();
  }
}
