import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { ReceiptWrongNetworkCopy } from '@/components/receipt-wrong-network';
import { receiptChain } from '@/services/receipt-chain-registry';
import {
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';
import { formatUnits } from 'viem';
import { useAccount } from 'wagmi';
import { useCurrentAccount, useSuiClient } from '@mysten/dapp-kit';

import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { modalCardShadow } from '@/components/ui/web-style-shims';
import { defaultChainId, getChainConfig, SUI_TESTNET_ID } from '@/config/chains';
import { RegisterWalletOffer, registerOfferGasText } from '@/components/register-wallet-offer';
import { linkToken } from '@/services/link-token-registry';
import { linkAmountText } from '@/services/link-token';
import { decodeNoteReceiptFromUrl, extractNoteReceiptEncoded } from '@/services/note-receipt';
import { useSessionChainId } from '@/hooks/use-session-chain-id';
import {
  parseSuiNoteReceipt,
  suiReceiptToStoredNote,
  verifySuiNoteOnChain,
  verifySuiNoteReceipt,
  type SuiNoteReceiptNote,
} from '@/services/sui-witness/note-receipt';
import { addressToU256 } from '@/services/sui-witness';
import { SuiChainReader } from '@/services/sui-witness/chain-reader';
import { upsertSuiNote } from '@/services/sui-witness/note-store';
import { useSuiNotes } from '@/hooks/use-sui-notes';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useNoteImport } from '@/hooks/use-note-import';
import { FlowProgress } from '@/components/ui/flow-progress';
import { useTabCloseGuard } from '@/hooks/use-tab-close-guard';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { useSupportedWalletConnection } from '@/hooks/use-supported-wallet-connection';

type ImportNoteModalContextType = {
  openImportNoteModal: () => void;
  closeImportNoteModal: () => void;
};

const missingProvider = () => {
  throw new Error('useImportNoteModal must be used within ImportNoteModalProvider');
};

const ImportNoteModalContext = createContext<ImportNoteModalContextType>({
  openImportNoteModal: missingProvider,
  closeImportNoteModal: missingProvider,
});

export function useImportNoteModal() {
  return useContext(ImportNoteModalContext);
}

