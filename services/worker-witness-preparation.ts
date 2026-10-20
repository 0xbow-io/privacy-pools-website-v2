import type {
  BuildDepositWitnessInputs,
  BuildRagequitWitnessInputs,
  BuildTransactWitnessInputs,
  DepositCircuitInputs,
  IWitnessPreparationService,
  RagequitWitness,
  TransactCircuitInputs,
} from "@privacy-pools-v2/sdk";

// IWitnessPreparationService backed by a Web Worker so the SDK's
// pre-proof Poseidon hashing (nullifiers + output commitments + three
// merkle proofs per input note) doesn't block the UI thread. Falls
// back to the supplied in-thread implementation if Worker is
// unavailable (native, SSR) or the worker crashes — proof-side
// failures (bad inputs) propagate so we don't pay for a guaranteed-bad
// witness twice.

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

// ONE worker per page, shared by every instance. A pool session is built on
// every chain switch, sign-in and cross-chain leg, and each used to get its own
// worker with its own WebAssembly Poseidon that nothing ever terminated. A long
// QA session ran the tab out of WebAssembly memory ("Failed to initialize
// Poseidon hash service: WebAssembly.Memory(): could not allocate memory",
// Mike 2026-10-13) and every deposit failed until a reload. The worker holds no
// session state (each message carries its inputs), the same reason the Groth16
// prover is a page singleton in services/sdk-setup.ts.
const shared: {
  worker: Worker | null;
  nextId: number;
  pending: Map<number, PendingResolver>;
  // Serialize to keep memory bounded: one large merkle tree build at a time is
  // enough, and concurrent builds in the same worker would multiply the working
  // set with no throughput win. Shared, because the worker is.
  chain: Promise<unknown>;
} = { worker: null, nextId: 1, pending: new Map(), chain: Promise.resolve() };

function getWorker(): Worker | null {
  if (shared.worker) return shared.worker;
  if (typeof Worker === "undefined" || typeof window === "undefined") return null;
  try {
    // Pre-bundled by scripts/build-witness-worker.mjs into
    // public/witness-worker.js. Same rationale as the snarkjs worker:
    // Metro doesn't bundle `new Worker(new URL(import.meta.url))` so
    // we ship a self-contained classic worker out of public/.
    const worker = new Worker("/witness-worker.js");
    shared.worker = worker;
    worker.addEventListener("message", (event: MessageEvent) => {
      const data = event.data as { id: number; ok: boolean; result?: unknown; error?: string };
      const pending = shared.pending.get(data.id);
      if (!pending) return;
      shared.pending.delete(data.id);
      if (data.ok) pending.resolve(data.result);
      else pending.reject(new Error(data.error || "Worker error"));
    });
    worker.addEventListener("error", (event: ErrorEvent) => {
      const err = new WorkerUnavailable(event.message || "Worker crashed");
      for (const [id, p] of shared.pending) {
        shared.pending.delete(id);
        p.reject(err);
      }
      if (shared.worker === worker) shared.worker = null;
    });
  } catch (err) {
    console.warn("[WorkerWitnessPreparationService] Worker construction failed:", err);
    shared.worker = null;
  }
  return shared.worker;
}

/**
 * A request the worker never answers (a hang that fires no `error` event) must
 * not hold the page-wide queue forever: past this it is treated as a dead
 * worker, which is replaced, and the build falls back to the main thread. Far
 * above a real witness build (seconds, even for multi-input transacts).
 */
export const WITNESS_WORKER_TIMEOUT_MS = 120_000;

function send<T>(message: object, timeoutMs = WITNESS_WORKER_TIMEOUT_MS): Promise<T> {
  const worker = getWorker();
  if (!worker) return Promise.reject(new WorkerUnavailable("Worker unavailable"));
  const id = shared.nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!shared.pending.has(id)) return;
      shared.pending.delete(id);
      if (shared.worker === worker) resetSharedWitnessWorker();
      reject(new WorkerUnavailable(`Witness worker did not answer within ${timeoutMs} ms`));
    }, timeoutMs);
    shared.pending.set(id, {
      resolve: (v) => { clearTimeout(timer); (resolve as (v: unknown) => void)(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    worker.postMessage({ ...message, id });
  });
}

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const next = shared.chain.then(task, task);
  shared.chain = next.catch(() => undefined);
  return next;
}

/** Test seam and HMR: drop the shared worker so the next call starts a fresh one. */
export function resetSharedWitnessWorker(): void {
  shared.worker?.terminate();
  shared.worker = null;
  for (const [id, p] of shared.pending) {
    shared.pending.delete(id);
    p.reject(new WorkerUnavailable("Witness preparer disposed"));
  }
}

export class WorkerWitnessPreparationService implements IWitnessPreparationService {
  private readonly fallback: IWitnessPreparationService;
  private readonly timeoutMs: number;

  constructor(fallback: IWitnessPreparationService, opts: { timeoutMs?: number } = {}) {
    this.fallback = fallback;
    this.timeoutMs = opts.timeoutMs ?? WITNESS_WORKER_TIMEOUT_MS;
  }

  buildDepositWitness(inputs: BuildDepositWitnessInputs): Promise<DepositCircuitInputs> {
    return this.run("buildDepositWitness", inputs, () => this.fallback.buildDepositWitness(inputs));
  }

  buildTransactWitness(inputs: BuildTransactWitnessInputs): Promise<TransactCircuitInputs> {
    return this.run("buildTransactWitness", inputs, () => this.fallback.buildTransactWitness(inputs));
  }

  buildRagequitWitness(inputs: BuildRagequitWitnessInputs): Promise<RagequitWitness> {
    return this.run("buildRagequitWitness", inputs, () => this.fallback.buildRagequitWitness(inputs));
  }

  private run<T>(type: string, inputs: unknown, fallbackFn: () => Promise<T>): Promise<T> {
    return enqueue(async () => {
      try {
        return await send<T>({ type, inputs }, this.timeoutMs);
      } catch (err) {
        if (err instanceof WorkerUnavailable) {
          console.warn(`[WorkerWitnessPreparationService] ${type} fell back to main thread:`, err);
          return fallbackFn();
        }
        throw err;
      }
    });
  }

  /**
   * The worker is shared by every session on the page, so one session going
   * away must not terminate it for the others. Kept for callers of the old API.
   */
  dispose(): void {}
}

// Fast Refresh / HMR: terminate the previous module's worker before the
// replacement module starts a new one. A no-op in production builds.
declare const module: { hot?: { dispose?: (cb: () => void) => void } };
if (typeof module !== "undefined" && module.hot && typeof module.hot.dispose === "function") {
  module.hot.dispose(() => resetSharedWitnessWorker());
}
