// Pure core of the account backup/restore flow (wallet-backup-encryption.ts
// wires the real storage adapter around it). No react-native and no SDK
// RUNTIME import — bun tests exercise the REAL public behavior (envelope
// build, AES-256-GCM, owner/chain validation, merge semantics, persisted
// end state) against an in-memory store.

import type { PaymentRequestServiceState, StoredPaymentRequestRecord } from '@privacy-pools-v2/sdk';

import type { AccountExport } from '@/services/sdk-types';
import { parseWithMaps, stringifyWithMaps } from '@/services/json-maps';
import { PaymentRequestServiceStateSchema } from '@/services/payment-request-state-schema';
import { upgradeLegacyPaymentRequestState } from '@/services/payment-request-state-migration';

// --- Injected persistence -------------------------------------------------

/** The persistence the backup flow needs, kept injectable: `load` must be a
 *  NO-WRITE read that retains a legacy record's stored paymentPrivKey (see
 *  payment-request-store-read); `save` persists a merged state. */
export type PaymentRequestStateStore = {
  load(chainId: number, owner: string): Promise<{
    state: PaymentRequestServiceState | null;
    loadError: string | null;
  }>;
  save(chainId: number, owner: string, state: PaymentRequestServiceState): Promise<void>;
};

// --- Password-based AES-256-GCM encryption ---------------------------------

export type PasswordEncryptedPayload = {
  kind: 'ppv2-password-backup';
  version: 2;
  walletAddress: string;
  chainId: number;
  createdAt: string;
  encryption: {
    algorithm: 'AES-256-GCM';
    kdf: 'PBKDF2-SHA256';
    iterations: number;
    salt: string;   // base64
    iv: string;     // base64
    ciphertext: string; // base64
  };
};

export type PreparedAccountBackup = {
  serialized: string;
  encrypted: boolean;
  warning: string | null;
};

const PBKDF2_ITERATIONS = 600_000;

function toBase64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as unknown as ArrayBuffer, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptWithPassword(plaintext: string, password: string): Promise<{ salt: string; iv: string; ciphertext: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as ArrayBuffer },
    key,
    enc.encode(plaintext),
  );
  return {
    salt: toBase64(salt),
    iv: toBase64(iv),
    ciphertext: toBase64(encrypted),
  };
}

async function decryptWithPassword(
  salt: string,
  iv: string,
  ciphertext: string,
  password: string,
  iterations: number,
): Promise<string> {
  const key = await deriveKey(password, fromBase64(salt), iterations);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(iv) as unknown as ArrayBuffer },
    key,
    fromBase64(ciphertext) as unknown as ArrayBuffer,
  );
  return new TextDecoder().decode(decrypted);
}

// --- Payload detection ------------------------------------------------------

function isPasswordEncryptedPayload(value: unknown): value is PasswordEncryptedPayload {
  if (!value || typeof value !== 'object') return false;
  const p = value as Partial<PasswordEncryptedPayload>;
  return p.kind === 'ppv2-password-backup' && p.version === 2 && !!p.encryption;
}

/**
 * Does this backup text need a password to import? The same test
 * parseAccountBackupCore applies, so the import form shows the password field
 * exactly when the import would refuse without one. Both ways in (pasting the
 * JSON and "Load File") go through this: "Load File" used to skip it, so an
 * encrypted file, the export default, never showed the field (DEV-460).
 */
export function backupTextNeedsPassword(text: string): boolean {
  try {
    return isPasswordEncryptedPayload(JSON.parse(text));
  } catch {
    return false;
  }
}

// Backups carry the account export AND the SDK payment-request state for
// the chain. The payment-request state holds the per-request
// paymentPrivKey + slot map and is NOT seed-derivable, so without it the
// seller can't discover payments for open links from a different device
// or a cleared browser. The extra `paymentRequests` field is opaque
// to legacy importers (validateAccountExport ignores unknown keys), so
// older builds reading a newer backup still get the notes back.
export type BackupEnvelope = AccountExport & {
  paymentRequests?: PaymentRequestServiceState | null;
};

