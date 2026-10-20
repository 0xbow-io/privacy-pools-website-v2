import type { Groth16Proof, PublicSignals } from "snarkjs";
import type { CircuitInputs, IGroth16Prover, VerificationKey } from "@privacy-pools-v2/sdk";
import { Groth16Prover } from "@privacy-pools-v2/sdk";

// IGroth16Prover backed by a Web Worker so snarkjs proof generation
// doesn't block the main thread. On platforms without `Worker` support
// (native, SSR), falls through to the in-thread Groth16Prover. Falls
// back to the in-thread prover ONLY when the worker is unavailable
// (construction failed or it crashed) — proof-side failures (bad
// inputs, mismatched circuit, etc.) propagate to the caller so we
// don't pay the cost of a guaranteed-bad proof twice.

class WorkerUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerUnavailable";
  }
}

type PendingResolver = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class WorkerGroth16Prover implements IGroth16Prover {
  private worker: Worker | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingResolver>();
  private readonly fallback = new Groth16Prover();
  // Serialize fullProve/verify across the single worker — overlapping
  // snarkjs.fullProve calls inside one worker each spin up their own
  // ffjavascript thread pool, multiplying nested workers and CPU/RAM
  // load. One proof at a time keeps the working set bounded.
  private chain: Promise<unknown> = Promise.resolve();

  private getWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === "undefined" || typeof window === "undefined") return null;
    try {
      // Static-asset URL served out of public/snarkjs-worker.js — Metro
      // doesn't bundle `new Worker(new URL(import.meta.url))` the way
      // webpack does, so we pre-build the worker via
      // `bun run build:worker` and load it as a classic script.
      this.worker = new Worker("/snarkjs-worker.js");
      this.worker.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as { id: number; ok: boolean; result?: unknown; error?: string };
        const pending = this.pending.get(data.id);
        if (!pending) return;
        this.pending.delete(data.id);
        if (data.ok) pending.resolve(data.result);
        else pending.reject(new Error(data.error || "Worker error"));
      });
      this.worker.addEventListener("error", (event: ErrorEvent) => {
        // Reject every in-flight request as WorkerUnavailable so the
        // outer fullProve catches it and falls back to in-thread.
        const err = new WorkerUnavailable(event.message || "Worker crashed");
        for (const [id, p] of this.pending) {
          this.pending.delete(id);
          p.reject(err);
        }
        this.worker = null;
      });
    } catch (err) {
      console.warn("[WorkerGroth16Prover] Worker construction failed:", err);
      this.worker = null;
    }
    return this.worker;
  }

  private send<T>(message: object): Promise<T> {
    const worker = this.getWorker();
    if (!worker) return Promise.reject(new WorkerUnavailable("Worker unavailable"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      worker.postMessage({ ...message, id });
    });
  }

  // Run `task` only after the previous queued task has settled, so
  // overlapping callers don't oversubscribe snarkjs's nested workers.
  // The chain swallows errors so a failed task doesn't poison the queue.
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.chain.then(task, task);
    this.chain = next.catch(() => undefined);
    return next;
  }

  fullProve(
    input: CircuitInputs,
    wasm: Uint8Array,
    provingKey: Uint8Array,
  ): Promise<{ proof: Groth16Proof; publicSignals: PublicSignals }> {
    return this.enqueue(async () => {
      try {
        return await this.send<{ proof: Groth16Proof; publicSignals: PublicSignals }>({
          type: "fullProve",
          input,
          wasm,
          provingKey,
        });
      } catch (err) {
        if (err instanceof WorkerUnavailable) {
          console.warn("[WorkerGroth16Prover] fullProve fell back to main thread:", err);
          return this.fallback.fullProve(input, wasm, provingKey);
        }
        throw err;
      }
    });
  }

  verify(
    verificationKey: VerificationKey,
    publicSignals: PublicSignals,
    proof: Groth16Proof,
  ): Promise<boolean> {
    return this.enqueue(async () => {
      try {
        return await this.send<boolean>({
          type: "verify",
          verificationKey,
          publicSignals,
          proof,
        });
      } catch (err) {
        if (err instanceof WorkerUnavailable) {
          return this.fallback.verify(verificationKey, publicSignals, proof);
        }
        throw err;
      }
    });
  }

  // Free the worker — used by sdk-setup's HMR dispose to avoid orphaning
  // workers across Fast Refresh in dev.
  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new WorkerUnavailable("Prover disposed"));
    }
  }
}
