import { loadSdkCore } from '@/services/crypto-runtime';
import type {
  PaymentRequestServiceState,
  Secret,
  StoredPaymentRequestRecord,
} from '@privacy-pools-v2/sdk';

import { ACTIVE_APP_ENVIRONMENT, type AppEnvironment } from '@/config/app-environment';
import { importSessionPaymentRequests, listSessionPaymentRequests, type SessionPaymentRequest } from '@/services/session-payment-requests';
import { parseSessionRequestBackup } from '@/services/session-payment-request-backup';
import { getSupportedChains } from '@/config/chains';
import {
  getSdkStorageService,
  migratePaymentRequestStateToV2Shape,
  parseWithMaps,
  stringifyWithMaps,
  upgradeLegacyPaymentRequestState,
} from '@/services/sdk-storage';
import {
  readAllPaymentRequestStatesNoWrite,
  readPaymentRequestStateNoWrite,
} from '@/services/payment-request-store-read';
import { bumpPaymentRequestRevision } from '@/services/payment-request-revision';
import { withoutPaymentRequest } from '@/services/payment-request-cleanup';
import { holdsSameRecoveryData, markPaymentRequestsBackedUp } from '@/services/payment-request-signout-purge';
import type { PaymentRequestPayloadV3 } from '@/services/payment-requests';
import type { Hex } from '@/services/sdk-types';

export type PaymentRequestBackupPayload = {
  kind: 'ppv2-payment-request-backup';
  version: 1 | 2;
  environment?: AppEnvironment;
  sessionRequests?: SessionPaymentRequest[];
  createdAt: string;
  chains: Record<string, PaymentRequestServiceState>;
};

export type PaymentRequestImportResult = {
  restored: number;
  skipped: number;
  chains: number;
};

function paymentRequestTimestamp(value: string | undefined): Hex {
  const parsed = value ? Date.parse(value) : NaN;
  const timestamp = Number.isFinite(parsed) ? BigInt(parsed) : BigInt(Date.now());
  return `0x${timestamp.toString(16)}` as Hex;
}

async function getPaymentRequestAdapter(chainId: number, ownerAddress: string) {
  const { PaymentRequestStorageAdapter } = await loadSdkCore();
  // v2.0 migration: the adapter's getState() validates against the v2.0
  // schema, which rejects records written by the old SDK (no
  // noteAddressHashes). Upgrade in place first so backup/export/import
  // flows can run before a PoolSession ever initializes this chain.
  await migratePaymentRequestStateToV2Shape(chainId, ownerAddress);
  // The SDK namespaces payment-request storage by owner now — pass the
  // connected wallet so we read/write the same slot the live session uses.
  return new PaymentRequestStorageAdapter(chainId, getSdkStorageService(), ownerAddress as `0x${string}`);
}

/**
 * Records that came FROM a backup the user holds (a backup envelope, or a
 * single exported payload, which only this app's export carries with its
 * paymentPrivKey): sign-out may purge them
 * (services/payment-request-signout-purge.ts). Best-effort: a missing entry
 * only means the record is kept at sign-out.
 */
async function ledgerImportedFromBackup(ownerAddress: string, paymentIds: string[]): Promise<void> {
  try {
    await markPaymentRequestsBackedUp(getSdkStorageService(), ownerAddress, paymentIds);
  } catch {
    // see above
  }
}