function validateAccountExport(value: unknown): AccountExport {
  if (!value || typeof value !== 'object' || !Array.isArray((value as Partial<AccountExport>).notes)) {
    throw new Error('Backup does not match the expected account export shape. Expected { notes: [...], syncCursor: "0x..." }');
  }
  return value as AccountExport;
}

// --- Merge ------------------------------------------------------------------

/**
 * Dedupe imported records against local ones by paymentId,
 * case-INSENSITIVELY (hex ids can arrive checksum- or lowercase-serialized
 * depending on which build exported them). Local records WIN so an older
 * backup can't regress a FULFILLED request to the backup's OPEN copy or
 * orphan a request created after the backup was taken. Shared by the
 * account-backup restore and the dedicated payment-request importer.
 */
export function mergePaymentRequestRecords<T extends { paymentId: string }>(
  current: readonly T[] | null | undefined,
  imported: readonly T[],
): { merged: T[]; restored: number; skipped: number } {
  const byId = new Map<string, T>();
  for (const record of current ?? []) byId.set(record.paymentId.toLowerCase(), record);
  let restored = 0;
  for (const record of imported) {
    const id = record.paymentId.toLowerCase();
    if (!byId.has(id)) {
      byId.set(id, record);
      restored += 1;
    }
  }
  return { merged: Array.from(byId.values()), restored, skipped: imported.length - restored };
}

/**
 * Merge imported payment-request records into the local store. Validates
 * the imported state (after in-memory legacy-shape normalization — a pre-v2
 * record's stored paymentPrivKey is RETAINED) before touching local
 * storage; invalid blobs are skipped (caller may warn).
 */
export async function restorePaymentRequestStateForChainCore(
  store: PaymentRequestStateStore,
  chainId: number,
  imported: PaymentRequestServiceState | null | undefined,
  ownerAddress: string,
): Promise<{ restored: number; skipped: number; warning: string | null }> {
  if (!imported || !Array.isArray(imported.requests) || imported.requests.length === 0) {
    return { restored: 0, skipped: 0, warning: null };
  }
  const parsed = PaymentRequestServiceStateSchema.safeParse(upgradeLegacyPaymentRequestState(imported));
  if (!parsed.success) {
    return {
      restored: 0,
      skipped: imported.requests.length,
      warning: `Backup payment-request state failed validation; skipped (${parsed.error.issues[0]?.message ?? 'unknown'}).`,
    };
  }
  // If reading local state fails (corruption), start fresh — the next
  // PoolSession init would reset it anyway.
  const { state: currentState } = await store.load(chainId, ownerAddress);
  const { merged, restored, skipped } = mergePaymentRequestRecords<StoredPaymentRequestRecord>(
    currentState?.requests,
    parsed.data.requests,
  );
  if (restored === 0) {
    return { restored: 0, skipped, warning: null };
  }
  await store.save(chainId, ownerAddress, { requests: merged });
  return { restored, skipped, warning: null };
}

// --- Public API cores ---------------------------------------------------------

export async function encryptAccountExportCore(
  address: string,
  chainId: number,
  envelope: BackupEnvelope,
  password: string,
): Promise<PasswordEncryptedPayload> {
  // Map-aware stringify — the envelope's `paymentRequests` carries
  // `requests[i].noteSecretsMap: Map<Hash, Secret>` which raw JSON
  // would silently drop.
  const plaintext = stringifyWithMaps(envelope);
  const { salt, iv, ciphertext } = await encryptWithPassword(plaintext, password);
  return {
    kind: 'ppv2-password-backup',
    version: 2,
    walletAddress: address.toLowerCase(),
    chainId,
    createdAt: new Date().toISOString(),
    encryption: {
      algorithm: 'AES-256-GCM',
      kdf: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      salt,
      iv,
      ciphertext,
    },
  };
}

