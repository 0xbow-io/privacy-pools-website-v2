// Pure shaping for the Payment Requests list widget: flattens the stored
// SDK-native (V3) records plus the legacy V1 device store into display rows,
// rebuilds shareable /pay links from stored records, and derives the
// re-issue prefill for rows whose link cannot be rebuilt.
//
// Deliberately dependency-injected for token/chain metadata (config/* pulls
// react-native through pool-profile) so bun tests can exercise everything
// here directly; the card passes getTokenMetadata/getChainConfig.

import { formatUnits } from 'viem';

import {
  encodePaymentRequestPayloadForUrl,
  SHARED_NOTE_SECRET_PLACEHOLDER,
  type PaymentRequestPayloadV1,
  type PaymentRequestPayloadV3,
} from '@/services/payment-request-codec';
import type { Address, Hash, Hex, Secret } from '@/services/sdk-types';

/** Structural mirror of the SDK's StoredPaymentRequestRecord — the slot map
 *  may arrive as a Map, entries array, or plain object depending on which
 *  serializer wrote it (see NoteSecretsMapCodec in the state schema). */
export type StoredRequestRecordLike = {
  paymentId: string;
  amount: string; // hex wei
  tokenId: string;
  tag: string;
  paymentPubKey: string;
  recipientAddress: string;
  // ARCHIVED arrived with the v2.0 SDK (PaymentRequestStatus). It is neither
  // open nor fulfilled: the request was retired without being paid, so it must
  // not be counted as either.
  status: 'OPEN' | 'FULFILLED' | 'ARCHIVED';
  createdAt: string; // hex milliseconds
  /** The SDK's payer-facing deadline (hex ms). Absent on records made before it existed. */
  expiresAt?: string;
  noteSecretsMap: Map<string, string> | [string, string][] | Record<string, string>;
};

export type PaymentRequestBackupLike = {
  chains: Record<string, { requests: StoredRequestRecordLike[] }>;
};

/** Legacy V1 device-store entry (services/payment-requests.ts STORAGE_KEY). */
export type LegacyStoredRequestLike = Pick<
  PaymentRequestPayloadV1,
  'requestId' | 'chainId' | 'recipientAddress' | 'tokenId' | 'amount' | 'createdAt'
>;

// LEGACY is ours (a pre-v2 device-store entry with no tracked fulfilment);
// OPEN / FULFILLED / ARCHIVED are the SDK's PaymentRequestStatus. Keeping
// ARCHIVED distinct matters: it is a request retired without payment, so
// folding it into either of the other two would misreport it.
export type PaymentRequestRowStatus = 'OPEN' | 'FULFILLED' | 'ARCHIVED' | 'LEGACY';

export type PaymentRequestListRow = {
  /** paymentId (sdk) or requestId (legacy). */
  id: string;
  kind: 'sdk' | 'legacy';
  chainId: number;
  chainName: string;
  createdAtMs: number;
  amountFormatted: string;
  assetSymbol: string;
  /** The requested token, as stored: what the row is priced by. */
  tokenAddress: string;
  recipient: string;
  status: PaymentRequestRowStatus;
  /** Rebuilt /pay share link (unsigned), when the stored record carries
   *  everything a payer needs. Null for legacy rows — their single blind
   *  slot may already be consumed and no fulfillment status is tracked, so
   *  re-sharing risks an unrecoverable double payment. */
  payLink: string | null;
  /** Create-flow prefill for the Re-issue fallback when no link exists.
   *  Carries the SOURCE chain so the create flow can align/validate before
   *  applying — the same text amount means something different under another
   *  chain's native token precision. */
  reissue: { chainId: number; amount: string; tokenAddress: Hex } | null;
};

export type TokenMetaLike = { symbol: string; address: string; decimals: number } | null | undefined;

export type PaymentRequestListDeps = {
  /** Display resolver (fallback metadata allowed) — e.g. getTokenMetadata. */
  resolveToken: (tokenId: string, chainId: number) => TokenMetaLike;
  /** STRICT resolver for the Re-issue prefill (null/undefined for tokens not
   *  known on that exact chain) — e.g. getKnownTokenMetadata. A guessed
   *  fallback here would re-issue a request for the wrong asset. Falls back
   *  to resolveToken when omitted. */
  resolveKnownToken?: (tokenId: string, chainId: number) => TokenMetaLike;
  /** e.g. (id) => getChainConfig(id)?.name */
  resolveChainName?: (chainId: number) => string | undefined;
};

