import type {
  RelayerInfo,
  RelayTransferParams,
  ResolvedTransferRecipient,
  TransferQuoteParams,
  TransferRelayerQuote,
} from '@privacy-pools-v2/sdk';

import { isFeeCommitmentExpired } from '@/services/fee-commitment';
import { isStaleAspRootRejection } from '@/services/relayed-withdrawal';
import { isFreshCommitmentLive } from '@/services/intent-swaps';
import type { Address, Hash, Hex } from '@/services/sdk-types';
import { nameRelayerTransportFailure } from '@/services/transfer-outcome';
import type { TransferRelayExpectation } from '@/services/transfer-relay-outputs';

export type { RelayTransferParams };

/** Display copy for a relayed transfer whose fee commitment expired before sending. */
export const TRANSFER_QUOTE_EXPIRED_MESSAGE =
  'The relayer quote ran out before this could be sent. Nothing was sent and your balance is unchanged. Try again for a fresh quote.';

const EXPIRED_ON_ARRIVAL_MESSAGE =
  'The relayer quote had already expired when it arrived. Nothing was sent and your balance is unchanged. Check that your device clock is set correctly, then try again.';

export type TransferQuoteFetcher = (
  relayer: RelayerInfo,
  params: TransferQuoteParams,
) => Promise<TransferRelayerQuote>;

/** This chain's relayers and their transfer quotes. */
export type TransferQuoteSource = {
  relayers: () => Promise<RelayerInfo[]>;
  quote: TransferQuoteFetcher;
};

export type SelectedTransferQuote = RelayTransferParams['selectedQuote'];

type TransferRelayOption = Pick<RelayTransferParams, 'selectedQuote'>;

/** The fee the relayed proof spends on top of the amount: the signed one. */
export function transferRelayFee(option: TransferRelayOption): bigint {
  return BigInt(option.selectedQuote.quote.feeCommitment.feeAmount);
}

/** Requests transfer quotes from this chain's relayer, built on first use. */
export function relayerTransferQuotes(chainId: number): TransferQuoteSource {
  let interactor: Promise<{
    getRelayers: () => Promise<RelayerInfo[]>;
    getTransferQuote: TransferQuoteFetcher;
  }> | undefined;
  const load = () => {
    interactor ??= import('@/services/sdk-runtime').then((m) => m.createRelayerInteractor(chainId));
    return interactor;
  };
  return {
    relayers: async () => (await load()).getRelayers(),
    quote: async (relayer, params) => {
      try {
        return await (await load()).getTransferQuote(relayer, params);
      } catch (error) {
        throw nameRelayerTransportFailure(error);
      }
    },
  };
}

/**
 * Request the one committed quote a relayed transfer proves against, at
 * Confirm and right before relayTransfer, so its one proof gets the whole
 * ~60 s lifetime. The request is the one prepareTransfer made (asset only,
 * the chain's relayer). Callers check that amount plus the signed fee fits
 * the selected notes before relaying. Resolves null when no relayer is
 * configured.
 */
export async function requestTransferQuote(
  source: TransferQuoteSource,
  tokenId: Address,
  now: () => number = Date.now,
): Promise<SelectedTransferQuote | null> {
  const relayers = await source.relayers();
  const relayerInfo = relayers.find((r) => r.status === 'active') ?? relayers[0];
  if (!relayerInfo) return null;
  const quote = await source.quote(relayerInfo, { asset: tokenId, commit: true });
  const commitment = quote.feeCommitment;
  if (!commitment
    || commitment.asset.toLowerCase() !== tokenId.toLowerCase()
    || BigInt(quote.feeAmount) !== BigInt(commitment.feeAmount)) {
    throw new Error('The relayer quote does not match the requested transfer. Nothing was sent. Please try again.');
  }
  // No proving window: the quote is seconds old, so a window could only
  // misfire on a device clock running ahead of the relayer's. Running out
  // mid-proof is caught before the POST by the SDK.
  if (!isFreshCommitmentLive(commitment.expiration, now())) {
    throw new Error(EXPIRED_ON_ARRIVAL_MESSAGE);
  }
  return { relayerInfo, quote };
}

