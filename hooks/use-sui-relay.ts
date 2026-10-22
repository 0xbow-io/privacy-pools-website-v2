/**
 * Sui relay hook — SAFE relayed-withdrawal flow for the Sui chain.
 *
 * This replaces the prior unsafe raw-fetch path (10a TODO) with a browser-safe
 * port of the SDK's `RelayerClient` + `RelayWithdrawBuilder` (relay-safety):
 *
 *   - fetch `/v1/details` + `/v1/quote/withdrawal` with a FETCH TIMEOUT (a hung
 *     relayer must not block the user); no HTTP caching of quotes (`no-store`).
 *   - VALIDATE the quote BEFORE binding it into a proof: required fields present
 *     + well-typed, signed `feeCommitment` present, asset matches, top-level fee
 *     == signed fee, fee <= u64 max, fee <= amount, and the commitment is live
 *     (ms `expiresAt`, `<=` rejects now). A bad/stale quote fails CLOSED.
 *   - the CALLER (use-sui-session.transferOrWithdraw-style flow) binds
 *     processor = relayer signer + processor_data =
 *     encodePayoutRouting(recipient, feeRecipient, feeAmount) into the proof
 *     context, then this hook POSTs `/v1/relay/withdrawal`.
 *
 * Field/encoding semantics mirror sdk/src/relayer-client.mjs +
 * relay-withdraw-builder.mjs (the proven-live reference) exactly.
 */
import { useState, useCallback } from 'react';
import { encodePayoutRouting } from '@/services/sui-witness/crypto';
import { friendlyError } from '@/services/sui-witness/abort-codes';
import { routedFetch } from '@/services/tor-fetch';

/**
 * Re-export the 72-byte PayoutRouting encoder (recipient(32) || feeRecipient(32)
 * || feeAmount(8, u64 LE)) so the relayed-withdraw flow can bind
 * processor_data into the proof context. Matches sources/relay.move::encode_payout
 * + sdk/src/relay.mjs. The relay path sets processor = the relayer signer
 * address and processor_data = encodePayoutRouting(...), so the on-chain
 * relay::relay_withdrawal recomputes the identical context.
 */
export { encodePayoutRouting };

export type RelayStatus = 'idle' | 'quoting' | 'proving' | 'relaying' | 'success' | 'error';

/** Max u64 — the on-chain fee field width. A fee above this cannot be encoded. */
const U64_MAX = (1n << 64n) - 1n;
/** Default per-request fetch timeout (ms). A hung relayer must not block. */
const DEFAULT_TIMEOUT_MS = 30_000;

export interface SignedFeeCommitment {
  asset: string;
  feeAmount: string;
  expiresAt: number;
  relayer: string;
  signature: string;
}

export interface FeeQuote {
  gasCost?: string;
  gasPrice?: string;
  feeAmount: string;
  amountReceived?: string;
  feeCommitment?: SignedFeeCommitment;
}

/** Relayer self-description (`/v1/details`): the signer + fee-receiver address. */
export interface RelayerDetails {
  /** Relayer signer / processor address (bound into the proof context). */
  relayerAddress: string;
  /** Fee receiver address (bound into PayoutRouting). Often == relayerAddress. */
  feeRecipient: string;
  [k: string]: unknown;
}

export interface RelayResult {
  txDigest: string;
  feeAmount: string;
  amountReceived: string;
}

/** A validated quote: the raw quote plus the cross-checked signed commitment. */
export interface ValidatedQuote {
  quote: FeeQuote;
  commitment: SignedFeeCommitment;
  feeAmount: bigint;
}

interface SubmitRelayParams {
  relayerUrl: string;
  proofBytes: string;
  n: number;
  m: number;
  nullifierHashes: string[];
  outputCommitments: string[];
  stateRoot: string;
  keystoreRoot: string;
  aspRoot: string;
  amountOut: string;
  tokenIdOut: string;
  gvkX?: string;
  gvkY?: string;
  ciphertext?: string[];
  coinType: string;
  recipient: string;
  feeAmount: string;
  noteHints: string[];
  noteData: string[];
  feeCommitment?: SignedFeeCommitment;
}

interface UseRelayReturn {
  status: RelayStatus;
  error: string | null;
  quote: FeeQuote | null;
  details: RelayerDetails | null;
  result: RelayResult | null;
  /** Read `/v1/details` (relayer signer + fee receiver). */
  getDetails: (relayerUrl: string) => Promise<RelayerDetails | null>;
  /** Fetch a quote (with timeout) and VALIDATE it. Returns the validated quote. */
  getValidatedQuote: (params: {
    relayerUrl: string;
    asset: string;
    amount: string;
    maxFeeAmount?: bigint;
  }) => Promise<ValidatedQuote | null>;
  /** Submit a context-bound relayed withdrawal (re-checks liveness first). */
  submitRelay: (params: SubmitRelayParams) => Promise<RelayResult | null>;
  reset: () => void;
}

