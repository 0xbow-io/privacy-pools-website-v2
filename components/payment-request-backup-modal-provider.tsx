import React, { createContext, useCallback, useContext, useState } from 'react';
import {
  Platform,
  Pressable,
  ScrollView,
  Share,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '@/components/theme-provider';
import { useToast } from '@/components/toast-provider';
import { Colors } from '@/constants/theme';
import { modalCardShadow } from '@/components/ui/web-style-shims';

import { usePoolSession } from '@/hooks/use-pool-session';
import { useRequestOwner } from '@/hooks/use-request-owner';
import {
  exportAllPaymentRequests,
  importAllPaymentRequests,
  reloadPaymentRequestsInSession,
  serializePaymentRequestBackup,
} from '@/services/payment-request-recovery';
import { PAY_URL_BASE } from '@/config/env';
import { isStellarRequestBackupPayload } from '@/services/stellar/stellar-backup';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { useChainRouter } from '@/hooks/use-chain-router';
import { canProveBackupSave, notePaymentRequestBackupDelivered, saveBackupWithProof } from '@/services/payment-request-signout';

type BackupMode = 'export' | 'import';

type PaymentRequestBackupModalContextType = {
  openExportPaymentRequestsModal: () => void;
  openImportPaymentRequestsModal: () => void;
  closePaymentRequestBackupModal: () => void;
};

const missingProvider = () => {
  throw new Error('usePaymentRequestBackupModal must be used within PaymentRequestBackupModalProvider');
};

const PaymentRequestBackupModalContext = createContext<PaymentRequestBackupModalContextType>({
  openExportPaymentRequestsModal: missingProvider,
  openImportPaymentRequestsModal: missingProvider,
  closePaymentRequestBackupModal: missingProvider,
});

export function usePaymentRequestBackupModal() {
  return useContext(PaymentRequestBackupModalContext);
}

function canUseBrowserApis(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined';
}

export function PaymentRequestBackupModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;
  // The canonical settled request OWNER — the same identity the list card
  // shows. For an account-key session that's the KEY address, never the
  // connected payer wallet: exporting/importing the payer's (empty) request
  // namespace while displaying the key account was exactly the P1 bug.
  const { owner } = useRequestOwner();
  const { poolSession } = usePoolSession();
  const { importRequestBackup: stellarImportRequestBackup } = useStellarSession();
  const { isStellar } = useChainRouter();
  const { toast } = useToast();

  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<BackupMode>('export');
  const [payload, setPayload] = useState('');
  // The export this modal produced, with the owner it was exported FOR. Only
  // that exact text may be ledgered as a backup, and only to that owner: the
  // session can switch while the modal is open, and a pasted payload is not
  // an export.
  const [exported, setExported] = useState<{ owner: string; text: string } | null>(null);
  // URL-first import: the pay-link field is the primary input; the JSON
  // textarea below it is a collapsible alternative for backup blobs.
  const [urlInput, setUrlInput] = useState('');
  const [jsonOpen, setJsonOpen] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  const reset = useCallback(() => {
    setPayload('');
    setExported(null);
    setUrlInput('');
    setJsonOpen(false);
    setStatusMessage(null);
    setIsBusy(false);
  }, []);

  // The contents stay as they are while the modal animates out; onDismiss
  // clears them afterwards. Android never fires onDismiss, and an export holds
  // recovery keys, so it clears on close there rather than waiting for the
  // next open.
  const closePaymentRequestBackupModal = useCallback(() => {
    setIsOpen(false);
    if (Platform.OS === 'android') reset();
  }, [reset]);

  const openExportPaymentRequestsModal = useCallback(() => {
    reset();
    setMode('export');
    setIsOpen(true);
    if (!owner) {
      setIsBusy(false);
      toast({ title: 'Connect your wallet or sign in to export payment requests.', variant: 'destructive' });
      return;
    }
    setIsBusy(true);
    void exportAllPaymentRequests(owner)
      .then((backup) => {
        const requestCount = Object.values(backup.chains).reduce(
          (count, state) => count + state.requests.length,
          backup.sessionRequests?.length ?? 0,
        );
        const text = serializePaymentRequestBackup(backup);
        setPayload(text);
        setExported({ owner, text });
        setStatusMessage(
          requestCount > 0
            ? `Backup ready with ${requestCount} payment request(s). Keep it private.`
            : 'No payment requests found for this account.',
        );
      })
      .catch((error) => {
        toast({ title: error instanceof Error ? error.message : 'Failed to export payment requests.', variant: 'destructive' });
      })
      .finally(() => setIsBusy(false));
  }, [reset, owner, toast]);

  const openImportPaymentRequestsModal = useCallback(() => {
    reset();
    setMode('import');
    setIsOpen(true);
  }, [reset]);

  const handleCopy = useCallback(async () => {
    if (!canUseBrowserApis() || !payload) return;
    try {
      await navigator.clipboard.writeText(payload);
      toast({ title: 'Payment request backup copied.' });
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Failed to copy backup.', variant: 'destructive' });
    }
  }, [payload, toast]);

  const plainDownload = useCallback((text: string, filename: string) => {
    try {
      const blob = new Blob([text], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast({ title: 'Payment request backup downloaded.' });
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Failed to download backup.', variant: 'destructive' });
    }
  }, [toast]);

  const handleDownload = useCallback(() => {
    if (!canUseBrowserApis() || !payload) return;
    // Named for the account the export was made FOR, not whoever is signed in now.
    const fileOwner = exported && exported.text === payload ? exported.owner : owner;
    const filename = `privacy-pools-payment-requests-${fileOwner ? fileOwner.toLowerCase() : 'wallet'}.json`;
    // No way to confirm a save here: the plain download, synchronously, while
    // the press still counts.
    if (!canProveBackupSave()) { plainDownload(payload, filename); return; }
    // A confirmed save is the only proof that lets sign-out purge the records
    // this file holds.
    const text = payload;
    void (async () => {
      const saved = await saveBackupWithProof(text, filename);
      if (saved === 'cancelled') return;
      if (saved === 'saved') {
        if (exported && exported.text === text) void notePaymentRequestBackupDelivered(exported.owner, text);
        toast({ title: 'Payment request backup saved.' });
        return;
      }
      plainDownload(text, filename);
    })();
  }, [owner, payload, exported, plainDownload, toast]);

  const handleShare = useCallback(async () => {
    if (!payload) return;
    try {
      const shared = await Share.share({
        title: 'Privacy Pools Payment Requests Backup',
        message: payload,
      });
      // iOS reports a dismissed sheet; Android resolves sharedAction either
      // way, so only an iOS share counts as a delivered backup.
      if (Platform.OS === 'ios' && shared.action === Share.sharedAction && exported && exported.text === payload) {
        void notePaymentRequestBackupDelivered(exported.owner, payload);
      }
      toast({ title: 'Payment request backup shared.' });
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Failed to share backup.', variant: 'destructive' });
    }
  }, [payload, exported, toast]);

  const handlePickFile = useCallback(() => {
    if (!canUseBrowserApis()) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        setPayload(typeof reader.result === 'string' ? reader.result : '');
        setStatusMessage(`Loaded ${file.name}. Review it, then press Import.`);
      };
      reader.onerror = () => toast({ title: 'Failed to read backup file.', variant: 'destructive' });
      reader.readAsText(file);
    };
    input.click();
  }, [toast]);

  const handleImport = useCallback(async () => {
    // URL-first: the pay-link field wins when filled; the collapsible JSON
    // textarea is the backup-blob alternative. Both go through the same
    // importer (it classifies links, single exports and full backups).
    const candidate = urlInput.trim() || payload.trim();
    if (!candidate) {
      toast({ title: 'Paste a pay link (or a backup JSON) first.', variant: 'destructive' });
      return;
    }
    // A Stellar request backup restores into the connected Stellar account,
    // only while Stellar is the selected chain.
    if (isStellarRequestBackupPayload(candidate)) {
      if (!isStellar) {
        toast({ title: 'This is a Stellar request backup. Switch to Stellar to import it.', variant: 'destructive' });
        return;
      }
      setIsBusy(true);
      setStatusMessage(null);
      try {
        const { requests } = await stellarImportRequestBackup(candidate);
        toast({ title: `Restored ${requests} request(s).` });
        closePaymentRequestBackupModal();
      } catch (error) {
        toast({ title: error instanceof Error ? error.message : 'Failed to import payment requests.', variant: 'destructive' });
      } finally {
        setIsBusy(false);
      }
      return;
    }
    if (!owner) {
      toast({ title: 'Connect your wallet or sign in to import payment requests.', variant: 'destructive' });
      return;
    }
    setIsBusy(true);
    setStatusMessage(null);
    try {
      const base = PAY_URL_BASE || (canUseBrowserApis() ? window.location.origin : '');
      const result = await importAllPaymentRequests(candidate, owner, base);
      await reloadPaymentRequestsInSession(poolSession);
      toast({ title: `Imported ${result.restored} new payment request(s). ${result.skipped} already existed.` });
      // Success ends the task — the toast confirms it, the modal goes away.
      // Busy stays set so the button does not flip back while it fades out.
      closePaymentRequestBackupModal();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : 'Failed to import payment requests.', variant: 'destructive' });
      setIsBusy(false);
    }
  }, [payload, urlInput, poolSession, owner, toast, closePaymentRequestBackupModal, stellarImportRequestBackup, isStellar]);

  return (
    <PaymentRequestBackupModalContext.Provider
      value={{
        openExportPaymentRequestsModal,
        openImportPaymentRequestsModal,
        closePaymentRequestBackupModal,
      }}
    >
      {children}
      <Modal
        animationType={isMobileSheet ? 'slide' : 'fade'}
        transparent
        visible={isOpen}
        onRequestClose={closePaymentRequestBackupModal}
        onDismiss={reset}
      >
        <View className={`flex-1 items-center bg-[rgba(0,0,0,0.48)] ${isMobileSheet ? 'justify-end p-0' : 'justify-center p-[20px]'}`}>
          <View
            className={`w-full border border-border bg-card-background p-[24px] ${isMobileSheet ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border-b-0 pt-[26px]' : 'max-w-[720px] max-h-[88%] rounded-card'}`}
            // nw-keep(platform-css): modal-card drop shadow (shared, scheme-tinted)
            style={modalCardShadow(colorScheme)}
          >
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isMobileSheet && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]" style={{ backgroundColor: colors.border }} />}
            <View className="flex-row items-start justify-between gap-[12px]">
              <View className="flex-1 gap-[6px]">
                <Text className="font-pp-bold text-[24px] leading-[30px] text-text">
                  {mode === 'export' ? 'Export Payment Requests' : 'Import Payment Requests'}
                </Text>
                <Text className="font-pp-regular text-[13px] leading-[18px] text-text-secondary">
                  Back up request recovery data for payment links.
                </Text>
              </View>
              <Pressable
                className="h-[36px] w-[36px] items-center justify-center rounded-control border border-border-light"
                onPress={closePaymentRequestBackupModal}
              >
                {/* nw-keep(data-color): close glyph color is the text theme token into the vector-icon sink */}
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            </View>

            {mode === 'export' && (
              <View className="mb-[12px] mt-[14px] rounded-control border border-[#E1C26B] bg-[#FFF9E8] px-[14px] py-[12px]">
                <Text className="font-pp-regular text-[12px] leading-[18px] text-[#8A6B1F]">
                  This backup contains payment-request recovery keys. Keep it private.
                </Text>
              </View>
            )}

            {statusMessage ? (
              <View className="mb-[12px] rounded-control border border-[#98B975] bg-[#F5FAEE] px-[14px] py-[12px]">
                <Text className="font-pp-regular text-[12px] leading-[18px] text-[#6E8A42]">{statusMessage}</Text>
              </View>
            ) : null}

            {mode === 'import' && (
              <View className="mt-[14px] gap-[6px]">
                <Text className="font-pp-semi-bold text-[12px] text-text-secondary">Pay link</Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={urlInput}
                  onChangeText={setUrlInput}
                  placeholder="https://…/pay/…"
                  // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                  placeholderTextColor={colors.textMuted}
                  className={`rounded-control border border-border-light px-[14px] py-[12px] font-pp-regular text-[13px] text-text ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
                />
                {/* JSON backup — the alternative, collapsed by default. */}
                <Pressable
                  className="mt-[6px] flex-row items-center gap-[6px] self-start"
                  onPress={() => setJsonOpen((v) => !v)}
                >
                  {/* nw-keep(data-color): chevron color is the secondary text token into the vector-icon sink */}
                  <Ionicons name={jsonOpen ? 'chevron-down' : 'chevron-forward'} size={14} color={colors.textSecondary} />
                  <Text className="font-pp-medium text-[13px] text-text-secondary">Import a backup JSON instead</Text>
                </Pressable>
                {jsonOpen && (
                  <View className="gap-[8px]">
                    <View className="rounded-control border border-[#E1C26B] bg-[#FFF9E8] px-[14px] py-[10px]">
                      <Text className="font-pp-regular text-[12px] leading-[18px] text-[#8A6B1F]">
                        Backups contain payment-request recovery keys. Keep them private.
                      </Text>
                    </View>
                  </View>
                )}
              </View>
            )}
            {(mode === 'export' || jsonOpen) && (
              <ScrollView className={`grow-0 ${mode === 'export' ? 'max-h-[420px] min-h-[280px]' : 'mt-[12px] max-h-[240px] min-h-[140px]'}`} contentContainerClassName="grow">
                <TextInput
                  multiline
                  editable={mode === 'import'}
                  selectTextOnFocus={mode === 'export'}
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={payload}
                  onChangeText={setPayload}
                  placeholder={mode === 'export' ? 'Preparing backup...' : 'Paste payment-request backup JSON here'}
                  // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                  placeholderTextColor={colors.textMuted}
                  className={`${mode === 'export' ? 'min-h-[280px]' : 'min-h-[140px]'} rounded-inner border border-border-light px-[14px] py-[14px] font-pp-regular text-[12px] leading-[18px] text-text ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
                  // nw-keep(platform-css): textAlignVertical is not css-interop-compatible — the [textAlignVertical:top] arbitrary class compiles to nothing on native, dropping the multiline top-align
                  style={{ textAlignVertical: 'top' }}
                />
              </ScrollView>
            )}

            <View className="mt-[18px] flex-row flex-wrap justify-end gap-[10px]">
              {mode === 'export' ? (
                <>
                  {Platform.OS === 'web' ? (
                    <>
                      <Pressable
                        className="h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px]"
                        onPress={handleCopy}
                        disabled={!payload || isBusy}
                      >
                        <Text className="font-pp-medium text-[14px] text-text">Copy</Text>
                      </Pressable>
                      <Pressable
                        className="h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px]"
                        onPress={handleDownload}
                        disabled={!payload || isBusy}
                      >
                        <Text className="font-pp-medium text-[14px] text-text">Download</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      className="h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px]"
                      onPress={handleShare}
                      disabled={!payload || isBusy}
                    >
                      <Text className="font-pp-medium text-[14px] text-text">Share</Text>
                    </Pressable>
                  )}
                  <Pressable
                    className="h-[46px] min-w-[132px] items-center justify-center rounded-control bg-button-primary px-[18px]"
                    onPress={closePaymentRequestBackupModal}
                  >
                    <Text className="font-pp-medium text-[14px] text-button-primary-text">Done</Text>
                  </Pressable>
                </>
              ) : (
                <>
                  {Platform.OS === 'web' && jsonOpen ? (
                    <Pressable
                      className="h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px]"
                      onPress={handlePickFile}
                      disabled={isBusy}
                    >
                      <Text className="font-pp-medium text-[14px] text-text">Load File</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    className="h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px]"
                    onPress={closePaymentRequestBackupModal}
                    disabled={isBusy}
                  >
                    <Text className="font-pp-medium text-[14px] text-text">Cancel</Text>
                  </Pressable>
                  <Pressable
                    className="h-[46px] min-w-[132px] items-center justify-center rounded-control bg-button-primary px-[18px]"
                    onPress={handleImport}
                    disabled={isBusy}
                  >
                    <Text className="font-pp-medium text-[14px] text-button-primary-text">
                      {isBusy ? 'Importing...' : 'Import'}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </PaymentRequestBackupModalContext.Provider>
  );
}