/** A pre-send expiry becomes the plain copy; every other error is unchanged. */
export function plainTransferRelayError(error: unknown): unknown {
  return isFeeCommitmentExpired(error) ? new Error(TRANSFER_QUOTE_EXPIRED_MESSAGE) : error;
}

/**
 * A relay refused before anything was sent, for a reason a fresh proof fixes:
 * the ASP root moved under the proof (PoolVault_InvalidASPRoot in the
 * relayer's simulation), or the fee commitment ran out while proving (the
 * SDK's check before the POST, or the relayer's own before it broadcasts).
 */
export function isReprovableRelayRefusal(error: unknown): boolean {
  return isStaleAspRootRejection(error) || isFeeCommitmentExpired(error);
}

/** Prefix of the error when the fresh quote for a re-prove fails (isKnownRejection matches it). */
export const REPROVE_REFRESH_FAILED = 'The relayer refused the proof and a fresh quote failed:';

/** How many times a relay is re-proved after a refusal that sent nothing. */
export const MAX_REPROVES = 2;

/**
 * Relay, and when the relayer refuses for a reason a fresh proof fixes, take
 * a fresh quote (`refresh`, which re-runs the caller's fee checks) and relay
 * again, at most MAX_REPROVES times. Each relay call proves anew. The same
 * recovery withdraw and payment already had for a moved root, for every flow
 * that relays a transfer. Other failures, and any after `sent()` reports a
 * broadcast, propagate unchanged.
 */
