import { useCallback, useState } from 'react';
import type { Hash, Hex, Address, Note } from '@/services/sdk-types';
import { buildRecipientReceipts, plannedRecipientReceipts, receiptsTotal, recipientDisclosuresOf, type RecipientDisclosure, type RecipientReceipt } from '@/services/transfer-receipts';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useDebug } from '@/components/debug-provider';
import { consolidationOutputsMatch, planConsolidation, type ConsolidatableNote } from '@/services/consolidate-notes';
import { getChainConfig } from '@/config/chains';
import {
  buildTransferRecipient,
  loadTransferRecipientDeps,
  planTransferOutputs,
  type BuiltTransferRecipient,
  type TransferInputNote,
  type TransferOutputPlan,
} from '@/services/relayed-transfer';

interface TransferInput {
  inputCommitments: Hash[];
  recipientAddress: Address;
  ownerAddress: Address;
  chainId: number;
  amount: Hex;
  tokenId: Address;
  allowOutOfBandFallback?: boolean;
  /**
   * DEV-237: a disclosed transfer binds the proof's processor to the wallet
   * that sends the tx. PoolVault enforces `processor == msg.sender` with no
   * zero-address fallback, so a processor=0x0 proof would revert.
   */
  selfSubmitProcessor: Address;
}

interface RelayedTransferInput {
  /** The selected notes, in the order they are spent. */
  inputNotes: Array<TransferInputNote & ConsolidatableNote>;
  recipientAddress: Address;
  ownerAddress: Address;
  chainId: number;
  amount: bigint;
  tokenId: Address;
  allowOutOfBandFallback?: boolean;
  /** Fee-only self transaction: one owned output per selected deposit group. */
  consolidation?: boolean;
}

/**
 * A relayed transfer planned before its one proof: the recipient it pays and
 * the receipts its recipient outputs will have. `plan(fee)` returns the full
 * output plan once the committed quote fixes the fee.
 */
export interface RelayedTransferPlan {
  recipient: BuiltTransferRecipient;
  recipientNotes: RecipientReceipt[];
  /** No change commitment exists before the proof; the audit key anchors on the first recipient note. */
  changeCommitment: null;
  discoverable: boolean;
  recipientDisclosures: RecipientDisclosure[];
  plan: (fee: bigint) => TransferOutputPlan;
}

interface TransferOutput {
  callData: Hex;
  to: Address;
  /**
   * EVERY recipient note the SDK emitted — one per contributing input
   * lineage (a two-lineage selection produces two notes whose values sum
   * to the transfer amount). Each carries its OWN SDK value and resolved
   * noteSecret; collapsing to the first note would ship a receipt whose
   * preimage can't recompute its commitment and drop the rest of the money.
   */
  recipientNotes: RecipientReceipt[];
  changeCommitment: Hash | null;
  spentNotes: Note[];
  /**
   * True when the SDK published an encrypted Note event for the
   * recipient (their viewing key was on the Keystore). When false the
   * call fell back to out-of-band: the recipient won't auto-discover
   * via scanCatchAll and the caller needs to surface every noteSecret
   * out-of-band (e.g. a receipt URL).
   */
  discoverable: boolean;
  /**
   * Full preimages of the recipient's notes (one disclosure per note),
   * captured straight from the SDK's prepareTransfer result. Present for
   * BOTH discoverable and out-of-band transfers. Lets the sender persist
   * audit receipts — per-transaction partial viewing keys proving the
   * payment. A note whose secret the SDK didn't return is omitted.
   */
  recipientDisclosures: RecipientDisclosure[];
}

interface UseTransferResult {
  transfer: (input: TransferInput) => Promise<TransferOutput>;
  prepareRelayed: (input: RelayedTransferInput) => Promise<RelayedTransferPlan>;
  isLoading: boolean;
  error: string | null;
}

const ZERO_HEX = '0x0' as Hex;