async function mergePaymentRequestState(
  chainId: number,
  imported: PaymentRequestServiceState,
  ownerAddress: string,
): Promise<{ restored: number; skipped: number }> {
  // v2.0 migration: the SDK no longer runtime-exports this schema (types
  // only); use ppv2's mirror. Backups exported by the old app carry
  // legacy-shaped records; normalize before validating so they stay
  // importable.
  const { PaymentRequestServiceStateSchema } = await import('@/services/payment-request-state-schema');
  const parsed = PaymentRequestServiceStateSchema.safeParse(upgradeLegacyPaymentRequestState(imported));
  if (!parsed.success) {
    throw new Error(`Payment request backup for chain ${chainId} is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  }

  const adapter = await getPaymentRequestAdapter(chainId, ownerAddress);
  // Read current state via the no-write reader: unlike adapter.getState()
  // (SDK schema strips unknown fields), it retains a legacy record's stored
  // paymentPrivKey so the merged save below can't drop it.
  const current = await readPaymentRequestStateNoWrite(getSdkStorageService(), chainId, ownerAddress);
  // Shared merge core: local wins, paymentId dedupe is case-insensitive.
  const { mergePaymentRequestRecords } = await import('@/services/account-backup-core');
  const { merged, restored, skipped } = mergePaymentRequestRecords(current?.requests, parsed.data.requests);
  const nextParsed = PaymentRequestServiceStateSchema.safeParse({ requests: merged });
  if (!nextParsed.success) {
    throw new Error(`Merged payment request backup for chain ${chainId} is invalid: ${nextParsed.error.issues[0]?.message ?? 'unknown error'}`);
  }
  await adapter.saveState(nextParsed.data);
  bumpPaymentRequestRevision();
  // Local wins on a duplicate id, so a backup entry covers the stored record
  // only when it carries the same recovery data.
  const storedById = new Map(merged.map((record) => [record.paymentId.toLowerCase(), record]));
  await ledgerImportedFromBackup(
    ownerAddress,
    parsed.data.requests
      .filter((record) => holdsSameRecoveryData(storedById.get(record.paymentId.toLowerCase()), record))
      .map((record) => record.paymentId),
  );
  return { restored, skipped };
}

export async function exportAllPaymentRequests(ownerAddress: string): Promise<PaymentRequestBackupPayload> {
  // NO-WRITE read (P0: rendering/exporting must never mutate storage):
  // legacy shapes are normalized in memory only, and — unlike the SDK
  // adapter's schema — the reader RETAINS a pre-v2 record's stored
  // paymentPrivKey, so backups keep the non-derivable legacy key.
  const chains = await readAllPaymentRequestStatesNoWrite(
    getSdkStorageService(),
    getSupportedChains().map((chain) => chain.id),
    ownerAddress,
  );
  return {
    kind: 'ppv2-payment-request-backup',
    version: 2,
    environment: ACTIVE_APP_ENVIRONMENT,
    createdAt: new Date().toISOString(),
    chains,
    sessionRequests: exportableSessionRequests(ownerAddress),
  };
}

/**
 * Session rows are a convenience list, while the SDK records beside them hold
 * keys a lost browser cannot rebuild. A row that would fail import (for one,
 * a link listed under another account by an earlier build) is left out, so it
 * can never block the backup, the card's list, or the post-create recovery file.
 */
function exportableSessionRequests(ownerAddress: string): SessionPaymentRequest[] {
  return listSessionPaymentRequests(ownerAddress).flatMap((record) => {
    try {
      return parseSessionRequestBackup([record], ownerAddress);
    } catch {
      return [];
    }
  });
}

export function serializePaymentRequestBackup(backup: PaymentRequestBackupPayload): string {
  return stringifyWithMaps(backup);
}

export async function importAllPaymentRequests(rawPayload: string, ownerAddress: string, linkBase = ''): Promise<PaymentRequestImportResult> {
  let parsed: unknown = null;
  let jsonParseFailed = false;
  try {
    parsed = parseWithMaps(rawPayload);
  } catch {
    // Not JSON — could still be a pasted /pay/ link; the single-request
    // handler below decodes that shape.
    jsonParseFailed = true;
  }

  const backup = parsed as Partial<PaymentRequestBackupPayload>;
  if (
    jsonParseFailed
    || backup?.kind !== 'ppv2-payment-request-backup'
    || (backup.version !== 1 && backup.version !== 2)
    || typeof backup.chains !== 'object'
    || !backup.chains
    || Array.isArray(backup.chains)
  ) {
    // Not the multi-chain backup envelope. Users often paste a SINGLE request
    // instead — the JSON shown when the request was created, or its /pay/
    // link (#212). Accept those shapes too.
    return importSingleRequestPayload(rawPayload, parsed, jsonParseFailed, ownerAddress, linkBase);
  }

  // Version 2 always names its environment. Version 1 never did, so a v1
  // envelope that names one was edited and gets the same check.
  if ((backup.version === 2 || backup.environment !== undefined) && backup.environment !== ACTIVE_APP_ENVIRONMENT) {
    throw new Error('Switch to the environment where this payment request backup was created before importing it.');
  }
  const sessionRequests = parseSessionRequestBackup(
    backup.version === 1 ? (backup.sessionRequests ?? []) : backup.sessionRequests,
    ownerAddress,
  );
  // Validate all saved records before either store is changed.
  const { PaymentRequestServiceStateSchema } = await import('@/services/payment-request-state-schema');
  for (const [chainId, state] of Object.entries(backup.chains)) {
    if (!Number.isSafeInteger(Number(chainId)) || Number(chainId) <= 0) {
      throw new Error(`Payment request backup has an invalid chain id: ${chainId}`);
    }
    const checked = PaymentRequestServiceStateSchema.safeParse(upgradeLegacyPaymentRequestState(state));
    if (!checked.success) {
      throw new Error(`Payment request backup for chain ${chainId} is invalid: ${checked.error.issues[0]?.message ?? 'unknown error'}`);
    }
    if (checked.data.requests.some((record) => record.recipientAddress.toLowerCase() !== ownerAddress.toLowerCase())) {
      throw new Error('This payment request backup belongs to another account. Sign in to that account to import it.');
    }
  }
  let restored = 0;
  let skipped = 0;
  let chains = 0;
  for (const [chainIdRaw, state] of Object.entries(backup.chains)) {
    const chainId = Number(chainIdRaw);
    if (!Number.isSafeInteger(chainId)) {
      throw new Error(`Payment request backup has an invalid chain id: ${chainIdRaw}`);
    }
    const result = await mergePaymentRequestState(chainId, state, ownerAddress);
    restored += result.restored;
    skipped += result.skipped;
    chains += 1;
  }

  const sessionResult = importSessionPaymentRequests(sessionRequests);
  restored += sessionResult.restored;
  skipped += sessionResult.skipped;
  if (sessionResult.restored) bumpPaymentRequestRevision();
  return { restored, skipped, chains };
}

// Handles everything the importer accepts besides the multi-chain backup
// envelope: a single exported request (SDK-native V3, registered V2, legacy
// V1) pasted as JSON, or a /pay/ share link carrying one (#212).
async function importSingleRequestPayload(
  rawPayload: string,
  parsed: unknown,
  jsonParseFailed: boolean,
  ownerAddress: string,
  linkBase: string,
): Promise<PaymentRequestImportResult> {
  const { classifySinglePaymentRequestPayload, decodePaymentRequestPayloadFromUrl, encodePaymentRequestPayloadForUrl, parsePaymentRequestPayload } = await import('@/services/payment-request-codec');

  let candidate: unknown = parsed;
  if (jsonParseFailed) {
    // Maybe a pasted /pay/ link (or just its base64url payload segment).
    const encoded = rawPayload.trim().match(/(?:\/pay\/)?([A-Za-z0-9_-]{40,})\s*$/)?.[1];
    if (!encoded) {
      throw new Error('Payment request backup is not valid JSON.');
    }
    try {
      candidate = decodePaymentRequestPayloadFromUrl(encoded);
    } catch {
      throw new Error(
        'Unrecognized payment-request data. Paste the JSON exported by this app (Export Payment Requests), a single exported payment request, or a /pay/ link.',
      );
    }
  }

  switch (classifySinglePaymentRequestPayload(candidate)) {
    case 'sdk-v3': {
      const status = await restorePaymentRequestFromPayload(candidate as PaymentRequestPayloadV3, ownerAddress);
      if (status === 'missing-private-key') {
        throw new Error(
          'This payment request has no private key, so it cannot be imported for fulfillment tracking. Import a backup exported from this app.',
        );
      }
      return { restored: status === 'restored' ? 1 : 0, skipped: status === 'exists' ? 1 : 0, chains: 1 };
    }
    case 'registered-v2': {
      const payload = parsePaymentRequestPayload(JSON.stringify(candidate));
      if (payload.kind !== 'ppv2-payment-request' || payload.version !== 2) {
        throw new Error('Invalid registered payment request.');
      }
      const createdAt = Date.parse(payload.createdAt);
      const payLink = /^https?:\/\//i.test(rawPayload.trim())
        ? rawPayload.trim()
        : linkBase ? `${linkBase}/pay#${encodePaymentRequestPayloadForUrl(payload)}` : null;
      const records = parseSessionRequestBackup([{
        requestId: payload.requestId,
        chainId: payload.chainId,
        owner: payload.recipientAddress,
        tokenAddress: payload.tokenId,
        amount: payload.amount,
        createdAtMs: Number.isFinite(createdAt) ? createdAt : Date.now(),
        payLink,
        signed: !!payload.signature,
      }], ownerAddress);
      const result = importSessionPaymentRequests(records);
      if (result.restored) bumpPaymentRequestRevision();
      return { ...result, chains: 1 };
    }
    case 'legacy-v1':
      throw new Error(
        'This is a legacy (v1) payment request; it depends on local data from the device that created it and cannot be imported. Create a new request instead.',
      );
    default:
      throw new Error(
        'Unrecognized payment-request data. Paste the JSON exported by this app (Export Payment Requests), a single exported payment request, or a /pay/ link.',
      );
  }
}

