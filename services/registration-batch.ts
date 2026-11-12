import { toHex } from 'viem';
import { withSessionInitTimeout } from '@/services/session-init-timeout';
import { BatchNotSubmittedError, isUnsupportedMethod, submitAtomicBatch, type BatchCall, type BatchedResult, type WalletBatchDeps } from '@/services/wallet-batch';

const pending = new Map<string, string>();
const running = new Map<string, Promise<BatchedResult | null>>();
const keyFor = (owner: string, chainId: number) => `pp:registration-batch:${chainId}:${owner.toLowerCase()}`;

function read(key: string): string | undefined {
  try { return pending.get(key) ?? sessionStorage.getItem(key) ?? undefined; }
  catch { return pending.get(key); }
}

function save(key: string, id?: string): void {
  if (id) pending.set(key, id);
  else pending.delete(key);
  try {
    if (id) sessionStorage.setItem(key, id);
    else sessionStorage.removeItem(key);
  } catch { /* Keep recovery in memory when browser storage is unavailable. */ }
}

export function hasPendingRegistrationBatch(owner: string | undefined, chainId: number): boolean {
  return !!owner && !!read(keyFor(owner, chainId));
}

export function clearRegistrationBatch(owner: string, chainId: number): void {
  save(keyFor(owner, chainId));
}

function refusalCode(error: unknown): number | undefined {
  let current = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const e = current as { code?: number; cause?: unknown };
    if (typeof e.code === 'number') return e.code;
    current = e.cause;
  }
}

export class RegistrationBatchPendingError extends Error {
  constructor(cause: unknown) {
    super('Registration confirmation is unavailable. Check your wallet, reconnect if needed, then retry to check its status.', { cause });
    this.name = 'RegistrationBatchPendingError';
  }
}

/** A retry follows the saved batch, including when the wallet lost the send response. */
export function submitRegistrationBatch(
  deps: WalletBatchDeps,
  args: {
    owner: string;
    chainId: number;
    calls: BatchCall[];
    beforeSend: () => void;
    onAwaitingWallet?: (waiting: boolean) => void;
    promptTimeoutMs?: number;
  },
): Promise<BatchedResult | null> {
  const key = keyFor(args.owner, args.chainId);
  const active = running.get(key);
  if (active) return active;
  const run = async () => {
    const resumeId = read(key);
    // Finish setup has only one call and keeps the existing transaction path.
    if (!resumeId && args.calls.length !== 2) return null;
    try {
      const result = await submitAtomicBatch({
        ...deps,
        getCapabilities: (chainId) => withSessionInitTimeout(deps.getCapabilities(chainId), { timeoutMs: 3_000 }),
        sendCalls: async (request) => {
          args.beforeSend();
          // EIP-5792 requires wallets to honor app-provided IDs. Save before
          // requesting approval so a lost response cannot cause a second send.
          const id = toHex(crypto.getRandomValues(new Uint8Array(32)));
          save(key, id);
          args.onAwaitingWallet?.(true);
          try {
            const submitted = deps.sendCalls({ ...request, id }).then((answer) => {
              if (!answer.id) throw new Error('The wallet returned no registration batch ID.');
              if (read(key) === id) save(key, answer.id);
              return answer;
            }).catch((error: unknown) => {
              // These responses reject the request before execution. Transport
              // errors and duplicate IDs leave its outcome unresolved.
              if (read(key) === id && (isUnsupportedMethod(error) || [4001, 4100, -32602, 5700, 5710, 5740, 5750, 5760].includes(refusalCode(error) ?? 0))) save(key);
              throw error;
            });
            return await withSessionInitTimeout(submitted, { timeoutMs: args.promptTimeoutMs ?? 120_000 });
          } finally {
            args.onAwaitingWallet?.(false);
          }
        },
        getCallsStatus: (id) => withSessionInitTimeout(deps.getCallsStatus(id), { timeoutMs: 10_000 }),
      }, { chainId: args.chainId, calls: args.calls, resumeId });
      save(key);
      return result;
    } catch (error) {
      if (error instanceof BatchNotSubmittedError) save(key);
      if (read(key)) throw new RegistrationBatchPendingError(error);
      if (refusalCode(error) === 5760) return null;
      throw error;
    }
  };
  const promise = run().finally(() => { running.delete(key); });
  running.set(key, promise);
  return promise;
}