export function useTransfer(): UseTransferResult {
  const { ensureInitialized, getSelfSubmitTransferSession } = usePoolSession();
  const { log } = useDebug();
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const transfer = useCallback(
    async (input: TransferInput): Promise<TransferOutput> => {
      // Build (or reuse) the SDK session lazily. The old code bailed
      // with "SDK not initialized" whenever `isInitialized` was false
      // — but after the auto-init-on-connect was removed, the session
      // only exists once something explicitly calls ensureInitialized.
      // The seed-derivation modal builds it on sign-in, but if the
      // user dismissed that modal this is the safety net: it derives
      // keys (prompting the signature) and builds the session.
      console.log('[useTransfer] transfer() called, ensuring SDK session');
      const mainSession = await ensureInitialized();
      // DEV-370: a disclosed transfer submits from
      // the user's own wallet and never relays, but the SDK's prepareTransfer
      // fetches a COMMITTING relayer quote before proving with no way to opt
      // out, and throws when every relayer fails to answer. Prepare it on a
      // relayer-less sibling session instead: no request, no commitment
      // reserved for a relay that never happens, and no dead end on a chain
      // the relayer does not serve. Falls back to the main session if the
      // sibling can't be built (nothing is committed yet), so behaviour can
      // only ever be as good as before.
      let poolSession = mainSession;
      {
        // Building it can THROW, not just return null: createPoolSession does
        // real network work (it rebuilds the ASP provider, which resolves the
        // entrypoint over HTTP). Unguarded, an ASP hiccup would fail a send the
        // main session could have prepared — a regression, and it made the
        // "can only ever be as good as before" claim false (codex). Catch it and
        // fall back: the quote comes back, which is exactly the old behaviour.
        try {
          const selfSubmitSession = await getSelfSubmitTransferSession();
          if (selfSubmitSession) {
            poolSession = selfSubmitSession as unknown as typeof mainSession;
            log('info', 'Transfer', 'Disclosed transfer: preparing on a relayer-less session (no quote)');
          }
        } catch (siblingErr) {
          log('warn', 'Transfer', 'Relayer-less session could not be built, falling back to the main session', {
            err: siblingErr instanceof Error ? siblingErr.message : String(siblingErr),
          });
        }
      }
      console.log('[useTransfer] session ready, preparing transfer');

      setIsLoading(true);
      setError(null);

      try {
        log('info', 'Transfer', 'Preparing transfer', {
          inputCount: input.inputCommitments.length,
          chainId: input.chainId,
          tokenId: input.tokenId,
        });

        const chainId = input.chainId;
        const chainConfig = getChainConfig(chainId);
        if (!chainConfig?.contracts) {
          throw new Error(`Unsupported chain: ${chainId}`);
        }

        // Single unified call. The SDK looks up the recipient's viewing
        // key from the Keystore contract internally. Only opt into the
        // out-of-band downgrade when the modal already confirmed the
        // recipient is unregistered and the sender chose the one-time
        // receipt path.
        const result = await poolSession.prepareTransfer({
          inputCommitments: input.inputCommitments,
          amount: input.amount,
          tokenId: input.tokenId,
          // PoolVault.transact enforces `processor == msg.sender` (no
          // zero-address fallback), so bind the submitting wallet. No fee on
          // a self-submit.
          relayAddress: input.selfSubmitProcessor,
          feeAmount: ZERO_HEX,
          processorAddress: input.selfSubmitProcessor,
          recipientDiscoveryData: {
            evmAddress: input.recipientAddress,
            ...(input.allowOutOfBandFallback ? { allowOutOfBandFallback: true } : {}),
          },
        });

        const exec = result.executeOptions;
        const changeReceipt = exec.changePendingNotes[0];
        if (!exec.recipientPendingNotes?.length) {
          throw new Error('prepareTransfer did not return a recipient receipt');
        }

        // One recipient note PER contributing input lineage — a two-lineage
        // selection returns two notes whose values sum to the amount. Map
        // EVERY note to a receipt with its own SDK value and resolved secret
        // (enriched field first, then the recipient noteSecretsMap).
        const { receipts: recipientNotes, discoverable } = buildRecipientReceipts(
          exec.recipientPendingNotes as never[],
          exec.recipient as never,
          { recipientAddress: input.recipientAddress, tokenId: input.tokenId },
        );

        // Hard invariant: the receipts must carry the full amount. A receipt
        // shipped with a wrong per-note value is unusable (its preimage can't
        // recompute the commitment), so fail the transfer before submission
        // rather than deliver a broken proof of payment.
        if (receiptsTotal(recipientNotes) !== BigInt(input.amount)) {
          throw new Error('prepareTransfer returned recipient notes that do not sum to the transfer amount');
        }

        // Full recipient-note preimages for the audit receipts — captured for
        // every transfer (discoverable or not) so the sender can later prove
        // the payment without their master viewing key.
        const recipientDisclosures = recipientDisclosuresOf(recipientNotes);

        log('info', 'Transfer', 'prepareTransfer succeeded', {
          discoverable,
          spentNoteCount: exec.spentNotes.length,
          recipientNoteCount: recipientNotes.length,
          hasChangeNote: changeReceipt != null,
          disclosureCount: recipientDisclosures.length,
        });

        setIsLoading(false);
        return {
          callData: exec.transactTx.data,
          to: exec.transactTx.to,
          recipientNotes,
          changeCommitment: changeReceipt?.commitment ?? null,
          spentNotes: exec.spentNotes as Note[],
          discoverable,
          recipientDisclosures,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', 'Transfer', 'Transfer failed', { err: message });
        setError(message);
        setIsLoading(false);
        throw err;
      }
    },
    [ensureInitialized, getSelfSubmitTransferSession, log],
  );

  const prepareRelayed = useCallback(
    async (input: RelayedTransferInput): Promise<RelayedTransferPlan> => {
      // A relayed transfer proves once, inside relayTransfer, against a quote
      // requested right before it. What prepareTransfer did besides proving is
      // done here: the recipient's secrets and viewing key, and the outputs
      // the proof will carry, so receipts can be stored before the relay.
      if (input.consolidation && (input.amount !== 0n || input.recipientAddress.toLowerCase() !== input.ownerAddress.toLowerCase())) {
        throw new Error('Consolidation must be a relayed, fee-only transaction to your own private account.');
      }
      const deps = await loadTransferRecipientDeps(input.chainId);
      const recipient = await buildTransferRecipient(
        {
          kind: 'address',
          evmAddress: input.recipientAddress,
          ...(input.allowOutOfBandFallback ? { allowOutOfBandFallback: true } : {}),
        },
        input.inputNotes.length,
        deps,
      );
      const plan = (fee: bigint) => planTransferOutputs({
        inputNotes: input.inputNotes,
        amount: input.amount,
        fee,
        tokenId: input.tokenId,
        recipient: recipient.recipient,
        commitment: deps.commitment,
      });
      // Recipient outputs do not depend on the fee, so receipts come from a
      // fee-free plan and the relay check holds the proof to them.
      const recipientNotes = plannedRecipientReceipts(plan(0n).recipient, {
        recipientAddress: input.recipientAddress,
        tokenId: input.tokenId,
      });
      if (input.consolidation ? recipientNotes.length !== 0 : recipientNotes.length === 0) {
        throw new Error('The planned transfer has no recipient note. Nothing was sent.');
      }
      if (receiptsTotal(recipientNotes) !== input.amount) {
        throw new Error('The planned recipient notes do not sum to the transfer amount. Nothing was sent.');
      }
      const recipientDisclosures = recipientDisclosuresOf(recipientNotes);
      log('info', 'Transfer', 'Planned relayed transfer', {
        discoverable: recipient.discoverable,
        inputCount: input.inputNotes.length,
        recipientNoteCount: recipientNotes.length,
        disclosureCount: recipientDisclosures.length,
      });
      return {
        recipient,
        recipientNotes,
        changeCommitment: null,
        discoverable: recipient.discoverable,
        recipientDisclosures,
        plan: (fee) => {
          const planned = plan(fee);
          if (planned.recipient.length !== recipientNotes.length
            || planned.recipient.some((r, i) => r.commitment !== recipientNotes[i].commitment)) {
            throw new Error('The planned recipient notes changed with the relayer fee. Nothing was sent.');
          }
          if (input.consolidation && !consolidationOutputsMatch(planned.change, planConsolidation(input.inputNotes, fee).outputs)) {
            throw new Error('The prepared consolidation does not preserve one owned note per group. Nothing was sent.');
          }
          return planned;
        },
      };
    },
    [log],
  );

  return { transfer, prepareRelayed, isLoading, error };
}