/**
 * Read one persisted payment-request record (recipient-local slots +
 * lifecycle metadata) by paymentId. v2.0 migration: the public
 * `PaymentRequest` returned by `session.generatePaymentRequest` no longer
 * carries `noteSecretsMap`, so callers that need the secrets (e.g. the V3
 * export payload) read them from the record the SDK just persisted.
 */
export async function getStoredPaymentRequestRecord(
  chainId: number,
  paymentId: Hex,
  ownerAddress: string,
): Promise<StoredPaymentRequestRecord | null> {
  // NO-WRITE read: a lookup must not trigger a storage migration.
  const state = await readPaymentRequestStateNoWrite(getSdkStorageService(), chainId, ownerAddress);
  return state?.requests.find((request) => request.paymentId.toLowerCase() === paymentId.toLowerCase()) ?? null;
}

export async function getStoredPaymentRequestPrivateKey(
  chainId: number,
  paymentId: Hex,
  ownerAddress: string,
): Promise<Secret | null> {
  // v2.0 migration: the SDK no longer persists paymentPrivKey (it is
  // re-derived from the viewing key + paymentId on load). Legacy stored
  // state written by the old SDK still carries the RANDOM (non-derivable)
  // key — read RAW storage, not the SDK adapter, whose schema strips the
  // field from parsed results.
  const state = await readPaymentRequestStateNoWrite(getSdkStorageService(), chainId, ownerAddress);
  const record = state?.requests.find((request) => request.paymentId.toLowerCase() === paymentId.toLowerCase());
  return ((record as { paymentPrivKey?: Secret } | undefined)?.paymentPrivKey) ?? null;
}