// ECMAScript Date range bound — a schema-valid but out-of-range hex
// timestamp must degrade to "unknown date", not throw in toISOString().
const MAX_DATE_MS = 8.64e15;

export function hexTimestampToMs(value: string | undefined): number {
  if (!value) return 0;
  try {
    const n = Number(BigInt(value));
    if (!Number.isFinite(n) || n <= 0) return 0;
    // Guard legacy second-precision values so they don't render far-future.
    const ms = n < 10_000_000_000 ? n * 1000 : n;
    return ms > MAX_DATE_MS ? 0 : ms;
  } catch {
    return 0;
  }
}

export function normalizeSecretsEntries(
  map: StoredRequestRecordLike['noteSecretsMap'] | null | undefined,
): [Hash, Secret][] {
  if (!map) return [];
  if (map instanceof Map) return Array.from(map.entries()) as [Hash, Secret][];
  if (Array.isArray(map)) {
    return map
      .filter((entry): entry is [string, string] => Array.isArray(entry) && entry.length === 2)
      .map(([k, v]) => [k, v] as [Hash, Secret]);
  }
  if (typeof map === 'object') return Object.entries(map) as [Hash, Secret][];
  return [];
}

/**
 * Rebuild the shareable /pay link for a stored SDK-native record. The link is
 * deterministic from the persisted public half (the payer-facing fields), so
 * "re-issue" for an SDK request IS this link — same paymentId, same slot
 * hashes. The payer fulfills from the tuple KEYS only, so the value slot of
 * every shared tuple carries the fixed placeholder — the recipient-local
 * noteSecrets never leave the device (the URL codec sanitizes again as a
 * backstop). Rebuilt links are unsigned (the EIP-712 signature is not
 * persisted). Returns null when the record has no slots.
 */
export function buildShareLinkForRecord(
  chainId: number,
  record: StoredRequestRecordLike,
  linkBase: string,
): string | null {
  const slotHashes = normalizeSecretsEntries(record.noteSecretsMap).map(([noteAddressHash]) => noteAddressHash);
  if (slotHashes.length === 0 || !linkBase) return null;
  try {
    const createdAtMs = hexTimestampToMs(record.createdAt);
    const payload: PaymentRequestPayloadV3 = {
      kind: 'ppv2-sdk-payment-request',
      version: 1,
      chainId,
      recipientAddress: record.recipientAddress as Address,
      paymentId: record.paymentId as Hex,
      tag: record.tag as Hex,
      paymentPubKey: record.paymentPubKey as Hex,
      tokenId: record.tokenId as Address,
      amount: record.amount as Hex,
      noteSecretsMap: slotHashes.map((hash) => [hash, SHARED_NOTE_SECRET_PLACEHOLDER] as [Hash, Secret]),
      // A rebuilt link keeps the record's deadline, so re-sharing it does not
      // turn an expiring request into one the payer cannot see expire.
      ...(record.expiresAt ? { expiresAt: record.expiresAt as Hex } : {}),
      createdAt: createdAtMs > 0 ? new Date(createdAtMs).toISOString() : new Date().toISOString(),
    };
    return `${linkBase}/pay/${encodePaymentRequestPayloadForUrl(payload)}`;
  } catch {
    return null;
  }
}

function formatAmount(
  amountHex: string,
  tokenId: string,
  chainId: number,
  deps: PaymentRequestListDeps,
): { amountFormatted: string; assetSymbol: string } {
  const meta = deps.resolveToken(tokenId, chainId);
  const decimals = meta?.decimals ?? 18;
  const symbol = meta?.symbol ?? '?';
  try {
    return { amountFormatted: formatUnits(BigInt(amountHex), decimals), assetSymbol: symbol };
  } catch {
    return { amountFormatted: '—', assetSymbol: symbol };
  }
}