export async function prepareAccountBackupCore(
  store: PaymentRequestStateStore,
  address: string,
  chainId: number,
  accountExport: AccountExport,
  password?: string,
): Promise<PreparedAccountBackup> {
  const { state: paymentRequests, loadError } = await store.load(chainId, address);
  // Tell the user when payment-request recovery data wasn't included
  // — they may have open links that can't be recovered from this
  // backup alone.
  const warning = loadError
    ? `Note backup ready, but the payment-request store on this chain couldn't be read (${loadError}). Open payment links from this device won't be recoverable from this backup.`
    : null;
  // v2.0 migration note: the SDK's exportAccount now also emits its own
  // `paymentRequests` (an ARRAY of serialized records). This spread
  // deliberately overwrites it with ppv2's envelope shape (an OBJECT
  // `{ requests: [...] }`) — ppv2 restores it itself via
  // restorePaymentRequestStateForChainCore on import, and the SDK's
  // importAccount guards with Array.isArray so the object is safely
  // ignored on the SDK side.
  const envelope: BackupEnvelope = { ...accountExport, paymentRequests };
  if (password) {
    const encrypted = await encryptAccountExportCore(address, chainId, envelope, password);
    return {
      serialized: JSON.stringify(encrypted, null, 2),
      encrypted: true,
      warning,
    };
  }
  // Plain backup uses Map-aware stringify for symmetry with the
  // encrypted path; `parseWithMaps` reverses it on import.
  return {
    serialized: stringifyWithMaps(envelope),
    encrypted: false,
    warning,
  };
}

export async function parseAccountBackupCore(
  store: PaymentRequestStateStore,
  address: string,
  chainId: number,
  rawPayload: string,
  password?: string,
): Promise<AccountExport> {
  let parsed: unknown;
  try {
    // Use the same Map-aware parser as the encrypted-plaintext branch
    // below so plain backups produced by the new code round-trip
    // through `paymentRequests` correctly. Plain backups from the old
    // code (or any JSON consumer) round-trip as-is.
    parsed = parseWithMaps(rawPayload);
  } catch {
    throw new Error('Backup is not valid JSON.');
  }

  if (!isPasswordEncryptedPayload(parsed)) {
    const envelope = parsed as BackupEnvelope;
    const accountExport = validateAccountExport(envelope);
    // Plain payloads have no wallet/chain metadata; the caller's
    // chainId is the only authority. Merge (don't replace) so an old
    // backup can't orphan newer local request links.
    await restorePaymentRequestStateForChainCore(store, chainId, envelope.paymentRequests, address);
    return accountExport;
  }

  // Encrypted payload — validate the embedded metadata BEFORE
  // decrypting and overwriting any local state. Importing a backup
  // signed for a different wallet or chain would silently park the
  // payment-request records under the wrong key.
  if (parsed.walletAddress.toLowerCase() !== address.toLowerCase()) {
    throw new Error(
      `This backup belongs to wallet ${parsed.walletAddress}. Connect that wallet to import.`,
    );
  }
  if (parsed.chainId !== chainId) {
    throw new Error(
      `This backup is for chainId ${parsed.chainId}, but you're currently on chain ${chainId}. Switch chains to import.`,
    );
  }

  if (!password) {
    throw new Error('This backup is password-protected. Enter your password to decrypt.');
  }

  let plaintext: string;
  try {
    plaintext = await decryptWithPassword(
      parsed.encryption.salt,
      parsed.encryption.iv,
      parsed.encryption.ciphertext,
      password,
      // Fixed KDF cost, exactly as every backup was written (the payload's
      // declared value is informational).
      PBKDF2_ITERATIONS,
    );
  } catch {
    throw new Error('Wrong password or corrupted backup.');
  }

  let decrypted: unknown;
  try {
    decrypted = parseWithMaps(plaintext);
  } catch {
    throw new Error('Decrypted backup is not valid JSON.');
  }

  const envelope = decrypted as BackupEnvelope;
  const accountExport = validateAccountExport(envelope);
  // Merge into local state — preserves any request links created on
  // this device after the backup was taken.
  await restorePaymentRequestStateForChainCore(store, chainId, envelope.paymentRequests, address);
  return accountExport;
}
