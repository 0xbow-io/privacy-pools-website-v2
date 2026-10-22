// EIP-5792 atomic batching for the wallet's own transactions.
//
// One `wallet_sendCalls` with atomic execution replaces "approve, wait, then
// swap": one prompt, and an approval can never outlive a swap that reverted,
// because the wallet runs them as one. MetaMask and Coinbase Wallet do this
// through an EIP-7702 delegation; plain EOAs in wallets such as Rabby do not
// support it, and for them nothing changes.
//
// Support is per wallet AND per chain, so it is asked of the wallet at the
// moment of use (`wallet_getCapabilities`), never assumed from the wallet's
// name. Every "cannot" answer resolves null with nothing sent, and the caller
// falls back to its step-by-step path.

import type { Hex } from '@/services/sdk-types';

export interface BatchCall {
  to: string;
  data: string;
  value?: string | null;
}

export interface BatchedResult {
  /** Hash of the transaction that carried the batch (its last receipt). */
  txHash: Hex | null;
  success: boolean;
}

/** One chain's capabilities, as `wallet_getCapabilities` reports them. */
export type ChainCapabilities = Record<string, unknown> | undefined;

export interface WalletBatchDeps {
  getCapabilities: (chainId: number) => Promise<ChainCapabilities>;
  sendCalls: (args: { chainId: number; calls: BatchCall[] }) => Promise<{ id: string }>;
  /** One status read of the bundle (EIP-5792 `wallet_getCallsStatus`). */
  getCallsStatus: (id: string) => Promise<CallsStatus>;
  /** Waits between status reads; injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface CallsStatus {
  status: string | undefined;
  /** EIP-5792 status code: 1xx pending, 2xx confirmed, 4xx never included (off-chain failure), 5xx/6xx reverted on chain. */
  statusCode?: number;
  receipts?: ReadonlyArray<{ transactionHash?: string; status?: string }>;
}

/** How long a signed bundle is followed before its outcome is reported as unknown. */
export const BATCH_WAIT_MS = 600_000;
const BATCH_POLL_MS = 2_000;

/**
 * Whether this chain's capabilities promise ATOMIC execution. The standard
 * field is `atomic.status` ('supported', or 'ready' when the wallet will first
 * upgrade the account, which it handles inside the same prompt). Require the
 * current atomic capability rather than the draft-era atomicBatch field.
 */
export function supportsAtomicBatch(capabilities: ChainCapabilities): boolean {
  if (!capabilities || typeof capabilities !== 'object') return false;
  const atomic = (capabilities as { atomic?: { status?: unknown } }).atomic;
  if (atomic && (atomic.status === 'supported' || atomic.status === 'ready')) return true;
  return false;
}

/** Raised when the wallet reports the batch was never included on chain: nothing was sent. */
export class BatchNotSubmittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BatchNotSubmittedError';
  }
}

const UNSUPPORTED_CODES = new Set<unknown>([4200, -32601, -32004]);
const UNSUPPORTED_NAMES = new Set<unknown>([
  'UnsupportedProviderMethodError',
  'MethodNotSupportedRpcError',
  'MethodNotFoundRpcError',
]);

/**
 * A wallet answering that it does not implement the method: nothing was sent.
 * viem wraps provider errors (e.g. in TransactionExecutionError), so the whole
 * cause chain is checked, not just the outer error.
 */
function isUnsupportedMethod(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; current && depth < 8; depth++) {
    const { code, name, cause } = current as { code?: unknown; name?: unknown; cause?: unknown };
    if (UNSUPPORTED_CODES.has(code) || UNSUPPORTED_NAMES.has(name)) return true;
    current = cause;
  }
  return false;
}

const isFinal = (status: string | undefined) => status === 'success' || status === 'failure';

/**
 * Send `calls` as one atomic batch and follow it until it is mined. Null,
 * having sent nothing, when the wallet cannot batch atomically on `chainId`.
 * A user rejection or any other failure is thrown, as a single transaction's
 * would be.
 *
 * A bundle has no transaction hash until it is mined, so `onBroadcast` fires
 * the moment the first status read carries one, before the final status is
 * settled. A bundle that never reports a hash within BATCH_WAIT_MS, or that
 * reports success without one, throws: its outcome is unknown, never success.
 */
export async function submitAtomicBatch(
  deps: WalletBatchDeps,
  args: { chainId: number; calls: BatchCall[]; onBroadcast?: (hash: Hex) => void },
): Promise<BatchedResult | null> {
  let capabilities: ChainCapabilities;
  try {
    capabilities = await deps.getCapabilities(args.chainId);
  } catch {
    // Rabby and other wallets without EIP-5792 reject the method itself.
    return null;
  }
  if (!supportsAtomicBatch(capabilities)) return null;

  let id: string;
  try {
    ({ id } = await deps.sendCalls({ chainId: args.chainId, calls: args.calls }));
  } catch (err) {
    if (isUnsupportedMethod(err)) return null;
    throw err;
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let reported: Hex | null = null;
  for (let waited = 0; ; waited += BATCH_POLL_MS) {
    let outcome: CallsStatus | null = null;
    try {
      outcome = await deps.getCallsStatus(id);
    } catch {
      outcome = null; // a failed read is not an outcome; keep following the bundle
    }
    const receipts = outcome?.receipts ?? [];
    const hash = (receipts[receipts.length - 1]?.transactionHash ?? null) as Hex | null;
    if (hash && hash !== reported) {
      reported = hash;
      args.onBroadcast?.(hash);
    }
    if (outcome && isFinal(outcome.status)) {
      // 4xx: the wallet never included the batch and will not retry. Nothing
      // was sent, which is a definitive answer, not an unknown one.
      if (!hash && typeof outcome.statusCode === 'number' && outcome.statusCode >= 400 && outcome.statusCode < 500) {
        throw new BatchNotSubmittedError('The wallet did not submit the wallet batch, so nothing was sent.');
      }
      if (!hash) {
        throw new Error('The wallet reported the wallet batch as finished but gave no transaction hash, so its outcome is unknown. Check your wallet activity before trying again.');
      }
      const success = outcome.status === 'success'
        && receipts.every((receipt) => receipt.status === undefined || receipt.status === 'success');
      return { txHash: hash, success };
    }
    if (waited >= BATCH_WAIT_MS) {
      throw new Error(`The wallet batch was signed but not confirmed in time${reported ? ` (transaction ${reported})` : ''}. Check your wallet activity before trying again.`);
    }
    await sleep(BATCH_POLL_MS);
  }
}
