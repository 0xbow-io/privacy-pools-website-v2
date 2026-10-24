import { getVerifiedPoolAssociationSetLeaves } from '@/services/public-association-set';
import { setPendingRelayOwner } from '@/services/pending-relays-store';
import { canonicalizeExportTokenIds } from '@/services/canonical-token-id';
import { createChainLimiter, feedHasData, snapshotActivityFingerprint, snapshotScanComplete, sweepChains, waitForFeed, earliestScanOptions, type ChainStepResult } from '@/services/chain-sweep';

// How long a sweep waits for a chain's held event snapshot before deferring that
// chain to the feed grid (services/chain-sweep.ts waitForFeed).
const SNAPSHOT_READY_WAIT_MS = 15_000;
import {
  clearNoteSpendTimes,
  collectNoteSpendTimes,
  noteSpendTimesFor,
  parseStoredNoteSpendTimes,
  recordNoteSpendTimes,
  serializeNoteSpendTimes,
} from '@/services/note-spend-times';
import { feedLabelDecisions, LABEL_DECISIONS_MAX_AGE_MS, readLabelDecisions, type LabelDecisions } from '@/services/label-decision-feed';
import { useToast } from '@/components/toast-provider';
import { isRateLimitError } from '@/services/rpc-log-chunking';
import { feedData, publicFeeds } from '@/services/public-feed-scheduler';
import { feedEventSnapshot } from '@/services/snapshot-source';
import { feedAssociationSet } from '@/services/public-asp-cache';
import { usePublicFeed } from '@/hooks/use-public-feed';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { perfPhaseStart, perfPhaseEnd } from '@/services/perf-trace';
import { staleBundleMessage } from '@/services/stale-bundle';
import { withSessionInitTimeout } from '@/services/session-init-timeout';
import { describeErrorFrames, describeRpcError } from '@/services/rpc-error-text';
import { sessionResuming } from '@/services/session-resume';
import { Platform } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { ActivePoolSelection } from '@/config/pool-profile';
import { envScopedStorageKey } from '@/config/app-environment';
import { useQuery } from '@tanstack/react-query';
import { setErrorReportWallet } from '@/services/error-reports';
import { PASSKEY_EOA_CONNECTOR_ID } from '@/services/passkey-eoa/constants';
import { EMBEDDED_CONNECTOR_ID } from '@/services/embedded-wallet/connector';
import { useAccount, useConfig, usePublicClient, useReconnect, useSignTypedData } from 'wagmi';
import { COINBASE_SMART_WALLET_SIGNIN_MESSAGE, connectorIsKnownDeterministicSigner, contractWalletVerdict, isPlainEcdsaSignature, NON_DETERMINISTIC_SIGNER_MESSAGE, SMART_WALLET_SIGNIN_MESSAGE } from '@/services/signer-determinism';
import { passkeyUnlockDefault } from '@/services/passkey-policy';
import { smartWalletPasskeyEnabled } from '@/config/smart-wallet-passkey-flag';
import { passkeyRpIdFor } from '@/services/passkey-rp-id';
import { resolveNotePersistTarget } from '@/services/note-source';
import {
  accountExportIdentityVerdict,
  parkStoredValue,
  stampAccountExport,
  writeStoredValueVerified,
} from '@/services/account-export-identity';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import { isAddress } from 'viem';
import type { PoolSession, INoteManager, IKeystoreManager, AccountExport, Address, Hash, Hex } from '@/services/sdk-types';
import type { RpcNullifierProof } from '@/services/balance-crosscheck';
// Lazy-loaded to avoid pulling snarkjs/ffjavascript at page load
const getPoolSessionService = () => import('@/services/sdk-runtime');
const getSdkSetup = () => import('@/services/sdk-runtime');
import apiClient from '@/services/api-client';
import { accountKeyFingerprint, decodeAccountKey, encodeAccountKey, type AccountKeyIdentity } from '@/services/account-key';
import { registerDebugSnapshot } from '@/services/debug-snapshots';
import { getPasskeyPrf, createPasskey } from '@/services/passkey';
import { bumpPaymentRequestRevision } from '@/services/payment-request-revision';
import { useDebug, isDebugModeActive } from '@/components/debug-provider';
import { isStaleConnectorError, pruneBareRestoredConnection } from '@/services/stale-connector';
import { isWalletReconnectingError, signAfterReconnect, waitForReconnectSettled, WALLET_RECONNECTING_MESSAGE, walletErrorLine, type ReconnectStore } from '@/services/wallet-reconnect';
import { coinbaseTwoTapProof, CoinbaseConfirmNextTapError, isCoinbaseAppCannotSign, isCoinbaseInAppBrowser, isCoinbaseV4Failed, signTypedDataWithCoinbaseFallback } from '@/services/coinbase-typed-data-fallback';
import { BaseAppCannotSignError } from '@/services/base-app-passkey-choice';
import { isCoinbaseWalletIdentity, isWalletConnectConnector, requestWalletSignature, resolveWalletIdentity, walletProvider, type SignatureStage, type WalletConnector } from '@/services/wallet-signature-timeout';
import { useTxActivity } from '@/components/tx-activity-provider';
import { getChainConfig, isSupportedEvmChainId, queryableEvmChainIds, supportedChainIds } from '@/config/chains';
import { clearReceiveSetupForAddress, receiveSetupFromIdentity, setReceiveSetup } from '@/services/receive-setup';
import { keysBelongTo, pickStatusIdentity, readStatusWithRetry } from '@/services/keystore-status-read';
import { LEGACY_CONFIG } from '@/config/env';
import { resolveEntrypointChainConfig } from '@/services/entrypoint-resolution';
import { NoteStatus } from '@/services/sdk-types';
import { NATIVE_MOCK_ACTIVE } from '@/constants/native-mock';
import { getNativeMockSession } from '@/services/native-mock-data';
import { allowPaymentRequestWrites, purgePaymentRequestsOnSignOut } from '@/services/payment-request-signout';
import { signedOutOwner } from '@/services/payment-request-signout-purge';
import { noteManagerLimitedTo } from '@/services/batch-withdrawals';
import { assertDepositUnlock } from '@/services/deposit-unlock-guard';

// Key derivation now uses the SDK's canonical HKDF scheme via
// services/sdk-setup (buildSecretDerivationPayload +
// createKeystoreManagerFromSignature). The old hand-rolled keccak
// derivation was removed in the SDK 3a3f5f9 cutover.

// ---------------------------------------------------------------------------
// Circuit artifacts base URL (served alongside the app)
// ---------------------------------------------------------------------------

const CIRCUIT_ARTIFACTS_BASE_URL =
  typeof window !== 'undefined' ? `${window.location.origin}/artifacts` : '/artifacts';

// ---------------------------------------------------------------------------
// Cross-platform storage for account export persistence
// ---------------------------------------------------------------------------

// On web, use sessionStorage — the export contains every note's noteSecret
// in plaintext, so it must not outlive the tab. It survives refreshes within
// the tab but is gone when the tab closes; a new session simply re-discovers
// the notes from chain + ASP (the cache is a convenience, never the source
// of truth). On native, expo-secure-store persists encrypted data across app
// restarts via the platform keychain / keystore.
//
// One-time hygiene: migrate-by-deletion of any plaintext export an older
// build left in localStorage.

function purgeLegacyLocalStorageExports(): void {
  if (Platform.OS !== 'web') return;
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith('ppv2_account_export_')) stale.push(key);
    }
    stale.forEach((key) => localStorage.removeItem(key));
  } catch {
    // ignore
  }
}
purgeLegacyLocalStorageExports();



function storageRemoveItem(key: string): void {
  if (Platform.OS === 'web') {
    try {
      sessionStorage.removeItem(key);
    } catch {
      // ignore
    }
    return;
  }
  try {
    SecureStore.deleteItemAsync(key);
  } catch {
    // ignore
  }
}

// Only Sepolia has wallets registered under the pre-cutover keccak scheme;
// mainnet / new deployments never did, so the legacy-key migration shim in
// deriveKeystoreManager is gated to this chain.
const SEPOLIA_CHAIN_ID = 11155111;

// ---------------------------------------------------------------------------
// Wallet-less sign-in (account key)
// ---------------------------------------------------------------------------
// The derivation signature is deterministic, so it doubles as a portable
// sign-in secret: paste it in a fresh browser and the same keys (and notes)
// come back — withdraw/transfer are fully relayed, so no wallet is needed.
// Privacy upside per the product ask: a key-based session never reveals the
// note-owner wallet to the connected-wallet machinery at all.
// sessionStorage like the note cache — spend-grade secret, tab-scoped.

const IMPORTED_IDENTITY_STORAGE_KEY = 'ppv2_account_key_v1';

/**
 * The key source switched while a derivation was in flight, so the result was
 * discarded. EXPECTED, not a failure: signing in with an account key tears the
 * old session down and bumps the epoch, and anything that called
 * ensureInitialized() in that window lands here. Callers should retry rather
 * than tell the user something went wrong.
 */
export class KeySourceChangedError extends Error {
  readonly transient = true;
}

function loadImportedIdentity(): AccountKeyIdentity | null {
  if (Platform.OS !== 'web') return null;
  try {
    const raw = sessionStorage.getItem(IMPORTED_IDENTITY_STORAGE_KEY);
    if (!raw) return null;
    return decodeAccountKey(raw);
  } catch {
    return null;
  }
}

function persistImportedIdentity(identity: AccountKeyIdentity | null): void {
  if (Platform.OS !== 'web') return;
  try {
    if (identity) sessionStorage.setItem(IMPORTED_IDENTITY_STORAGE_KEY, encodeAccountKey(identity));
    else sessionStorage.removeItem(IMPORTED_IDENTITY_STORAGE_KEY);
  } catch {
    // Storage unavailable — the in-memory identity still works for this page.
  }
}

function sameAccountKeyIdentity(a: AccountKeyIdentity | null | undefined, b: AccountKeyIdentity | null | undefined): boolean {
  if (!a || !b) return false;
  return a.address.toLowerCase() === b.address.toLowerCase()
    && a.signature.toLowerCase() === b.signature.toLowerCase()
    && (a.legacySignature ?? '').toLowerCase() === (b.legacySignature ?? '').toLowerCase();
}

// ---------------------------------------------------------------------------
// Passkey (WebAuthn PRF) sign-in. When active, the keystore keys are derived
// from a passkey PRF instead of the wallet signature; the connected wallet
// still OWNS the account on-chain (registration / deposit / ragequit stay
// wallet-signed). Phishing-resistant spend keys without changing capabilities.
//
// The derivation salts (services/passkey.ts) and the design decision (plans/007)
// are FROZEN. Passkey is offered ONLY to smart-contract wallets, with no URL
// flag (config/smart-wallet-passkey-flag.ts)
// (Safe, Ambire, ...): they cannot produce the single ECDSA signature the wallet
// path derives from, so the passkey PRF is their one unlock. EOAs keep the
// wallet-signature sign-in unchanged and never see a passkey option, so nobody
// has to remember which of two unlocks they used (Pat, 2026-09-05; the
// previous rule, 2026-09-03, hid passkeys entirely). EXPO_PUBLIC_PASSKEY_PREVIEW=0
// turns the feature off for a build. services/passkey-policy.ts.
//
// IDENTITY CAVEAT (load-bearing — see the dual-unlock hazard): passkey-derived
// keys are a DIFFERENT keystore identity than wallet-signature keys for the same
// wallet (passkey feeds the raw PRF as appSecret; the signature path derives
// appSecret via HKDF over the signature, salted by the signer address). The
// on-chain nullifying key is write-once per owner address, and the local note
// cache is keyed by wallet address (not by source), so a wallet that already
// holds a signature-derived account cannot see or spend it in passkey mode, and
// notes created across the two modes commingle in one balance. Consistent for a
// fresh wallet that only ever uses passkey; the hazard is switching modes or a
// pre-existing signature account.
// On for every smart-contract wallet (config/smart-wallet-passkey-flag.ts);
// EXPO_PUBLIC_PASSKEY_PREVIEW=0 is a hard off for a build.
const passkeyUnlockEnabled = (): boolean => smartWalletPasskeyEnabled();
// One credential per (owner, RP ID). A single global marker used to be
// overwritten by whichever wallet unlocked last, so connecting Safe B evicted
// Safe A's only lookup key and A's next unlock CREATED a second credential and
// a different account (codex on PR #36). rpId: a credential only authenticates
// for the RP ID it was created under, so a hostname-era marker is not usable
// under the apex RP ID and a fresh create follows.
// One storage item per (owner, RP ID): `ppv2_passkey_cred_v2|<owner>|<rpId>` →
// credentialId. A whole-map read/modify/write let two tabs adding different
// owners overwrite each other's only lookup key, and a malformed blob wiped
// every owner at once (codex on PR #36); separate items cannot. First-time
// creation is serialized per (owner, RP ID) across tabs with the Web Locks API
// so two tabs cannot each mint a credential and a different account. A
// storage that refuses the write fails the unlock closed: nothing volatile
// stands in for a durable record (codex on PR #36).
const PASSKEY_CRED_PREFIX = 'ppv2_passkey_cred_v2|';
const LEGACY_PASSKEY_MARKER_KEY = 'ppv2_passkey_preview_v1';

type PasskeyMarker = { credentialId?: string; ownerAddress: string; rpId?: string };

function getRpId(): string {
  // Apex RP ID for every *.privacypools.com page (services/passkey-rp-id.ts).
  return passkeyRpIdFor(typeof window !== 'undefined' ? window.location?.hostname : undefined);
}

function randomChallenge(): Uint8Array {
  const b = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
  return b;
}

function passkeyMarkerKey(ownerAddress: string, rpId: string): string {
  return `${ownerAddress.toLowerCase()}|${rpId}`;
}

/** Moves the single hostname-era marker into its own item; the legacy key is removed only once the destination is verified. */
function migrateLegacyPasskeyMarker(): void {
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage?.getItem(LEGACY_PASSKEY_MARKER_KEY);
    if (!raw) return;
    const legacy = JSON.parse(raw) as Partial<PasskeyMarker>;
    if (typeof legacy?.ownerAddress === 'string' && typeof legacy.credentialId === 'string' && typeof legacy.rpId === 'string') {
      const item = PASSKEY_CRED_PREFIX + passkeyMarkerKey(legacy.ownerAddress, legacy.rpId);
      if (!window.localStorage.getItem(item)) window.localStorage.setItem(item, legacy.credentialId);
      if (!window.localStorage.getItem(item)) return; // destination not written: keep the legacy marker
    }
    window.localStorage.removeItem(LEGACY_PASSKEY_MARKER_KEY);
  } catch {
    // unreadable or unwritable: the legacy marker stays for a later attempt
  }
}

/** The credential recorded for this owner under this RP ID, if any. Null when the feature is off. */
function loadPasskeyMarkerFor(ownerAddress: string, rpId: string): PasskeyMarker | null {
  if (!passkeyUnlockEnabled()) return null;
  const key = passkeyMarkerKey(ownerAddress, rpId);
  let credentialId: string | undefined;
  if (typeof window !== 'undefined') {
    migrateLegacyPasskeyMarker();
    try {
      credentialId = window.localStorage?.getItem(PASSKEY_CRED_PREFIX + key) ?? undefined;
    } catch {
      credentialId = undefined;
    }
  }
  return credentialId ? { ownerAddress, credentialId, rpId } : null;
}

/**
 * Records this owner's credential under its RP ID (its own storage item, so
 * other owners are never rewritten). Returns false when the durable write
 * failed and the caller must refuse the unlock.
 */
function persistPasskeyMarker(marker: PasskeyMarker): boolean {
  const key = passkeyMarkerKey(marker.ownerAddress, marker.rpId ?? getRpId());
  if (typeof window === 'undefined') return false;
  try {
    const item = PASSKEY_CRED_PREFIX + key;
    if (marker.credentialId) window.localStorage?.setItem(item, marker.credentialId);
    else window.localStorage?.removeItem(item);
    return (window.localStorage?.getItem(item) ?? null) === (marker.credentialId ?? null);
  } catch {
    return false;
  }
}

export const PASSKEY_SETUP_ELSEWHERE_MESSAGE =
  'Passkey setup for this wallet is running in another tab. Finish it there, then tap Sign in again.';
export const PASSKEY_NO_LOCKS_MESSAGE =
  'This browser cannot run the passkey unlock (no Web Locks support). Use a current Chrome, Safari or Firefox.';
export const PASSKEY_STORAGE_MESSAGE =
  'This browser refused to store the passkey record (site storage disabled or full). Enable site storage and try again; nothing was set up.';

/**
 * Runs `fn` under a cross-tab Web Lock. A second tab does not queue behind
 * another tab's WebAuthn ceremony (that would wait indefinitely on a stuck
 * prompt and then assert outside the user's click): it is told to finish
 * there and tap again. No Web Locks means no cross-tab uniqueness, which is
 * an identity invariant here, so that fails closed too (codex on PR #36).
 */
async function withWebLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' && 'locks' in navigator ? navigator.locks : undefined;
  if (!locks) throw new Error(PASSKEY_NO_LOCKS_MESSAGE);
  return locks.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new Error(PASSKEY_SETUP_ELSEWHERE_MESSAGE);
    return fn();
  });
}

/**
 * Diagnostic print for module-level code (no hooks available here). Gated on
 * the same `ppv2_debug` flag the debug panel uses, so it is silent unless the
 * tester turned it on. Added while chasing why a wallet session and an
 * account-key session disagreed about which notes exist (Pat, 2026-09-01).
 */
function debugTrace(tag: string, payload: Record<string, unknown>): void {
  if (Platform.OS !== 'web') return;
  try {
    if (localStorage.getItem('ppv2_debug') !== '1') return;
    console.log(`[notes] ${tag}`, payload);
  } catch {
    /* storage unavailable — stay silent rather than break a read path */
  }
}

function accountExportKey(address: string, chainId: number): string {
  // v2 corresponds to the upstream SDK that requires a `noteAddressHash`
  // field on every Note. Bumping the key forces a clean re-discovery
  // for users whose locally-cached export pre-dates that schema. On
  // Sepolia testnet we accept the resync churn rather than backfill
  // each note's `Poseidon(ownerAddress, noteSecret)` client-side.
  //
  // A non-default pool selection gets its own slot: different pools' notes
  // must never share a cache, or switching would import the other pool's
  // notes into the wrong session.
  const poolSuffix = ActivePoolSelection
    ? `_${ActivePoolSelection.poolVault.slice(2, 10).toLowerCase()}`
    : '';
  // Environment-scoped too: prod and staging deploy different pools on the same
  // chain ids, so a chain-keyed export would load one world's notes into the
  // other's session (config/app-environment.ts).
  return envScopedStorageKey(`ppv2_account_export_v2_${address.toLowerCase()}_${chainId}${poolSuffix}`);
}

/**
 * Where a refused bucket is parked. Not deleted: the blob may hold notes that
 * were received out of band and cannot be rediscovered from chain, so a wrong
 * refusal must be recoverable rather than destructive.
 */
function mismatchedExportKey(address: string, chainId: number): string {
  return `${accountExportKey(address, chainId)}__mismatched`;
}

const accountExportStorage = {
  // Do not route account exports through the generic helpers above: those
  // intentionally swallow storage exceptions, so neither a quarantine copy
  // nor a primary write could be verified before the only other copy changed.
  // These operations surface failures to the verified parking/save policy.
  read: (key: string): string | null => (
    Platform.OS === 'web' ? sessionStorage.getItem(key) : SecureStore.getItem(key)
  ),
  write: (key: string, value: string): void => {
    if (Platform.OS === 'web') sessionStorage.setItem(key, value);
    else SecureStore.setItem(key, value);
  },
};

// Points spend times live beside the export they belong to (services/note-spend-times.ts).
function spendTimesKey(address: string, chainId: number): string {
  return `${accountExportKey(address, chainId)}__spend_times`;
}

export function loadStoredNoteSpendTimes(address: string, chainId: number): Map<string, number> {
  try {
    return parseStoredNoteSpendTimes(accountExportStorage.read(spendTimesKey(address, chainId)));
  } catch {
    return new Map();
  }
}

function saveStoredNoteSpendTimes(address: string, chainId: number): void {
  // A pass that outlived a wipe must not write the wiped times back.
  if (wipedAccountKeys.has(wipedAccountKey(address, chainId))) return;
  const times = noteSpendTimesFor(chainId, address);
  if (times.size === 0) return;
  try {
    accountExportStorage.write(spendTimesKey(address, chainId), serializeNoteSpendTimes(times));
  } catch {
    // A cache: the next discovery pass records them again.
  }
}

/**
 * Points spend times after a discovery pass, from the bulk note index that pass
 * refreshed: lookups only, never a request. Best effort; a missed pass leaves
 * the notes unknown until the next one.
 */
async function recordDiscoveredSpendTimes(
  chainId: number,
  address: string,
  notes: readonly { commitment: string; status: unknown }[],
  keystoreManager: IKeystoreManager,
): Promise<void> {
  try {
    const pool = getChainConfig(chainId)?.contracts?.poolAddress;
    if (!pool || notes.length === 0) return;
    const { latestPoolNoteIndex, createNoteComputationService } = await getSdkSetup();
    const index = latestPoolNoteIndex(chainId, String(pool));
    if (!index) return;
    const noteComp = await createNoteComputationService();
    if (wipedAccountKeys.has(wipedAccountKey(address, chainId))) return;
    const nullifyingKey = keystoreManager.getPrivateNullifyingKey();
    recordNoteSpendTimes(chainId, address, collectNoteSpendTimes(
      notes,
      (commitment) => noteComp.computeNullifier(nullifyingKey, commitment as Hash),
      (nullifier) => index.nullifierSpentAt(nullifier as Hash),
    ));
    saveStoredNoteSpendTimes(address, chainId);
  } catch {
    // Points only.
  }
}

export function loadStoredAccountExport(address: string, chainId: number): AccountExport | null {
  const primaryKey = accountExportKey(address, chainId);
  try {
    const raw = accountExportStorage.read(primaryKey);
    if (!raw) {
      debugTrace('export MISS', { address, chainId, key: primaryKey });
      return null;
    }
    const parsed = JSON.parse(raw) as AccountExport;
    debugTrace('export HIT', { address, chainId, key: primaryKey, notes: parsed?.notes?.length ?? 0 });
    // Does the CONTENT agree with the bucket it is filed under? A blob naming
    // another owner is one account's notes sitting in another's cache, and
    // every read of it renders as this account's balance and activity.
    // See services/account-export-identity.ts.
    const verdict = accountExportIdentityVerdict(parsed, { address, chainId });
    if (verdict.status === 'mismatch') {
      const parked = parkStoredValue(
        accountExportStorage,
        primaryKey,
        mismatchedExportKey(address, chainId),
        raw,
      );
      const parkingOutcome = parked === 'parked'
        ? 'parked for recovery'
        : parked === 'source-clear-failed'
          ? 'recovery copy verified; primary clear unverified'
          : `primary retained (${parked})`;
      console.warn(
        `[SDK] Refusing a stored export whose ${verdict.field} disagrees with its bucket; `
        + parkingOutcome,
      );
      return null;
    }
    // One spelling per token before the NoteManager sees them: notes written by
    // different paths can name the same token in different case, and the SDK
    // reduces a transact's inputs with a strict !==, so a mixture splits a
    // balance the user cannot reassemble. See services/canonical-token-id.ts.
    return canonicalizeExportTokenIds(parsed);
  } catch {
    console.warn('[SDK] Account export could not be read; preserving its bucket');
    return null;
  }
}

/**
 * Persist an export under (address, chainId), STAMPED with that identity.
 *
 * The single choke point every save goes through, which is the only place a
 * stamp can survive: exportState() returns just {notes, syncCursor} and
 * mergeImportedNote rebuilds the envelope from scratch, so a stamp applied at
 * any call site would be dropped by the next save. Throws when the write is
 * refused or cannot be verified, so callers cannot silently ignore a `false`
 * and then delete the only recovery secret.
 */
export function saveStoredAccountExport(input: AccountExport, address: string, chainId: number): void {
  // Canonical on the way in as well as out: a blob saved this session would
  // otherwise carry back whatever spelling the producing path used.
  const data = canonicalizeExportTokenIds(input);
  // A blob that names another owner is not this bucket's to hold. Refuse
  // rather than file it: this is the write that produced the leak, and one
  // skipped save is recoverable where a poisoned bucket is not.
  const verdict = accountExportIdentityVerdict(data, { address, chainId });
  if (verdict.status === 'mismatch') {
    console.warn(
      `[SDK] Refusing to save an export whose ${verdict.field} disagrees with its bucket`,
    );
    throw new Error('Account export identity does not match its storage bucket.');
  }

  const primaryKey = accountExportKey(address, chainId);
  const existingRaw = accountExportStorage.read(primaryKey);
  if (existingRaw) {
    let existing: unknown;
    let existingReadable = true;
    try {
      existing = JSON.parse(existingRaw);
    } catch {
      existingReadable = false;
    }
    if (!existingReadable) {
      // The raw value may still hold the only copy of out-of-band notes, so it
      // is preserved — but PARKED, not left in place. Throwing here instead
      // would refuse every future save for this bucket as long as the corrupt
      // value sits in it (a truncated write from a quota failure is the likely
      // cause), so one bad write would permanently stop this account from
      // persisting anything. Park it and continue.
      const parked = parkStoredValue(
        accountExportStorage,
        primaryKey,
        mismatchedExportKey(address, chainId),
        existingRaw,
      );
      if (parked !== 'parked') {
        console.warn(`[SDK] Refusing to overwrite an unreadable account export (${parked})`);
        throw new Error('The existing account export could not be read; it was preserved.');
      }
      console.warn('[SDK] Parked an unreadable account export before saving');
    }
    if (existingReadable) {
      const existingVerdict = accountExportIdentityVerdict(existing, { address, chainId });
      if (existingVerdict.status === 'mismatch') {
        const parked = parkStoredValue(
          accountExportStorage,
          primaryKey,
          mismatchedExportKey(address, chainId),
          existingRaw,
        );
        if (parked !== 'parked') {
          console.warn(`[SDK] Refusing to overwrite an unparked mismatched export (${parked})`);
          throw new Error('Could not preserve the mismatched account export before saving.');
        }
      }
    }
  }

  try {
    const serialized = JSON.stringify(stampAccountExport(data, { address, chainId }));
    if (!writeStoredValueVerified(accountExportStorage, primaryKey, serialized)) {
      throw new Error('Account export storage write could not be verified.');
    }
  } catch (err) {
    console.warn('[SDK] saveStoredAccountExport failed - local note cache is stale');
    throw err;
  }
}