function reissuePrefill(
  amountHex: string,
  tokenId: string,
  chainId: number,
  deps: PaymentRequestListDeps,
): { chainId: number; amount: string; tokenAddress: Hex } | null {
  // STRICT resolution: an unknown/foreign-chain token gets NO prefill —
  // fallback metadata would silently re-issue a request for a different
  // asset (or the right address with guessed decimals).
  const meta = (deps.resolveKnownToken ?? deps.resolveToken)(tokenId, chainId);
  if (!meta) return null;
  try {
    return {
      chainId,
      amount: formatUnits(BigInt(amountHex), meta.decimals),
      tokenAddress: meta.address as Hex,
    };
  } catch {
    return null;
  }
}

/**
 * Flatten the per-chain stored V3 state plus the legacy V1 device store into
 * a single newest-first row list, scoped to `owner`: only records whose
 * recipientAddress matches (case-insensitive) are listed — every legacy
 * request on the device would otherwise surface (and be re-issuable) under
 * whichever wallet is currently connected. Legacy rows carry a re-issue
 * prefill instead of a link (see PaymentRequestListRow.payLink). Row
 * building is per-record fault-isolated: one malformed record is skipped
 * instead of blanking the whole list.
 */
export function buildPaymentRequestRows(
  args: {
    backup: PaymentRequestBackupLike | null;
    legacy?: LegacyStoredRequestLike[];
    linkBase: string;
    owner: string;
  },
  deps: PaymentRequestListDeps,
): PaymentRequestListRow[] {
  const rows: PaymentRequestListRow[] = [];
  const owner = args.owner.toLowerCase();
  const chainName = (chainId: number) => deps.resolveChainName?.(chainId) ?? `chain ${chainId}`;

  for (const [chainIdStr, state] of Object.entries(args.backup?.chains ?? {})) {
    const chainId = Number(chainIdStr);
    for (const record of state.requests ?? []) {
      try {
        if ((record.recipientAddress ?? '').toLowerCase() !== owner) continue;
        // ARCHIVED is the SDK's recipient-controlled terminal state (b2a37959,
        // finding #600) and is excluded from its scannable set. Nothing in this
        // app archives, so this only fires for a record another client retired
        // — list it as neither open nor fulfilled: don't list it at all.
        if (record.status === 'ARCHIVED') continue;
        const { amountFormatted, assetSymbol } = formatAmount(record.amount, record.tokenId, chainId, deps);
        const isOpen = record.status === 'OPEN';
        const payLink = isOpen ? buildShareLinkForRecord(chainId, record, args.linkBase) : null;
        rows.push({
          id: record.paymentId,
          kind: 'sdk',
          chainId,
          chainName: chainName(chainId),
          createdAtMs: hexTimestampToMs(record.createdAt),
          amountFormatted,
          assetSymbol,
          tokenAddress: record.tokenId,
          recipient: record.recipientAddress,
          status: record.status,
          payLink,
          // Colleague-parity fallback (ui-overhaul 567245a): an OPEN request
          // whose link can't be rebuilt still gets a Re-issue action.
          reissue: isOpen && !payLink ? reissuePrefill(record.amount, record.tokenId, chainId, deps) : null,
        });
      } catch {
        // Skip the malformed record; the rest of the list still renders.
      }
    }
  }

  for (const entry of args.legacy ?? []) {
    try {
      if ((entry.recipientAddress ?? '').toLowerCase() !== owner) continue;
      const chainId = entry.chainId;
      const { amountFormatted, assetSymbol } = formatAmount(entry.amount, entry.tokenId, chainId, deps);
      const createdAtMs = (() => {
        const parsed = Date.parse(entry.createdAt ?? '');
        return Number.isFinite(parsed) && parsed > 0 && parsed <= MAX_DATE_MS ? parsed : 0;
      })();
      rows.push({
        id: entry.requestId,
        kind: 'legacy',
        chainId,
        chainName: chainName(chainId),
        createdAtMs,
        amountFormatted,
        assetSymbol,
        tokenAddress: entry.tokenId,
        recipient: entry.recipientAddress,
        status: 'LEGACY',
        payLink: null,
        reissue: reissuePrefill(entry.amount, entry.tokenId, chainId, deps),
      });
    } catch {
      // Skip the malformed entry; the rest of the list still renders.
    }
  }

  rows.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return rows;
}