export function ImportNoteModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;
  const { address } = useAccount();
  const { keysReady, sessionAddress, identityMode } = usePoolSession();
  const { openSeedDerivationModal } = useSeedDerivationModal();
  const { connectWallet } = useSupportedWalletConnection();
  const {
    status,
    statusMessage,
    errMessage,
    busy,
    done,
    importToDevice,
    importOnChain,
    hasUnanchoredLocalNote,
    approvalBlock,
    reset,
    registerOffer,
    registerState,
    registerWalletOnly,
    dismissRegisterOffer,
  } = useNoteImport();

  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState('');
  // Device-only import lives behind this toggle for wallet sessions.
  // Sui receipt import lifecycle (independent of the EVM useNoteImport hook).
  const [suiStatus, setSuiStatus] = useState<'idle' | 'importing' | 'done' | 'error'>('idle');
  const [suiError, setSuiError] = useState<string | null>(null);
  // Sui import generation (codex): close/reopen/re-paste supersedes an
  // in-flight Sui import, so receipt A's late completion can't stamp
  // done/error onto receipt B.
  const suiRunGenRef = useRef(0);

  // Same protection as the /import-note receipt page: warn while an import
  // is in flight (EVM or Sui) or while a locally imported note is still
  // unanchored — durable across errors and modal close.
  useTabCloseGuard(
    busy || hasUnanchoredLocalNote || suiStatus === 'importing',
    'These funds exist only in this browser until you add them to your shielded balance on-chain. Keep the link safe until then.',
  );
  const suiAccount = useCurrentAccount();
  const suiClient = useSuiClient();
  const suiNotesStore = useSuiNotes();

  const openImportNoteModal = useCallback(() => {
    suiRunGenRef.current += 1;
    reset();
    setInput('');
    setSuiStatus('idle');
    setSuiError(null);
    setIsOpen(true);
  }, [reset]);

  const closeImportNoteModal = useCallback(() => {
    if (busy) return;
    suiRunGenRef.current += 1;
    setIsOpen(false);
    setInput('');
    setSuiStatus('idle');
    setSuiError(null);
    reset();
  }, [busy, reset]);

  // Live-decode whatever is pasted. `note` is null while empty or
  // unparseable; we only show the import controls once a real note
  // is recovered from the receipt.
  const receipt = useMemo(() => {
    const encoded = extractNoteReceiptEncoded(input);
    if (!encoded) return null;
    return decodeNoteReceiptFromUrl(encoded);
  }, [input]);

  // Sui one-time receipts (kind "ppv2-sui-note", raw or base64 JSON) — tried
  // only when the input isn't an EVM receipt. A payload that IS a Sui receipt
  // but malformed surfaces its parse error instead of the generic decode hint.
  const suiParse = useMemo((): { note: SuiNoteReceiptNote | null; error: string | null } => {
    if (receipt) return { note: null, error: null };
    try {
      return { note: parseSuiNoteReceipt(input), error: null };
    } catch (e) {
      return { note: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [input, receipt]);
  const suiNote = suiParse.note;

  // A new paste invalidates any previous Sui import outcome — INCLUDING an
  // in-flight one (codex): receipt A's late completion must not stamp
  // done/error onto receipt B.
  useEffect(() => {
    suiRunGenRef.current += 1;
    setSuiStatus('idle');
    setSuiError(null);
  }, [input]);

  // Sui ownership pre-check (sync): the receipt's owner is a field element
  // (addressToU256 of the recipient address), so we can flag a wrong-account
  // paste before the import button is pressed.
  const suiOwnerMatches = useMemo(() => {
    if (!suiNote || !suiAccount?.address) return false;
    try {
      return addressToU256(suiAccount.address) === BigInt(suiNote.ownerAddress);
    } catch {
      return false;
    }
  }, [suiNote, suiAccount?.address]);

  const handleImportSuiNote = useCallback(async () => {
    if (!suiNote) return;
    const owner = suiAccount?.address;
    if (!owner) {
      setSuiError('Connect your Sui wallet first.');
      setSuiStatus('error');
      return;
    }
    const runGen = suiRunGenRef.current;
    const live = () => suiRunGenRef.current === runGen;
    setSuiStatus('importing');
    setSuiError(null);
    try {
      // Owner + commitment reconstruction check — refuses tampered receipts.
      await verifySuiNoteReceipt(suiNote, owner);
      // Existence check — a self-consistent receipt can still be a forgery
      // that no pool transaction ever inserted; refuse (or, on a transient
      // RPC failure, ask to retry) rather than store a phantom balance.
      const contracts = getChainConfig(SUI_TESTNET_ID)?.suiContracts;
      if (!contracts) throw new Error('Sui deployment not configured.');
      const reader = new SuiChainReader({
        client: suiClient,
        packageId: contracts.packageId,
        poolId: contracts.poolObjectId,
      });
      await verifySuiNoteOnChain(reader, suiNote);
      // Superseded (close/reopen/new paste): don't store under a stale run —
      // the user may be importing a different receipt now (codex).
      if (!live()) return;
      upsertSuiNote(owner, suiReceiptToStoredNote(suiNote));
      suiNotesStore.refetch();
      setSuiStatus('done');
    } catch (e) {
      if (!live()) return;
      setSuiError(e instanceof Error ? e.message : String(e));
      setSuiStatus('error');
    }
  }, [suiNote, suiAccount?.address, suiNotesStore, suiClient]);

  // Import ALL notes: a two-lineage transfer packs one per lineage, and the
  // paste flow used to drop everything after the first — losing that value.
  const notes = receipt?.notes ?? [];
  const note = notes[0] ?? null;
  // The receipt's OWN chain when the envelope carries one (chainless native
  // sentinels are ambiguous across chains); legacy receipts fall back to the
  // default chain.
  const receiptChainId = receipt?.chainId ?? defaultChainId;
  // Chain-SCOPED lookup when the envelope names the chain (codex: the
  // any-chain helper's registry scan labeled Citrea native receipts as ETH).
  // Any environment's registry, and never a guessed 18 decimals (DEV-484):
  // an OP USDC claim opened on Prod read "0.000000000003 0X0B2C".
  const token = note ? linkToken(note.tokenId, receipt?.chainId) : null;
  const amountLabel = notes.length > 0 && token
    ? linkAmountText(notes.reduce((sum, n) => sum + BigInt(n.value), 0n), token)
    : null;

  const effectiveAddress = sessionAddress ?? address ?? null;
  // A send-time receipt names its recipient. A claim RECOVERED from the
  // sender's on-chain backup does not (it carries only what the SDK itself
  // announces), and is claimed by whoever is signed in: the import path
  // recomputes the commitment from the claimant's address, and only the true
  // recipient's reproduces the committed one. Same rule as the /import-note page.
  const expectedRecipient = note?.ownerAddress ?? effectiveAddress ?? null;
  const recipientMatches = expectedRecipient && effectiveAddress
    ? expectedRecipient.toLowerCase() === effectiveAddress.toLowerCase()
    : false;
  const shortRecipient = expectedRecipient
    ? `${expectedRecipient.slice(0, 6)}…${expectedRecipient.slice(-4)}`
    : 'this address';

  const canAnchorOnChain = identityMode === 'wallet';
  const locked = recipientMatches && !keysReady;
  // Gate against the SESSION chain — the import mutates the SDK session's
  // NoteManager, which follows the connector-first chain, not the display
  // selection (codex). Legacy receipts without a chainId keep the old behavior.
  const sessionChainId = useSessionChainId();
  const chainMismatch = receipt?.chainId !== undefined && receipt.chainId !== sessionChainId;
  const receiptChainInfo = receiptChain(receiptChainId);
  const importsDisabled = !recipientMatches || !keysReady || busy || done || chainMismatch;
  const showDecodeError = input.trim().length > 0 && !note && !suiNote && !suiParse.error;

  return (
    <ImportNoteModalContext.Provider value={{ openImportNoteModal, closeImportNoteModal }}>
      {children}
      <Modal
        animationType={isMobileSheet ? 'slide' : 'fade'}
        transparent
        visible={isOpen}
        onRequestClose={closeImportNoteModal}
      >
        <View className={`flex-1 items-center bg-[rgba(0,0,0,0.48)] ${isMobileSheet ? 'justify-end p-0' : 'justify-center p-[20px]'}`}>
          <View
            className={`w-full border border-border bg-card-background p-[24px] ${isMobileSheet ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border-b-0 pt-[26px]' : 'max-w-[560px] max-h-[88%] rounded-card'}`}
            // nw-keep(platform-css): modal-card drop shadow (shared, scheme-tinted)
            style={modalCardShadow(colorScheme)}
          >
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isMobileSheet && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]" style={{ backgroundColor: colors.border }} />}
            <View className="flex-row items-start justify-between gap-[12px]">
              <View className="flex-1 gap-[6px]">
                <Text className="font-pp-bold text-[22px] leading-[28px] text-text">Import Note</Text>
                <Text className="font-pp-regular text-[13px] leading-[18px] text-text-secondary">
                  Paste a transfer receipt link or its code to receive a private transfer.
                </Text>
              </View>
              <Pressable
                className="h-[36px] w-[36px] items-center justify-center rounded-control border border-border-light"
                onPress={closeImportNoteModal}
                disabled={busy}
              >
                {/* nw-keep(data-color): close glyph color is the text theme token into the vector-icon sink */}
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            </View>

            <ScrollView className="mt-[16px] max-h-[420px] grow-0" contentContainerClassName="gap-[12px]">
              <TextInput
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                value={input}
                onChangeText={setInput}
                editable={!busy}
                placeholder="Paste the receipt link (…/import-note/…) or code here"
                // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                placeholderTextColor={colors.textMuted}
                className={`min-h-[96px] rounded-control border border-border-light px-[14px] py-[12px] font-pp-regular text-[12px] leading-[18px] text-text ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
                // nw-keep(platform-css): textAlignVertical is not css-interop-compatible — the [textAlignVertical:top] arbitrary class compiles to nothing on native, dropping the multiline top-align
                style={{ textAlignVertical: 'top' }}
              />

              {showDecodeError && (
                <View className="rounded-control border border-[#F2B8B5] bg-[#FFF4F4] px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-[#C24131]">
                    Couldn&apos;t read that receipt. Paste the full link the sender shared, or just the code after /import-note/.
                  </Text>
                </View>
              )}

              {/* Sui receipt: parse error / summary / status */}
              {suiParse.error && (
                <View className="rounded-control border border-[#F2B8B5] bg-[#FFF4F4] px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-[#C24131]">
                    Couldn&apos;t read this Sui receipt: {suiParse.error}
                  </Text>
                </View>
              )}

              {suiNote && (
                <View className="gap-[8px] rounded-control border border-border-light px-[14px] py-[12px]">
                  <View className="flex-row items-center justify-between gap-[12px]">
                    <Text className="font-pp-semi-bold text-[14px] text-text">Amount</Text>
                    <Text className="font-pp-semi-bold text-[14px] text-text">
                      {formatUnits(BigInt(suiNote.value), 9)} SUI
                    </Text>
                  </View>
                  <View className="flex-row items-center justify-between gap-[12px]">
                    <Text className="font-pp-medium text-[12px] text-text-muted">Chain</Text>
                    <Text className="font-pp-medium text-[12px] text-right text-text-secondary">Sui Testnet</Text>
                  </View>
                  <View className="flex-row items-center justify-between gap-[12px]">
                    <Text className="font-pp-medium text-[12px] text-text-muted">Commitment</Text>
                    <Text className="font-pp-medium text-[12px] text-right text-text-secondary">
                      {`${suiNote.commitment.slice(0, 8)}…${suiNote.commitment.slice(-6)}`}
                    </Text>
                  </View>
                </View>
              )}

              {suiNote && !suiAccount?.address ? (
                <View className="rounded-control border border-border bg-success-bg px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                    Connect the Sui wallet this receipt was sent to, then import.
                  </Text>
                </View>
              ) : suiNote && !suiOwnerMatches ? (
                <View className="rounded-control border border-warning bg-warning-bg px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-warning">
                    This receipt is addressed to a different Sui account. Switch accounts to import.
                  </Text>
                </View>
              ) : suiNote && suiStatus === 'error' && suiError ? (
                <View className="rounded-control border border-[#F2B8B5] bg-[#FFF4F4] px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-[#C24131]">Import failed: {suiError}</Text>
                </View>
              ) : suiNote && suiStatus === 'done' ? (
                <View className="rounded-control border border-[#98B975] bg-[#F5FAEE] px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-[#6E8A42]">
                    Imported. It now shows in your Sui balance on this device.
                  </Text>
                </View>
              ) : suiNote ? (
                <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted">
                  Sui one-time receipt. Importing verifies it and saves the note to this device.
                </Text>
              ) : null}

              {note && amountLabel && (
                <View className="gap-[8px] rounded-control border border-border-light px-[14px] py-[12px]">
                  <View className="flex-row items-center justify-between gap-[12px]">
                    <Text className="font-pp-semi-bold text-[14px] text-text">Amount</Text>
                    <Text className="font-pp-semi-bold text-[14px] text-text">{amountLabel}</Text>
                  </View>
                  <View className="flex-row items-center justify-between gap-[12px]">
                    <Text className="font-pp-medium text-[12px] text-text-muted">Owner</Text>
                    <Text className="font-pp-medium text-[12px] text-right text-text-secondary">{shortRecipient}</Text>
                  </View>
                  <View className="flex-row items-center justify-between gap-[12px]">
                    <Text className="font-pp-medium text-[12px] text-text-muted">Commitment</Text>
                    <Text className="font-pp-medium text-[12px] text-right text-text-secondary">
                      {notes.length > 1
                        ? `${notes.length} notes`
                        : note.commitment
                          ? `${note.commitment.slice(0, 8)}…${note.commitment.slice(-6)}`
                          // A recovered claim has no commitment until the
                          // import derives it from the signed-in address.
                          : 'Derived on claim'}
                    </Text>
                  </View>
                </View>
              )}

              {note && chainMismatch ? (
                <View className="gap-[8px] rounded-control border border-warning bg-warning-bg px-[14px] py-[12px]">
                  <ReceiptWrongNetworkCopy pasted chain={receiptChainInfo} textClassName="font-pp-regular text-[12px] leading-[18px] text-warning" />
                </View>
              ) : note && !effectiveAddress ? (
                <View className="gap-[10px] rounded-control border border-border bg-success-bg px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">
                    Connect the wallet that owns {shortRecipient} to claim this transfer.
                  </Text>
                  {/* In-modal connect (codex): the overlay blocks the header
                      connector and closing clears the pasted receipt, so
                      without this the user had to discard and re-paste. */}
                  <Pressable
                    onPress={() => connectWallet()}
                    className="items-center self-start rounded-[8px] bg-primary px-[14px] py-[8px]"
                  >
                    <Text className="font-pp-semi-bold text-[13px] text-white">Connect wallet</Text>
                  </Pressable>
                </View>
              ) : note && !recipientMatches ? (
                <View className="rounded-control border border-warning bg-warning-bg px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-warning">
                    The current account doesn&apos;t match the recipient on this receipt. Switch to {shortRecipient} to import.
                  </Text>
                </View>
              ) : locked ? (
                <View className="rounded-control border border-warning bg-warning-bg px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-warning">
                    You&apos;re not signed in. Sign in to decrypt your balances and import this transfer. Signing in only unlocks this session.
                  </Text>
                </View>
              ) : note ? (
                <View className="gap-[8px]">
                  <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted">
                    Add it to your shielded balance to use it from any device with your wallet.
                  </Text>
                  {/* DEV-569: no device-only import for wallet sessions. Key
                      sessions cannot anchor, so for them it IS the path. */}
                  {!canAnchorOnChain && (
                    <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted">
                      Keep on this device only: faster, but the funds are lost if you clear the browser or switch devices.
                    </Text>
                  )}
                </View>
              ) : null}

              {/* Ungated on `status` (code review 2026-08-27): the hook's
                  re-entrancy refusal sets errMessage WITHOUT moving status off
                  'anchoring', because moving it dropped `busy` and re-enabled
                  the button mid-proof. Gating the render on status === 'error'
                  made that refusal invisible here, which is the silent dead
                  click the hook comment says it is fixing. */}
              {errMessage && (
                <View className="rounded-control border border-[#F2B8B5] bg-[#FFF4F4] px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-[#C24131]">{approvalBlock ? errMessage : `Import failed: ${errMessage}`}</Text>
                </View>
              )}
              <RegisterWalletOffer
                offered={!!registerOffer}
                state={registerState}
                gasText={registerOfferGasText(registerOffer)}
                onRegister={() => { void registerWalletOnly(); }}
                onDismiss={dismissRegisterOffer}
              />

              {/* Same staged horizontal progress as the shield/send flows for
                  the on-chain add; the quick device merge keeps a status line. */}
              {status === 'anchoring' ? (
                <FlowProgress message={statusMessage} />
              ) : busy && statusMessage ? (
                <View className="rounded-control border border-[#98B975] bg-[#F5FAEE] px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-[#6E8A42]">{statusMessage}</Text>
                </View>
              ) : null}

              {done && (
                <View className="rounded-control border border-[#98B975] bg-[#F5FAEE] px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-[#6E8A42]">
                    {status === 'anchored'
                      ? 'Added to your shielded balance. Available from any device you sign in on.'
                      : 'Kept on this device only. Add it to your shielded balance to keep it across reloads and devices.'}
                  </Text>
                </View>
              )}
            </ScrollView>

            <View className="mt-[18px] flex-row flex-wrap justify-end gap-[10px]">
              <Pressable
                className="h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px]"
                onPress={closeImportNoteModal}
                disabled={busy}
              >
                <Text className="font-pp-medium text-[14px] text-text">
                  {done || suiStatus === 'done' ? 'Done' : 'Cancel'}
                </Text>
              </Pressable>

              {suiNote && suiStatus !== 'done' && (
                <Pressable
                  className={`h-[46px] min-w-[132px] items-center justify-center rounded-control bg-button-primary px-[18px] ${(suiStatus === 'importing' || !suiOwnerMatches) ? 'opacity-50' : 'opacity-100'}`}
                  onPress={handleImportSuiNote}
                  disabled={suiStatus === 'importing' || !suiOwnerMatches}
                >
                  <Text className="font-pp-medium text-[14px] text-button-primary-text">
                    {suiStatus === 'importing' ? 'Importing…' : 'Import Sui note'}
                  </Text>
                </Pressable>
              )}

              {note && !done && locked && (
                <Pressable
                  className="h-[46px] min-w-[132px] items-center justify-center rounded-control bg-button-primary px-[18px]"
                  onPress={() => openSeedDerivationModal()}
                >
                  <Text className="font-pp-medium text-[14px] text-button-primary-text">Sign in</Text>
                </Pressable>
              )}

              {note && !done && !locked && (
                <>
                  {!canAnchorOnChain && (
                    <Pressable
                      className={`h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px] ${importsDisabled ? 'opacity-50' : 'opacity-100'}`}
                      onPress={() => importToDevice(notes, { expectedChainId: receipt?.chainId })}
                      disabled={importsDisabled}
                    >
                      <Text className="font-pp-medium text-[14px] text-text">
                        {status === 'importing' ? 'Adding…' : 'Keep on this device'}
                      </Text>
                    </Pressable>
                  )}
                  {canAnchorOnChain && (
                    <Pressable
                      className={`h-[46px] min-w-[132px] items-center justify-center rounded-control bg-button-primary px-[18px] ${importsDisabled ? 'opacity-50' : 'opacity-100'}`}
                      onPress={() => importOnChain(notes, { expectedChainId: receipt?.chainId })}
                      disabled={importsDisabled}
                    >
                      <Text className="font-pp-medium text-[14px] text-button-primary-text">
                        {status === 'anchoring' ? 'Adding…' : 'Add to shielded balance'}
                      </Text>
                    </Pressable>
                  )}
                </>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </ImportNoteModalContext.Provider>
  );
}