// Explicitly remove a wallet's locally-cached notes for a chain. Used by the
// disconnect-confirmation flow when the user opts to wipe local notes. Note
// this only deletes the LOCAL cache — notes remain recoverable on-chain via a
// fresh discovery when the wallet reconnects.
export function clearStoredAccountExport(address: string, chainId: number): void {
  const primaryKey = accountExportKey(address, chainId);
  // Empty both values synchronously and verify the result. SecureStore only
  // exposes an async delete, which can race a reconnect and delete a newly
  // saved export after this function returns. Empty strings are treated as
  // absent by the loader and retain none of the note plaintext.
  const primaryCleared = writeStoredValueVerified(accountExportStorage, primaryKey, '');
  const quarantineCleared = writeStoredValueVerified(
    accountExportStorage,
    mismatchedExportKey(address, chainId),
    '',
  );
  const spendTimesCleared = writeStoredValueVerified(accountExportStorage, spendTimesKey(address, chainId), '');
  clearNoteSpendTimes(chainId, address);
  if (!primaryCleared || !quarantineCleared || !spendTimesCleared) {
    console.warn('[SDK] Could not verify the local account-export wipe');
  }
}

// Accounts the user intentionally wiped on disconnect. The provider has
// several autosave paths (the wallet-switch snapshot + the unmount cleanup)
// that would otherwise re-write the just-deleted cache from the still-live
// in-memory session during the disconnect transition, resurrecting the
// notes. Those paths skip any key in this set. An entry is cleared when a
// fresh session is deliberately built for that account again (reconnect).
const wipedAccountKeys = new Set<string>();
function wipedAccountKey(address: string, chainId: number): string {
  return `${address.toLowerCase()}:${chainId}`;
}
export function markAccountWiped(address: string, chainId: number): void {
  wipedAccountKeys.add(wipedAccountKey(address, chainId));
  clearStoredAccountExport(address, chainId);
}
// "identity:chainId" keys for holdings readiness (see syncedHoldings in the
// provider). Pure, so the setters can take them as functional updates and no
// memoized helper has to sit in the component.
function holdingsKey(identity: string, chainId: number): string {
  return `${identity.toLowerCase()}:${chainId}`;
}
function withHoldingsKey(prev: ReadonlySet<string>, identity: string | undefined, chainId: number): ReadonlySet<string> {
  if (!identity) return prev;
  const key = holdingsKey(identity, chainId);
  return prev.has(key) ? prev : new Set(prev).add(key);
}
function withoutHoldingsKey(prev: ReadonlySet<string>, identity: string, chainId: number): ReadonlySet<string> {
  const key = holdingsKey(identity, chainId);
  if (!prev.has(key)) return prev;
  const next = new Set(prev);
  next.delete(key);
  return next;
}

// Staging chains are PINNED, not resolved from the ASP feed — see the module
// header of services/entrypoint-resolution.ts for why (the chain-10 feed row
// shipped wrong, and the fallback would have made every OP deposit revert).


// TODO: Remove 64-char padStart once SDK normalizes hex values consistently.
function normalizeHashValue(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return `0x${BigInt(value).toString(16).padStart(64, '0')}`.toLowerCase();
  } catch {
    return value.toLowerCase();
  }
}

// Compare the active keystore identity to what's registered on-chain for this
// owner. The nullifying-key hash is write-once per address, so if it's already
// set to a DIFFERENT identity (e.g. the wallet registered under a passkey and
// is now in wallet mode, or vice versa), depositing would strand funds under an
// un-spendable identity. 'unknown' = couldn't read (fail-open, never blocks).
// 'partial' = auth policy set, viewing key not: can spend, can't receive.
export type KeystoreIdentityStatus = 'unknown' | 'unregistered' | 'compatible' | 'partial' | 'incompatible';

/**
 * The vendored SDK's note-status transition table (constant/NoteManager.ts).
 * Needed because the pre-session promotion pass writes statuses straight to
 * storage, where the SDK cannot police them: ACTIVE → PENDING in particular is
 * refused there, so persisting it would create a state the SDK never produces.
 * Kept as data next to the provider that needs it rather than reaching into the
 * bundle's internals.
 */
const SDK_STATUS_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  INACTIVE: new Set(['INACTIVE', 'PENDING', 'EXIT_PENDING', 'EXITED']),
  PENDING: new Set(['PENDING', 'ACTIVE', 'EXIT_PENDING', 'EXITED', 'REJECTED']),
  ACTIVE: new Set(['ACTIVE', 'SPENT', 'EXIT_PENDING', 'EXITED', 'REJECTED']),
  SPENT: new Set(['SPENT']),
  EXITED: new Set(['EXITED']),
  // EXIT_PENDING arrived with the audit stack's ragequit settling: a ragequit
  // log is only evidence once its block can no longer change, so the note waits
  // here rather than being written terminal on a log that may yet reorg out.
  // It is therefore NOT terminal in either direction — the exit settles
  // (EXITED), or it never happened and the note is spendable again (ACTIVE), or
  // the chain shows it spent instead (SPENT).
  EXIT_PENDING: new Set(['EXIT_PENDING', 'EXITED', 'ACTIVE', 'SPENT']),
  // A rejected note recovers to ACTIVE on
  // reapproval and reconciles to SPENT/EXITED from chain events.
  REJECTED: new Set(['REJECTED', 'ACTIVE', 'SPENT', 'EXIT_PENDING', 'EXITED']),
};