/** Quote validation failure (fails CLOSED — never binds a bad quote). */
export class RelayQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayQuoteError';
  }
}

/** POST with a bounded abort timeout + no-store cache. Mirrors RelayerClient.#post. */
async function postJson<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
  const controller =
    timeoutMs > 0 && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let resp: Response;
  try {
    resp = await routedFetch('relayer')(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller?.signal,
      cache: 'no-store',
    });
  } catch (err) {
    const reason = controller?.signal?.aborted
      ? `request timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new Error(`relayer request failed: ${reason}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await resp.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const e = (data as { error?: string })?.error ?? text;
    throw new Error(`relayer ${resp.status}: ${e}`);
  }
  return data as T;
}

/** GET with a bounded abort timeout + no-store cache. */
async function getJson<T>(url: string, timeoutMs: number): Promise<T> {
  const controller =
    timeoutMs > 0 && typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let resp: Response;
  try {
    resp = await routedFetch('relayer')(url, { method: 'GET', cache: 'no-store', signal: controller?.signal });
  } catch (err) {
    const reason = controller?.signal?.aborted
      ? `request timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    throw new Error(`relayer request failed: ${reason}`);
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await resp.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!resp.ok) {
    const e = (data as { error?: string })?.error ?? text;
    throw new Error(`relayer ${resp.status}: ${e}`);
  }
  return data as T;
}

function assertIntegerString(value: unknown, name: string): void {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new RelayQuoteError(`${name} is not a non-negative integer string: ${String(value)}`);
  }
}

/**
 * Validate a quote DTO + its signed commitment against caller intent, and derive
 * the fee. Faithful port of RelayWithdrawBuilder.#validateQuote +
 * #assertCommitmentLive + #assertFeeNotExceedingAmount + #assertFeeWithinMax.
 * Runs BEFORE any proof work; throws (fails CLOSED) on any mismatch.
 */
export function validateQuote(
  quote: FeeQuote,
  opts: { amount: bigint; asset: string; maxFeeAmount?: bigint },
): ValidatedQuote {
  if (quote == null || typeof quote !== 'object') {
    throw new RelayQuoteError('Relayer returned a non-object quote');
  }
  assertIntegerString(quote.feeAmount, 'quote.feeAmount');

  const commitment = quote.feeCommitment;
  if (commitment == null || typeof commitment !== 'object') {
    throw new RelayQuoteError('Relayer returned no signed fee commitment (request commit:true)');
  }
  assertIntegerString(commitment.feeAmount, 'feeCommitment.feeAmount');
  if (typeof commitment.asset !== 'string' || commitment.asset.length === 0) {
    throw new RelayQuoteError('feeCommitment.asset is missing or not a string');
  }
  if (typeof commitment.expiresAt !== 'number' || !Number.isFinite(commitment.expiresAt)) {
    throw new RelayQuoteError('feeCommitment.expiresAt is missing or not a finite number');
  }
  if (typeof commitment.signature !== 'string' || commitment.signature.length === 0) {
    throw new RelayQuoteError('feeCommitment.signature is missing or malformed');
  }
  if (typeof commitment.relayer !== 'string' || commitment.relayer.length === 0) {
    throw new RelayQuoteError('feeCommitment.relayer is missing or not a string');
  }
  if (commitment.asset !== opts.asset) {
    throw new RelayQuoteError(
      `Relayer commitment asset ${commitment.asset} does not match caller asset ${opts.asset}`,
    );
  }
  if (quote.feeAmount !== commitment.feeAmount) {
    throw new RelayQuoteError(
      `Quote feeAmount ${quote.feeAmount} does not match signed commitment feeAmount ${commitment.feeAmount}`,
    );
  }
  const fee = BigInt(commitment.feeAmount);
  if (fee > U64_MAX) throw new RelayQuoteError(`Signed fee ${fee} exceeds u64 max`);
  if (fee > opts.amount) {
    throw new RelayQuoteError(`Signed fee ${fee} exceeds withdrawal amount ${opts.amount}`);
  }
  if (opts.maxFeeAmount != null && fee > opts.maxFeeAmount) {
    throw new RelayQuoteError(`Relayer fee ${fee} exceeds caller maxFeeAmount ${opts.maxFeeAmount}`);
  }
  // Liveness: ms expiresAt, `<=` rejects exactly-now (matches EVM/Stellar).
  if (commitment.expiresAt <= Date.now()) {
    throw new RelayQuoteError(`fee commitment expired (expiresAt=${commitment.expiresAt})`);
  }
  return { quote, commitment, feeAmount: fee };
}

export function useSuiRelay(): UseRelayReturn {
  const [status, setStatus] = useState<RelayStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [quote, setQuote] = useState<FeeQuote | null>(null);
  const [details, setDetails] = useState<RelayerDetails | null>(null);
  const [result, setResult] = useState<RelayResult | null>(null);

  const getDetails = useCallback(async (relayerUrl: string): Promise<RelayerDetails | null> => {
    try {
      const base = relayerUrl.replace(/\/+$/, '');
      const d = await getJson<RelayerDetails>(`${base}/v1/details`, DEFAULT_TIMEOUT_MS);
      setDetails(d);
      return d;
    } catch (err) {
      setError(friendlyError(err));
      setStatus('error');
      return null;
    }
  }, []);

  const getValidatedQuote = useCallback(
    async (params: {
      relayerUrl: string;
      asset: string;
      amount: string;
      maxFeeAmount?: bigint;
    }): Promise<ValidatedQuote | null> => {
      try {
        setStatus('quoting');
        setError(null);
        const base = params.relayerUrl.replace(/\/+$/, '');
        const raw = await postJson<FeeQuote>(
          `${base}/v1/quote/withdrawal`,
          { asset: params.asset, amount: params.amount, commit: true },
          DEFAULT_TIMEOUT_MS,
        );
        // Validate BEFORE the caller binds it into a proof (fails CLOSED).
        const validated = validateQuote(raw, {
          amount: BigInt(params.amount),
          asset: params.asset,
          maxFeeAmount: params.maxFeeAmount,
        });
        setQuote(raw);
        setStatus('idle');
        return validated;
      } catch (err) {
        setError(friendlyError(err));
        setStatus('error');
        return null;
      }
    },
    [],
  );

  const submitRelay = useCallback(async (params: SubmitRelayParams): Promise<RelayResult | null> => {
    try {
      setStatus('relaying');
      setError(null);
      // Final liveness pre-flight before the network call (mirrors
      // RelayerClient.#assertFeeCommitmentLive — re-check after proving time).
      if (params.feeCommitment) {
        if (
          typeof params.feeCommitment.expiresAt !== 'number' ||
          params.feeCommitment.expiresAt <= Date.now()
        ) {
          throw new RelayQuoteError('fee commitment expired before submit');
        }
      }
      const base = params.relayerUrl.replace(/\/+$/, '');
      const relayResult = await postJson<{ txDigest: string; success?: boolean; error?: string }>(
        `${base}/v1/relay/withdrawal`,
        {
          proofBytes: params.proofBytes,
          n: params.n,
          m: params.m,
          nullifierHashes: params.nullifierHashes,
          outputCommitments: params.outputCommitments,
          stateRoot: params.stateRoot,
          keystoreRoot: params.keystoreRoot,
          aspRoot: params.aspRoot,
          amountOut: params.amountOut,
          tokenIdOut: params.tokenIdOut,
          gvkX: params.gvkX ?? '0',
          gvkY: params.gvkY ?? '0',
          ciphertext: params.ciphertext ?? [],
          coinType: params.coinType,
          recipient: params.recipient,
          feeAmount: params.feeAmount,
          noteHints: params.noteHints,
          noteData: params.noteData,
          feeCommitment: params.feeCommitment,
        },
        DEFAULT_TIMEOUT_MS,
      );
      if (relayResult.success === false) {
        throw new Error(relayResult.error || 'relay failed');
      }
      // A malformed "success" body (missing/empty txDigest) must NOT be
      // treated as a submitted transaction — callers mark local notes spent
      // off this digest, so fail CLOSED with the raw body for diagnosis.
      if (typeof relayResult.txDigest !== 'string' || relayResult.txDigest.length === 0) {
        throw new Error(
          `relayer returned success without a txDigest: ${JSON.stringify(relayResult).slice(0, 200)}`,
        );
      }
      const r: RelayResult = {
        txDigest: relayResult.txDigest,
        feeAmount: params.feeAmount,
        amountReceived: (BigInt(params.amountOut) - BigInt(params.feeAmount)).toString(),
      };
      setResult(r);
      setStatus('success');
      return r;
    } catch (err) {
      setError(friendlyError(err));
      setStatus('error');
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
    setQuote(null);
    setDetails(null);
    setResult(null);
  }, []);

  return { status, error, quote, details, result, getDetails, getValidatedQuote, submitRelay, reset };
}