export async function restorePaymentRequestFromPayload(
  payload: PaymentRequestPayloadV3,
  ownerAddress: string,
): Promise<'restored' | 'exists' | 'missing-private-key'> {
  // v2.0 migration: the key is no longer persisted (the SDK re-derives it
  // on load), but we keep requiring it in the payload so only backups
  // exported by this app — not hand-built share links — are importable,
  // matching pre-migration acceptance behavior.
  if (!payload.paymentPrivKey) return 'missing-private-key';

  // v2.0 migration: schema mirrored locally (SDK runtime no longer exports it).
  const { PaymentRequestServiceStateSchema } = await import('@/services/payment-request-state-schema');
  const adapter = await getPaymentRequestAdapter(payload.chainId, ownerAddress);
  // No-write reader (retains any legacy stored paymentPrivKey in `current`
  // so the save below can't drop it from unrelated records).
  const current = await readPaymentRequestStateNoWrite(getSdkStorageService(), payload.chainId, ownerAddress);
  const requests = current?.requests ?? [];
  const existing = requests.find((request) => request.paymentId.toLowerCase() === payload.paymentId.toLowerCase());
  if (existing) {
    // The stored record stays, so the payload covers it only when it holds the
    // same recovery data, not merely the same id.
    if (holdsSameRecoveryData(existing, payload)) await ledgerImportedFromBackup(ownerAddress, [payload.paymentId]);
    return 'exists';
  }

  // v2.0 migration: the persisted shape is StoredPaymentRequestRecord with
  // an explicit noteAddressHashes array (the public slot list; identical to
  // the noteSecretsMap keys). The payload's paymentPrivKey is RETAINED in
  // storage: for a pre-v2 backup it is a RANDOM key the SDK cannot
  // re-derive; for a v2.0 backup it is redundant but harmless (the SDK's
  // schema strips it from its own parsed reads).
  const noteSecretsMap = new Map(payload.noteSecretsMap);
  const record: StoredPaymentRequestRecord = {
    paymentId: payload.paymentId,
    noteAddressHashes: Array.from(noteSecretsMap.keys()),
    noteSecretsMap,
    // Required by the v2.0 SDK: the slots a matched fulfilment has already
    // taken, so a second match cannot claim the same one. A request recovered
    // from a backup has no local record of that, and asserting slots were used
    // would suppress a real payment, so it starts empty like
    // fulfilledByCommitments below and the SDK's own schema default.
    consumedSlots: [],
    amount: payload.amount,
    tokenId: payload.tokenId,
    tag: payload.tag,
    paymentPubKey: payload.paymentPubKey,
    // Kept, so a link rebuilt from the restored record still expires.
    ...(payload.expiresAt !== undefined ? { expiresAt: payload.expiresAt } : {}),
    recipientAddress: payload.recipientAddress,
    status: 'OPEN',
    createdAt: paymentRequestTimestamp(payload.createdAt),
    fulfilledByCommitments: [],
    ...(payload.paymentPrivKey ? { paymentPrivKey: payload.paymentPrivKey } : {}),
  } as StoredPaymentRequestRecord;
  const nextState = { requests: [...requests, record] };
  const parsed = PaymentRequestServiceStateSchema.safeParse(nextState);
  if (!parsed.success) {
    throw new Error(`Payment request recovery data is invalid: ${parsed.error.issues[0]?.message ?? 'unknown error'}`);
  }
  await adapter.saveState(parsed.data);
  bumpPaymentRequestRevision();
  await ledgerImportedFromBackup(ownerAddress, [payload.paymentId]);
  return 'restored';
}