async function resolveKeystoreIdentityStatus(
  sdkSetup: Awaited<ReturnType<typeof getSdkSetup>>,
  km: IKeystoreManager,
  addr: `0x${string}`,
  chainId: number,
): Promise<KeystoreIdentityStatus> {
  try {
    const chain = getChainConfig(chainId);
    if (!chain?.contracts) return 'unknown';
    const rpc = sdkSetup.createRPCInteractor(chainId, Number(chain.contracts.fromBlock));
    const keystoreAddr = (LEGACY_CONFIG?.keystore ?? chain.contracts.keystoreAddress) as `0x${string}`;
    const ks = sdkSetup.createKeystoreInteractor(
      rpc,
      keystoreAddr,
      chain.contracts.keystoreFromBlock ?? chain.contracts.fromBlock,
    );
    const n = await ks.getNullifyingKeyHash(addr);
    if (!n || BigInt(n) === 0n) return 'unregistered';
    const hashService = await sdkSetup.createHashService();
    const activeNull = String(hashService.hash([km.getPrivateNullifyingKey()])).toLowerCase();
    if (String(n).toLowerCase() !== activeNull) return 'incompatible';
    // A failed read falls through to 'unknown', never to 'compatible'.
    const v = await ks.getViewingKey(addr);
    if (!v || BigInt(v) === 0n) return 'partial';
    // A nonzero on-chain key is not necessarily THIS session's key — a stale
    // registration from a prior unlock reads as nonzero too. Only the exact
    // match is 'compatible'; anything else can't be discovered by this
    // session's viewing key, so it's still 'partial'.
    const activeView = km.getViewingKeyPair().publicKey.toLowerCase();
    return String(v).toLowerCase() === activeView ? 'compatible' : 'partial';
  } catch {
    return 'unknown'; // sign-in and discovery stay available; write guards reject unknown
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

interface SdkContextValue {
  poolSession: PoolSession | null;
  /** Committed (address, chainId) of the LIVE session — null while none. */
  sessionTarget: { address: string; chainId: number } | null;
  noteManager: INoteManager | null;
  keystoreManager: IKeystoreManager | null;
  isInitialized: boolean;
  isInitializing: boolean;
  /** No session yet, but one is about to be rebuilt without a prompt: a
   *  wallet whose derivation signature this tab proved. Never true for an
   *  account key (services/session-resume.ts). */
  sessionResuming: boolean;
  error: string | null;
  exportAccount: (sessionOverride?: PoolSession | null, opts?: { chainId?: number }) => Promise<AccountExport | null>;
  importAccount: (data: AccountExport) => Promise<void>;
  initializeKeys: () => Promise<void>;
  ensureInitialized: () => Promise<PoolSession>;
  // Synchronously read the managers committed by the most recent
  // createSession. Safe right after `await ensureInitialized()` even on the
  // first run, when render-captured noteManager/keystoreManager are still stale.
  getCommittedManagers: () => { noteManager: INoteManager | null; keystoreManager: IKeystoreManager | null };
  /** Build/cache a batch-withdrawal session bound to the PrivacyPoolRelay
   *  processor (finding 1). Null until the main session is committed. */
  getBatchWithdrawSession: (onlyInputs?: ReadonlySet<string>) => Promise<PoolSession | null>;
  /** Build/cache a relayer-less session for the disclosed (self-submit)
   *  transfer, so prepareTransfer skips its unconditional relayer quote
   *  (DEV-370). Null until the main session is committed. */
  getSelfSubmitTransferSession: () => Promise<PoolSession | null>;
  /**
   * One-shot session PAIR for a cross-chain reshield (flow 4): the source-chain
   * session with the destination pool attached (it estimates, quotes and
   * relays), plus a plain session on the destination chain, which is the only
   * place the resulting note can be persisted — `relayReshieldCrosschain`
   * records the spent inputs and the source-side change, and nothing on the far
   * side. Null when the pair is not routable or no session is committed.
   */
  createReshieldCrosschainSessions: (args: {
    destinationChainId: number;
  }) => Promise<{ source: PoolSession; destination: PoolSession } | null>;
  /**
   * A session for ANOTHER chain, without moving the app to it.
   *
   * Registration is per chain, and a cross-chain reshield deposits on the far
   * side: an account registered on mainnet and not on BNB signs a swap whose
   * destination deposit cannot land, and LiFi pays the bridged tokens to the
   * fallback address instead. Asking the far chain whether this account is
   * registered, and registering it there, both need a session for that chain
   * while the user stays on the form they are filling in here.
   *
   * Null when nothing is committed or the chain is not served.
   */
  sessionForChain: (chainId: number) => Promise<PoolSession | null>;
  /** One-shot session for a cross-chain swap-and-deposit: pool on
   *  `poolChainId`, wallet + pay token on `sourceChainId`. Null when the pair
   *  is not routable or no session is committed. */
  createCrossChainShieldSession: (args: {
    poolChainId: number;
    sourceChainId: number;
    walletInteractor: unknown;
  }) => Promise<PoolSession | null>;
  keysReady: boolean;
  notesRevision: number;
  /**
   * Commitments of notes local state calls EXITED but no finalized chain
   * ragequit event corroborates. An `EXITED` status can arrive from an
   * unauthenticated ASP snapshot row, and it is terminal — the note leaves the
   * recoverable total and drops out of the exit list, while staying spendable
   * on chain. The UI keeps offering these; nothing rewrites their status.
   * See `services/unconfirmed-exits.ts`.
   */
  unconfirmedExitCommitments: ReadonlySet<string>;
  /** Drop one commitment from the offered set, after its exit is confirmed on chain. */
  clearUnconfirmedExit: (commitment: string) => void;
  refreshNotes: () => void;
  syncFromSnapshot: () => Promise<{ depositsFound: number; spent: number; exited: number } | null>;
  /** Discovery across every EVM chain this build serves, not just the active one. */
  syncAllChains: (primaryOpts?: { fromBlock?: string }) => Promise<{ depositsFound: number; spent: number; exited: number } | null>;
  isSyncing: boolean;
  /** Chains of the current all-chain sweep not yet finished (0 when idle). */
  syncChainsLeft: number;
  /** "identity:chainId" keys whose note discovery SUCCEEDED this session, identity lower-cased. */
  syncedHoldings: ReadonlySet<string>;
  /** Association-set leaves (normalized label hashes) for the active pool. A
   *  note is only spendable once its label leaf is published, so this gates the
   *  home balance the same way the withdraw flow does. */
  associationSetLeaves: string[];
  /** Newer rejection/POI decisions override published membership. */
  blockedLabelHashes: string[] | undefined;
  blockedLabelsError: string | null;
  /** True once the leaves query has succeeded (distinguishes a loaded-empty set
   *  from "not loaded yet" so the gate doesn't wrongly trust ACTIVE on an empty set). */
  associationSetLeavesReady: boolean;
  /** Stable identity of the chain/pool/root query that produced the current leaves. */
  associationSetLeavesScopeKey: string;
  /** Terminal verification/fetch failure; null while loading or after success. */
  associationSetLeavesError: string | null;
  /** Retry the shared, root-verifying association-set query. */
  retryAssociationSetLeaves: () => void;
  // Wallet-less sign-in (account key):
  /** 'wallet' = wagmi connection; 'key' = imported account key; null = neither. */
  identityMode: 'wallet' | 'key' | null;
  /** The address owning the session's notes (wallet or imported key). */
  sessionAddress: string | null;
  /** accountKeyFingerprint of the imported key in a 'key' session, else null. */
  keyFingerprint: string | null;
  /** Encode the current identity as a portable account key (may prompt a signature in wallet mode). */
  exportAccountKey: () => Promise<string>;
  /** Sign in from a pasted account key and build the session. */
  signInWithAccountKey: (encoded: string) => Promise<void>;
  /** Drop the imported account key and tear the session down. */
  signOutAccountKey: () => void;
  // Passkey (WebAuthn PRF) preview — keys derived from a passkey instead of the
  // wallet signature; the connected wallet still owns the account on-chain.
  /** Whether the passkey unlock is built into this app at all (on unless EXPO_PUBLIC_PASSKEY_PREVIEW=0). */
  passkeyPreviewEnabled: boolean;
  /** The connected address is a smart-contract wallet: its unlock is the passkey, never a wallet signature. */
  isSmartWallet: boolean;
  /** The smart-wallet probe has answered (or failed, or is not needed) for the connected address on this chain. */
  smartWalletProbeSettled: boolean;
  /** Passkey mode is currently active (keys sourced from a passkey). */
  passkeyActive: boolean;
  /** The connected wallet proved it signs non-deterministically, so the signature path cannot work for it. */
  signerRefusedDerivation: boolean;
  /** Offer that wallet the passkey instead (no-op unless the refusal was actually observed). */
  choosePasskeyForRefusedSigner: () => void;
  /**
   * The Base / Coinbase app signer failed sign-in for the connected address this
   * session: the dialog asks the user to use another wallet.
   */
  baseAppCannotSign: boolean;
  /** Active keystore identity vs the on-chain registration for this owner. */
  keystoreIdentityStatus: KeystoreIdentityStatus;
  /** Throws if the active identity can't deposit (registered under a different unlock). Fresh on-chain re-check. */
  /** Pass the chain the WRITE will execute on so a session bound to a
   *  different chain can never authorize it (codex P1: store-vs-connector
   *  chain split could send Sepolia calldata on mainnet). */
  assertCanDeposit: (writeChainId?: number) => Promise<void>;
  /**
   * The committed identity's registration on ANY supported EVM chain, without
   * building a session there. Registration is per chain, and the per-chain
   * answer is the same four-way read the deposit guard makes
   * (resolveKeystoreIdentityStatus): one keystore RPC read plus a local hash,
   * so 'incompatible' (registered here under a different unlock) is told apart
   * from 'unregistered'. 'unknown' when no session is committed or the read
   * failed; it never throws.
   */
  keystoreStatusForChain: (chainId: number) => Promise<KeystoreIdentityStatus>;
}

const SdkContext = createContext<SdkContextValue | null>(null);

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function SdkProvider({ children }: { children: React.ReactNode }) {
  const { address, isConnected, status: accountStatus, connector: activeConnector } = useAccount();
  // The chain every identity/session operation binds to: key derivation
  // (incl. the Sepolia legacy-keccak scheme shim), the write-once keystore
  // identity guard, session keys and RPC reads. The derivation lives in
  // useSessionChainId (connector chain → app EVM selection → store) so the
  // consumers of the session's per-chain storage — use-notes, account
  // recovery, the disconnect warning — key off the SAME chain the session
  // writes; they used to read raw useChainId() (the wagmi config store,
  // which initializes to the first configured chain on staging) and could
  // address a different chain's storage bucket than the live session.
  const chainId = useSessionChainId();
  const chainPublicClient = usePublicClient({ chainId });
  const configuredPoolAddress = (LEGACY_CONFIG?.pool ?? getChainConfig(chainId)?.contracts?.poolAddress)?.toLowerCase();
  const { signTypedDataAsync } = useSignTypedData();
  // Used to heal a connection restored from storage whose connector has not been
  // re-created yet (EIP-6963 announcement race).
  const { reconnectAsync } = useReconnect();
  const wagmiConfig = useConfig();
  // Live connector/status for the async paths below: reading the render snapshot
  // inside a promise chain reports whatever was true when the callback was built,
  // which is exactly the wrong thing when diagnosing a connection that changed.
  const activeConnectorRef = useRef(activeConnector);
  const accountStatusRef = useRef(accountStatus);
  useEffect(() => {
    activeConnectorRef.current = activeConnector;
    accountStatusRef.current = accountStatus;
  }, [activeConnector, accountStatus]);
  const { log } = useDebug();
  const { txPending } = useTxActivity();

  // Wallet-less sign-in: an imported key, when present, IS the session
  // identity — a connected wallet then acts as the PAYER (it can fund
  // deposits into the key account) without ever becoming the session. With
  // no key, the wallet is the session as before.
  const [importedIdentity, setImportedIdentity] = useState<AccountKeyIdentity | null>(() => loadImportedIdentity());
  const walletActive = isConnected && !!address;
  const keyIdentity = importedIdentity;
  const effectiveAddress = keyIdentity?.address ?? (walletActive ? address : undefined);
  // Discovery passes that SUCCEEDED this session, keyed by the identity they
  // ran for plus the chain: the signal pools-provider turns into holdingsReady
  // (are the holdings on the active chain known, or merely not loaded yet).
  // Identity-scoped so account B never inherits account A's readiness and a
  // late completion for A cannot mark B; success-only because a failed
  // discovery is no evidence that the account holds nothing (codex P2 x2 on
  // 3b6fea4).
  const [syncedHoldings, setSyncedHoldings] = useState<ReadonlySet<string>>(() => new Set());
  const identityMode: 'wallet' | 'key' | null = keyIdentity ? 'key' : walletActive ? 'wallet' : null;
  const keyFingerprint = useMemo(() => (keyIdentity ? accountKeyFingerprint(keyIdentity) : null), [keyIdentity]);
  // Signatures captured during wallet-mode derivation, so Export Account Key
  // doesn't have to re-prompt. In-memory only.
  const capturedSigsRef = useRef<{ address: string; signature?: `0x${string}`; legacySignature?: `0x${string}` } | null>(null);
  // Signatures a derivation actually COMMITTED keys from, so switching chains
  // does not re-prompt the wallet for a byte-identical signature (Mike, QA
  // 2026-09-21). Sound because the derivation payload carries no chainId
  // (services/sdk-setup.ts: domain is {name, version, verifyingContract: 0x0,
  // salt}) — the same wallet on any chain signs the same bytes.
  //
  // Deliberately NOT `capturedSigsRef`, which is written before the derivation
  // proves anything: only a signature that produced committed keys, passed the
  // determinism proof and was not refused lands here. And deliberately NOT a
  // retained keystoreManager: the derivation does per-chain work around the
  // signature — the Sepolia keccak/HKDF scheme shim, the on-chain identity
  // status, the contract-wallet probe — and skipping THAT would carry a legacy
  // Sepolia manager onto mainnet (and vice versa). So the derivation still runs
  // in full on every chain; only the wallet prompt is skipped.
  //
  // In-memory only, cleared when the address changes or the wallet is caught
  // signing non-deterministically.
  const provenSigsRef = useRef<{ address: string; signature: `0x${string}`; legacySignature?: `0x${string}` } | null>(null);
  // Its address, as state, for `sessionResuming`. Written beside every ref write.
  const [provenAddress, setProvenAddress] = useState<string | null>(null);
  // True only while the promptless chain-switch derivation runs. Any branch
  // that would open a wallet prompt must refuse instead: nobody clicked, so a
  // prompt appearing out of nowhere is worse than falling back to the unlock
  // dialog (which is what a refusal here produces, since keys stay uncommitted).
  const silentDeriveRef = useRef<boolean>(false);

  // Passkey (preview): when active, keystore keys come from a passkey PRF
  // instead of the wallet signature. The wallet still owns the account, so
  // identityMode/effectiveAddress are unchanged — only the key SOURCE differs.
  const [passkeyActive, setPasskeyActive] = useState<boolean>(false);
  const passkeyModeRef = useRef<boolean>(false);
  // Which source produced the currently-committed keystore manager, so a
  // mode switch forces a re-derive even if `keysReady` is still true.
  const keystoreSourceRef = useRef<'signature' | 'passkey' | null>(null);
  // The `${address}:${chainId}` the committed manager was derived FOR. The
  // cache hit in deriveKeystoreManager reads `keysReady`/`keystoreManager` out
  // of a closure, and on the render where the chain changes those still hold
  // the previous chain's values (the teardown's setState lands next render).
  // Without this check a caller in that window is handed the old chain's
  // manager — which on staging means a Sepolia keccak manager building a
  // mainnet session. A ref is written synchronously at commit, so it is the
  // only thing in that comparison that cannot be stale.
  const keystoreTargetRef = useRef<string | null>(null);
  useEffect(() => { passkeyModeRef.current = passkeyActive; }, [passkeyActive]);
  // Smart-contract wallet at the connected address (code present, not an
  // EIP-7702 delegation). Probed AHEAD of the unlock click so the passkey
  // branch can still be the first awaited op inside the click's user
  // activation. The verdict is keyed by address:chain, so a wallet or chain
  // change reads as "not probed" (false) until its own probe lands; a failed
  // probe stays false (the wallet path re-probes, and the SDK's 65-byte check
  // is the enforcement). No synchronous setState in the effect: the key does
  // the reset, the async result does the only write.
  const smartWalletKey = address && !keyIdentity ? `${address.toLowerCase()}:${chainId}` : null;
  // Fixed for the page's lifetime (config/smart-wallet-passkey-flag.ts): a
  // flag change needs a reload, so mode and flag cannot drift apart.
  const passkeyFeatureOn = passkeyUnlockEnabled();
  const [smartWalletProbe, setSmartWalletProbe] = useState<{ key: string; smart: boolean } | null>(null);
  // Wallets caught returning two different signatures for the same payload,
  // lowercased. Address-keyed, so the offer never follows the user to another
  // wallet, and in-memory only: a refusal is a fact about this connection, and
  // a wallet that gets fixed (firmware, a different app) deserves the
  // signature path back on the next page load.
  const [refusedSigners, setRefusedSigners] = useState<ReadonlySet<string>>(() => new Set());
  // Set when the user takes the offer. Separate from the observation above so
  // hitting the error does not silently change the unlock under them: the
  // dialog shows a choice, and this is the choice.
  const [passkeyForSigner, setPasskeyForSigner] = useState<string | null>(null);
  const signerRefusedDerivation = !!address && refusedSigners.has(address.toLowerCase());
  // Base / Coinbase app signers that failed sign-in this session (in memory: a
  // fixed Base app gets the signature path back on the next load).
  const [baseAppRefused, setBaseAppRefused] = useState<ReadonlySet<string>>(() => new Set());
  const passkeyChosenForSigner = !!address && passkeyForSigner === address.toLowerCase();
  const isSmartWallet = !!smartWalletKey && smartWalletProbe?.key === smartWalletKey && smartWalletProbe.smart;
  // The failure reports name the KIND of wallet and its connector id, both
  // folded onto allowlists in services/error-reports-failure.ts. No address.
  const errorReportConnectorId = isConnected ? activeConnector?.id : undefined;
  // eoa only once the probe answered "not a contract" for this wallet.
  const errorReportWalletVerifiedEoa = !!smartWalletKey && smartWalletProbe?.key === smartWalletKey && !smartWalletProbe.smart;
  useEffect(() => {
    const kind = !isConnected
      ? 'unknown'
      : errorReportConnectorId === PASSKEY_EOA_CONNECTOR_ID
        ? 'passkey'
        : errorReportConnectorId === EMBEDDED_CONNECTOR_ID || isSmartWallet
          ? 'smart'
          : errorReportWalletVerifiedEoa
            ? 'eoa'
            : 'unknown';
    setErrorReportWallet(kind, errorReportConnectorId);
  }, [isConnected, errorReportConnectorId, isSmartWallet, errorReportWalletVerifiedEoa]);
  const smartWalletProbeRef = useRef<{ key: string; smart: boolean } | null>(null);
  // A Base refusal is a fact about THAT connection: another wallet on the same
  // address starts clean.
  useEffect(() => {
    setBaseAppRefused((prev) => (prev.size ? new Set() : prev));
  }, [address, activeConnector]);
  // DEV-427: addresses whose v4 sign-in the Coinbase app already failed (or the
  // user cancelled) this session; their next tap asks with v3 instead.
  const coinbaseV4FailedRef = useRef<Set<string>>(new Set());
  // The v3 signature from the previous tap, waiting for its determinism proof
  // (the next tap's signature). Keyed by address.
  const coinbaseProofPendingRef = useRef<Map<string, `0x${string}`>>(new Map());
  useEffect(() => { smartWalletProbeRef.current = smartWalletProbe; }, [smartWalletProbe]);
  useEffect(() => {
    if (!passkeyFeatureOn || !smartWalletKey || !address || !chainPublicClient) return;
    let cancelled = false;
    chainPublicClient.getCode({ address: address as `0x${string}` })
      .then((code) => {
        if (!cancelled) setSmartWalletProbe({ key: smartWalletKey, smart: contractWalletVerdict(code) === 'contract' });
      })
      .catch(() => { if (!cancelled) setSmartWalletProbeFailedKey(smartWalletKey); /* fail open: see above */ });
    return () => { cancelled = true; };
  }, [passkeyFeatureOn, smartWalletKey, address, chainPublicClient]);
  // DEV-522: the auto sign-in after connect must not start a wallet signature
  // before this probe has answered, or a smart wallet gets the signature path
  // (and a WebAuthn call with no user activation) instead of the dialog.
  const [smartWalletProbeFailedKey, setSmartWalletProbeFailedKey] = useState<string | null>(null);
  const smartWalletProbeSettled = !passkeyFeatureOn || !smartWalletKey || !chainPublicClient
    || smartWalletProbe?.key === smartWalletKey || smartWalletProbeFailedKey === smartWalletKey;


  const [poolSession, setPoolSession] = useState<PoolSession | null>(null);
  // The COMMITTED identity of the live session — the (address, chainId) it
  // was created with, stored alongside it (codex P1 on 4b2202a). The render's
  // `chainId` is the DESIRED target and moves synchronously with the
  // connector, while `poolSession` stays the old object until the reset
  // effect runs — in that window, persisting under the render's chainId
  // saves chain A's export into chain B's bucket, overwriting B-only notes.
  // Everything that persists FROM the live session must key on this instead.
  const [sessionTarget, setSessionTarget] = useState<{ address: string; chainId: number } | null>(null);
  const [noteManager, setNoteManager] = useState<INoteManager | null>(null);
  const [keystoreManager, setKeystoreManager] = useState<IKeystoreManager | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  // Covers a whole multichain sweep; the context reports the two ORed so the
  // spinner never blinks between the sweep's phases.
  const [isSyncingAll, setIsSyncingAll] = useState(false);
  const [syncChainsLeft, setSyncChainsLeft] = useState(0);
  // Scheduled discovery passes in flight. A ref, not state: they must not
  // show as syncing, only hold note promotion back while they run.
  const backgroundDiscoveryRef = useRef(0);
  const [error, setError] = useState<string | null>(null);
  const [keysReady, setKeysReady] = useState(false);
  const [keystoreIdentityStatus, setKeystoreIdentityStatus] = useState<KeystoreIdentityStatus>('unknown');
  const [notesRevision, setNotesRevision] = useState(0);
  // Empty is the correct default and the correct fallback: with no chain view,
  // nothing is claimed either way, and the exit list stays exactly as it was.
  const [unconfirmedExitCommitments, setUnconfirmedExitCommitments] =
    useState<ReadonlySet<string>>(() => new Set<string>());
  const clearUnconfirmedExit = useCallback((commitment: string) => {
    setUnconfirmedExitCommitments((prev) => {
      if (!prev.has(commitment)) return prev;
      const next = new Set(prev);
      next.delete(commitment);
      return next;
    });
  }, []);

  // Track current params to detect changes and avoid stale closures
  const sessionKeyRef = useRef<string>('');
  const keyInitPromiseRef = useRef<Promise<IKeystoreManager> | null>(null);
  const ensureInitPromiseRef = useRef<Promise<PoolSession> | null>(null);
  const initTargetRef = useRef<string>('');
  // Bumped on every wallet/chain reset AND every key-source switch (wallet
  // signature <-> passkey). A derivation captures the epoch at start and
  // commits its KM/session only if the epoch still matches — so a derivation
  // (or biometric prompt) in flight when the source/target changed can never
  // commit a stale or wrong-source manager. See deriveKeystoreManager/createSession.
  const deriveEpochRef = useRef<number>(0);
  // The last committed session's note manager + owner, so the targetKey reset
  // can snapshot its notes to localStorage (keyed by that address) before
  // tearing down in-memory state — nothing unsaved is lost on a wallet switch.
  const committedSessionRef = useRef<{ address: string; chainId: number; noteManager: INoteManager; keystoreManager: IKeystoreManager } | null>(null);

  // Resolved build params of the most-recent main session, so a batch
  // withdrawal can build a sibling session that binds proofs to the
  // PrivacyPoolRelay contract (see getBatchWithdrawSession). Captured at commit
  // time because the addresses are resolved inside createSession, not props.
  const batchSessionParamsRef = useRef<{
    key: string;
    ownerAddress: Address;
    chainId: number;
    entrypointAddress: Address;
    poolAddress: Address;
    keystoreAddress: Address;
    deploymentBlock?: number;
  } | null>(null);
  // Cache one batch session per committed key (its async setup is non-trivial).
  const batchSessionRef = useRef<{ key: string; session: PoolSession } | null>(null);
  // Same, for the disclosed (self-submit) transfer session — see
  // getSelfSubmitTransferSession.
  const selfSubmitSessionRef = useRef<{ key: string; session: PoolSession } | null>(null);

  // Passkey is the DEFAULT unlock for a connected WALLET session — but ONLY for
  // a wallet that either already has a passkey (local marker) or has NO on-chain
  // account yet. A wallet already registered with a different (e.g. signature)
  // key set must NOT default to passkey: forcing it would create a throwaway
  // credential and then fail the owner-match on every unlock. So we preflight
  // the on-chain nullifying key OUTSIDE the WebAuthn path (no gesture) and only
  // enable passkey-create for a fresh owner. Never for account-key sessions.
  // Does NOT auto-assert — the first protected action's seed-modal tap drives it.
  // Full teardown for a key-source switch: invalidate in-flight work AND drop
  // every committed/in-memory manager + session so nothing stale (wrong source)
  // can be reused or committed. Same semantics used by signIn/disable.
  const teardownSourceSwitch = useCallback(() => {
    deriveEpochRef.current += 1;
    keyInitPromiseRef.current = null;
    ensureInitPromiseRef.current = null;
    setIsSyncing(false);
    setIsSyncingAll(false);
    setSyncChainsLeft(0);
    setIsInitializing(false); // the orphaned initializer can no longer clear it (codex on PR #36)
    sessionKeyRef.current = '';
    // The cached receive-setup state belongs to the OLD unlock source's
    // keystore identity. Same address, different keys on the next derivation
    // — a stale complete/partial here would answer for a wallet it did not
    // derive.
    if (effectiveAddress) clearReceiveSetupForAddress(effectiveAddress);
    keystoreSourceRef.current = null;
    committedSessionRef.current = null;
    // Sibling sessions hold these managers; drop them with the session.
    batchSessionRef.current = null;
    selfSubmitSessionRef.current = null;
    setKeysReady(false);
    setKeystoreManager(null);
    setKeystoreIdentityStatus('unknown');
    setPoolSession(null);
      setSessionTarget(null);
    setNoteManager(null);
    // Per-identity, like everything else dropped here. Empty is the safe value:
    // it claims nothing, so the exit list behaves exactly as it did before.
    setUnconfirmedExitCommitments(new Set<string>());
    setIsInitialized(false);
  }, [effectiveAddress, setIsInitializing, setIsSyncing, setIsSyncingAll]);

  useEffect(() => {
    // Passkey is the unlock for a smart-contract wallet and for nothing else
    // (services/passkey-policy.ts). Does NOT auto-assert (no gesture); the
    // first protected action's unlock-dialog tap drives create-or-sign-in.
    const enabled = passkeyUnlockDefault({
      enabled: passkeyFeatureOn,
      isSmartWallet,
      hasKeyIdentity: !!keyIdentity,
      supportedChain: isSupportedEvmChainId(chainId),
      hasAddress: !!address,
      signerRefusedDerivation: passkeyChosenForSigner,
    });
    if (passkeyModeRef.current === enabled) return;
    // Nothing committed yet (first unlock still deriving, or never unlocked):
    // there is no stale source to tear down, and bumping the epoch here would
    // discard a passkey the click path is about to produce (codex on PR #36).
    if (keystoreSourceRef.current !== null) teardownSourceSwitch(); // source switch → full teardown
    passkeyModeRef.current = enabled;
    setPasskeyActive(enabled);
  }, [address, keyIdentity, chainId, isSmartWallet, passkeyFeatureOn, passkeyChosenForSigner, teardownSourceSwitch]);

  const refreshNotes = useCallback(() => {
    setNotesRevision((revision) => revision + 1);
  }, []);

  // Rejection or POI can change without rotating the association-set root, so
  // these are their own feed — on the scheduler's grid, not a query. The poll
  // this replaces paused while txPending, which told the ASP when this client
  // was signing; the pause is gone because the poll is gone.
  const blockedLabelsFeed = usePublicFeed<LabelDecisions>(feedLabelDecisions(chainId));
  const blockedDecisions = feedData(blockedLabelsFeed);
  const blockedLabelHashes = useMemo(
    // Memoized on the feed state: use-leaf-gate puts this array in a
    // JSON.stringify computation key, and a fresh array per render would spin
    // its hashing effect.
    () => (blockedDecisions ? [...blockedDecisions.rejected, ...blockedDecisions.poiRequired] : undefined),
    [blockedDecisions],
  );
  // One failed tick is not an outage: the scheduler keeps the last good
  // decisions and readLabelDecisions honours them until they age out. Keying
  // ready/error on the status alone blanked every withdraw balance ("Shielded
  // balance unavailable") whenever a single refresh failed, e.g. a rate-limited
  // one. Fresh last-good decisions count as ready; only stale ones are an error.
  // Read with the age bound on every render, success or error: a paused
  // scheduler must not keep an old snapshot spendable. The timer re-renders at
  // the moment the current snapshot ages out, so nothing waits on the next tick.
  const [, setDecisionExpiryTick] = useState(0);
  const blockedLabelsRead = readLabelDecisions(blockedLabelsFeed, Date.now());
  const blockedLabelsFresh = blockedLabelsRead.ok;
  const blockedLabelsExpiresInMs = blockedLabelsRead.ok ? LABEL_DECISIONS_MAX_AGE_MS - blockedLabelsRead.ageMs : null;
  useEffect(() => {
    if (blockedLabelsExpiresInMs === null) return;
    const timer = setTimeout(() => setDecisionExpiryTick((n) => n + 1), Math.max(0, blockedLabelsExpiresInMs) + 50);
    return () => clearTimeout(timer);
  }, [blockedLabelsExpiresInMs === null, blockedLabelsFeed]); // eslint-disable-line react-hooks/exhaustive-deps
  const blockedLabelsReady = blockedLabelsFresh;
  // Note promotion writes statuses, so it keeps demanding a successful answer
  // this tick rather than a cached one (see the effect below).
  const blockedLabelsSucceeded = blockedLabelsFeed.status === 'ready';
  const blockedLabelsError = blockedLabelsFeed.status === 'error' && !blockedLabelsFresh ? blockedLabelsFeed.error : null;

  // The association set's root as the feed grid last read it, with the leaves
  // for that root in the shared cache (services/public-asp-cache.ts). Reading
  // either is a cache read: the root probe used to be a 60s poll keyed to the
  // selected chain, so switching chains, and the poll's own phase, decided
  // when the ASP heard from this client.
  const associationSetFeed = usePublicFeed<string | null>(feedAssociationSet(chainId));
  const associationSetRoot = feedData(associationSetFeed) ?? undefined;
  // The grid answered without a root: its probe failed, or the refresh did.
  const associationSetRootFailed = associationSetFeed.status !== 'empty' && associationSetRoot === undefined;

  const associationSetLeavesScopeKey = JSON.stringify([
    chainId,
    configuredPoolAddress ?? '',
    associationSetRoot ?? 'no-root',
  ]);
  const {
    data: associationSetLeaves = [],
    isSuccess: associationSetLeavesReady,
    isError: associationSetLeavesFailed,
    error: associationSetLeavesQueryError,
    refetch: refetchAssociationSetLeaves,
  } = useQuery({
    // The root is part of the key, so an append is a new cache entry (one
    // re-read and on-chain check) and an unchanged root never re-reads at all.
    queryKey: ['sdkAssociationSetLeaves', chainId, configuredPoolAddress, associationSetRoot ?? 'no-root'],
    queryFn: async () => {
      // The verifier reads the grid's copy of the leaves, then rebuilds the
      // tree and checks it against the on-chain registry root, so a
      // bad/mid-rebuild set is not offered as spendable here only to fail when
      // proof construction re-checks it.
      const leaves = await getVerifiedPoolAssociationSetLeaves(chainId);
      return leaves
        .map((leaf: string) => normalizeHashValue(leaf))
        .filter((leaf): leaf is string => Boolean(leaf));
    },
    // Wait for the grid's first root (or its failure): keying on an unknown
    // root and then re-keying when it lands would verify the set twice. A
    // legacy build reads its frozen set by id and has no root feed.
    enabled: isSupportedEvmChainId(chainId)
      && (Boolean(LEGACY_CONFIG) || associationSetRoot !== undefined || associationSetRootFailed),
    staleTime: Infinity,
  });
  const associationSetLeavesError = associationSetLeavesFailed
    ? (associationSetLeavesQueryError instanceof Error
      ? associationSetLeavesQueryError.message
      : String(associationSetLeavesQueryError ?? 'Association set unavailable'))
    : null;
  // Say so when the ASP is throttling this connection. Otherwise the only sign
  // is "Shielded balance unavailable" and a Retry that cannot help (Mike,
  // 2026-10-01). Once a minute at most: every failed tick repeats the error.
  const { toast } = useToast();
  const rateLimitToastAtRef = useRef(0);
  // The raw feed error, not blockedLabelsError: during the grace period the
  // spending gate masks the error, but the throttle is still worth saying.
  const rawLabelsFeedError = blockedLabelsFeed.status === 'error' ? blockedLabelsFeed.error : null;
  const rawAssociationSetFeedError = associationSetFeed.status === 'error' ? associationSetFeed.error : null;
  const aspRateLimited = isRateLimitError(associationSetLeavesError ?? '') || isRateLimitError(rawLabelsFeedError ?? '')
    || isRateLimitError(rawAssociationSetFeedError ?? '');
  useEffect(() => {
    if (!aspRateLimited) return;
    const now = Date.now();
    if (now - rateLimitToastAtRef.current < 60_000) return;
    rateLimitToastAtRef.current = now;
    toast({ title: 'The ASP is rate limiting this connection. Balances will refresh in a minute.', variant: 'warning' });
  }, [aspRateLimited, toast]);
  const retryAssociationSetLeaves = useCallback(() => {
    // Re-reads the grid's copy and re-checks it on chain. The set and the
    // decisions are scheduler-owned and deliberately have no retry door: one
    // would be a request the user's click caused, which is the thing the grid
    // exists to prevent. Their next tick is at most a minute away.
    void refetchAssociationSetLeaves();
  }, [refetchAssociationSetLeaves]);

  // ---------------------------------------------------------------------------
  // Key initialization via wallet signature
  // ---------------------------------------------------------------------------

  const deriveKeystoreManager = useCallback(async (): Promise<IKeystoreManager> => {
    if (!effectiveAddress || !isSupportedEvmChainId(chainId)) {
      throw new Error('Connect a wallet or sign in with an account key on a supported chain first.');
    }
    const derivationAddress = effectiveAddress;

    // Reuse the cached manager only if it was derived by the CURRENT source.
    // Toggling passkey mode changes the source, which must force a re-derive
    // even though keysReady may still be true for the old source.
    const currentSource: 'signature' | 'passkey' = passkeyModeRef.current ? 'passkey' : 'signature';
    if (
      keysReady
      && keystoreManager
      && keystoreSourceRef.current === currentSource
      && keystoreTargetRef.current === `${String(derivationAddress).toLowerCase()}:${chainId}`
    ) {
      return keystoreManager;
    }

    if (keyInitPromiseRef.current) {
      return keyInitPromiseRef.current;
    }

    const keyPromise = (async () => {
      // Target this derivation is for. If the wallet/chain changes during the
      // (multi-step, signature-prompting) derivation, the reset effect updates
      // initTargetRef; we then must NOT commit this stale result.
      const myTarget = `${derivationAddress}:${chainId}`;
      const myEpoch = deriveEpochRef.current;
      const stillCurrent = () => initTargetRef.current === myTarget && deriveEpochRef.current === myEpoch;
      try {
        setError(null);

        // PASSKEY PREVIEW: derive keys from a passkey PRF instead of the wallet
        // signature. Assert FIRST (before any other awaited work like the
        // dynamic SDK import) so the WebAuthn call stays inside the click's
        // transient user activation. The connected wallet still owns the
        // account on-chain. Skips the signature + legacy scheme logic.
        // Excludes account-key sessions (those carry their own imported
        // signature). WebAuthn is the FIRST awaited op so the prompt stays in
        // the click's user activation.
        const runPasskeyBranch = async (): Promise<IKeystoreManager> => {
          const ownerLc = String(derivationAddress).toLowerCase();
          const marker = loadPasskeyMarkerFor(ownerLc, getRpId());
          const haveCredForOwner = !!marker?.credentialId;
          let prfFirst: `0x${string}`;
          let credentialId: string;
          if (haveCredForOwner) {
            // Known passkey for this owner → targeted sign-in (no QR fallback).
            const res = await getPasskeyPrf({ rpId: getRpId(), challenge: randomChallenge(), credentialId: marker!.credentialId });
            prfFirst = res.prf.first;
            credentialId = res.credentialId;
          } else {
            // First time for this owner under this RP ID → CREATE a passkey (the
            // native "save passkey" prompt), not a GET (which would dead-end to
            // the cross-device QR when no local credential exists). Serialized
            // per (owner, RP ID) across tabs, re-checked under the lock, so two
            // tabs cannot each mint a credential and a different account.
            const rpId = getRpId();
            const outcome = await withWebLock(`ppv2-passkey-create|${passkeyMarkerKey(ownerLc, rpId)}`, async () => {
              const raced = loadPasskeyMarkerFor(ownerLc, rpId);
              if (raced?.credentialId) return { credentialId: raced.credentialId, prfFirst: undefined as `0x${string}` | undefined };
              const created = await createPasskey({
                rpId,
                rpName: 'Privacy Pools',
                userId: randomChallenge().slice(0, 16),
                userName: 'privacy-pools',
                userDisplayName: 'Privacy Pools',
                challenge: randomChallenge(),
              });
              // Creation is an irreversible external side effect: record the id
              // for THIS owner under THIS RP ID whether or not the derivation is
              // still current, or a wallet switch during the prompt orphans the
              // credential and the owner's next tap creates another (codex on
              // PR #36). Provider state below still waits for stillCurrent().
              if (!persistPasskeyMarker({ credentialId: created.credentialId, ownerAddress: String(derivationAddress), rpId })) {
                // A record this page alone remembers is not a record: after a reload
                // the owner would create another credential and a different account.
                // Refuse before the identity can receive funds (codex on PR #36).
                log('error', 'SDK', 'Passkey credential id could not be stored durably; refusing the passkey unlock', { address: derivationAddress });
                throw new Error(PASSKEY_STORAGE_MESSAGE);
              }
              return { credentialId: created.credentialId, prfFirst: created.prf?.first };
            });
            credentialId = outcome.credentialId;
            if (outcome.prfFirst) {
              prfFirst = outcome.prfFirst;
            } else {
              // Platform returns PRF only on assertion (e.g. iOS), or another tab
              // created the credential: a targeted GET, local, so no QR.
              const res = await getPasskeyPrf({ rpId, challenge: randomChallenge(), credentialId });
              prfFirst = res.prf.first;
            }
          }
          const sdkSetup = await getSdkSetup();
          const pkKm = sdkSetup.derivePasskeyKeystoreManager(prfFirst);

          // Identity vs the on-chain registration. Passkey is still allowed for
          // any wallet; the deposit guard only blocks the irreversible action
          // (deposit) on a mismatch, and the recovery flow can import the other
          // identity's notes to exit them.
          const pkStatus = await resolveKeystoreIdentityStatus(sdkSetup, pkKm, derivationAddress as `0x${string}`, chainId);

          // Commit only if still the current target AND epoch AND the UI is still
          // in passkey mode: a wallet change, a source switch or a mode flip
          // during the prompt must not commit these keys (codex on PR #36).
          if (stillCurrent() && passkeyModeRef.current && passkeyUnlockEnabled()) {
            keystoreSourceRef.current = 'passkey';
            // Same pin as the signature commit below. Without it the cache hit
            // above can never match in passkey mode, so every later call
            // re-derives and raises another WebAuthn prompt for keys the page
            // already holds (missed when keystoreTargetRef was added).
            keystoreTargetRef.current = `${String(derivationAddress).toLowerCase()}:${chainId}`;
            setKeystoreManager(pkKm);
            setKeystoreIdentityStatus(pkStatus);
            // Seed the receive-setup store from this same read: without it an
            // already-partial account shows 'unknown' until some other flow
            // happens to write this chain, and FinishSetupBanner never renders.
            setReceiveSetup(derivationAddress, chainId, receiveSetupFromIdentity(pkStatus), 'onchain');
            setKeysReady(true);
            log('info', 'SDK', 'Keys initialized (passkey, preview)', { address: derivationAddress, identity: pkStatus });
          } else {
            log('warn', 'SDK', 'Discarding passkey keys for a since-changed target/epoch', { myTarget, myEpoch });
            throw new KeySourceChangedError('Key source or target changed during the passkey unlock; retry.');
          }
          return pkKm;
        };
        if (passkeyModeRef.current && !keyIdentity) {
          // Awaited HERE, inside the try/finally: a bare return of the promise let
          // finally clear keyInitPromiseRef before WebAuthn settled and cached any
          // rejection for every later tap (codex on PR #36). Mode is only ever set
          // while the page's flag is on, and the flag is fixed per page.
          const passkeyKm = await runPasskeyBranch();
          return passkeyKm;
        }

        // Canonical Signature-Based Derivation (SDK HKDF), matching
        // apps/sample-web. Replaces ppv2's old hand-rolled keccak derivation.
        const sdkSetup = await getSdkSetup();
        const payload = sdkSetup.buildSecretDerivationPayload(derivationAddress as `0x${string}`);
        let signature: `0x${string}`;
        // The connector that produces the first signature; the determinism
        // proof below is sent through the same one (a connector switch on the
        // same address does not move the epoch, so it must be pinned explicitly).
        let signConnector: typeof activeConnectorRef.current = undefined;
        // DEV-427: every wallet signature below is logged by stage, and Coinbase
        // (extension or WalletConnect) is bounded so a popup that never answers
        // gets a Sign in again message instead of waiting for the 120s cap.
        // Only Coinbase gets the 45s bound; every other wallet keeps the
        // user-paced 120s session cap (hardware unlock, finding a phone).
        const timedSign = async (sign: () => Promise<`0x${string}`>, stage: SignatureStage, connector?: WalletConnector | null) => {
          const who = connector ?? activeConnectorRef.current;
          // Coinbase over WalletConnect is the generic WalletConnect connector;
          // its session metadata names the wallet.
          const result = await requestWalletSignature(sign, who, {
            stage,
            onPending: (identity, timeoutMs) => {
              if (!stillCurrent()) throw new KeySourceChangedError('Key source or target changed during sign-in; retry.');
              log('info', 'SDK', 'Waiting for wallet signature', { stage, connectorId: who?.id, connectorName: who?.name, peerName: identity.peerName, timeoutMs });
            },
            onTimeout: () => log('error', 'SDK', 'Wallet signature timed out', { stage, connectorId: who?.id, connectorName: who?.name }),
          });
          if (!stillCurrent()) throw new KeySourceChangedError('Key source or target changed during sign-in; retry.');
          return result;
        };
        // DEV-576: every wallet signature (initial, legacy, proof) waits for a
        // wagmi reconnect to settle and retries once on "unavailable while
        // reconnecting". The retry signs through the live current connection.
        const reconnectStore: ReconnectStore = {
          getStatus: () => wagmiConfig.state.status,
          subscribe: (listener) => wagmiConfig.subscribe((state) => state.status, listener),
        };
        const liveConnection = () => (wagmiConfig.state.current
          ? wagmiConfig.state.connections.get(wagmiConfig.state.current)?.connector
          : undefined) as typeof activeConnectorRef.current;
        const settledSign = (
          stage: SignatureStage,
          pinned: WalletConnector | null | undefined,
          sign: (connector: WalletConnector | null | undefined) => Promise<`0x${string}`>,
        ) => {
          let attempt = 0;
          return signAfterReconnect(() => {
            if (!stillCurrent()) throw new KeySourceChangedError('Key source or target changed during sign-in; retry.');
            const connector = attempt++ === 0 ? pinned : (liveConnection() ?? pinned);
            return timedSign(() => sign(connector), stage, connector);
          }, reconnectStore, {
            onWait: (phase) => log('info', 'SDK', 'Waiting for the wallet to finish reconnecting before signing', { stage, phase }),
            onRetry: (e) => log('warn', 'SDK', 'Wallet was still reconnecting; retrying the signature once', { stage, detail: e instanceof Error ? e.message : String(e) }),
          });
        };
        // DEV-427 (mobile): the Coinbase app fails v4 on this payload. One request per
        // tap: after a v4 failure the next tap asks with v3 (same hash for this flat
        // struct, checked locally). See services/coinbase-typed-data-fallback.ts.
        const derivationSign = async (
          connector: WalletConnector | null | undefined,
          typed: { domain: typeof payload.domain; types: typeof payload.types; primaryType: typeof payload.primaryType; message: typeof payload.message },
        ): Promise<`0x${string}`> => {
          const provider = await walletProvider(connector) as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } | null;
          // The Base / Coinbase app, in its in-app browser or over WalletConnect
          // (its peer metadata names it). Never the browser extension.
          const coinbaseInApp = isCoinbaseInAppBrowser({ provider, userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null })
            || (isWalletConnectConnector(connector) && isCoinbaseWalletIdentity(await resolveWalletIdentity(connector)));
          return signTypedDataWithCoinbaseFallback({
            signV4: () => signTypedDataAsync({ ...typed, account: derivationAddress as `0x${string}`, connector: connector as typeof signConnector }),
            coinbaseInApp,
            useV3: coinbaseV4FailedRef.current.has(String(derivationAddress).toLowerCase()),
            provider: provider && typeof provider.request === 'function' ? provider : null,
            address: derivationAddress as `0x${string}`,
            typedData: { domain: typed.domain, types: typed.types, primaryType: typed.primaryType, message: typed.message } as never,
          });
        };
        // A signature this wallet already proved, on any chain. Skips the
        // prompt AND the determinism proof below (it was proved once; the
        // payload is identical), but nothing else: the scheme shim, the
        // identity status and the smart-wallet state all re-resolve for the
        // chain we are on now.
        const proven = provenSigsRef.current?.address === String(derivationAddress).toLowerCase()
          ? provenSigsRef.current
          : null;
        const reusedSignature = !keyIdentity && !!proven;
        if (keyIdentity) {
          // Account-key session: the deterministic signature was imported,
          // no wallet prompt.
          signature = keyIdentity.signature;
        } else if (proven) {
          signature = proven.signature;
          // Export Account Key reads `capturedSigsRef`, which only the prompt
          // path writes. Backfill it, or a session restored from a proved
          // signature can never export (the manager is cached, so the prompt
          // that would fill it never runs again).
          if (capturedSigsRef.current?.address !== proven.address) {
            capturedSigsRef.current = {
              address: proven.address,
              signature: proven.signature,
              legacySignature: proven.legacySignature,
            };
          }
          log('info', 'SDK', 'Reusing the signature this wallet already proved; no prompt for the chain switch', { address: derivationAddress, chainId });
        } else {
          // A connection restored from storage names its connector by id, and an
          // EIP-6963 wallet (MetaMask and friends) only becomes a real connector
          // once the page receives its announcement. Sign in that window and
          // wagmi calls a method on a plain object, throwing
          // "connection.connector.<method> is not a function" and leaving the
          // dialog stuck on "Key initialization failed" no matter how often the
          // user retried. Re-establish the connection once and sign again.
          const signPayload = {
            domain: payload.domain,
            types: payload.types,
            primaryType: payload.primaryType,
            message: payload.message,
          };
          // A contract wallet (Safe, Ambire, ...) signs with EIP-1271 data, not
          // one secp256k1 signature, so the derivation below would refuse it
          // with a bare "must be 65 bytes" after the prompt. Its unlock is the
          // passkey. An EIP-7702 delegated EOA still signs with its own key and
          // stays on the wallet path. Fail-open on an RPC error: the SDK's
          // 65-byte check is the enforcement (services/signer-determinism.ts).
          let smartAtUnlock: boolean;
          // The getCode verdict on this chain, or null when the read failed.
          let codeVerdict: ReturnType<typeof contractWalletVerdict> | null = null;
          let codeOnChain: string | undefined;
          try {
            if (!chainPublicClient) throw new Error('no public client for the active chain');
            const code = await chainPublicClient.getCode({ address: derivationAddress as `0x${string}` });
            codeOnChain = code;
            codeVerdict = contractWalletVerdict(code);
            smartAtUnlock = codeVerdict === 'contract';
          } catch (codeErr) {
            if (!passkeyUnlockEnabled()) {
              // Feature off: main's behaviour. The probe is advice only and the
              // SDK's 65-byte check remains the enforcement.
              log('warn', 'SDK', 'Contract-wallet probe failed; continuing to the signature', { detail: describeRpcError(codeErr) });
              smartAtUnlock = false;
            } else {
            // No verdict from this read. Reuse the ahead probe's settled verdict for
            // this exact address:chain; with none, guessing "EOA" would send a smart
            // wallet to the wallet prompt and the SDK's 65-byte failure, so ask for
            // a retry instead (codex on PR #36).
            const ahead = smartWalletProbeRef.current;
            if (ahead?.key !== `${String(derivationAddress).toLowerCase()}:${chainId}`) {
              log('warn', 'SDK', 'Contract-wallet probe failed with no earlier verdict', { detail: describeRpcError(codeErr) });
              throw new Error('Could not verify the wallet type because a network request failed. Please try again.');
            }
            smartAtUnlock = ahead.smart;
            }
          }
          let coinbaseSmart = false;
          if (smartAtUnlock) {
            // A deployed Coinbase smart wallet (getCode found code) gets the Coinbase
            // wording too, not the Safe/Ambire one.
            if (!coinbaseSmart && codeVerdict === 'contract') {
              coinbaseSmart = isCoinbaseWalletIdentity(await resolveWalletIdentity(liveConnection() ?? activeConnectorRef.current));
            }
            if (coinbaseSmart && !passkeyUnlockEnabled()) throw new Error(COINBASE_SMART_WALLET_SIGNIN_MESSAGE);
            // A disabled build must not sign or create a passkey for a smart wallet:
            // the marker store is dark there, so every reload would mint another
            // credential and another identity (codex on PR #36). Say what it is.
            if (!passkeyUnlockEnabled()) throw new Error(SMART_WALLET_SIGNIN_MESSAGE);
            // Detected late (the click beat the detection effect): this is a
            // passkey account, switch now and unlock with it. The WebAuthn prompt
            // may have lost the click's activation by this point; if the browser
            // refuses, the dialog is already in passkey mode and the next tap
            // goes straight to it.
            log('info', 'SDK', 'Smart-contract wallet detected at unlock; switching to the passkey unlock', { address: derivationAddress });
            setSmartWalletProbe({ key: `${String(derivationAddress).toLowerCase()}:${chainId}`, smart: true });
            passkeyModeRef.current = true;
            setPasskeyActive(true);
            const passkeyKm = await runPasskeyBranch();
            return passkeyKm;
          }
          // Detection MUST survive minification: the shipped bundle renames the
          // receiver, so the error users actually see reads
          // "u.connector.getChainId is not a function" — the old literal
          // `connection.connector.` test never matched it and this retry never
          // fired in production (services/stale-connector.ts).
          // DEV-576: MetaMask mobile injects its provider asynchronously, so
          // wagmi can still be reconnecting when Sign in is tapped, and any
          // call into the restored connector throws "unavailable while
          // reconnecting". Wait for the reconnect to settle before the prompt
          // (and before the Coinbase 45s bound starts), retry once if it still
          // says so, then re-pin the now-live connector.
          // DEV-427: the wallet signature is ALWAYS tried first. Only when the
          // Coinbase app then fails it (v4 and the v3 retry), and the account is one
          // the Base app runs as a smart wallet, does the passkey take over.
          try {
          try {
            // The pin is read after the wait, so it is the restored connection.
            await waitForReconnectSettled(reconnectStore);
            signature = await settledSign('initial', liveConnection() ?? activeConnectorRef.current, (connector) => {
              signConnector = connector as typeof signConnector;
              return derivationSign(signConnector, signPayload);
            });
          } catch (signErr) {
            const detail = signErr instanceof Error ? signErr.message : String(signErr);
            if (!isStaleConnectorError(detail)) throw signErr;
            log('warn', 'SDK', 'Wallet connection was not live yet; reconnecting before signing', { detail });
            // Capture the connector the retry will sign through BEFORE prompting:
            // the reconnect result names the live connection, and the ref is
            // refreshed by a passive effect that may not have run yet (codex on f0419b5).
            const reconnected = await reconnectAsync().catch(() => undefined);
            signConnector = reconnected?.[0]?.connector ?? activeConnectorRef.current;
            signature = await timedSign(() => derivationSign(signConnector, signPayload), 'initial', signConnector);
          }
          } catch (cbErr) {
            // These two only come from the Base / Coinbase app (in-app browser or
            // its WalletConnect peer). It cannot sign (base/account-sdk#387), so the
            // first failure asks for another wallet. No passkey offer.
            if (!isCoinbaseV4Failed(cbErr) && !isCoinbaseAppCannotSign(cbErr)) throw cbErr;
            const refusedKey = String(derivationAddress).toLowerCase();
            log('info', 'SDK', 'Base app could not sign; asking for another wallet', { address: derivationAddress, codeVerdict });
            setBaseAppRefused((prev) => (prev.has(refusedKey) ? prev : new Set(prev).add(refusedKey)));
            throw new BaseAppCannotSignError();
          }
          // A smart wallet that did sign answers with ERC-1271/6492 data. Say
          // what it is instead of the SDK's bare "must be 65 bytes".
          if (!isPlainEcdsaSignature(signature)) {
            // A contract signature means a contract wallet: it never had a
            // signature-derived account, so the passkey is its unlock.
            if (passkeyUnlockEnabled()) {
              log('info', 'SDK', 'Wallet answered with a contract signature; switching to the passkey unlock', { address: derivationAddress });
              setSmartWalletProbe({ key: `${String(derivationAddress).toLowerCase()}:${chainId}`, smart: true });
              passkeyModeRef.current = true;
              setPasskeyActive(true);
              const passkeyKm = await runPasskeyBranch();
              return passkeyKm;
            }
            const identity = await resolveWalletIdentity(signConnector ?? activeConnectorRef.current);
            throw new Error(isCoinbaseWalletIdentity(identity) ? COINBASE_SMART_WALLET_SIGNIN_MESSAGE : SMART_WALLET_SIGNIN_MESSAGE);
          }
          capturedSigsRef.current = { address: derivationAddress.toLowerCase(), signature };
        }

        const newKm = sdkSetup.createKeystoreManagerFromSignature({
          signature,
          signerAddress: derivationAddress as `0x${string}`,
          addressHash: payload.message.addressHash,
          // No rotation yet → index 0. (Rotation would persist + pass
          // the discovered index here.)
          revocableKeyIndex: '0x0' as `0x${string}`,
        });
        let km = newKm;
        // Which derivation each key actually resolves to (for the sign-in log).
        let nullifyingScheme: 'new' | 'keccak' = 'new';
        let viewingScheme: 'new' | 'keccak' = 'new';

        // --- Sepolia dual-scheme migration shim ---
        //
        // SCOPE, and it is deliberately narrow (Pat, 2026-09-21): this is
        // STAGING-ONLY and it is legacy. Mainnet is the only chain that
        // matters, and NO ONE ever registered under the keccak scheme there,
        // so no mainnet wallet can take this branch. Keep it working for the
        // handful of pre-cutover Sepolia wallets, but do NOT let it shape
        // anything new: if a design has to bend to accommodate the dual-scheme
        // case, the design is wrong. It is an acceptable cost here and it
        // should not be one anywhere else. Delete it once Sepolia is retired.
        // The Keystore's nullifying key is write-once, so wallets registered
        // before the keccak->HKDF cutover are permanently bound to their old
        // keys for SPENDING (the keystore-membership proof is built from the
        // current nullifying key and must match the on-chain registration).
        // Separately, RECEIVING depends on the on-chain PUBLISHED viewing key
        // (senders encrypt to it). The brief setViewingKey window means a
        // wallet's viewing and nullifying schemes can differ, so we resolve
        // each independently against on-chain and build a (possibly mixed)
        // manager. Sepolia-only: no mainnet / new deployment registered keccak.
        if (chainId === SEPOLIA_CHAIN_ID) {
          // Fail-open on the on-chain read: a flaky RPC shouldn't block
          // sign-in — fall back to the current keys.
          let onNull: string | null = null;
          let onView: string | null = null;
          try {
            const chain = getChainConfig(chainId);
            if (chain?.contracts) {
              const rpc = sdkSetup.createRPCInteractor(chainId, Number(chain.contracts.fromBlock));
              // Prefer the pinned legacy keystore so the detection runs
              // against the correct registration even if chains.ts is
              // later bumped to a new keystore.
              const keystoreAddr = (LEGACY_CONFIG?.keystore ?? chain.contracts.keystoreAddress) as `0x${string}`;
              const ks = sdkSetup.createKeystoreInteractor(
                rpc,
                keystoreAddr,
                chain.contracts.keystoreFromBlock ?? chain.contracts.fromBlock,
              );
              const n = await ks.getNullifyingKeyHash(derivationAddress as `0x${string}`);
              if (n && BigInt(n) !== 0n) onNull = String(n).toLowerCase();
              const v = await ks.getViewingKey(derivationAddress as `0x${string}`);
              if (v && BigInt(v) !== 0n) onView = String(v).toLowerCase();
            }
          } catch (schemeErr) {
            log('warn', 'SDK', 'Scheme detection (on-chain read) failed; using current keys', schemeErr);
          }

          if (onNull) {
            const hashService = await sdkSetup.createHashService();
            const newNullHash = String(hashService.hash([newKm.getPrivateNullifyingKey()])).toLowerCase();
            const newViewPub = newKm.getViewingKeyPair().publicKey.toLowerCase();
            const nullIsNew = onNull === newNullHash;
            const viewIsNew = !onView || onView === newViewPub;

            if (!nullIsNew || !viewIsNew) {
              // The wallet's nullifying and/or published viewing key isn't the
              // new HKDF one → derive the legacy keccak keys. REQUIRED: don't
              // fail-open to keys known not to match on-chain (spending /
              // discovery would silently break). A rejected signature
              // propagates so the user can retry.
              const legacyPayload = sdkSetup.buildLegacyKeccakDerivationPayload(derivationAddress as `0x${string}`);
              let legacySig: `0x${string}`;
              if (keyIdentity) {
                if (!keyIdentity.legacySignature) {
                  throw new Error(
                    'This wallet is registered under the legacy key scheme, but the account key does not include the legacy signature. Export a fresh account key while connected with the wallet.',
                  );
                }
                legacySig = keyIdentity.legacySignature;
              } else if (proven?.legacySignature) {
                // Same reuse as the primary signature: the legacy payload is
                // chain-independent too, so a Sepolia wallet that already
                // signed it is not asked again on a later visit.
                legacySig = proven.legacySignature;
              } else if (silentDeriveRef.current) {
                // Reached only by switching TO Sepolia from a chain whose
                // sign-in never needed the legacy prompt. Nobody clicked, so
                // do not prompt: leave the keys uncommitted and let the unlock
                // dialog ask, exactly as it did before the silent path existed.
                throw new KeySourceChangedError('This wallet needs an interactive sign-in on this chain; retry.');
              } else {
                // Same not-live-yet retry as the first signature above: this
                // second prompt can hit the identical stale-connector window,
                // and it had NO guard at all.
                const legacySignPayload = {
                  domain: legacyPayload.domain,
                  types: legacyPayload.types,
                  primaryType: legacyPayload.primaryType,
                  message: legacyPayload.message,
                  account: derivationAddress as `0x${string}`,
                  connector: signConnector ?? activeConnectorRef.current,
                };
                try {
                  legacySig = await settledSign('legacy', legacySignPayload.connector, (connector) => signTypedDataAsync({ ...legacySignPayload, connector: connector as typeof legacySignPayload.connector }));
                } catch (legacyErr) {
                  const detail = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
                  if (!isStaleConnectorError(detail)) throw legacyErr;
                  log('warn', 'SDK', 'Wallet connection was not live yet; reconnecting before the legacy signature', { detail });
                  const reconnected = await reconnectAsync().catch(() => { /* the retry below reports the real outcome */ });
                  const liveConnector = reconnected?.[0]?.connector ?? activeConnectorRef.current;
                  legacySig = await timedSign(() => signTypedDataAsync({ ...legacySignPayload, connector: liveConnector }), 'legacy', liveConnector);
                }
                if (capturedSigsRef.current?.address === derivationAddress.toLowerCase()) {
                  capturedSigsRef.current.legacySignature = legacySig;
                }
              }
              const legacyKm = sdkSetup.deriveLegacyKeccakKeystoreManager(legacySig);
              const legacyNullHash = String(hashService.hash([legacyKm.getPrivateNullifyingKey()])).toLowerCase();
              const legacyViewPub = legacyKm.getViewingKeyPair().publicKey.toLowerCase();

              // Spend keys (nullifying/revocable) must match the immutable
              // on-chain registration.
              const nullScheme = nullIsNew ? newKm : (legacyNullHash === onNull ? legacyKm : newKm);
              if (!nullIsNew && legacyNullHash !== onNull) {
                log('warn', 'SDK', 'Keystore nullifying matches neither scheme; spending may fail', { address: derivationAddress, onNull });
              }
              // Viewing key must match the on-chain PUBLISHED key so incoming
              // transfers (encrypted to it) are discoverable. Default to the
              // spend scheme when the published key is unset/unknown.
              const viewScheme = viewIsNew ? newKm
                : onView === legacyViewPub ? legacyKm
                : nullScheme;

              km = sdkSetup.createKeystoreManager({
                privateNullifyingKey: nullScheme.getPrivateNullifyingKey(),
                privateRevocableKey: nullScheme.getPrivateRevocableKey(),
                viewingPrivateKey: viewScheme.getViewingKeyPair().privateKey,
                viewingPublicKey: viewScheme.getViewingKeyPair().publicKey,
                revocableKeyIndex: '0x0' as `0x${string}`,
              });
              nullifyingScheme = nullScheme === newKm ? 'new' : 'keccak';
              viewingScheme = viewScheme === newKm ? 'new' : 'keccak';
            }
          }
        }

        // Sign-in scheme report. "keccak" = pre-cutover legacy keys, "new" =
        // canonical HKDF. A wallet can be mixed (e.g. legacy nullifying for
        // spending + new viewing for receiving) after the setViewingKey window.
        const usesLegacy = nullifyingScheme === 'keccak' || viewingScheme === 'keccak';
        console.log(
          `[PrivacyPools] sign-in keystore scheme for ${derivationAddress}: ${usesLegacy ? 'LEGACY keccak' : 'NEW hkdf'} `
          + `(nullifying/spend: ${nullifyingScheme}, viewing/receive: ${viewingScheme})`,
        );

        const sigStatus = await resolveKeystoreIdentityStatus(sdkSetup, km, derivationAddress as `0x${string}`, chainId);
        // Determinism proof. The account is derived from the signature's r, so
        // the wallet must return the SAME r every time. A key the chain already
        // vouches for (registered and matching) needs no proof; MetaMask and
        // Rabby are trusted RFC 6979 signers and skip it (a second prompt for
        // everyone is too annoying: Pat, 2026-09-05); every other wallet signs
        // the same payload once more. Two different r values would otherwise
        // derive a fresh, empty account on every sign-in, and on a registered
        // wallet would read as the legacy-scheme cutover. (Sepolia legacy
        // wallets whose status is not 'compatible' see this as a third prompt;
        // staging only.) The prompt is pinned to the wallet and account that
        // produced the first signature and is skipped once the target has
        // moved on, so a wallet switched mid-flow is never asked to sign the
        // old address's payload nor blamed for a mismatch (codex on 4548cd2).
        // A reused signature was proved once already (or came back 'compatible'
        // then); the payload has not changed, so asking again would be a second
        // prompt for a question already answered.
        if (!keyIdentity && !reusedSignature && sigStatus !== 'compatible' && sigStatus !== 'partial' && stillCurrent()) {
          const proofConnector = signConnector ?? activeConnectorRef.current;
          const trusted = await connectorIsKnownDeterministicSigner(proofConnector);
          const addrKey = String(derivationAddress).toLowerCase();
          // The v3 path (Coinbase app, after a failed v4) already used this tap's
          // one wallet request. Its proof is the NEXT tap's signature instead of a
          // second request now; the comparison is the same r check as below.
          let v3Path = false;
          if (!trusted && coinbaseV4FailedRef.current.has(addrKey)) {
            const p = await walletProvider(proofConnector).catch(() => null);
            v3Path = isCoinbaseInAppBrowser({ provider: p, userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null });
          }
          if (v3Path && stillCurrent()) {
            const step = coinbaseTwoTapProof(coinbaseProofPendingRef.current.get(addrKey), signature);
            coinbaseProofPendingRef.current.delete(addrKey);
            if (step === 'defer') {
              coinbaseProofPendingRef.current.set(addrKey, signature);
              log('info', 'SDK', 'Coinbase v3 signature taken; its determinism proof waits for the next tap', { address: derivationAddress });
              throw new CoinbaseConfirmNextTapError();
            }
            if (step === 'mismatch') {
              log('error', 'SDK', 'Wallet returned two different derivation signatures across taps (r differs); refusing to derive an account', {
                connectorId: proofConnector?.id,
                connectorName: proofConnector?.name,
                identity: sigStatus,
              });
              capturedSigsRef.current = null;
              provenSigsRef.current = null;
              setProvenAddress(null);
              setRefusedSigners((prev) => (prev.has(addrKey) ? prev : new Set(prev).add(addrKey)));
              throw new Error(NON_DETERMINISTIC_SIGNER_MESSAGE);
            }
            log('info', 'SDK', 'Wallet proved a deterministic derivation signature across two taps', { connectorId: proofConnector?.id });
          } else if (!trusted && stillCurrent()) {
            const proofPayload = {
              domain: payload.domain,
              types: payload.types,
              primaryType: payload.primaryType,
              message: payload.message,
              account: derivationAddress as `0x${string}`,
              connector: proofConnector,
            };
            let again: `0x${string}`;
            try {
              again = await settledSign('proof', proofConnector, (connector) => derivationSign(connector, proofPayload));
            } catch (proofErr) {
              const detail = proofErr instanceof Error ? proofErr.message : String(proofErr);
              if (!isStaleConnectorError(detail)) throw proofErr;
              log('warn', 'SDK', 'Wallet connection was not live yet; reconnecting before the determinism proof', { detail });
              const reconnected = await reconnectAsync().catch(() => undefined);
              const liveConnector = reconnected?.[0]?.connector ?? activeConnectorRef.current;
              // The reconnect installed a fresh connector: a pinned stale object
              // would be called again, so follow the refreshed current connection.
              again = await timedSign(() => derivationSign(liveConnector, proofPayload), 'proof', liveConnector);
            }
            // Only r feeds the derivation (SDK deriveKeysFromSignature drops s
            // and v), so only r has to repeat: 0x + 64 hex chars.
            if (stillCurrent() && again.slice(0, 66).toLowerCase() !== signature.slice(0, 66).toLowerCase()) {
              log('error', 'SDK', 'Wallet returned two different derivation signatures (r differs); refusing to derive an account', {
                connectorId: proofConnector?.id,
                connectorName: proofConnector?.name,
                identity: sigStatus,
              });
              // Remember WHICH wallet did it: that is what lets the unlock
              // dialog offer this one the passkey without offering it to
              // every wallet (services/passkey-policy.ts).
              capturedSigsRef.current = null;
              provenSigsRef.current = null;
              setProvenAddress(null);
              const refused = String(derivationAddress).toLowerCase();
              setRefusedSigners((prev) => (prev.has(refused) ? prev : new Set(prev).add(refused)));
              throw new Error(NON_DETERMINISTIC_SIGNER_MESSAGE);
            }
            if (stillCurrent()) log('info', 'SDK', 'Wallet proved a deterministic derivation signature', { connectorId: proofConnector?.id });
          }
        }
        // Also require the wallet source to still be the UI's mode: a late
        // smart-wallet verdict may have flipped it while this ran (codex on PR #36).
        if (stillCurrent() && !passkeyModeRef.current) {
          keystoreSourceRef.current = 'signature';
          keystoreTargetRef.current = `${String(derivationAddress).toLowerCase()}:${chainId}`;
          // Recorded only HERE — on the commit — so the next chain switch
          // reuses a signature that is known to have derived usable keys,
          // never one the wallet was in the middle of disowning. And only for
          // a WALLET session: an account-key session's signature was imported,
          // not proved by a wallet in this tab, and treating it as proved let a
          // later connect of that same address build a session with no click
          // and no captured signature (so Export Account Key then failed).
          if (!keyIdentity) {
            provenSigsRef.current = {
              address: String(derivationAddress).toLowerCase(),
              signature,
              legacySignature: capturedSigsRef.current?.address === String(derivationAddress).toLowerCase()
                ? capturedSigsRef.current.legacySignature ?? proven?.legacySignature
                : proven?.legacySignature,
            };
            setProvenAddress(String(derivationAddress).toLowerCase());
          }
          setKeystoreManager(km);
          setKeystoreIdentityStatus(sigStatus);
          // Same seed as the passkey branch above: this load-time read is the
          // only chance an already-partial account has to show as such before
          // some other flow refreshes this chain.
          setReceiveSetup(derivationAddress, chainId, receiveSetupFromIdentity(sigStatus), 'onchain');
          setKeysReady(true);
          log('info', 'SDK', 'Keys initialized successfully', { address: derivationAddress, identity: sigStatus });
        } else {
          // Wallet/chain/source changed mid-derivation — don't commit stale keys.
          log('warn', 'SDK', 'Discarding keys derived for a since-changed target/epoch', { myTarget, myEpoch });
          throw new KeySourceChangedError('Key source or target changed during sign-in; retry.');
        }
        return km;
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        // A wagmi connection restored from storage whose connector is not in
        // THIS build's config rehydrates as a bare object, so the first call
        // into it dies with "connection.connector.<method> is not a function"
        // (QA hit `getChainId`). That happens after a build changes its
        // connector set, or when two builds share an origin (same localhost
        // port), and the raw TypeError reads as a broken app rather than as a
        // session that needs reconnecting.
        const staleConnector = isStaleConnectorError(raw);
        // An expected abort (wallet, chain or unlock source changed under the
        // derivation): the next attempt runs fresh; not a failure to paint or to
        // log as one (codex on PR #36).
        const sourceChanged = err instanceof KeySourceChangedError;
        // A lazy import that cannot resolve (getSdkSetup and friends) means this
        // tab is older than the server, which has nothing to do with keys.
        const staleBundle = staleBundleMessage(raw);
        // DEV-576: never paint a wagmi/viem dump. The full error is in the
        // structured log below and the console.
        const reconnecting = isWalletReconnectingError(err);
        if (reconnecting) console.warn('[SDK] sign-in while the wallet was reconnecting', err);
        const message = staleBundle
          ?? (reconnecting ? WALLET_RECONNECTING_MESSAGE : null)
          ?? (staleConnector
            ? 'Your saved wallet session was out of date and has been reset. Connect your wallet again to sign in.'
            : walletErrorLine(err));
        // A stale connector reaching THIS catch means the reconnect-and-retry
        // above also failed — usually because the wallet's EIP-6963
        // announcement still hasn't arrived. Pressing Sign in again works (by
        // then it has), so painting the raw TypeError teaches nothing and
        // reads as a broken app; refreshes hit it at random for months (Pat,
        // 2026-08-28). Outside debug mode, leave the dialog clean and let the
        // button be the retry. Debug mode keeps the full message, and the
        // structured log below always records it.
        // A prompt that outlived its target (wallet or chain changed while it was
        // open) must not paint its failure onto the new target's dialog; the
        // structured log below still records it (codex on bc53136).
        // The reconnect-and-retry above did not revive the restored connection,
        // so its stored record is what keeps failing: drop it now instead of
        // asking the user to, on every attempt (Zeeshan, QA 2026-09-01: the
        // same message repeatedly). Synchronous and identity-guarded (codex on
        // 5e58d71): wagmi's disconnect cannot remove a method-less record, and
        // a connection a reconnect repaired meanwhile must survive. Account-key
        // sessions never raise this error.
        if (staleConnector && stillCurrent()) {
          const pruned = pruneBareRestoredConnection(wagmiConfig.state);
          if (pruned) wagmiConfig.setState(pruned);
          log('info', 'SDK', pruned ? 'Dropped the stale restored wallet connection' : 'Stale-connector error, but the current connection is live; left it alone');
        }
        if (!sourceChanged && (!staleConnector || isDebugModeActive()) && stillCurrent()) {
          setError(reconnecting ? message : `Key initialization failed: ${message}`);
        }
        // The stack and the connector's shape say WHERE this came from. Without
        // them a "not a function" error only says that some wagmi call ran against
        // a connection that was not live, not which call.
        log(sourceChanged ? 'info' : 'error', 'SDK', `Key initialization failed: ${message}`, {
          raw,
          staleConnector,
          stack: err instanceof Error ? err.stack?.split('\n').slice(0, 8).join(' | ') : undefined,
          connectorId: activeConnectorRef.current?.id,
          connectorType: activeConnectorRef.current?.type,
          connectorHasGetChainId: typeof (activeConnectorRef.current as { getChainId?: unknown } | undefined)?.getChainId === 'function',
          accountStatus: accountStatusRef.current,
        });
        throw err;
      }
    })();

    keyInitPromiseRef.current = keyPromise;
    // Clear the shared ref only while it still points at THIS promise: a
    // derivation invalidated by a target/source change settles later, after a
    // newer derivation has taken the ref, and must not clear that one (codex
    // on PR #36). The caught chain is only for the cleanup; callers still get
    // keyPromise's own rejection.
    void keyPromise.catch(() => undefined).finally(() => {
      if (keyInitPromiseRef.current === keyPromise) keyInitPromiseRef.current = null;
    });
    return keyPromise;
  }, [effectiveAddress, keyIdentity, chainId, keysReady, keystoreManager, signTypedDataAsync, reconnectAsync, wagmiConfig, log, chainPublicClient, setPasskeyActive, setSmartWalletProbe, setRefusedSigners, setProvenAddress]);

  const initializeKeys = useCallback(async () => {
    await deriveKeystoreManager();
  }, [deriveKeystoreManager]);

  useEffect(() => {
    const targetKey = effectiveAddress ? `${effectiveAddress}:${chainId}` : '';
    if (targetKey !== initTargetRef.current) {
      initTargetRef.current = targetKey;
      deriveEpochRef.current += 1; // invalidate any in-flight derivation/session
      setError(null);
      // Wallet or chain changed → discard the previous wallet's keys so the
      // next deriveKeystoreManager re-runs per-wallet scheme detection.
      // Without this, keysReady stays true and the cached manager (possibly
      // the wrong wallet's, or wrong scheme) would be reused for the new
      // account. The session is separately re-keyed by `${address}:${chainId}`.
      keyInitPromiseRef.current = null;
      // A proved signature belongs to ONE address, never to a chain: keep it
      // across a chain switch (that is the whole point) and drop it the moment
      // the wallet changes, so the next account cannot reuse this one's.
      // A disconnect is not a different wallet, and this ref is in-memory only,
      // so an empty address leaves it alone (as `capturedSigsRef` already does)
      // — a wagmi blip mid-switch must not turn into a fresh prompt.
      const nextOwner = String(effectiveAddress ?? '').toLowerCase();
      if (nextOwner && nextOwner !== provenSigsRef.current?.address) {
        provenSigsRef.current = null;
        setProvenAddress(null);
      }
      // Also discard any in-flight session init for the previous target so a
      // stale promise can't be reused or commit the old wallet's session.
      ensureInitPromiseRef.current = null;
      setIsSyncing(false);
      setIsSyncingAll(false);
      setSyncChainsLeft(0);
      setIsInitializing(false); // the orphaned initializer can no longer clear it (codex on PR #36)
      setKeysReady(false);
      setKeystoreManager(null);
      setKeystoreIdentityStatus('unknown');
      // Snapshot the previous session's notes to localStorage (keyed by THAT
      // wallet's address) before tearing down, so a switch never loses
      // unsaved notes — they're reloaded when that wallet reconnects.
      const prevSession = committedSessionRef.current;
      if (prevSession) {
        // Don't resurrect a cache the user just chose to wipe on disconnect.
        if (!wipedAccountKeys.has(wipedAccountKey(prevSession.address, prevSession.chainId))) {
          try {
            saveStoredAccountExport(prevSession.noteManager.exportState(), prevSession.address, prevSession.chainId);
          } catch {
            // best-effort backup; the per-op saves during the session already
            // persist most state.
          }
        }
        committedSessionRef.current = null;
        // Sibling sessions hold these managers; drop them with the session.
        batchSessionRef.current = null;
        selfSubmitSessionRef.current = null;
      }
      // Tear down the previous account's SESSION + NOTES immediately. The
      // disconnect effect below only fires on an actual disconnect, not on an
      // account *switch* (connected -> connected, new address) — without this,
      // the new wallet would keep showing the previous account's notes until
      // its own session finishes building.
      setPoolSession(null);
      setSessionTarget(null);
      setNoteManager(null);
      setIsInitialized(false);
      sessionKeyRef.current = '';
    }
  }, [effectiveAddress, chainId]);

  const createSession = useCallback(async (
    currentAddress: string,
    currentChainId: number,
    currentKeystoreManager: IKeystoreManager,
  ): Promise<PoolSession> => {
    const key = `${currentAddress}:${currentChainId}`;
    const sessionEpoch = deriveEpochRef.current;
    if (key === sessionKeyRef.current && poolSession) {
      return poolSession;
    }

    // Deliberately (re)building a session for this account → it's no longer
    // "wiped"; allow autosaves again. (Cache was deleted, so this rebuild
    // re-discovers from chain and re-persists.)
    wipedAccountKeys.delete(wipedAccountKey(currentAddress, currentChainId));
    // The export was wiped: its discovery mark no longer stands either, so the
    // holdings read as unknown until this fresh session's discovery succeeds.
    setSyncedHoldings((prev) => withoutHoldingsKey(prev, currentAddress, currentChainId));

    // Belongs to the session being replaced, not to this one. A pass that never
    // reaches the chain cross-check (index not built, RPC down) must end with an
    // empty set rather than the previous account's, and empty is the safe value:
    // it claims nothing, so the exit list behaves exactly as it did before.
    setUnconfirmedExitCommitments(new Set<string>());

    setError(null);
    setIsInitialized(false);

    try {
      // Legacy spend-out build: when LEGACY_CONFIG is set, all four contract
      // values (entrypoint, pool, keystore, MT id) come from env so the build
      // is decoupled from chains.ts. After the cutover, the ASP's
      // /entrypoints feed and chains.ts will both move to NEW addresses;
      // env pins keep the legacy URL talking to the OLD contracts. The
      // legacy build still reads `fromBlock` from chains.ts, so it must be
      // deployed off a commit that still has the OLD pool's deploy block.
      const localChainConfig = getChainConfig(currentChainId);
      const fromBlock = localChainConfig?.contracts?.fromBlock;
      if (fromBlock === undefined) {
        throw new Error(`Missing fromBlock configuration for chain ${currentChainId}`);
      }

      let entrypointAddress: Address;
      let poolAddress: Address;
      let keystoreAddress: Address;

      if (LEGACY_CONFIG) {
        entrypointAddress = LEGACY_CONFIG.entrypoint as Address;
        poolAddress = LEGACY_CONFIG.pool as Address;
        keystoreAddress = LEGACY_CONFIG.keystore as Address;
      } else {
        const entrypoints = await apiClient.getEntrypoints();
        const chainConfig = resolveEntrypointChainConfig(
          entrypoints,
          currentChainId,
          localChainConfig?.contracts?.poolAddress,
        );
        if (!chainConfig) {
          throw new Error(`No entrypoint configuration found for chain ${currentChainId}`);
        }
        const rawEntrypoint = chainConfig.entrypoint;
        if (typeof rawEntrypoint !== 'string' || !isAddress(rawEntrypoint)) {
          throw new Error(`Invalid entrypoint address for chain ${currentChainId}: ${rawEntrypoint}`);
        }
        entrypointAddress = rawEntrypoint as Address;
        const localPool = localChainConfig?.contracts?.poolAddress;
        const localKeystore = localChainConfig?.contracts?.keystoreAddress;
        if (!localPool || !isAddress(localPool)) {
          throw new Error(`Missing pool address configuration for chain ${currentChainId}`);
        }
        if (!localKeystore || !isAddress(localKeystore)) {
          throw new Error(`Missing keystore address configuration for chain ${currentChainId}`);
        }
        poolAddress = localPool as Address;
        keystoreAddress = localKeystore as Address;
      }

      const { createNoteManager, createCircuitArtifacts } = await getSdkSetup();
      const { createPoolSession } = await getPoolSessionService();
      const nm = createNoteManager();

      const storedExport = loadStoredAccountExport(currentAddress, currentChainId);
      if (storedExport) {
        const raw = storedExport as Record<string, unknown>;
        const notesField = raw.notes;
        const notesIsArray = Array.isArray(notesField);
        if (!notesIsArray) {
          log('warn', 'SDK', 'Stored account export is in legacy shape (notes not an array); clearing and starting fresh', {
            address: currentAddress,
            chainId: currentChainId,
            storedKeys: Object.keys(raw),
            notesType: notesField === null ? 'null' : typeof notesField,
          });
          try {
            storageRemoveItem(accountExportKey(currentAddress, currentChainId));
          } catch {
            // best-effort
          }
        } else {
          try {
            // Lowercase address-shaped fields on every restored note so the
            // SDK's character-strict tokenId comparison in transact paths
            // (`getNotesTokenId`) doesn't reject a mix of checksum-cased
            // and lowercase forms — e.g. one ETH note stored as
            // 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE and another as
            // 0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee. Both refer to the
            // same on-chain asset; only the local string representation
            // differs depending on whether the note came from a deposit
            // (checksum) or from discovery (lowercase from RPC).
            const normalizedNotes = (notesField as unknown[]).map((n) => {
              const note = n as Record<string, unknown>;
              return {
                ...note,
                tokenId: typeof note.tokenId === 'string' ? note.tokenId.toLowerCase() : note.tokenId,
                ownerAddress:
                  typeof note.ownerAddress === 'string' ? note.ownerAddress.toLowerCase() : note.ownerAddress,
              };
            });
            // v2.0 migration: backfill the now-required noteAddressHash on
            // notes persisted by the pre-v2.0 SDK, or importState rejects
            // the whole blob and the local cache is dropped (out-of-band
            // receipt notes would be lost — they can't be re-scanned).
            const { backfillNoteAddressHashes } = await import('@/services/note-migration');
            const migrated = await backfillNoteAddressHashes({
              ...raw,
              notes: normalizedNotes,
              syncCursor: raw.syncCursor ?? '0x0',
            }) as Parameters<typeof nm.importState>[0];
            // Awaited for the same reason: unhandled otherwise, and the log
            // below would claim a restore that never happened.
            await (nm as unknown as { importState: (d: unknown) => Promise<void> }).importState(migrated);
            log('info', 'SDK', 'Restored account from local storage', {
              address: currentAddress,
              chainId: currentChainId,
              noteCount: (notesField as unknown[]).length,
              hadSyncCursor: 'syncCursor' in raw,
            });
          } catch (importErr) {
            const msg = importErr instanceof Error ? importErr.message : String(importErr);
            log('warn', 'SDK', `Failed to restore stored account, starting fresh: ${msg}`, importErr);
          }
        }
      }

      // Heal notes whose stored `createdAtBlock` is a block number instead
      // of a block.timestamp — a bug in older versions of
      // PoolSessionNoteDiscovery that caused state-proof lookups to fail
      // with "Leaf not found in tree" when spending. Resolves the real
      // timestamps from the bulk on-chain index; this used to issue one
      // PoolVault.commitments() eth_call per stored note, which enumerated
      // the user's whole portfolio to the RPC provider on every init.
      try {
        const { createRPCInteractor, createPoolVaultInteractor, createHashService, healNoteTimestamps } =
          await getSdkSetup();
        const rpc = createRPCInteractor(currentChainId, Number(fromBlock));
        const hashSvc = await createHashService();
        const pv = createPoolVaultInteractor(rpc, poolAddress as Address, hashSvc, BigInt(fromBlock));
        const { createOnChainNoteIndex } = await import('@/services/onchain-note-index');
        const balanceCrosscheck = await import('@/services/balance-crosscheck');
        // OnChainNoteIndex also accepts unverified ASP snapshot rows. Capture
        // the nullifiers returned by its EXISTING bulk RPC Transacted reads so
        // only independent chain evidence can drive a terminal status change.
        // The wrapper itself performs no read and forwards the refresh stream.
        const rpcSpentEvidence = balanceCrosscheck.captureRpcProvenSpent(pv as never);
        // Freeze the chain's finality boundary BEFORE the event scan. Fetching
        // it afterwards has a same-height race: a head event can be captured,
        // reorged out during the build, and have its replacement height become
        // finalized before the later read. Only rows already final when the
        // canonical bulk scan begins may drive a terminal local transition.
        let finalizedBlockNumber: bigint | null = null;
        const finalityClient = chainPublicClient;
        if (finalityClient && Number(finalityClient.chain?.id) === currentChainId) {
          try {
            const finalized = await finalityClient.getBlock({ blockTag: 'finalized' });
            finalizedBlockNumber = finalized.number ?? null;
          } catch {
            // A provider without `finalized` support leaves the pass diagnostic.
          }
        }
        const noteIndex = createOnChainNoteIndex({
          chainId: currentChainId,
          poolVaultInteractor: rpcSpentEvidence.interactor as never,
          hashService: hashSvc as never,
          poolAddress: poolAddress as string,
        });
        const { healed, removed } = await healNoteTimestamps(nm, noteIndex);
        // A latest-head log can be reorged out. SPENT/EXITED are terminal in the
        // SDK, so the frozen boundary above keeps every later terminal action
        // below finality. That request carries only the public block tag, never
        // a value derived from a user's note.
        // A THIRD opinion on the balance, from the chain — see
        // services/balance-crosscheck.ts. The balance and My transactions are
        // two readings of the same two inputs (ASP feed, local notes), so they
        // agree whenever an input is wrong; only the pool contract is
        // independent of both. Run HERE because healNoteTimestamps has already
        // built and refreshed this index: nullifier/commitment answers below
        // are in-memory Map/Set lookups. The only added request is the same
        // chain-wide `finalized` boundary for every session pass; it carries no
        // note-derived value. Never call refresh() for the check itself.
        const spentByChain = noteIndex.isBuilt()
          ? await (async () => {
            try {
              const { createNoteComputationService } = await getSdkSetup();
              const noteComp = await createNoteComputationService();
              const nullifyingKey = currentKeystoreManager.getPrivateNullifyingKey();
              const allNotes = (nm as unknown as { getNotes: () => Array<{
                commitment: Hash; value: string; tokenId?: string; status: unknown;
              }> }).getNotes();
              const active = allNotes.filter((n) => String(n.status).toUpperCase() === 'ACTIVE');
              // The same question asked in the other direction. `active` above
              // looks for notes the balance counts that the chain says are gone;
              // this looks for notes local state has written off that the chain
              // never confirmed leaving. Both readings come from the one bulk
              // scan already in hand, so neither costs a request.
              // EXIT_PENDING counts as well as EXITED. It is the SDK's provisional
              // state for an exit it has not seen settle, so a note stuck there with
              // no chain proof is the same loss of access as a poisoned EXITED and
              // must be surfaced the same way.
              const locallyExited = allNotes.filter((n) => {
                const s = String(n.status).toUpperCase();
                return s === 'EXITED' || s === 'EXIT_PENDING';
              });
              // Derived locally from our own key; never sent anywhere.
              const nullifierOf = new Map<string, Hex>();
              const finalizedProofOf = new Map<string, RpcNullifierProof>();
              for (const n of [...active, ...locallyExited]) {
                try {
                  nullifierOf.set(n.commitment, noteComp.computeNullifier(nullifyingKey, n.commitment) as Hex);
                } catch {
                  // Leave it absent -> the check reports indeterminate, not spent.
                }
              }
              // Spend times for points, read from the same index: Map lookups only.
              recordNoteSpendTimes(currentChainId, currentAddress, collectNoteSpendTimes(
                allNotes,
                (commitment) => nullifierOf.get(commitment) ?? noteComp.computeNullifier(nullifyingKey, commitment as Hash),
                (nullifier) => noteIndex.nullifierSpentAt(nullifier as Hash),
              ));
              saveStoredNoteSpendTimes(currentAddress, currentChainId);
              const report = balanceCrosscheck.crossCheckBalance({
                notes: active.map((n) => ({
                  commitment: n.commitment, value: n.value, tokenId: n.tokenId,
                })),
                isSpentOnChain: (commitment) => {
                  const nullifier = nullifierOf.get(commitment);
                  if (!nullifier) return null;
                  const rawProof = rpcSpentEvidence.proofOf(nullifier);
                  if (!rawProof) return false;
                  const proof = balanceCrosscheck.finalizedRpcProof(rawProof, finalizedBlockNumber);
                  if (!proof) return null;
                  finalizedProofOf.set(commitment, proof);
                  return true;
                },
                isObservedOnChain: (commitment) => noteIndex.hasCommitment(commitment as Hash),
              });
              // Notes local state wrote off as EXITED with nothing on chain to
              // show for it. Reported, never healed: EXITED has no outgoing edge
              // in the SDK's matrix, and absence of a log is weak evidence — the
              // UI keeps offering these, it does not rewrite their status.
              const { findUnconfirmedExits } = await import('@/services/unconfirmed-exits');
              const exitReport = findUnconfirmedExits({
                notes: locallyExited.map((n) => ({
                  commitment: n.commitment, value: n.value, tokenId: n.tokenId,
                })),
                exitProofOf: (commitment) => {
                  const nullifier = nullifierOf.get(commitment);
                  // Underivable nullifier: no verdict, not "no exit".
                  if (!nullifier) return undefined;
                  const rawProof = rpcSpentEvidence.proofOf(nullifier);
                  // The chain was consulted and showed nothing.
                  if (!rawProof) return null;
                  // Seen, but still reorgable: no verdict either way. Only a
                  // FINALIZED proof may retire a note, for the same reason the SDK
                  // now gates its own terminal writes — an orphaned log names a real
                  // pair, so matching cannot tell a log that was true from one that
                  // still is.
                  return balanceCrosscheck.finalizedRpcProof(rawProof, finalizedBlockNumber) ?? undefined;
                },
                isObservedOnChain: (commitment) => noteIndex.hasCommitment(commitment as Hash),
              });
              return { ...report, finalizedProofOf, exitReport };
            } catch {
              log('warn', 'SDK', 'Balance cross-check unavailable; continuing');
              return null;
            }
          })()
          : null;

        let markedSpent = 0;
        let markedExited = 0;
        if (spentByChain && spentByChain.provenSpent > 0) {
          // Positive FINALIZED RPC event evidence only: a nullifier is consumed
          // exactly once, and this one was derived from our own key over our own
          // commitment. ASP-only and reorgable head rows never enter this map.
          for (const commitment of spentByChain.provenSpentCommitments) {
            try {
              const proof = spentByChain.finalizedProofOf.get(commitment);
              if (!proof) continue;
              const status = proof.terminalStatus === 'EXITED' ? NoteStatus.EXITED : NoteStatus.SPENT;
              (nm as unknown as { updateNoteStatus: (c: Hash, s: NoteStatus, b?: Hex) => void })
                .updateNoteStatus(commitment as Hash, status, proof.blockNumber);
              if (status === NoteStatus.EXITED) markedExited += 1;
              else markedSpent += 1;
            } catch {
              // Best effort; the report below still records what we found.
            }
          }
        }
        if (spentByChain?.exitReport) {
          const exitReport = spentByChain.exitReport;
          // Only for the target this pass was built for. The cross-check above is
          // network-bound, so a wallet or chain switch can land mid-flight — and
          // publishing then would overwrite the incoming account's set with this
          // one's, hiding ITS unconfirmed exits behind a stale answer. The same
          // guard the session commit uses further down, applied earlier because
          // this write escapes into shared state sooner.
          // Published only when the vendored SDK can actually act on it. Listing a
          // note the SDK will refuse turns the recovery path into a button that
          // throws, which is a worse outcome than the note being absent — the user
          // believes recovery was tried and failed. The two halves of this fix ship
          // separately, so this is asked rather than assumed; the list lights up on
          // its own when the tarball is refreshed.
          const { sdkAllowsUnconfirmedExit } = await getSdkSetup();
          const canExitUnconfirmed = await sdkAllowsUnconfirmedExit();
          if (initTargetRef.current === key && deriveEpochRef.current === sessionEpoch) {
            // Unconditional within that target: an empty report must CLEAR a
            // previous pass's set, or a note since genuinely exited would keep
            // being offered forever.
            setUnconfirmedExitCommitments(
              new Set(canExitUnconfirmed ? exitReport.offerableCommitments : []),
            );
          }
          if (!canExitUnconfirmed && exitReport.offerableCommitments.length > 0) {
            log('warn', 'SDK', 'Unproven exits found but the vendored SDK cannot retry them; not offering', {
              chainId: currentChainId,
              offered: exitReport.offerableCommitments.length,
            });
          }
          if (exitReport.offerableCommitments.length > 0) {
            // COUNTS ONLY — `offerableCommitments` identifies notes and the debug
            // buffer is exportable to a file users paste into bug reports.
            log('warn', 'SDK', 'Exits reported locally but not proven on chain', {
              chainId: currentChainId,
              checked: exitReport.checked,
              offered: exitReport.offerableCommitments.length,
              unconfirmed: exitReport.unconfirmed,
              confirmed: exitReport.confirmed,
              spentNotExited: exitReport.spentNotExited,
              indeterminate: exitReport.indeterminate,
            });
          }
        }
        if (spentByChain) {
          // COUNTS ONLY. The debug buffer is exportable to a file
          // users paste into bug reports, so a commitment or nullifier logged
          // here would leave the device. Commitments, nullifiers, private token
          // ids and exact values are deliberately not included.
          log(
            spentByChain.provenSpent > 0 ? 'warn' : 'debug',
            'SDK',
            'Balance cross-check against chain',
            balanceCrosscheck.balanceCrossCheckLogPayload(spentByChain, {
              chainId: currentChainId, markedSpent, markedExited,
            }),
          );
          try {
            console.log(
              `[perf] · balance-crosscheck chain ${currentChainId}: ${spentByChain.checked} counted,`
              + ` ${spentByChain.provenSpent} finalized terminal (${markedSpent} spent, ${markedExited} exited),`
              + ` ${spentByChain.unobserved} not yet seen on-chain,`
              + ` ${spentByChain.indeterminate} indeterminate`,
            );
          } catch { /* diagnostics must never break session init */ }
        }
        if (healed > 0 || removed > 0 || markedSpent > 0 || markedExited > 0) {
          const exportState = (nm as unknown as { exportState: () => unknown }).exportState();
          saveStoredAccountExport(exportState as AccountExport, currentAddress, currentChainId);
          log('info', 'SDK', `Reconciled notes on init: ${healed} healed, ${removed} phantoms removed, ${markedSpent} spent, ${markedExited} exited on-chain`);
        }
      } catch (healErr) {
        log('warn', 'SDK', 'Note timestamp healing failed, continuing', healErr);
      }

      const circuitArtifacts = createCircuitArtifacts(CIRCUIT_ARTIFACTS_BASE_URL);
      const session = await createPoolSession({
        ownerAddress: currentAddress as Address,
        chainId: currentChainId,
        entrypointAddress,
        poolAddress: poolAddress as Address,
        keystoreAddress: keystoreAddress as Address,
        keystoreManager: currentKeystoreManager,
        noteManager: nm,
        circuitArtifacts,
        deploymentBlock: Number(fromBlock),
      });

      if (initTargetRef.current !== key || deriveEpochRef.current !== sessionEpoch) {
        // Wallet/chain changed, or the key source switched, while this session
        // was being built — don't commit it over the new target's state.
        // Return it to the (stale) caller without mutating shared state.
        log('warn', 'SDK', 'Discarding session built for a since-changed target/epoch', { key, current: initTargetRef.current });
        return session as unknown as PoolSession;
      }
      sessionKeyRef.current = key;
      committedSessionRef.current = {
        address: currentAddress,
        chainId: currentChainId,
        noteManager: nm as unknown as INoteManager,
        keystoreManager: currentKeystoreManager,
      };
      // Capture the resolved addresses so a batch withdrawal can build a
      // relay-contract-bound sibling session (finding 1). Invalidate any cached
      // batch session for a prior key.
      batchSessionParamsRef.current = {
        key,
        ownerAddress: currentAddress as Address,
        chainId: currentChainId,
        entrypointAddress,
        poolAddress: poolAddress as Address,
        keystoreAddress: keystoreAddress as Address,
        deploymentBlock: Number(fromBlock),
      };
      batchSessionRef.current = null;
      selfSubmitSessionRef.current = null;
      setNoteManager(nm as unknown as INoteManager);
      setPoolSession(session as unknown as PoolSession);
      setSessionTarget({ address: currentAddress, chainId: currentChainId });
      setIsInitialized(true);
      refreshNotes();
      log('info', 'SDK', 'PoolSession created', { address: currentAddress, chainId: currentChainId });
      return session as unknown as PoolSession;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPoolSession(null);
      setSessionTarget(null);
      setNoteManager(null);
      sessionKeyRef.current = '';
      setError(message);
      // describeRpcError, not message: a viem HTTP error embeds the endpoint
      // (and usually its key) in its message, and this line lands in the
      // exportable debug buffer. See services/rpc-error-text.ts.
      log('error', 'SDK', `Session init failed: ${describeRpcError(err)}`);
      throw err;
    }
  }, [chainPublicClient, log, poolSession]);

  const ensureInitialized = useCallback(async (): Promise<PoolSession> => {
    if (!effectiveAddress) {
      throw new Error('Connect a wallet or sign in with an account key first.');
    }
    if (!isSupportedEvmChainId(chainId)) {
      throw new Error(`Unsupported chain ${chainId}.`);
    }

    const currentKey = `${effectiveAddress}:${chainId}`;
    if (currentKey === sessionKeyRef.current && poolSession && isInitialized) {
      return poolSession;
    }

    // Every caller of ensureInitialized shares ONE in-flight promise, and each
    // await inside it is unbounded (the wallet prompt, the ASP entrypoints
    // read, the session build). So a stalled init strands not just the caller
    // that started it but every later one — Send handed the promise an earlier
    // caller started sat on "Syncing latest pool state..." with no message and
    // no way back (Nathaniel, QA 2026-09-21). Bound the WAIT, here, so no flow
    // can reach that dead end: deposit, withdraw, send, swap, payment requests
    // and ragequit all arrive through this one function.
    //
    // The wait is abandoned, the work is not: it may be a wallet prompt the
    // user is seconds from approving, and a late result still commits through
    // the target/epoch checks below. Dropping the shared ref is what makes the
    // user's retry a real second attempt rather than a re-attach to the same
    // stalled promise.
    const abandonWait = (waited: Promise<PoolSession>) => () => {
      log('warn', 'SDK', 'Session init exceeded its wait budget; releasing the caller', { chainId });
      if (ensureInitPromiseRef.current === waited) {
        ensureInitPromiseRef.current = null;
        setIsInitializing(false);
      }
    };

    if (ensureInitPromiseRef.current) {
      const inFlight = ensureInitPromiseRef.current;
      return withSessionInitTimeout(inFlight, { onTimeout: abandonWait(inFlight) });
    }

    const initPromise = (async () => {
      setIsInitializing(true);
      const startEpoch = deriveEpochRef.current;
      const km = await deriveKeystoreManager();
      // If the key source (or wallet/chain) switched while we were deriving,
      // abort instead of committing a stale-source manager/session — a fresh
      // ensureInitialized will run for the new source.
      if (deriveEpochRef.current !== startEpoch) {
        throw new KeySourceChangedError('Key source changed during initialization; retry.');
      }
      const session = await createSession(effectiveAddress, chainId, km);
      // Re-check after the (async) session build: createSession skips the
      // provider COMMIT on an epoch change but still RETURNS the built session.
      // Don't hand a stale wrong-source session back to the awaiting caller
      // (deposit/withdraw use the return value directly) — abort so they retry.
      if (deriveEpochRef.current !== startEpoch) {
        throw new KeySourceChangedError('Key source changed during session build; retry.');
      }
      return session;
    })()
      .finally(() => {
        // Only this invocation's own ref and flag: a superseded initializer
        // settling late must not clear the newer one's (codex on PR #36).
        if (ensureInitPromiseRef.current === initPromise) {
          ensureInitPromiseRef.current = null;
          setIsInitializing(false);
        }
      });

    ensureInitPromiseRef.current = initPromise;
    return withSessionInitTimeout(initPromise, { onTimeout: abandonWait(initPromise) });
  }, [effectiveAddress, chainId, createSession, deriveKeystoreManager, isInitialized, poolSession, log]);

  useEffect(() => {
    if (!effectiveAddress || !isSupportedEvmChainId(chainId)) {
      setPoolSession(null);
      setSessionTarget(null);
      setNoteManager(null);
      setIsInitialized(false);
      setError(null);
      return;
    }

    // Intentionally NOT auto-calling ensureInitialized() here. Doing so
    // fired `signTypedData` the moment the wallet connected, which the
    // user had no context for. The seed-derivation modal now drives
    // that flow — it opens on connect, explains why a signature is
    // needed, and only triggers signing when the user clicks Sign.
    // Anything that needs an initialised session also calls
    // ensureInitialized() lazily, which will reuse the result of the
    // user's earlier click.
  }, [accountStatus, effectiveAddress, chainId]);

  // ---------------------------------------------------------------------------
  // Reset on disconnect or chain switch
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!effectiveAddress) {
      setKeysReady(false);
      setKeystoreManager(null);
      setKeystoreIdentityStatus('unknown');
      sessionKeyRef.current = '';
    }
  }, [effectiveAddress]);

  // ---------------------------------------------------------------------------
  // Account export / import
  // ---------------------------------------------------------------------------

  // A sibling session (batch withdrawal, disclosed transfer) is built from the
  // committed params + managers, and building one awaits. If the world moves
  // during that await — a passkey/account-key rederive, a wallet or chain
  // switch — the resolved session carries the OLD note/keystore managers, and
  // caching it by `address:chain` alone would let a later spend prove against
  // stale note state (codex). So capture the exact identities we started from
  // and refuse to cache or return anything built against a superseded world.
  const siblingWorld = () => ({
    params: batchSessionParamsRef.current,
    managers: committedSessionRef.current,
    epoch: deriveEpochRef.current,
  });
  const siblingWorldUnchanged = (started: ReturnType<typeof siblingWorld>) => (
    batchSessionParamsRef.current === started.params &&
    committedSessionRef.current === started.managers &&
    deriveEpochRef.current === started.epoch
  );

  const exportAccount = useCallback(async (
    sessionOverride?: PoolSession | null,
    opts?: { chainId?: number },
  ): Promise<AccountExport | null> => {
    const sessionToExport = sessionOverride ?? poolSession;
    if (!sessionToExport || !effectiveAddress) return null;
    // Persist under the exported session's COMMITTED identity. For the live
    // session that is sessionTarget (never the render's chainId — mid
    // connector-switch the render already points at the NEW chain while
    // poolSession is still the OLD one, and keying on the render would write
    // chain A's export over chain B's bucket). An explicit override session
    // was just created by the caller with the current render values, so those
    // apply; a live session without a target is a teardown race — skip the
    // persist rather than guess a bucket.
    // A cross-chain session's notes belong to ITS chain, not the render's: a
    // cross-chain shield runs with the wallet on chain A and the pool on chain
    // B, so defaulting to the render would file B's note in A's bucket, where
    // nothing reads it. Callers holding such a session pass the chain.
    const target = sessionOverride
      ? { address: effectiveAddress, chainId: opts?.chainId ?? chainId }
      : sessionTarget;
    if (!target) return null;
    const started = siblingWorld();
    const data = await sessionToExport.exportAccount();
    if (!siblingWorldUnchanged(started)) return null;
    saveStoredAccountExport(data, target.address, target.chainId);
    refreshNotes();
    log('info', 'SDK', 'Account exported', {
      address: target.address,
      chainId: target.chainId,
      noteCount: data.notes.length,
      notes: data.notes.map((note) => ({
        commitment: note.commitment,
        tokenId: note.tokenId,
        status: note.status,
        value: note.value,
        txHash: note.txHash,
      })),
    });
    return data;
  }, [poolSession, sessionTarget, effectiveAddress, chainId, log, refreshNotes]);

  const importAccount = useCallback(
    async (data: AccountExport) => {
      // The import mutates the LIVE session, so both the operation and the
      // reconcile-persist below must bind to that session's COMMITTED
      // identity — mid connector-switch the render's chainId already points
      // elsewhere (see exportAccount).
      if (!poolSession || !effectiveAddress || !sessionTarget) return;
      // v2.0 migration: the SDK's NoteSchema now requires noteAddressHash on
      // every note, and importState rejects the whole blob if one legacy note
      // lacks it. Backfill (Poseidon(ownerAddress, noteSecret)) so pre-v2.0
      // backups — incl. out-of-band receipt notes that no chain scan can
      // rediscover — stay importable.
      const { backfillNoteAddressHashes } = await import('@/services/note-migration');
      await poolSession.importAccount(await backfillNoteAddressHashes(data));
      // v2.0 migration note: importAccount no longer resets notes to PENDING
      // (v2.0's importState preserves stored statuses) — but a note's spend
      // may still sit in a block the incremental sync cursor already passed
      // (or one the ASP event-snapshot hasn't indexed yet). Re-derive the
      // true status from chain over the FULL range so a previously-spent note
      // is re-marked SPENT (terminal) instead of resurfacing as ACTIVE once
      // promotion runs.
      //
      // Persist ONLY the reconciled export, and ONLY when the full reconcile
      // succeeds. If the re-scan or export fails we must NOT write the raw,
      // unreconciled import back to storage — that would lose the re-derived
      // SPENT status and resurface a spent note as ACTIVE on the next reload.
      // The in-memory import still stands; the next successful full sync
      // (session-start / withdraw-open) reconciles and persists it.
      let reconciled: AccountExport | null = null;
      try {
        const deployFromBlock = getChainConfig(sessionTarget.chainId)?.contracts?.fromBlock;
        const fromBlock = deployFromBlock !== undefined ? `0x${deployFromBlock.toString(16)}` : undefined;
        await (poolSession as unknown as {
          discoverNotes: (params?: { fromBlock?: string }) => Promise<unknown>;
        }).discoverNotes(fromBlock ? { fromBlock } : undefined);
        reconciled = await (poolSession as unknown as {
          exportAccount: () => Promise<AccountExport>;
        }).exportAccount();
      } catch (err) {
        log('warn', 'SDK', 'Import reconcile failed; not persisting until a full sync succeeds', {
          address: effectiveAddress,
          chainId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (reconciled) {
        saveStoredAccountExport(reconciled, sessionTarget.address, sessionTarget.chainId);
        log('info', 'SDK', 'Account imported and reconciled (full-range)', { address: sessionTarget.address, chainId: sessionTarget.chainId });
      }
      refreshNotes();
    },
    [poolSession, sessionTarget, effectiveAddress, chainId, log, refreshNotes],
  );

  // The identity as of the LATEST render. An async pass captures the values it
  // started with; comparing those to themselves proves nothing, so a write that
  // outlives its effect checks against this instead.
  const liveIdentityRef = useRef<{ address: string | null; chainId: number }>({ address: null, chainId });
  // Updated in an effect rather than during render: writing a ref mid-render is
  // what the react-compiler lint flags, and "latest COMMITTED identity" is the
  // right semantics here anyway — a render that never commits should not be what
  // an async write validates itself against.
  useEffect(() => {
    liveIdentityRef.current = { address: effectiveAddress ?? null, chainId };
  }, [effectiveAddress, chainId]);

  /**
   * A session for a chain OTHER than the committed one: that chain's pool,
   * keystore and entrypoint, with a note manager seeded from that chain's own
   * stored export, sharing the committed keystore manager (the identity derives
   * from the wallet signature or passkey, so it is chain-independent).
   *
   * Two callers, same requirements: a cross-chain shield needs it to prepare a
   * deposit against the destination pool, and the multichain sync needs it to
   * run note discovery on chains the active session cannot see. Both must seed
   * from — and later export to — the SAME (owner, chain) bucket, so the drift
   * and seed-failure guards live here rather than in either caller.
   *
   * Returns null when the chain is not usable for this identity; throws only
   * when continuing would risk the user's notes.
   */
  const buildSessionForChain = useCallback(async (
    targetChainId: number,
    opts?: {
      /** Read-only discovery needs no address-keyed registration checks. */
      discoveryOnly?: boolean;
      swapSourceChain?: {
        chainId: number;
        relaySwapsAddress: Address;
        walletInteractor: unknown;
        deploymentBlock?: number;
      };
      /**
       * Attach a DESTINATION pool for a cross-chain reshield (flow 4). The SDK
       * builds its `reshieldCrosschain` delegate only when it gets both a chain
       * id and an entrypoint interactor for that chain, so the entrypoint is
       * resolved here from the same source the target's own is: the ASP feed,
       * matched on that chain's configured pool.
       */
      reshieldDestinationChainId?: number;
      /**
       * The destination chain's share targets (`session.yields` from a session
       * built for THAT chain). Passing them is what lets a cross-chain reshield
       * land in a share pool instead of only a plain one.
       */
      reshieldDestinationYieldTargets?: readonly unknown[];
    },
  ): Promise<PoolSession | null> => {
    const started = siblingWorld();
    const managers = started.managers;
    if (!managers) return null;

    const targetConfig = getChainConfig(targetChainId);
    const targetFromBlock = targetConfig?.contracts?.fromBlock;
    const targetPool = targetConfig?.contracts?.poolAddress;
    const targetKeystore = targetConfig?.contracts?.keystoreAddress;
    if (targetFromBlock === undefined || !targetPool || !targetKeystore) {
      throw new Error(`Missing pool/keystore config for chain ${targetChainId}`);
    }
    const entrypoints = await apiClient.getEntrypoints();
    const targetEntrypointCfg = resolveEntrypointChainConfig(entrypoints, targetChainId, targetPool);
    const targetEntrypoint = targetEntrypointCfg?.entrypoint;
    if (typeof targetEntrypoint !== 'string' || !isAddress(targetEntrypoint)) {
      throw new Error(`No entrypoint for chain ${targetChainId}`);
    }

    const sdkSetup = await getSdkSetup();

    // The bucket we SEED from has to be the same one exportAccount will write
    // back to — it keys on effectiveAddress. If the committed identity and the
    // render's have drifted apart (mid connector-switch), seeding from one and
    // exporting to the other would replace that chain's notes with a set that
    // never contained them. Refuse instead.
    if (!effectiveAddress
      || (managers.address && managers.address.toLowerCase() !== effectiveAddress.toLowerCase())) {
      return null;
    }
    const owner = effectiveAddress as Address;

    // The target chain's identity must match the unlock in use. A bare
    // isKeystoreRegistered() only says "someone registered this address here" —
    // not whether that someone was this unlock. The nullifying-key hash is
    // write-once per address, so depositing under a different unlock than the
    // one registered there mints a note that can NEVER be spent and cannot be
    // re-registered. A failed lookup blocks writes, while 'unregistered'
    // falls through to the caller's registration handling. Discovery stays open.
    const targetIdentity = opts?.discoveryOnly ? 'unknown' : await resolveKeystoreIdentityStatus(
      sdkSetup,
      managers.keystoreManager as IKeystoreManager,
      owner,
      targetChainId,
    );
    if (!opts?.discoveryOnly) assertDepositUnlock(targetIdentity);

    const { createPoolSession } = await getPoolSessionService();
    // Seeded from that chain's own stored export so work appends to its notes
    // rather than starting a fresh set (notes are persisted per (owner, chain)).
    const targetNoteManager = sdkSetup.createNoteManager();
    const stored = loadStoredAccountExport(owner, targetChainId);
    if (stored) {
      try {
        await (targetNoteManager as unknown as { importState: (d: unknown) => Promise<void> }).importState(stored);
      } catch (importErr) {
        // REFUSE, don't continue empty: exportAccount later writes this manager
        // back over the (owner, chain) bucket, so an empty seed would replace
        // every note that chain already held. Pool deposits could be
        // rediscovered on-chain; notes received out of band could not.
        log('error', 'SDK', `Stored notes for chain ${targetChainId} could not be loaded; refusing rather than overwriting them`, importErr);
        throw new Error('Could not load your notes for that network.');
      }
      // A throw is not the only way importState can fail to absorb the bucket.
      // Handed a blob with no syncCursor or no notes array, the SDK logs
      // "Legacy NoteManager export — resetting to full rescan", empties the
      // manager and returns NORMALLY. The refusal above would pass, discovery
      // would run, and the export afterwards would write back only what a chain
      // scan can see — dropping any note received out of band, which no rescan
      // can recover. So check what actually landed, not just that it did not
      // throw (kimi's review of b79a440).
      // Count DISTINCT commitments, not array entries. The SDK rebuilds its
      // state into a Map keyed by commitment, so a blob that happened to carry
      // the same commitment twice legitimately yields fewer notes — and a raw
      // length comparison would refuse it, throwing inside the sweep and (since
      // the cross-chain shield shares this helper) blocking a deposit outright.
      const absorbed = (targetNoteManager as unknown as { getNotes: () => unknown[] }).getNotes().length;
      const storedNotes = Array.isArray((stored as { notes?: { commitment?: string }[] }).notes)
        ? (stored as { notes: { commitment?: string }[] }).notes
        : [];
      const expected = new Set(storedNotes.map((n) => String(n?.commitment ?? ''))).size;
      if (expected > 0 && absorbed < expected) {
        log('error', 'SDK', `Stored notes for chain ${targetChainId} only partially loaded (${absorbed}/${expected}); refusing rather than overwriting them`);
        throw new Error('Could not load your notes for that network.');
      }
    }

    // Destination attachment for flow 4. Resolved through the same feed and the
    // same pool match as the target above, so an unconfigured or unlisted
    // destination yields nothing rather than a half-built session whose
    // reshieldCrosschain methods would throw inside a money flow.
    let reshieldDestination: { chainId: number; entrypointAddress: Address; deploymentBlock?: number; yieldDepositTargets?: readonly unknown[] } | undefined;
    if (opts?.reshieldDestinationChainId !== undefined) {
      const destChainId = opts.reshieldDestinationChainId;
      const destConfig = getChainConfig(destChainId);
      const destPool = destConfig?.contracts?.poolAddress;
      const destFromBlock = destConfig?.contracts?.fromBlock;
      const destEntrypoint = destPool
        ? resolveEntrypointChainConfig(entrypoints, destChainId, destPool)?.entrypoint
        : undefined;
      if (!destPool || !destEntrypoint) {
        // Refuse rather than build the half-configured session this function's
        // own rule forbids: without the delegate the reshieldCrosschain methods
        // are undefined and the flow would die on a raw TypeError inside a money
        // path. The caller turns null into "not available yet" (kimi F4).
        log('warn', 'SDK', 'No entrypoint for the reshield destination; refusing the session', {
          destinationChainId: destChainId,
          hasPool: !!destPool,
        });
        return null;
      } else {
        reshieldDestination = {
          chainId: destChainId,
          entrypointAddress: destEntrypoint as Address,
          ...(destFromBlock !== undefined ? { deploymentBlock: Number(destFromBlock) } : {}),
          ...(opts?.reshieldDestinationYieldTargets?.length
            ? { yieldDepositTargets: opts.reshieldDestinationYieldTargets }
            : {}),
        };
      }
    }

    const session = (await createPoolSession({
      ownerAddress: owner,
      chainId: targetChainId,
      entrypointAddress: targetEntrypoint as Address,
      poolAddress: targetPool as Address,
      keystoreAddress: targetKeystore as Address,
      keystoreManager: managers.keystoreManager as never,
      noteManager: targetNoteManager as never,
      circuitArtifacts: sdkSetup.createCircuitArtifacts(CIRCUIT_ARTIFACTS_BASE_URL),
      deploymentBlock: Number(targetFromBlock),
      ...(opts?.swapSourceChain
        ? {
          swapSourceChain: {
            chainId: opts.swapSourceChain.chainId,
            relaySwapsAddress: opts.swapSourceChain.relaySwapsAddress,
            walletInteractor: opts.swapSourceChain.walletInteractor as never,
            ...(opts.swapSourceChain.deploymentBlock !== undefined
              ? { deploymentBlock: opts.swapSourceChain.deploymentBlock }
              : {}),
          },
        }
        : {}),
      ...(reshieldDestination ? { reshieldDestination } : {}),
    })) as unknown as PoolSession;
    return siblingWorldUnchanged(started) ? session : null;
  }, [effectiveAddress, log]);

  const discoverNotes = useCallback(async (opts?: { fromBlock?: string; quiet?: boolean }) => {
    if (!noteManager || !effectiveAddress || !poolSession) return null;
    // A scheduled pass is not something the user asked for, so it does not
    // show as syncing; promotion still waits for it (see backgroundDiscoveryRef).
    if (opts?.quiet) backgroundDiscoveryRef.current += 1;
    else setIsSyncing(true);
    const nm = noteManager as unknown as {
      getNotes: () => Array<{ commitment: string; status: string; txHash?: string; label?: string; tokenId?: string }>;
      getSyncCursor?: () => string;
    };
    const beforeNotes = nm.getNotes();
    const beforeCursor = nm.getSyncCursor?.();
    log('info', 'SDK', 'Starting note discovery', {
      chainId,
      address: effectiveAddress,
      beforeNoteCount: beforeNotes.length,
      beforeSyncCursor: beforeCursor,
      beforeNotes: beforeNotes.map((n) => ({
        commitment: n.commitment,
        status: String(n.status),
        txHash: n.txHash,
      })),
    });
    try {
      // A `fromBlock` forces a full-range re-scan (chain RPC over the whole
      // history, not just from the incremental cursor) so spends the ASP
      // event-snapshot hasn't indexed yet are still detected and notes are
      // marked SPENT. Without it, discovery is incremental from the stored
      // cursor.
      // Timed because this is the step users experience as "my balance is slow":
      // it is a full SDK discovery pass (chain getLogs + per-note work), and a
      // fromBlock turns it into a whole-history re-scan.
      perfPhaseStart(opts?.fromBlock ? 'discovery:notes(full-rescan)' : 'discovery:notes(incremental)');
      const discovered = await (poolSession as unknown as {
        discoverNotes: (params?: { fromBlock?: string }) => Promise<Array<{ commitment: string; txHash?: string }>>;
      }).discoverNotes(opts?.fromBlock ? { fromBlock: opts.fromBlock } : undefined);
      perfPhaseEnd(
        opts?.fromBlock ? 'discovery:notes(full-rescan)' : 'discovery:notes(incremental)',
        `${Array.isArray(discovered) ? discovered.length : 0} discovered`,
      );

      // Discovery may finish after another wallet or chain committed a manager.
      if (committedSessionRef.current?.noteManager !== noteManager) return null;

      const afterNotes = nm.getNotes();
      const afterCursor = nm.getSyncCursor?.();

      const data = noteManager.exportState();
      // Persist under the MANAGER's committed identity, never the render's.
      // These notes are `noteManager`'s, and on an in-wallet account switch the
      // render already names the new wallet while this manager is still the old
      // one — writing the render's key files A's notes in B's bucket, where they
      // survive reloads as B's balance. See services/note-source.ts.
      const persist = resolveNotePersistTarget({
        committed: committedSessionRef.current,
        renderAddress: effectiveAddress,
        renderChainId: chainId,
      });
      if (persist.action === 'persist') {
        if (persist.drifted) {
          log('warn', 'SDK', 'Identity drifted during discovery; persisting under the session that owns these notes', {
            committed: { address: persist.address, chainId: persist.chainId },
            render: { address: effectiveAddress, chainId },
          });
        }
        saveStoredAccountExport(data as AccountExport, persist.address, persist.chainId);
        // A tab that started with no stored notes skipped the session-init pass,
        // so this is the first chance to record its spend times.
        const committedKeys = committedSessionRef.current?.keystoreManager;
        if (committedKeys) void recordDiscoveredSpendTimes(persist.chainId, persist.address, afterNotes, committedKeys);
        // Holdings for this identity + chain are now KNOWN: the notes were
        // persisted under the session that owns them. Keyed by that session,
        // not the render's identity, and never when persistence was skipped: a
        // discovery that outlived its session's wipe/rebuild must not restore
        // the readiness createSession just dropped (codex P2 on 0867560).
        setSyncedHoldings((prev) => withHoldingsKey(prev, persist.address, persist.chainId));
      } else {
        log('warn', 'SDK', 'Skipped persisting discovery: no committed session to key the export by', {
          render: { address: effectiveAddress, chainId },
        });
      }
      refreshNotes();
      // Discovery may have marked payment requests FULFILLED (the SDK's
      // PaymentRequestService persists status flips during the scan) —
      // tell the Payment Requests card to reload.
      bumpPaymentRequestRevision();

      log('info', 'SDK', 'Note discovery complete', {
        discoveredCount: discovered.length,
        discovered: discovered.map((n) => ({ commitment: n.commitment, txHash: n.txHash })),
        afterNoteCount: afterNotes.length,
        afterSyncCursor: afterCursor,
        afterNotes: afterNotes.map((n) => ({
          commitment: n.commitment,
          status: String(n.status),
          txHash: n.txHash,
          label: n.label,
          tokenId: n.tokenId,
        })),
      });
      return {
        depositsFound: discovered.length,
        spent: 0,
        exited: 0,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Frames only: Error.stack starts with the whole multi-line message, so
      // logging the stack logs the endpoint and the request body with it.
      log('error', 'SDK', `Note discovery failed: ${describeRpcError(err)}`, { frames: describeErrorFrames(err) });
      if (typeof console !== 'undefined' && console.error) {
        console.error('[SDK] syncFromSnapshot raw error:', err);
      }
      return null;
    } finally {
      if (opts?.quiet) {
        backgroundDiscoveryRef.current -= 1;
        // Lets the promotion pass that skipped while this ran go again.
        refreshNotes();
      } else if (committedSessionRef.current?.noteManager === noteManager) {
        setIsSyncing(false);
      }
    }
  }, [effectiveAddress, chainId, log, noteManager, poolSession, refreshNotes, setSyncedHoldings, setIsSyncing]);

  // A sweep whose active-chain pass waited for the event snapshot and gave up:
  // the grid-driven pass below runs it, with the range it asked for, once held.
  const deferredPrimaryRef = useRef<{ managers: object | null; opts?: { fromBlock?: string } } | null>(null);
  const limitSiblingDiscoveryRef = useRef(createChainLimiter());
  const siblingFlightsRef = useRef(new WeakMap<object, Map<number, Promise<ChainStepResult>>>());
  const backgroundSnapshotsRef = useRef(new WeakMap<object, Map<number, string>>());
  const allChainsFlightsRef = useRef(new WeakMap<object, Promise<{ depositsFound: number; spent: number; exited: number } | null>>());
  const discoveriesRef = useRef(new WeakMap<INoteManager, ReturnType<SdkContextValue['syncFromSnapshot']>>());
  const syncFromSnapshot = useCallback(async (opts?: { fromBlock?: string; quiet?: boolean }) => {
    if (!noteManager || committedSessionRef.current?.noteManager !== noteManager) return null;
    // Share incremental scans, but preserve explicit rescan ranges. This also
    // makes a spend preflight await any background pass on the same manager.
    const flights = discoveriesRef.current;
    while (flights.has(noteManager)) {
      const existing = flights.get(noteManager)!;
      if (!opts?.fromBlock) {
        const result = await existing;
        return committedSessionRef.current?.noteManager === noteManager ? result : null;
      }
      await existing;
    }
    const flight = Promise.resolve().then(() =>
      committedSessionRef.current?.noteManager === noteManager ? discoverNotes(opts) : null);
    flights.set(noteManager, flight);
    try { return await flight; } finally { flights.delete(noteManager); }
  }, [noteManager, discoverNotes]);

  /**
   * syncAllChains' step for ONE non-active EVM chain: bulk discovery + export,
   * persisted under that chain's bucket. A full scan of the pool, never a read naming a note.
   * 'stale' means the identity changed underneath it: the caller stops.
   */
  // What a pass is about to scan, read from the held pool-wide snapshot (never
  // a request while the grid owns the chain). Recorded once the pass completes
  // so the grid's background pass skips a chain a sweep already covered.
  const heldScanFingerprint = async (cid: number) => {
    const { loadPoolEventSnapshot } = await import('@/services/snapshot-source');
    const held = await loadPoolEventSnapshot(cid).catch(() => null);
    const fingerprint = snapshotActivityFingerprint(held, {
      associationRoot: feedData(publicFeeds.read(feedAssociationSet(cid))),
      labelDecisions: feedData(publicFeeds.read(feedLabelDecisions(cid))),
    });
    return { held, fingerprint };
  };
  const markSnapshotScanned = (
    owner: object,
    cid: number,
    scan: { held: unknown; fingerprint: string | null },
    cursor: () => unknown,
  ) => {
    if (scan.fingerprint === null || !snapshotScanComplete(scan.held, cursor())) return;
    let seen = backgroundSnapshotsRef.current.get(owner);
    if (!seen) {
      seen = new Map();
      backgroundSnapshotsRef.current.set(owner, seen);
    }
    seen.set(cid, scan.fingerprint);
  };

  const discoverSiblingChain = useCallback(async (
    cid: number,
    started: ReturnType<typeof siblingWorld>,
    sweepKeys: NonNullable<ReturnType<typeof siblingWorld>['managers']>['keystoreManager'],
  ): Promise<ChainStepResult> => {
    if (!effectiveAddress || !started.managers || !siblingWorldUnchanged(started)) return 'stale';
    // A manual sweep can join a grid pass already in flight. Keep this lock
    // outside effects so a rerender cannot create two managers for one bucket.
    let flights = siblingFlightsRef.current.get(started.managers);
    if (!flights) {
      flights = new Map();
      siblingFlightsRef.current.set(started.managers, flights);
    }
    const existing = flights.get(cid);
    if (existing) {
      const result = await existing;
      return siblingWorldUnchanged(started) ? result : 'stale';
    }
    const run = async (): Promise<ChainStepResult> => {
      if (!siblingWorldUnchanged(started)) return 'stale';
      // Discovery reads the chain's Note events from the grid's held snapshot.
      // Without it the SDK walks the chain from the deployment block, so wait
      // for the data and otherwise leave the chain to the grid's next refresh.
      if (!(await waitForFeed(publicFeeds, feedEventSnapshot(cid), SNAPSHOT_READY_WAIT_MS))) {
        log('info', 'SDK', 'Discovery deferred until the event snapshot is held', { chainId: cid });
        return siblingWorldUnchanged(started) ? 'deferred' : 'stale';
      }
      if (!siblingWorldUnchanged(started)) return 'stale';
      const scan = await heldScanFingerprint(cid);
      if (!siblingWorldUnchanged(started)) return 'stale';
      try {
        const session = await buildSessionForChain(cid, { discoveryOnly: true });
        if (!siblingWorldUnchanged(started)) return 'stale';
        if (!session) return 'skipped';
        const discovered = await (session as unknown as {
          discoverNotes: () => Promise<unknown[]>;
        }).discoverNotes();
        if (!siblingWorldUnchanged(started)) return 'stale';
        // Persist under THAT chain's bucket — the one the session was seeded
        // from, and the only place the balance views read it back.
        const exported = await exportAccount(session, { chainId: cid });
        if (!exported) return 'stale';
        void recordDiscoveredSpendTimes(cid, effectiveAddress, exported.notes, sweepKeys);
        // Only while this identity is still the live one and its bucket was not
        // wiped meanwhile: an older sweep must not undo a wipe's readiness
        // invalidation (codex P2 on 0867560).
        if (liveIdentityRef.current.address?.toLowerCase() === effectiveAddress.toLowerCase()
          && !wipedAccountKeys.has(wipedAccountKey(effectiveAddress, cid))) {
          setSyncedHoldings((prev) => withHoldingsKey(prev, effectiveAddress, cid));
        }
        // Discovery may have marked payment requests FULFILLED, as on the
        // active-chain path: tell the Payment Requests card to reload.
        bumpPaymentRequestRevision();
        if (started.managers) markSnapshotScanned(started.managers, cid, scan, () => loadStoredAccountExport(effectiveAddress, cid)?.syncCursor);
        log('info', 'SDK', 'Cross-chain discovery complete', {
          chainId: cid,
          discovered: discovered.length,
        });
        return 'synced';
      } catch (chainErr) {
        // Isolated per chain: one RPC being down, or that chain being
        // registered under a different unlock, must not abandon the rest.
        log('warn', 'SDK', `Discovery failed for chain ${cid}; other chains continue: ${describeRpcError(chainErr)}`);
        return siblingWorldUnchanged(started) ? 'failed' : 'stale';
      }
    };
    const flight = limitSiblingDiscoveryRef.current(run);
    flights.set(cid, flight);
    try { return await flight; } finally { if (flights.get(cid) === flight) flights.delete(cid); }
  }, [effectiveAddress, buildSessionForChain, exportAccount, log]);

  /**
   * Discovery across EVERY EVM chain this build serves, not just the active one.
   *
   * The balance and activity views are multichain — they read each chain's
   * stored export and the ASP feed for all chains — but discovery only ever ran
   * against the active session, so notes on the other chains (a cross-chain
   * shield's, most obviously) stayed as stale as whenever that chain was last
   * active. The active chain goes first, through syncFromSnapshot, because it
   * owns the cursor and export bookkeeping; the rest run through a
   * per-chain session, side by side (services/chain-sweep.ts).
   *
   * Every other chain is best-effort and isolated: one chain's RPC failing, or
   * being registered under a different unlock, must not abandon the others.
   */
  const syncAllChains = useCallback(async (primaryOpts?: { fromBlock?: string }) => {
    // One sweep per committed session at a time. Account-key sign-in and the
    // session-ready effect both start one; two would scan every sibling twice
    // and count the "chains left" marker down twice. A later call joins the
    // running sweep, unless it asks for an explicit range, which then runs
    // after it (same rule as syncFromSnapshot).
    const started = siblingWorld();
    const owner = started.managers;
    // This callback belongs to the rendered session, including while a new
    // sign-in commits its managers before React renders their callbacks.
    if (!owner || owner.noteManager !== noteManager) return null;
    const flights = allChainsFlightsRef.current;
    while (flights.has(owner)) {
      const existing = flights.get(owner)!;
      if (!primaryOpts?.fromBlock) {
        const result = await existing;
        return siblingWorldUnchanged(started) ? result : null;
      }
      await existing.catch(() => null);
      if (!siblingWorldUnchanged(started)) return null;
    }
    const sweep = async () => {
      if (!siblingWorldUnchanged(started)) return null;
      const sweepKeys = owner.keystoreManager;
      // One spinner across BOTH phases: syncFromSnapshot clears the flag in its
      // own finally, so relying on that alone drops it for a render between the
      // active chain and the others — long enough for the header button to
      // re-enable and start an overlapping sweep (kimi's review).
      setIsSyncingAll(true);
      try {
        // Once the user has an endpoint of their own, the chains they did NOT
        // give one for drop out of the sweep rather than being scanned through
        // the defaults. See queryableChainIds for why, and for what it costs;
        // the custom RPC form names the chains this skips before it saves.
        const queryable = new Set(queryableEvmChainIds());
        const scanPrimary = getChainConfig(chainId)?.chainType !== 'evm' || queryable.has(chainId);
        const others = supportedChainIds.filter(
          (cid) => cid !== chainId && getChainConfig(cid)?.chainType === 'evm' && queryable.has(cid),
        );
        // "Syncing (N chains left)" on the balance: counts down as each chain
        // finishes, failed ones included. Local state only, no request.
        setSyncChainsLeft(others.length + (scanPrimary ? 1 : 0));
        // Same data gate as the other chains. A deferred primary keeps its
        // requested range for the grid-driven pass below.
        const primaryReady = scanPrimary && (getChainConfig(chainId)?.chainType !== 'evm'
          || await waitForFeed(publicFeeds, feedEventSnapshot(chainId), SNAPSHOT_READY_WAIT_MS));
        if (!siblingWorldUnchanged(started)) return null;
        const deferred = deferredPrimaryRef.current?.managers === owner ? deferredPrimaryRef.current : null;
        const opts = earliestScanOptions(deferred?.opts, primaryOpts);
        // Retain the requested range on either a missing feed or a failed scan.
        const requested = scanPrimary ? { managers: owner, opts } : null;
        if (requested) deferredPrimaryRef.current = requested;
        const primaryScan = primaryReady && getChainConfig(chainId)?.chainType === 'evm' ? await heldScanFingerprint(chainId) : null;
        const primary = primaryReady ? await syncFromSnapshot(opts) : null;
        if (primary && siblingWorldUnchanged(started) && deferredPrimaryRef.current === requested) deferredPrimaryRef.current = null;
        if (primary && primaryScan && siblingWorldUnchanged(started)) {
          markSnapshotScanned(owner, chainId, primaryScan, () => (noteManager as unknown as { getSyncCursor?: () => string } | null)?.getSyncCursor?.());
        }
        if (!effectiveAddress || !siblingWorldUnchanged(started)) return null;
        if (scanPrimary) setSyncChainsLeft((n) => Math.max(0, n - 1));
        // Side by side, not one after another: each chain added to the build used
        // to add its whole discovery time to the sweep (services/chain-sweep.ts).
        if (await sweepChains(others, (cid) => discoverSiblingChain(cid, started, sweepKeys),
          undefined, () => { if (siblingWorldUnchanged(started)) setSyncChainsLeft((n) => Math.max(0, n - 1)); }) === 'stale') return null;
        if (!siblingWorldUnchanged(started)) return null;
        if (others.length > 0) refreshNotes();
        return primary;
      } finally {
        if (siblingWorldUnchanged(started)) { setIsSyncingAll(false); setSyncChainsLeft(0); }
      }
    };
    const flight = sweep();
    flights.set(owner, flight);
    try { return await flight; } finally { if (flights.get(owner) === flight) flights.delete(owner); }
  }, [syncFromSnapshot, effectiveAddress, chainId, noteManager, discoverSiblingChain, refreshNotes]);

  // ---------------------------------------------------------------------------
  // Auto-run note discovery on first session ready (once per session)
  // ---------------------------------------------------------------------------

  // Guarded per SESSION OBJECT, not per address:chain string: the string key
  // survived session teardown, so a same-wallet disconnect/reconnect (same
  // provider lifetime) rebuilt keys+session but skipped discovery — "Sign in
  // to sync" would sign in and never sync. Every committed session is a new
  // object, so a rebuilt session always gets its first-sync pass; the WeakSet
  // lets torn-down sessions be collected.
  const autoDiscoveredSessionsRef = useRef<WeakSet<object>>(new WeakSet());
  useEffect(() => {
    if (!poolSession || !noteManager || !effectiveAddress) return;
    if (autoDiscoveredSessionsRef.current.has(poolSession as unknown as object)) return;
    autoDiscoveredSessionsRef.current.add(poolSession as unknown as object);
    // Full-range on the FIRST sync for this (address, chain) in this tab, so
    // spends that predate the stored cursor (a note spent on another device, or
    // an imported note) are re-detected and marked SPENT. Later syncs stay
    // incremental because the cursor has advanced.
    //
    // Measured 2026-08-27: that full-range pass takes ~45s and issues ~450
    // eth_getBlockByNumber calls, and it was re-running on EVERY session
    // object - so a reconnect, or anything that rebuilt the session, paid it
    // again and usually discovered nothing. The guard is now recorded per
    // (address, chain) in sessionStorage: same-tab reconnects skip it, and a
    // new tab (which has no notes cached anyway) still gets its deep scan.
    //
    // sessionStorage, not localStorage, deliberately: this must not suppress
    // the deep scan for a whole browser profile, only for the tab that already
    // paid for it.
    const deployFromBlock = getChainConfig(chainId)?.contracts?.fromBlock;
    const deepScanKey = envScopedStorageKey(`ppv2_deep_scan_v1:${effectiveAddress.toLowerCase()}:${chainId}`);
    let deepScanDone = false;
    try {
      deepScanDone = typeof sessionStorage !== 'undefined' && sessionStorage.getItem(deepScanKey) === '1';
    } catch {
      deepScanDone = false;
    }
    // A cursor with NO notes is impossible state, and it means this guard was
    // inherited rather than earned. sessionStorage is COPIED into a tab opened
    // from an existing page, so a "new tab" arrives holding both the deep-scan
    // flag and a sync cursor from the tab that spawned it, while its own note
    // manager is empty. Discovery then runs INCREMENTALLY from that inherited
    // cursor and skips everything before it.
    //
    // Measured on Pat's account, 2026-09-01: the incremental pass scanned
    // blocks 11610762 to 11610768, six blocks, starting 32 blocks AFTER the
    // registration (11610728) and claim (11610730) it was supposed to find.
    // It reported "0 discovered" and the account rendered as empty.
    //
    // So: no notes means the deep scan has not actually happened HERE,
    // whatever the flag says. Re-earn it.
    const restoredNoteCount = loadStoredAccountExport(effectiveAddress, chainId)?.notes?.length ?? 0;
    const deepScanTrustworthy = deepScanDone && restoredNoteCount > 0;
    const fromBlock = !deepScanTrustworthy && deployFromBlock !== undefined
      ? `0x${deployFromBlock.toString(16)}`
      : undefined;
    log(
      'info',
      'SDK',
      fromBlock ? 'Auto-running full-range note discovery on session ready' : 'Auto-running incremental note discovery (deep scan already done in this tab)',
      { address: effectiveAddress, chainId, fromBlock },
    );
    // EVERY session sweeps EVERY EVM chain, whatever the network selector says.
    // Discovery is per active chain, so single-chain discovery made the balance
    // and the transactions list a function of which chain you happened to be
    // standing on. Two ways that bit, both measured on Pat's account:
    //   - an ACCOUNT KEY names no chain, so the app boots on defaultChainId
    //     (mainnet on the staging build, config/chains.ts:204) and the whole
    //     account read as EMPTY: 1.96s, 0 discovered, against the wallet's
    //     10.06s, 30 discovered on Sepolia (2026-08-31).
    //   - a WALLET names only ITS chain, so an Optimism note stayed undiscovered
    //     and 23.29 USDC was missing from the balance and its deposit missing
    //     from the table, while the key session on the same account showed both
    //     (2026-09-01). sessionStorage is per-tab, so one tab's discovery cannot
    //     cover another's.
    // Pat's rule, and the right one: all notes from all chains, no matter the
    // network selected up top. syncAllChains does the active chain first with
    // the same deep-scan fromBlock, then each other chain into its own bucket.
    syncAllChains(fromBlock ? { fromBlock } : undefined)
      .then((result) => {
        // Only record success: a failed deep scan must be retried, not skipped.
        if (!result || !fromBlock) return;
        try { sessionStorage.setItem(deepScanKey, '1'); } catch { /* non-fatal */ }
      })
      .catch(() => { /* errors logged inside */ });
  }, [effectiveAddress, chainId, log, noteManager, poolSession, syncAllChains]);

  // Discovery on the feed grid's clock, for EVERY chain the sweep covers, not
  // just the active one: a cross-chain deposit landing on another chain used
  // to wait for the user to switch to it. The grid already refreshes each
  // chain's event snapshot, so this adds no timer and no ASP request; it reads
  // the held copy. A chain is rescanned only when its pool-wide rows changed
  // (snapshotActivityFingerprint), or when the sweep deferred it for want of
  // the snapshot. The flows apply what they know locally; this reconciles the
  // rest. A pass the flows started themselves at confirmation, or before a
  // proof, made that moment visible to the ASP and the RPC provider; a pass on
  // the grid says nothing about it.
  useEffect(() => {
    if (!poolSession || !noteManager || !effectiveAddress) return;
    const session = poolSession as unknown as object;
    const started = siblingWorld();
    const owner = started.managers;
    if (!owner || owner.noteManager !== noteManager) return;
    let active = true;
    const current = () => active && siblingWorldUnchanged(started);
    const chains = supportedChainIds.filter(
      (cid) => isSupportedEvmChainId(cid) && queryableEvmChainIds().includes(cid),
    );
    let seen = backgroundSnapshotsRef.current.get(owner);
    if (!seen) {
      seen = new Map();
      backgroundSnapshotsRef.current.set(owner, seen);
    }
    const running = new Set<number>();
    const onFeed = (cid: number) => {
      const state = publicFeeds.read(feedEventSnapshot(cid));
      if (!current() || !feedHasData(state)) return;
      // The session-ready sweep comes first and may be a full-range one; a
      // background pass never overlaps it.
      if (!autoDiscoveredSessionsRef.current.has(session)) return;
      if (owner && allChainsFlightsRef.current.has(owner)) return;
      if (running.has(cid)) return;
      running.add(cid);
      void (async () => {
        try {
          // This feed publishes only its watermark; the rows live in the
          // shared snapshot store. Reading it never refreshes the ASP.
          const { loadPoolEventSnapshot } = await import('@/services/snapshot-source');
          const held = await loadPoolEventSnapshot(cid);
          if (!current() || allChainsFlightsRef.current.has(owner)) return;
          // A pass already running may have read an OLDER snapshot. Joining
          // it must not mark the new fingerprint as scanned. Leave this copy
          // for the next grid tick instead of launching a follow-up off-grid.
          if (cid === chainId ? discoveriesRef.current.has(noteManager)
            : siblingFlightsRef.current.get(owner)?.has(cid)) return;
          const fingerprint = snapshotActivityFingerprint(held, {
            associationRoot: feedData(publicFeeds.read(feedAssociationSet(cid))),
            labelDecisions: feedData(publicFeeds.read(feedLabelDecisions(cid))),
          });
          const deferred = cid === chainId && deferredPrimaryRef.current?.managers === owner
            ? deferredPrimaryRef.current : null;
          if (!deferred && fingerprint !== null && seen.get(cid) === fingerprint) return;
          let ok = false;
          if (cid === chainId) {
            const opts = deferred?.opts;
            ok = (await syncFromSnapshot({ ...opts, quiet: true })) !== null;
            if (ok && current() && deferred && deferredPrimaryRef.current === deferred) deferredPrimaryRef.current = null;
          } else {
            const result = await discoverSiblingChain(cid, started, owner.keystoreManager);
            ok = result === 'synced' || result === 'skipped';
            if (current() && result === 'synced') refreshNotes();
          }
          // The SDK can resolve successfully while holding its cursor at an
          // unverified note or unfinalized exit. Do not permanently suppress
          // that retry just because the ASP rows have stopped changing.
          const cursor = cid === chainId ? (noteManager as unknown as { getSyncCursor?: () => string }).getSyncCursor?.()
            : loadStoredAccountExport(owner.address, cid)?.syncCursor;
          if (current() && ok && fingerprint !== null && snapshotScanComplete(held, cursor)) seen.set(cid, fingerprint);
        } catch {
          // Logged inside; the next refresh retries.
        } finally {
          running.delete(cid);
        }
      })();
    };
    const unsubscribes = chains.map((cid) => publicFeeds.subscribe(feedEventSnapshot(cid), () => onFeed(cid)));
    return () => { active = false; for (const u of unsubscribes) u(); };
  }, [poolSession, noteManager, effectiveAddress, chainId, syncFromSnapshot, discoverSiblingChain, refreshNotes]);

  useEffect(() => {
    // Stored exports feed the balance before a session exists. Apply the same
    // promotion policy there, preserving all fields except accepted statuses.
    // A failed fetch may retain cached data: require successful answers from
    // BOTH queries, not just a non-empty leaves array.
    if (!effectiveAddress || !associationSetLeavesReady || associationSetLeaves.length === 0
      || !blockedLabelsSucceeded || !blockedLabelHashes || txPending || isSyncing
      || backgroundDiscoveryRef.current > 0) return;

    const passAddress = effectiveAddress;
    const passChainId = chainId;
    const committed = committedSessionRef.current;
    const sessionParams = batchSessionParamsRef.current;
    // On a chain/account switch React can still hold the previous manager.
    // Check ownership before hashing or mutating any of its notes, including
    // the resolved pool rather than trusting a non-empty set from another pool.
    const stillCurrent = () => (
      liveIdentityRef.current.address?.toLowerCase() === passAddress.toLowerCase()
      && liveIdentityRef.current.chainId === passChainId
      && committedSessionRef.current === committed
      && (!noteManager || (
        committed?.noteManager === noteManager
        && committed.address.toLowerCase() === passAddress.toLowerCase()
        && committed.chainId === passChainId
        && sessionParams === batchSessionParamsRef.current
        && sessionParams?.poolAddress.toLowerCase() === configuredPoolAddress
      ))
    );
    if (!stillCurrent()) return;
    let cancelled = false;

    (async () => {
      const { createHashService } = await getSdkSetup();
      const hashService = await createHashService();
      if (cancelled || !stillCurrent()) return;

      // Read AFTER the awaits so an import/deposit saved during SDK startup
      // cannot be overwritten by a snapshot captured before it.
      const storedForPromotion = noteManager ? null : loadStoredAccountExport(passAddress, passChainId);
      if (!noteManager && !storedForPromotion) return;
      const notes = noteManager ? noteManager.getNotes() : storedForPromotion!.notes;
      if (!Array.isArray(notes)) return;
      const leafSet = new Set(associationSetLeaves);
      const blockedSet = new Set(blockedLabelHashes);
      const storageFlips = new Map<Hash, NoteStatus>();
      const statusNow = new Map<string, string>(
        notes.map((note) => [String(note.commitment), String(note.status).toUpperCase()]),
      );
      const applyStatus = (commitment: Hash, next: NoteStatus): boolean => {
        const from = statusNow.get(commitment) ?? '';
        if (from === next || !SDK_STATUS_TRANSITIONS[from]?.has(next)) return false;
        if (noteManager) {
          noteManager.updateNoteStatus(commitment, next);
          // The wrapper can swallow invalid transitions. Count/persist only
          // changes that actually landed, including the first INACTIVE step.
          const actual = String(noteManager.getNote(commitment).status).toUpperCase();
          statusNow.set(commitment, actual);
          return actual === next;
        }
        storageFlips.set(commitment, next);
        statusNow.set(commitment, next);
        return true;
      };
      let promotedCount = 0;
      let invalidLabelCount = 0;
      for (const note of notes) {
        const status = statusNow.get(note.commitment);
        if (status !== 'PENDING' && status !== 'INACTIVE') continue;
        // Never infer a label from token+amount or let one malformed stored
        // note abort promotion (or persistence) for the rest of the account.
        let labelHash: string | null;
        try {
          if (typeof note.label !== 'string' || !/^0x[0-9a-fA-F]+$/.test(note.label)) {
            invalidLabelCount += 1;
            continue;
          }
          labelHash = normalizeHashValue(hashService.hash([note.label]));
        } catch {
          invalidLabelCount += 1;
          continue;
        }
        // Membership proves the ASP part of the witness, not every condition
        // for spending. A newer decline can coexist with a published leaf;
        // match sdk-setup's decision precedence before promoting a note.
        // In legacy mode getPoolBlockedLabelHashes returns an empty set and
        // the frozen historical tree remains the approval authority.
        if (!labelHash || !leafSet.has(labelHash) || blockedSet.has(labelHash)) continue;
        if (status === 'INACTIVE' && !applyStatus(note.commitment, NoteStatus.PENDING)) continue;
        if (applyStatus(note.commitment, NoteStatus.ACTIVE)) promotedCount += 1;
      }

      // Absence alone is not a status transition. The pinned SDK refuses
      // ACTIVE -> PENDING and requires explicit rejection PLUS verified absence
      // for ACTIVE -> REJECTED. Leave demotion and rejected-note recovery to
      // discovery, which also reconciles spends before recovering a note.
      log('debug', 'SDK', 'Association-set promotion pass complete', {
        chainId: passChainId,
        source: noteManager ? 'live-note-manager' : 'stored-export',
        promotedCount,
        invalidLabelCount,
        pendingCount: [...statusNow.values()].filter((status) => status === 'PENDING').length,
      });
      if (promotedCount === 0 && storageFlips.size === 0) return;
      if (cancelled || !stillCurrent()) return;
      if (noteManager && poolSession) {
        // No override: exportAccount uses the session's committed storage key.
        await exportAccount();
      } else if (storageFlips.size > 0 && storedForPromotion) {
        saveStoredAccountExport({
          ...storedForPromotion,
          notes: notes.map((note) => {
            const status = storageFlips.get(note.commitment);
            return status ? { ...note, status } : note;
          }),
        }, passAddress, passChainId);
        refreshNotes();
      }
    })().catch((err) => {
      if (cancelled) return;
      const message = err instanceof Error ? err.message : String(err);
      log('error', 'SDK', `Failed to sync note activation from ASP leaves: ${describeRpcError(err)}`);
    });

    return () => { cancelled = true; };
    // Discovery/import can add a note to an already-approved lineage without
    // changing the root. notesRevision is the local trigger that replaces the
    // removed event query's incidental reruns. Actual changes alone refresh it.
  }, [effectiveAddress, associationSetLeaves, associationSetLeavesReady, associationSetLeavesScopeKey,
    blockedLabelHashes, blockedLabelsSucceeded, chainId, configuredPoolAddress, exportAccount, log,
    noteManager, notesRevision, poolSession, refreshNotes, txPending, isSyncing]);

  // Auto-save on unmount if session is active
  useEffect(() => {
    const currentSession = committedSessionRef.current;
    return () => {
      if (poolSession && currentSession
        && !wipedAccountKeys.has(wipedAccountKey(currentSession.address, currentSession.chainId))) {
        poolSession
          .exportAccount()
          .then((data) => saveStoredAccountExport(data, currentSession.address, currentSession.chainId))
          .catch(() => {
            // Ignore export errors on cleanup
          });
      }
    };
  }, [poolSession, effectiveAddress, chainId]);

  const getCommittedManagers = useCallback(
    () => ({
      noteManager: committedSessionRef.current?.noteManager ?? null,
      keystoreManager: committedSessionRef.current?.keystoreManager ?? null,
    }),
    [],
  );


  // Build (and cache) a batch-withdrawal-scoped PoolSession. Identical to the
  // main session EXCEPT its relayer record advertises the PrivacyPoolRelay
  // contract as the processor, so the SDK's PoolSessionBatchWithdraw binds
  // every batch proof to the on-chain relayBatch msg.sender (finding 1 —
  // batch can't rebind per-call the way single withdrawals do). It REUSES the
  // committed note/keystore managers, so note-state persistence lands in the
  // same store the UI reads. Returns null until the main session is committed.
  // `onlyInputs` builds an uncached session that proves only those notes: a
  // sub-batch, when the whole balance cannot prove inside one quote window
  // (services/batch-withdrawals.ts, withdrawGroupsWithinWindow).
  const getBatchWithdrawSession = useCallback(async (onlyInputs?: ReadonlySet<string>): Promise<PoolSession | null> => {
    const started = siblingWorld();
    const params = started.params;
    const managers = started.managers;
    if (!params || !managers) return null;
    if (!onlyInputs && batchSessionRef.current?.key === params.key) {
      return batchSessionRef.current.session;
    }
    const { getWithdrawalProcessorAddress } = await import('@/config/relayer');
    const { createCircuitArtifacts } = await getSdkSetup();
    const { createPoolSession } = await getPoolSessionService();
    const session = (await createPoolSession({
      ownerAddress: params.ownerAddress,
      chainId: params.chainId,
      entrypointAddress: params.entrypointAddress,
      poolAddress: params.poolAddress,
      keystoreAddress: params.keystoreAddress,
      // Committed managers are the ppv2 INoteManager/IKeystoreManager mirror;
      // the runtime instances are the real SDK managers (they were built by
      // the SDK in createSession), so bridge the nominal typing gap.
      keystoreManager: managers.keystoreManager as never,
      noteManager: (onlyInputs ? noteManagerLimitedTo(managers.noteManager, onlyInputs) : managers.noteManager) as never,
      circuitArtifacts: createCircuitArtifacts(CIRCUIT_ARTIFACTS_BASE_URL),
      deploymentBlock: params.deploymentBlock,
      relayerProcessorAddress: getWithdrawalProcessorAddress(params.chainId),
    })) as unknown as PoolSession;
    // Superseded mid-build: this session holds managers nobody reads any more.
    // Drop it rather than cache it under a key the next caller would accept.
    if (!siblingWorldUnchanged(started)) return null;
    if (onlyInputs) return session;
    batchSessionRef.current = { key: params.key, session };
    return session;
  }, []);

  // Build (and cache) a session for the DISCLOSED transfer ("Hide my address"
  // off), whose only difference is that it advertises no relayers.
  //
  // DEV-370: the SDK's prepareTransfer always fetches a committing transfer
  // quote before it proves, with no way to opt out, and throws
  // RelayerRequestFailed when every relayer fails. A disclosed transfer never
  // relays — it self-submits from the user's wallet — so on a chain the relayer
  // does not serve, the send died on a quote whose answer it would have thrown
  // away, and reserved a fee commitment for a relay that never happens. With no
  // relayers configured the SDK skips the request entirely (the throw is
  // guarded by `relayers.length > 0`).
  //
  // Same shape as getBatchWithdrawSession: reuses the committed note/keystore
  // managers so note-state writes land in the store the UI reads. Returns null
  // until the main session is committed, so callers fall back to it.
  const getSelfSubmitTransferSession = useCallback(async (): Promise<PoolSession | null> => {
    const started = siblingWorld();
    const params = started.params;
    const managers = started.managers;
    if (!params || !managers) return null;
    if (selfSubmitSessionRef.current?.key === params.key) {
      return selfSubmitSessionRef.current.session;
    }
    const { createCircuitArtifacts } = await getSdkSetup();
    const { createPoolSession } = await getPoolSessionService();
    const session = (await createPoolSession({
      ownerAddress: params.ownerAddress,
      chainId: params.chainId,
      entrypointAddress: params.entrypointAddress,
      poolAddress: params.poolAddress,
      keystoreAddress: params.keystoreAddress,
      keystoreManager: managers.keystoreManager as never,
      noteManager: managers.noteManager as never,
      circuitArtifacts: createCircuitArtifacts(CIRCUIT_ARTIFACTS_BASE_URL),
      deploymentBlock: params.deploymentBlock,
      withoutRelayers: true,
    })) as unknown as PoolSession;
    // Superseded mid-build (see siblingWorldUnchanged). Returning null sends
    // the caller back to the main session, which is correct-but-quoting rather
    // than fast-and-stale.
    if (!siblingWorldUnchanged(started)) return null;
    selfSubmitSessionRef.current = { key: params.key, session };
    return session;
  }, []);

  /**
   * A session for a pool on ANOTHER chain, with the connected wallet's chain
   * attached as the swap source — the shape a cross-chain swap-and-deposit
   * needs (SDK ≥ eecb069b): the approval and the LiFi transaction execute on
   * the wallet's chain while the deposit lands in `poolChainId`'s pool, so the
   * session must be built for the DESTINATION while the wallet stays put.
   *
   * Deliberately NOT cached: it carries a wallet interactor whose identity is
   * owned by the caller's render, and a cross-chain deposit is a one-shot.
   * Returns null when the pair is not routable (config/intent-swaps decides —
   * LiFi has to serve both ends and both need a RelaySwaps) or when no session
   * is committed yet.
   */


  const createCrossChainShieldSession = useCallback(async (args: {
    poolChainId: number;
    sourceChainId: number;
    walletInteractor: unknown;
  }): Promise<PoolSession | null> => {
    const { crossChainSwapDepositSupported, getSwapProcessorAddress } = await import('@/config/intent-swaps');
    if (!crossChainSwapDepositSupported(args.sourceChainId, args.poolChainId)) return null;
    const sourceRelaySwaps = getSwapProcessorAddress(args.sourceChainId);
    if (!sourceRelaySwaps) return null;
    return buildSessionForChain(args.poolChainId, {
      swapSourceChain: {
        chainId: args.sourceChainId,
        relaySwapsAddress: sourceRelaySwaps,
        walletInteractor: args.walletInteractor,
        deploymentBlock: Number(getChainConfig(args.sourceChainId)?.contracts?.fromBlock ?? 0) || undefined,
      },
    });
  }, [buildSessionForChain]);

  /**
   * Flow 4's two sessions. Refused unless config/intent-swaps says this exact
   * pair can route, so an unsupported destination cannot reach the SDK at all.
   * Both are built through the same identity guards as every other session
   * (buildSessionForChain), so a chain this account is registered differently on
   * throws there rather than silently producing foreign notes.
   */
  /** See the context type: a far-chain session without moving the app there. */
  const sessionForChain = useCallback(async (targetChainId: number): Promise<PoolSession | null> => {
    if (!isSupportedEvmChainId(targetChainId)) return null;
    return buildSessionForChain(targetChainId);
  }, [buildSessionForChain]);

  const createReshieldCrosschainSessions = useCallback(async (args: {
    destinationChainId: number;
  }): Promise<{ source: PoolSession; destination: PoolSession } | null> => {
    const { crossChainReshieldSupported } = await import('@/config/intent-swaps');
    if (!crossChainReshieldSupported(chainId, args.destinationChainId)) return null;
    // The DESTINATION is built first now, because the source session needs its
    // share targets. It is still a separate session, and the destination note is
    // still persisted against it — losing it would leave the reshielded value
    // invisible locally until a rescan found it.
    const destination = await buildSessionForChain(args.destinationChainId);
    if (!destination) return null;
    // `yields` is the destination chain's configured share namespaces. Handing
    // them to the source session is what lets the far-side deposit fund a share
    // through its router; without them the SDK can only call Entrypoint.deposit
    // over there, which no share pool accepts. Absent on an older SDK, in which
    // case this is simply omitted and plain targets behave exactly as before.
    const source = await buildSessionForChain(chainId, {
      reshieldDestinationChainId: args.destinationChainId,
      ...(destination.yields?.length ? { reshieldDestinationYieldTargets: destination.yields } : {}),
    });
    if (!source) return null;
    return { source, destination };
  }, [buildSessionForChain, chainId]);

  // ---------------------------------------------------------------------------
  // Account key: export current identity / sign in without a wallet
  // ---------------------------------------------------------------------------

  const exportAccountKey = useCallback(async (): Promise<string> => {
    if (identityMode === 'key' && keyIdentity) {
      // Re-export the imported key verbatim.
      return encodeAccountKey(keyIdentity);
    }
    if (!walletActive || !address) {
      throw new Error('Connect a wallet (or sign in with an account key) first.');
    }
    // Derive (or reuse) the keys so the deterministic signature(s) are
    // captured — prompts the wallet only if the account isn't unlocked yet.
    const epoch = deriveEpochRef.current;
    await deriveKeystoreManager();
    if (deriveEpochRef.current !== epoch || liveIdentityRef.current.address?.toLowerCase() !== address.toLowerCase()
      || passkeyModeRef.current || keystoreSourceRef.current !== 'signature') {
      throw new Error('The account changed or uses a passkey. Export from the current account’s recovery options.');
    }
    const captured = capturedSigsRef.current;
    if (!captured || captured.address !== address.toLowerCase() || !captured.signature) {
      throw new Error('Could not capture the derivation signature. Unlock the account and try again.');
    }
    return encodeAccountKey({
      address: address as Address,
      signature: captured.signature,
      ...(captured.legacySignature ? { legacySignature: captured.legacySignature } : {}),
    });
  }, [identityMode, keyIdentity, walletActive, address, deriveKeystoreManager]);

  // Sign-in completion runs in an effect so ensureInitialized closes over the
  // committed identity state (no stale-closure race on the fresh import).
  const keySignInSeqRef = useRef(0);
  // Bumped when a key sign-in commits, so effects waiting on the attempt
  // (the payment-request sign-out purge) re-run: the resolver is a ref.
  const [keySignInCommits, setKeySignInCommits] = useState(0);
  const keySignInResolverRef = useRef<{
    requestId: number;
    identity: AccountKeyIdentity;
    started: boolean;
    resolve: () => void;
    reject: (e: unknown) => void;
  } | null>(null);
  const signInWithAccountKey = useCallback((encoded: string): Promise<void> => {
    return new Promise<void>((resolve, reject) => {
      try {
        const identity = decodeAccountKey(encoded);
        persistImportedIdentity(null);
        keySignInResolverRef.current?.reject(new Error('A newer account-key sign-in was started.'));
        keySignInResolverRef.current = {
          requestId: ++keySignInSeqRef.current,
          identity,
          started: false,
          resolve,
          reject,
        };
        setImportedIdentity(identity);
      } catch (err) {
        reject(err);
      }
    });
  }, [walletActive]);

  useEffect(() => {
    const pending = keySignInResolverRef.current;
    if (!pending || pending.started || identityMode !== 'key' || !sameAccountKeyIdentity(importedIdentity, pending.identity)) {
      return;
    }
    pending.started = true;
    ensureInitialized()
      .then(() => {
        if (keySignInResolverRef.current?.requestId !== pending.requestId) return;
        keySignInResolverRef.current = null;
        persistImportedIdentity(pending.identity);
        setKeySignInCommits((n) => n + 1);
        pending.resolve();
        // Kick discovery explicitly — don't rely on the session-ready effect's
        // timing for the headline moment of a fresh key sign-in.
        syncAllChains().catch(() => { /* errors logged inside */ });
      })
      .catch((err) => {
        if (keySignInResolverRef.current?.requestId !== pending.requestId) return;
        keySignInResolverRef.current = null;
        // An interrupted derivation is not a bad key: keep the identity for the retry.
        if (err instanceof KeySourceChangedError) { pending.reject(err); return; }
        // Bad key (or derivation failure): drop it so the app doesn't keep a
        // broken identity around.
        persistImportedIdentity(null);
        setImportedIdentity(null);
        pending.reject(err);
      });
  }, [identityMode, importedIdentity, ensureInitialized, syncAllChains]);

  // ---------------------------------------------------------------------------
  // Sign-out purge of the stored payment-request records
  // ---------------------------------------------------------------------------
  // Each record carries its request's note secrets under a key naming the
  // owner, and used to outlive every sign-out. Purged here, for the owner that
  // stopped being the session identity, on every way that happens: a wallet
  // disconnect (header, settings, the wallet itself, the embedded passkey
  // wallet), signOutAccountKey, an account switch in the wallet, and a key
  // sign-in or sign-out that replaces the wallet identity (or vice versa).
  //
  // An EMPTY identity counts only once wagmi settles on 'disconnected': a
  // reconnect blip ('connecting'/'reconnecting') is not a sign-out, and
  // purging on one would drop records mid-session. A key-source switch
  // (signature <-> passkey unlock) keeps the same owner signed in, so it is
  // not a sign-out either: those records are still that owner's live state.
  //
  // What is purged is only what a backup exists for; see
  // services/payment-request-signout-purge.ts.
  const signedInOwnerRef = useRef<string | null>(null);
  useEffect(() => {
    // A key sign-in sets the identity BEFORE its session builds, and a failed
    // one drops the key and falls back to the wallet. Until it commits it is
    // only an attempt, not a sign-out of the wallet it would replace: wait.
    // A commit bumps keySignInCommits, a failure drops importedIdentity, and
    // either re-runs this.
    const pendingKey = keySignInResolverRef.current;
    if (pendingKey && identityMode === 'key' && sameAccountKeyIdentity(importedIdentity, pendingKey.identity)) return;
    const { signedOut, owner } = signedOutOwner(signedInOwnerRef.current, effectiveAddress ?? null, accountStatus);
    signedInOwnerRef.current = owner;
    if (owner) allowPaymentRequestWrites(owner);
    if (!signedOut) return;
    void purgePaymentRequestsOnSignOut(signedOut)
      .then((result) => {
        log(result.kept > 0 || result.aborted ? 'warn' : 'info', 'PaymentRequest', 'Sign-out purge of stored requests', result);
      })
      .catch((err) => log('warn', 'PaymentRequest', 'Sign-out purge of stored requests failed', err));
  }, [effectiveAddress, accountStatus, identityMode, importedIdentity, keySignInCommits, log]);



  // A RESTORED key session (page reload with the key still in
  // sessionStorage) has an identity but no session until something calls
  // ensureInitialized — unlike wallet mode there's no signature prompt to
  // wait for, so build it (and run discovery via the session-ready effect)
  // automatically. Ref-guarded per identity so a failing init doesn't loop.
  const keyAutoInitRef = useRef<string | null>(null);
  useEffect(() => {
    if (identityMode !== 'key' || !keyIdentity || isInitialized || isInitializing) return;
    if (keySignInResolverRef.current) return; // fresh paste path handles itself
    const initKey = `${keyIdentity.address.toLowerCase()}:${chainId}`;
    if (keyAutoInitRef.current === initKey) return;
    keyAutoInitRef.current = initKey;
    ensureInitialized().catch(() => { /* surfaced via error state; logged inside */ });
  }, [identityMode, keyIdentity, isInitialized, isInitializing, chainId, ensureInitialized]);

  // The wallet-mode twin, and ONLY for a chain switch that can be resumed with
  // no prompt at all. The rule above still stands: a wallet that has not signed
  // in this tab is never auto-signed, because `signTypedData` the moment the
  // wallet connects is a prompt the user has no context for. But once this
  // address HAS proved a signature, a chain switch can rebuild its session
  // silently — and must, or the user is left signed in with no session, no
  // discovery, and no Sign in button (the unlock gate hides it while
  // `keysReady` is true). Ref-guarded per target so a failure cannot loop.
  // The target this effect last started a build for. State, not a ref, so
  // `sessionResuming` below reads the very guard this effect obeys.
  const [walletAutoInitKey, setWalletAutoInitKey] = useState<string | null>(null);
  useEffect(() => {
    if (identityMode !== 'wallet' || keyIdentity || isInitialized || isInitializing || error) return;
    // `keysReady` true here means one of two things, and neither may auto-init:
    // a stale closure from the render where the chain changed (teardown's
    // setState has not landed yet, so `ensureInitialized` would build the new
    // chain's session from the OLD chain's manager), or keys already derived
    // for THIS chain with no session — which is the Export Account Key state,
    // and exporting is not a request for a session. The teardown always drives
    // it false before any legitimate rebuild.
    if (keysReady) return;
    if (!effectiveAddress || !isSupportedEvmChainId(chainId)) return;
    // No proved signature → the ordinary first sign-in, which the unlock
    // dialog owns. Nothing here may reach the wallet.
    if (provenSigsRef.current?.address !== String(effectiveAddress).toLowerCase()) return;
    const initKey = `${String(effectiveAddress).toLowerCase()}:${chainId}`;
    if (walletAutoInitKey === initKey) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the once-per-target guard, shared with sessionResuming
    setWalletAutoInitKey(initKey);
    silentDeriveRef.current = true;
    void ensureInitialized()
      .catch(() => { /* surfaced via error state; logged inside */ })
      .finally(() => { silentDeriveRef.current = false; });
  }, [identityMode, keyIdentity, isInitialized, isInitializing, error, keysReady, effectiveAddress, chainId, ensureInitialized, walletAutoInitKey]);

  // Take the offer: unlock THIS wallet with a passkey instead of a signature
  // it cannot repeat. Guarded on the observation, so nothing can turn an
  // ordinary wallet into a passkey account by calling this.
  const choosePasskeyForRefusedSigner = useCallback(() => {
    const current = address?.toLowerCase();
    if (!current || !refusedSigners.has(current)) return;
    setPasskeyForSigner(current);
  }, [address, refusedSigners, setPasskeyForSigner]);
  const baseAppCannotSign = !!address && baseAppRefused.has(address.toLowerCase());

  const signOutAccountKey = useCallback(() => {
    persistImportedIdentity(null);
    setImportedIdentity(null);
    // Signing out is the one moment the user says "not this identity any more",
    // and the address goes undefined rather than changing, so the reset effect
    // deliberately keeps its refs. Drop the proved signature here or connecting
    // a wallet for that same address would silently inherit this session.
    provenSigsRef.current = null;
    setProvenAddress(null);
    // Session/keys teardown happens via the identity-keyed reset effects.
  }, [setProvenAddress]);




  // GUARD: refuse to deposit when the active unlock isn't the one registered
  // on-chain for this owner — that deposit would be owned by an identity that
  // can't authorize a spend/exit (the keystore nullifying key is write-once).
  // Re-reads on-chain against the COMMITTED manager rather than trusting the
  // React `keystoreIdentityStatus` (which can lag the just-derived identity, or
  // be stale if another tab/device registered in between). Unknown results
  // block a deposit; first-time registration remains available.
  // Field tracing for the balances-landing bug: session readiness flips.
  useEffect(() => {
    console.log('[PP-SESSION]', JSON.stringify({ keysReady, identityMode, sessionAddress: effectiveAddress ?? null, chainId }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keysReady, identityMode]);

  // Relays are tagged with the account they were made under (pending-relays-store).
  useEffect(() => {
    setPendingRelayOwner(effectiveAddress ?? null);
  }, [effectiveAddress]);

  const assertCanDeposit = useCallback(async (writeChainId?: number) => {
    const committed = committedSessionRef.current;
    // FAIL CLOSED: the deposit flow only calls this after ensureInitialized,
    // so a missing commit means the session was torn down (or discarded for a
    // since-changed target) mid-flight — the captured session the caller
    // still holds must not be deposited against unguarded (codex P1).
    if (!committed?.keystoreManager || !committed.address) {
      throw new Error('Session is not ready. Sign in again and retry the deposit.');
    }
    // A session left over from another chain must never be identity-checked
    // (wrong keystore → spurious 'incompatible') or deposited against — and
    // it must match the chain the caller is about to WRITE on.
    if (committed.chainId !== chainId || (writeChainId !== undefined && committed.chainId !== writeChainId)) {
      throw new Error('Network changed since sign-in. Close the modal and try the deposit again.');
    }
    const sdkSetup = await getSdkSetup();
    const status = await resolveKeystoreIdentityStatus(
      sdkSetup,
      committed.keystoreManager,
      committed.address as `0x${string}`,
      committed.chainId,
    );
    // Re-validate after the async on-chain read: a wallet/chain switch while
    // the RPC was pending tears the commit down or replaces it.
    if (committedSessionRef.current !== committed) {
      throw new Error('Network changed since sign-in. Close the modal and try the deposit again.');
    }
    setKeystoreIdentityStatus(status);
    assertDepositUnlock(status);
  }, [chainId]);


  // DEV-439: the keys are ready at unlock, the session is committed seconds
  // later. The status read needs only the keys and the address, so it takes
  // them from the unlock when no session is committed yet.
  const derivedIdentityRef = useRef<{ keystoreManager: IKeystoreManager | null; address: string | null | undefined }>({ keystoreManager: null, address: null });
  // Only keys derived FOR this address: on a wallet switch the address changes
  // at once while the old keys are cleared a render later, and that render
  // must not pair the new address with the old account's keys.
  derivedIdentityRef.current = {
    keystoreManager: keysReady && keysBelongTo(keystoreTargetRef.current, effectiveAddress) ? keystoreManager : null,
    address: effectiveAddress,
  };

  const keystoreStatusForChain = useCallback(async (targetChainId: number): Promise<KeystoreIdentityStatus> => {
    if (!isSupportedEvmChainId(targetChainId)) return 'unknown';
    const identity = pickStatusIdentity(committedSessionRef.current, derivedIdentityRef.current);
    if (!identity) return 'unknown';
    try {
      const sdkSetup = await getSdkSetup();
      return await readStatusWithRetry(() => resolveKeystoreIdentityStatus(
        sdkSetup,
        identity.keystoreManager,
        identity.address as `0x${string}`,
        targetChainId,
      ));
    } catch {
      return 'unknown';
    }
  }, []);

  // The wallet session the auto-init effect above is about to rebuild with no
  // prompt (services/session-resume.ts): the effect's own conditions and guard.
  const resuming = sessionResuming({
    isInitialized,
    isInitializing,
    error,
    evmChain: isSupportedEvmChainId(chainId),
    identityMode,
    keysReady,
    address: effectiveAddress ? String(effectiveAddress).toLowerCase() : null,
    chainId,
    provenAddress,
    startedTarget: walletAutoInitKey,
  });

  const value: SdkContextValue = {
    poolSession,
    sessionTarget,
    noteManager,
    keystoreManager,
    isInitialized,
    isInitializing,
    sessionResuming: resuming,
    error,
    exportAccount,
    importAccount,
    initializeKeys,
    ensureInitialized,
    getCommittedManagers,
    getBatchWithdrawSession,
    getSelfSubmitTransferSession,
    createCrossChainShieldSession,
    createReshieldCrosschainSessions,
    sessionForChain,
    keysReady,
    notesRevision,
    unconfirmedExitCommitments,
    clearUnconfirmedExit,
    refreshNotes,
    syncFromSnapshot,
    syncAllChains,
    isSyncing: isSyncing || isSyncingAll,
    syncChainsLeft,
    syncedHoldings,
    associationSetLeaves,
    blockedLabelHashes: blockedLabelsReady ? blockedLabelHashes : undefined,
    blockedLabelsError: blockedLabelsError ? String(blockedLabelsError) : null,
    associationSetLeavesReady,
    associationSetLeavesScopeKey,
    associationSetLeavesError,
    retryAssociationSetLeaves,
    identityMode,
    sessionAddress: effectiveAddress ?? null,
    keyFingerprint,
    exportAccountKey,
    signInWithAccountKey,
    signOutAccountKey,
    passkeyPreviewEnabled: passkeyFeatureOn,
    isSmartWallet,
    smartWalletProbeSettled,
    passkeyActive,
    signerRefusedDerivation,
    choosePasskeyForRefusedSigner,
    baseAppCannotSign,
    keystoreIdentityStatus,
    assertCanDeposit,
    keystoreStatusForChain,
  };

  // Debug recording snapshot (services/debug-snapshots.ts): the whole identity,
  // keys included, at Pat's explicit ask so the team can reproduce a user's
  // session (2026-09-24). Read only when a debug recording starts or stops;
  // the save prompt warns that the file can spend the funds.
  const debugIdentityRef = useRef({ identityMode, keyIdentity, address, effectiveAddress, chainId, keystoreManager, keysReady });
  useEffect(() => {
    debugIdentityRef.current = { identityMode, keyIdentity, address, effectiveAddress, chainId, keystoreManager, keysReady };
  });
  useEffect(() => registerDebugSnapshot('identity', () => {
    const cur = debugIdentityRef.current;
    const km = cur.keystoreManager;
    const captured = capturedSigsRef.current;
    const accountKey = cur.identityMode === 'key' && cur.keyIdentity
      ? encodeAccountKey(cur.keyIdentity)
      : cur.address && captured?.signature && captured.address === cur.address.toLowerCase()
        ? encodeAccountKey({
          address: cur.address as Address,
          signature: captured.signature,
          ...(captured.legacySignature ? { legacySignature: captured.legacySignature } : {}),
        })
        : null;
    const viewing = km ? km.getViewingKeyPair() : null;
    return {
      identityMode: cur.identityMode,
      walletAddress: cur.address ?? null,
      effectiveAddress: cur.effectiveAddress ?? null,
      sessionChainId: cur.chainId,
      keysReady: cur.keysReady,
      accountKey,
      keys: km ? {
        viewingPublicKey: viewing?.publicKey ?? null,
        viewingPrivateKey: viewing?.privateKey ?? null,
        privateNullifyingKey: km.getPrivateNullifyingKey(),
        privateRevocableKey: km.getPrivateRevocableKey(),
        revocableKeyIndex: km.getRevocableKeyIndex(),
      } : null,
    };
  }), []);

  return <SdkContext.Provider value={value}>{children}</SdkContext.Provider>;
}

export function useSdkContext(): SdkContextValue {
  const ctx = useContext(SdkContext);
  if (!ctx) {
    throw new Error('useSdkContext must be used within <SdkProvider>');
  }
  // Native mock mode: consumers see the mock account as signed in. The
  // provider's own state stays signed out, so nothing initializes or syncs.
  // NATIVE_MOCK_ACTIVE is a build constant, so the hook order never changes.
  if (NATIVE_MOCK_ACTIVE) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    return useMemo(() => ({ ...ctx, ...getNativeMockSession() }), [ctx]);
  }
  return ctx;
}