export async function relayWithReprove<Option, Result>({
  option, relay, refresh, shouldContinue, onReprove, sent = () => false, maxReproves = MAX_REPROVES,
}: {
  option: Option;
  relay: (option: Option) => Promise<Result>;
  refresh: () => Promise<Option>;
  shouldContinue: () => boolean;
  onReprove: (error: Error, attempt: number) => void;
  sent?: () => boolean;
  maxReproves?: number;
}): Promise<{ result: Result; option: Option }> {
  let current = option;
  for (let attempt = 1; ; attempt++) {
    try {
      return { result: await relay(current), option: current };
    } catch (error) {
      if (attempt > maxReproves || sent() || !isReprovableRelayRefusal(error) || !shouldContinue()) throw error;
      onReprove(error as Error, attempt);
      try {
        current = await refresh();
      } catch (refreshError) {
        // The refused attempt sent nothing and neither did this: say so, so the
        // caller never reads it as a relay whose outcome is unknown.
        const why = refreshError instanceof Error ? refreshError.message : String(refreshError);
        throw new Error(`${REPROVE_REFRESH_FAILED} ${why} Nothing was sent and your balance is unchanged.`, { cause: refreshError });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The recipient
// ---------------------------------------------------------------------------

/**
 * Who a relayed transfer pays, before it is resolved into the SDK's
 * ResolvedTransferRecipient. Each kind is one branch of the SDK's
 * resolveRecipient (or prepareFulfillPaymentRequest), which prepareTransfer ran
 * and relayTransfer does not.
 */
export type TransferRecipientSpec =
  /** Send, consolidation and note import: secrets made here, key read from the Keystore. */
  | { kind: 'address'; evmAddress: Address; allowOutOfBandFallback?: boolean }
  /** A legacy v2 payment request: one secret made here, encrypted to the request's viewing key. */
  | { kind: 'viewing-key'; evmAddress: Address; publicViewingKey: Hex }
  /** An SDK-native payment request: its pre-committed slots, encrypted to its payment key. */
  | { kind: 'payment-request'; noteAddressHashes: Hash[]; paymentPubKey: Hex; tag: Hex; expiresAt?: Hex }
  /** A legacy v1 payment request: one pre-blinded slot, delivered by receipt. */
  | { kind: 'blind'; noteAddressHash: Hash };

/** The note math and reads the recipient and the output plan need. */
export type TransferNoteMath = {
  generateSecret: () => Hex;
  /** Poseidon(address, secret): NoteComputationService.computeNoteAddressHash on EVM. */
  noteAddressHash: (evmAddress: Address, secret: Hex) => Hash;
  /** Poseidon(Poseidon(noteAddressHash, tokenId, value, metadata), label). */
  commitment: (note: { noteAddressHash: Hash; value: Hex; tokenId: Address; label: Hash }) => Hash;
};

export type TransferRecipientDeps = TransferNoteMath & {
  /** Keystore.viewingKeys(address), the read prepareTransfer made; 0 means unregistered. */
  getViewingKey: (evmAddress: Address) => Promise<Hex>;
  /** The SDK's own errors, so every flow's existing copy still matches. */
  errors: {
    unregistered: (evmAddress: Address) => Error;
    expired: (expiresAt: Hex, nowMs: bigint) => Error;
  };
};

export type BuiltTransferRecipient = {
  recipient: ResolvedTransferRecipient;
  recipientEvmAddress?: Address;
  /** True when the recipient gets an encrypted Note event (a public viewing key is set). */
  discoverable: boolean;
};

function isZeroField(value: Hex): boolean {
  try { return BigInt(value) === 0n; } catch { return false; }
}

/**
 * Throws unless every key equals Poseidon(evmAddress, secret). The recipient
 * recomputes the commitment from the secret it decrypts, so a mismatched map
 * creates notes nobody can spend. relayTransfer does not re-check this.
 */
export function assertRecipientBinding(
  noteSecretsMap: ReadonlyMap<Hash, Hex>,
  evmAddress: Address,
  noteAddressHash: TransferNoteMath['noteAddressHash'],
): void {
  for (const [key, secret] of noteSecretsMap) {
    if (BigInt(noteAddressHash(evmAddress, secret)) !== BigInt(key)) {
      throw new Error('The recipient note secrets do not match the recipient address. Nothing was sent. Please try again.');
    }
  }
}

function secretsFor(count: number, evmAddress: Address, deps: TransferNoteMath): Map<Hash, Hex> {
  const map = new Map<Hash, Hex>();
  for (let i = 0; i < count; i++) {
    const secret = deps.generateSecret();
    map.set(deps.noteAddressHash(evmAddress, secret), secret);
  }
  return map;
}

/**
 * Resolve a relayed transfer's recipient the way prepareTransfer did, without
 * proving. `inputCount` is the number of input commitments: the SDK makes one
 * secret per input, of which one per input label is used.
 */
export async function buildTransferRecipient(
  spec: TransferRecipientSpec,
  inputCount: number,
  deps: TransferRecipientDeps,
  now: () => number = Date.now,
): Promise<BuiltTransferRecipient> {
  switch (spec.kind) {
    case 'address': {
      const noteSecretsMap = secretsFor(inputCount, spec.evmAddress, deps);
      assertRecipientBinding(noteSecretsMap, spec.evmAddress, deps.noteAddressHash);
      const noteAddressHash = [...noteSecretsMap.keys()];
      const publicViewingKey = await deps.getViewingKey(spec.evmAddress);
      if (isZeroField(publicViewingKey)) {
        if (!spec.allowOutOfBandFallback) throw deps.errors.unregistered(spec.evmAddress);
        return { recipient: { noteAddressHash, noteSecretsMap }, recipientEvmAddress: spec.evmAddress, discoverable: false };
      }
      return {
        recipient: { noteAddressHash, noteSecretsMap, publicViewingKey },
        recipientEvmAddress: spec.evmAddress,
        discoverable: true,
      };
    }
    case 'viewing-key': {
      const noteSecretsMap = secretsFor(1, spec.evmAddress, deps);
      assertRecipientBinding(noteSecretsMap, spec.evmAddress, deps.noteAddressHash);
      return {
        recipient: { noteAddressHash: [...noteSecretsMap.keys()], noteSecretsMap, publicViewingKey: spec.publicViewingKey },
        discoverable: true,
      };
    }
    case 'payment-request': {
      if (spec.expiresAt !== undefined) {
        const nowMs = BigInt(now());
        if (nowMs > BigInt(spec.expiresAt)) throw deps.errors.expired(spec.expiresAt, nowMs);
      }
      if (spec.noteAddressHashes.length === 0 || inputCount > spec.noteAddressHashes.length) {
        throw new Error('inputCommitments.length exceeds payment request slot count');
      }
      return {
        recipient: { noteAddressHash: spec.noteAddressHashes, publicViewingKey: spec.paymentPubKey, hint: spec.tag },
        discoverable: true,
      };
    }
    case 'blind':
      return { recipient: { noteAddressHash: [spec.noteAddressHash] }, discoverable: false };
  }
}

/** The SDK's note math, the Keystore read and its error classes, for this chain. */
export async function loadTransferRecipientDeps(chainId: number): Promise<TransferRecipientDeps> {
  const [{ getChainConfig }, { LEGACY_CONFIG }, sdk] = await Promise.all([
    import('@/config/chains'), import('@/config/env'), import('@/services/sdk-runtime'),
  ]);
  const contracts = getChainConfig(chainId)?.contracts;
  if (!contracts) throw new Error(`Unsupported chain: ${chainId}`);
  const noteComputation = await sdk.createNoteComputationService();
  const crypto = sdk.createCryptoService();
  const keystore = sdk.createKeystoreInteractor(
    sdk.createRPCInteractor(chainId, Number(contracts.fromBlock)),
    // The legacy host's session reads its own keystore (components/sdk-provider.tsx).
    (LEGACY_CONFIG?.keystore ?? contracts.keystoreAddress) as Address,
    contracts.keystoreFromBlock,
  );
  return {
    generateSecret: () => crypto.generateSecret() as Hex,
    // EVM's AddressFieldConverter is the identity for addresses and token ids.
    noteAddressHash: (evmAddress, secret) => noteComputation.computeNoteAddressHash(evmAddress, secret) as Hash,
    commitment: (note) => noteComputation.computeFullCommitment(note) as Hash,
    getViewingKey: async (evmAddress) => (await keystore.getViewingKey(evmAddress)) as Hex,
    errors: {
      unregistered: (evmAddress) => new sdk.RecipientViewingKeyUnregistered(evmAddress),
      expired: (expiresAt, nowMs) => new sdk.PaymentRequestExpired(expiresAt, nowMs),
    },
  };
}

// ---------------------------------------------------------------------------
// The outputs
// ---------------------------------------------------------------------------

export type TransferInputNote = { commitment: string; value: string | bigint; label: string };

export type PlannedRecipientOutput = {
  commitment: Hash;
  label: Hash;
  noteAddressHash: Hash;
  /** This note's own value, 32-byte hex as the SDK writes it. */
  value: Hex;
  /** The recipient's secret, when this flow made it; null for a request's own slots. */
  noteSecret: Hex | null;
};

export type TransferOutputPlan = {
  /** One per input label, first in the proof. Commitments are random. */
  change: { label: Hash; value: bigint }[];
  /** The proof's recipient outputs, after the change, in the same order. */
  recipient: PlannedRecipientOutput[];
};

const field = (value: bigint): Hex => `0x${value.toString(16).padStart(64, '0')}` as Hex;

/**
 * The outputs relayTransfer's proof will carry, worked out the way the SDK's
 * TransactOrchestrator.getTransactOutputNotes does: inputs grouped by label in
 * first-occurrence order, each label paying the recipient up to its value
 * (amount first) and keeping the rest less its share of the fee as change.
 * Recipient commitments depend only on the recipient's hashes, the amount and
 * the inputs, so they are known before proving; the relay check holds the
 * proof to them (services/transfer-relay-outputs.ts).
 */
export function planTransferOutputs(params: {
  inputNotes: readonly TransferInputNote[];
  amount: bigint;
  fee: bigint;
  tokenId: Address;
  recipient: ResolvedTransferRecipient;
  commitment: TransferNoteMath['commitment'];
}): TransferOutputPlan {
  const byLabel = new Map<string, bigint>();
  for (const note of params.inputNotes) {
    byLabel.set(note.label, (byLabel.get(note.label) ?? 0n) + BigInt(note.value));
  }
  const total = [...byLabel.values()].reduce((sum, v) => sum + v, 0n);
  if (total < params.amount + params.fee) {
    throw new Error('Insufficient value for transact: the selected notes do not cover the amount plus the relayer fee.');
  }
  const labels = [...byLabel.keys()];
  const hashes = params.recipient.noteAddressHash;
  if (hashes.length < labels.length) {
    throw new Error(`Too few noteAddressHashes for recipient notes: ${labels.length} > ${hashes.length}`);
  }
  const secrets = params.recipient.noteSecretsMap as ReadonlyMap<Hash, Hex> | undefined;
  let remainingSent = params.amount;
  let remainingTotal = params.amount + params.fee;
  const change: TransferOutputPlan['change'] = [];
  const recipient: PlannedRecipientOutput[] = [];
  labels.forEach((label, i) => {
    const labelValue = byLabel.get(label) as bigint;
    const deduct = remainingTotal >= labelValue ? labelValue : remainingTotal;
    const sent = remainingSent >= labelValue ? labelValue : remainingSent;
    change.push({ label: label as Hash, value: labelValue - deduct });
    if (remainingSent > 0n) {
      const noteAddressHash = hashes[i];
      const value = field(sent);
      let noteSecret: Hex | null = null;
      if (secrets) {
        const secret = secrets.get(noteAddressHash);
        if (!secret) throw new Error('A recipient note has no secret. Nothing was sent. Please try again.');
        noteSecret = secret;
      }
      recipient.push({
        commitment: params.commitment({ noteAddressHash, value, tokenId: params.tokenId, label: label as Hash }),
        label: label as Hash,
        noteAddressHash,
        value,
        noteSecret,
      });
      remainingSent -= sent;
    }
    remainingTotal -= deduct;
  });
  return { change, recipient };
}

/** The relay check's view of a plan: see services/transfer-relay-outputs.ts. */
export function transferRelayExpectation(
  selectedQuote: SelectedTransferQuote,
  inputCount: number,
  plan: TransferOutputPlan,
): TransferRelayExpectation {
  return {
    signedRelayerCommitment: String(selectedQuote.quote.feeCommitment.signedRelayerCommitment),
    inputCount,
    changeCount: plan.change.length,
    recipientCommitments: plan.recipient.map((r) => r.commitment),
  };
}

/**
 * The relayTransfer parameters prepareTransfer used to hand back as a relay
 * option, built here so the transfer proves once. relayTransfer binds the
 * relayer as relay and processor and takes the signed fee itself.
 */
export function relayTransferParams(params: {
  inputCommitments: Hash[];
  amount: bigint;
  tokenId: Address;
  built: BuiltTransferRecipient;
  selectedQuote: SelectedTransferQuote;
}): RelayTransferParams {
  const relayer = params.selectedQuote.relayerInfo.address;
  return {
    inputCommitments: params.inputCommitments,
    amount: `0x${params.amount.toString(16)}` as Hex,
    tokenId: params.tokenId,
    relayAddress: relayer,
    feeAmount: `0x${transferRelayFee(params).toString(16)}` as Hex,
    processorAddress: relayer,
    recipient: params.built.recipient,
    ...(params.built.recipientEvmAddress ? { recipientEvmAddress: params.built.recipientEvmAddress } : {}),
    selectedQuote: params.selectedQuote,
  };
}