/**
 * Remove a request the SDK just persisted but that never got a link (DEV-515).
 * `generatePaymentRequest` stores an OPEN record before the link is built, so a
 * create that failed afterwards left a row that looked payable but could not be
 * shared, one per attempt. Only for a record created in this same call and never
 * shared: it holds nothing a payer could have used.
 */
export async function discardUnsharedPaymentRequest(
  chainId: number,
  paymentId: Hex,
  ownerAddress: string,
  session: unknown,
): Promise<boolean> {
  // A cheap no-write look first, so a no-op loads nothing and writes nothing.
  const storage = getSdkStorageService();
  if (!withoutPaymentRequest(await readPaymentRequestStateNoWrite(storage, chainId, ownerAddress), paymentId)) {
    return false;
  }
  // Then everything async, and the read and the write back to back. Same
  // unlocked read-modify-write as restorePaymentRequestFromPayload: the SDK
  // exposes no lock. The window is the create flow itself, right after
  // generatePaymentRequest.
  const { PaymentRequestServiceStateSchema } = await import('@/services/payment-request-state-schema');
  const adapter = await getPaymentRequestAdapter(chainId, ownerAddress);
  const next = withoutPaymentRequest(await readPaymentRequestStateNoWrite(storage, chainId, ownerAddress), paymentId);
  if (!next) return false;
  const parsed = PaymentRequestServiceStateSchema.safeParse(next);
  if (!parsed.success) return false;
  await adapter.saveState(parsed.data);
  await reloadPaymentRequestsInSession(session);
  bumpPaymentRequestRevision();
  return true;
}

export async function reloadPaymentRequestsInSession(session: unknown): Promise<boolean> {
  const paymentRequestService = (session as unknown as {
    delegates?: {
      noteDiscovery?: { paymentRequestService?: { loadFromStorage?: () => Promise<void> } };
      transfer?: { paymentRequestService?: { loadFromStorage?: () => Promise<void> } };
    };
  } | null)?.delegates?.noteDiscovery?.paymentRequestService
    ?? (session as unknown as {
      delegates?: { transfer?: { paymentRequestService?: { loadFromStorage?: () => Promise<void> } } };
    } | null)?.delegates?.transfer?.paymentRequestService;

  if (!paymentRequestService?.loadFromStorage) return false;
  await paymentRequestService.loadFromStorage();
  return true;
}
