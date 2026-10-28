import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
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
import { useAccount } from 'wagmi';
import { useSessionChainId } from '@/hooks/use-session-chain-id';

import { useTheme } from '@/components/theme-provider';
import { useToast } from '@/components/toast-provider';
import { CopyIconButton } from '@/components/ui/copy-address';
import { loadStoredAccountExport, saveStoredAccountExport } from '@/components/sdk-provider';
import { Colors } from '@/constants/theme';
import { modalCardShadow } from '@/components/ui/web-style-shims';

import type { AccountExport } from '@/services/sdk-types';
import { usePoolSession } from '@/hooks/use-pool-session';
import { parseAccountBackup, prepareAccountBackup, type AddressBookImportResult } from '@/services/wallet-backup-encryption';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useStellarSession } from '@/hooks/use-stellar-session';
import { STELLAR_TESTNET_ID } from '@/config/chains';
import { isStellarBackupPayload, isStellarRequestBackupPayload } from '@/services/stellar/stellar-backup';
import { stellarErrorMessage } from '@/services/stellar/stellar-copy';
import { backupTextNeedsPassword } from '@/services/account-backup-core';

type RecoveryMode = 'export' | 'import';

type AccountRecoveryModalContextType = {
  openExportNotesModal: () => void;
  openImportNotesModal: () => void;
  closeAccountRecoveryModal: () => void;
};

const missingProvider = () => {
  throw new Error('useAccountRecoveryModal must be used within an AccountRecoveryModalProvider');
};

const AccountRecoveryModalContext = createContext<AccountRecoveryModalContextType>({
  openExportNotesModal: missingProvider,
  openImportNotesModal: missingProvider,
  closeAccountRecoveryModal: missingProvider,
});

export function useAccountRecoveryModal() {
  return useContext(AccountRecoveryModalContext);
}

function truncateAddress(address: string): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function canUseBrowserApis(): boolean {
  return Platform.OS === 'web' && typeof window !== 'undefined' && typeof document !== 'undefined';
}

export function AccountRecoveryModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;
  const { address: walletAddress } = useAccount();
  // Session chain, not the wagmi store: exports/imports address the stored
  // account bucket the SESSION writes — the store value diverges on staging.
  const sessionChainId = useSessionChainId();
  // Stellar: the Freighter account's own backup (services/stellar/stellar-backup.ts),
  // always password-sealed by the SDK.
  const { isStellar } = useChainRouter();
  const stellar = useStellarSession();
  const { exportBackup: stellarExportBackup, importBackup: stellarImportBackup, importRequestBackup: stellarImportRequestBackup } = stellar;
  const stellarAddress = isStellar && stellar.wallet.isConnected ? stellar.wallet.address ?? null : null;
  const chainId = isStellar ? STELLAR_TESTNET_ID : sessionChainId;
  const { exportAccount, importAccount, poolSession, refreshNotes, sessionAddress, isInitializing } = usePoolSession();
  const { toast } = useToast();
  // Live mirror for post-await re-reads (the closure's poolSession can be a
  // stale null while the session commits mid-parse — codex).
  const poolSessionRef = useRef(poolSession);
  poolSessionRef.current = poolSession;
  // Effective identity: backups belong to the SESSION owner. An account-key
  // session has no wagmi address but absolutely has notes to back up (codex:
  // the backup surface didn't recognize key sessions).
  const address: string | undefined = isStellar
    ? stellarAddress ?? undefined
    : (sessionAddress ?? walletAddress ?? undefined);

  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<RecoveryMode>('export');
  const [exportPayload, setExportPayload] = useState('');
  // The (address, chainId) the CURRENT exportPayload was prepared for. Plain
  // backups carry no chain metadata, so an A-chain payload downloaded after a
  // manual switch to B would get a B filename — and importing that file on B
  // merges A's notes into B's bucket. Copy/download/share use THIS capture,
  // and the payload is invalidated whenever the live context moves off it.
  const [exportTarget, setExportTarget] = useState<{ address: string; chainId: number } | null>(null);
  const [importPayload, setImportPayload] = useState('');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [warningMessage, setWarningMessage] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [isPreparingExport, setIsPreparingExport] = useState(false);
  const [isEncryptedBackup, setIsEncryptedBackup] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [useEncryption, setUseEncryption] = useState(true);
  const [needsPassword, setNeedsPassword] = useState(false);

  const resetMessages = useCallback(() => {
    setStatusMessage(null);
    setErrorMessage(null);
    setWarningMessage(null);
  }, []);

  const closeAccountRecoveryModal = useCallback(() => {
    setIsOpen(false);
    setIsImporting(false);
    setPassword('');
    setConfirmPassword('');
    setNeedsPassword(false);
    resetMessages();
  }, [resetMessages]);

  const resolveCurrentExport = useCallback(async (): Promise<AccountExport | null> => {
    const liveExport = await exportAccount();
    if (liveExport) return liveExport;
    if (!address) return null;
    return loadStoredAccountExport(address, chainId);
  }, [address, chainId, exportAccount]);

  const openExportNotesModal = useCallback(() => {
    resetMessages();
    setMode('export');
    setExportPayload('');
    setIsEncryptedBackup(false);
    setPassword('');
    setConfirmPassword('');
    setUseEncryption(true);
    setIsOpen(true);

    void (async () => {
      // Stellar: the backup is built from the unlocked session on Generate.
      if (isStellar) {
        if (!address) setStatusMessage('Connect Freighter to back up this account.');
        return;
      }
      const data = await resolveCurrentExport();
      if (!data || !address) {
        setStatusMessage(
          'No local note backup found for this wallet and chain yet. Make a deposit or import an existing backup first.',
        );
      }
    })();
  }, [address, isStellar, resetMessages, resolveCurrentExport]);

  const handlePrepareExport = useCallback(async () => {
    resetMessages();
    if (isStellar) {
      if (!address) { setErrorMessage('Connect Freighter first.'); return; }
      if (password.length < 8) { setErrorMessage('Password must be at least 8 characters.'); return; }
      if (password !== confirmPassword) { setErrorMessage('Passwords do not match.'); return; }
      setIsPreparingExport(true);
      try {
        const { payload, noteCount } = await stellarExportBackup(password);
        setExportPayload(payload);
        setExportTarget({ address, chainId });
        setIsEncryptedBackup(true);
        setStatusMessage(`Password-encrypted backup ready. Save it to recover ${noteCount} note(s).`);
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        setErrorMessage(/reject|denied|cancel|declined/i.test(raw) ? 'Cancelled in Freighter.' : stellarErrorMessage(raw));
      } finally {
        setIsPreparingExport(false);
      }
      return;
    }
    const data = await resolveCurrentExport();
    if (!data || !address) return;

    if (useEncryption) {
      if (!password) { setErrorMessage('Enter a password.'); return; }
      if (password.length < 8) { setErrorMessage('Password must be at least 8 characters.'); return; }
      if (password !== confirmPassword) { setErrorMessage('Passwords do not match.'); return; }
    }

    setIsPreparingExport(true);
    try {
      const prepared = await prepareAccountBackup(address, chainId, data, useEncryption ? password : undefined);
      setExportPayload(prepared.serialized);
      setExportTarget(address ? { address, chainId } : null);
      setIsEncryptedBackup(prepared.encrypted);
      setStatusMessage(
        prepared.encrypted
          ? `Password-encrypted backup ready. Save it to recover ${data.notes.length} note(s).`
          : `Plain backup ready. Save it to recover ${data.notes.length} note(s).`,
      );
      if (prepared.warning) {
        setWarningMessage(prepared.warning);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to prepare backup.');
    } finally {
      setIsPreparingExport(false);
    }
  }, [address, chainId, confirmPassword, password, resetMessages, resolveCurrentExport, useEncryption, isStellar, stellarExportBackup]);

  const openImportNotesModal = useCallback(() => {
    resetMessages();
    setMode('import');
    setImportPayload('');
    setPassword('');
    setNeedsPassword(false);
    setIsEncryptedBackup(false);
    setIsOpen(true);
    setStatusMessage('Paste a backup to restore your notes. If it\'s password-protected, you\'ll be asked for the password.');
  }, [resetMessages]);

  // A prepared payload must not outlive the context it was prepared for: a
  // plain backup carries no chain metadata, so an A-chain payload copied or
  // downloaded after a switch to B is indistinguishable from a B backup and
  // imports A's notes into B's bucket. Clear it the moment the live
  // (address, chainId) moves off the captured target.
  useEffect(() => {
    if (!exportTarget) return;
    if (exportTarget.address === address && exportTarget.chainId === chainId) return;
    setExportPayload('');
    setExportTarget(null);
    setIsEncryptedBackup(false);
    if (isOpen && mode === 'export') {
      setStatusMessage('Network or account changed. Prepare a fresh backup for the current context.');
    }
  }, [address, chainId, exportTarget, isOpen, mode]);

  const handleCopy = useCallback(async () => {
    if (!canUseBrowserApis() || !exportPayload) return;
    try {
      await navigator.clipboard.writeText(exportPayload);
      setStatusMessage('Backup copied to clipboard.');
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to copy backup.');
    }
  }, [exportPayload]);

  const handleDownload = useCallback(() => {
    if (!canUseBrowserApis() || !exportPayload || !exportTarget) return;
    try {
      const blob = new Blob([exportPayload], { type: 'application/json' });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      // Name the file for the context the payload was PREPARED under — the
      // live chainId may have moved since (see exportTarget above).
      link.download = `privacy-pools-notes-${exportTarget.address.toLowerCase()}-${exportTarget.chainId}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      setStatusMessage('Backup downloaded.');
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to download backup.');
    }
  }, [exportTarget, exportPayload]);

  const handleShare = useCallback(async () => {
    if (!exportPayload) return;
    try {
      await Share.share({
        title: 'Privacy Pools Notes Backup',
        message: exportPayload,
      });
      setStatusMessage('Backup shared.');
      setErrorMessage(null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to share backup.');
    }
  }, [exportPayload]);

  // Every way a backup reaches the form (typed, pasted, loaded from a file)
  // goes through here, so an encrypted one always shows the password field.
  const handleImportPayloadChange = useCallback((text: string) => {
    setImportPayload(text);
    // A Stellar backup is always password-sealed.
    const encrypted = backupTextNeedsPassword(text) || isStellarBackupPayload(text);
    setNeedsPassword(encrypted);
    if (encrypted) setErrorMessage(null);
  }, []);

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
        const result = typeof reader.result === 'string' ? reader.result : '';
        // Same path as a paste, so an encrypted file shows the password field (DEV-460).
        handleImportPayloadChange(result);
        setStatusMessage(`Loaded ${file.name}. Review it, then press Import Notes.`);
        setErrorMessage(null);
      };
      reader.onerror = () => {
        setErrorMessage('Failed to read backup file.');
      };
      reader.readAsText(file);
    };
    input.click();
  }, [handleImportPayloadChange]);

  const handleImport = useCallback(async () => {
    if (!importPayload.trim()) {
      setErrorMessage('Paste a backup JSON first.');
      setStatusMessage(null);
      return;
    }

    if (!address) {
      setErrorMessage('Connect the wallet you want to recover before importing notes.');
      setStatusMessage(null);
      return;
    }

    if (needsPassword && !password) {
      setErrorMessage('This backup is password-protected. Enter your password.');
      return;
    }

    if (isStellar && isStellarRequestBackupPayload(importPayload)) {
      // The request backup a new Stellar request downloads: no password.
      setIsImporting(true);
      resetMessages();
      try {
        const { requests } = await stellarImportRequestBackup(importPayload);
        toast({ title: `Restored ${requests} request(s).` });
        setImportPayload('');
        closeAccountRecoveryModal();
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        setErrorMessage(/reject|denied|cancel|declined/i.test(raw) ? 'Cancelled in Freighter.' : stellarErrorMessage(raw));
      } finally {
        setIsImporting(false);
      }
      return;
    }

    if (isStellar) {
      if (!isStellarBackupPayload(importPayload)) {
        setErrorMessage('This is not a Stellar backup.');
        return;
      }
      setIsImporting(true);
      resetMessages();
      try {
        const { added, requests } = await stellarImportBackup(importPayload, password);
        toast({ title: `Restored ${added} note(s)${requests ? ` and ${requests} request(s)` : ''}.` });
        setPassword('');
        setNeedsPassword(false);
        setImportPayload('');
        closeAccountRecoveryModal();
      } catch (error) {
        const raw = error instanceof Error ? error.message : String(error);
        setErrorMessage(/reject|denied|cancel|declined/i.test(raw) ? 'Cancelled in Freighter.' : stellarErrorMessage(raw));
      } finally {
        setIsImporting(false);
      }
      return;
    }

    // A session initializer in flight will overwrite the storage bucket with
    // whatever snapshot it loaded BEFORE a raw save here — the import would
    // report success and then silently lose the notes (codex). Wait it out.
    if (isInitializing) {
      setErrorMessage('Your session is still initializing. Retry the import in a moment.');
      return;
    }
    setIsImporting(true);
    resetMessages();

    try {
      let book: AddressBookImportResult = { status: 'absent' };
      const accountExport = await parseAccountBackup(address, chainId, importPayload, needsPassword ? password : undefined, (r) => { book = r; });
      // Re-read the LIVE session after the await: it can commit while parsing,
      // and the render-captured null would raw-save under a live session.
      const liveSession = poolSessionRef.current;
      if (liveSession) {
        // The live session import reconciles against the chain and persists
        // only the reconciled export — pre-saving the raw backup here could
        // resurrect an already-spent note. Await it so a failure lands in
        // this catch instead of behind a premature success message.
        await importAccount(accountExport);
      } else {
        // No session to reconcile with: store the raw backup so the next
        // unlock imports it.
        saveStoredAccountExport(accountExport, address, chainId);
        refreshNotes();
      }
      // The "temporary until discovery lands" disclaimer is gone — discovery
      // shipped; this modal stays as a manual fallback.
      const bookResult = book as AddressBookImportResult;
      toast({
        title: `Imported ${accountExport.notes.length} note(s).`,
        ...(bookResult.status === 'restored' && bookResult.added > 0
          ? { description: `${bookResult.added} saved address${bookResult.added === 1 ? '' : 'es'} restored.` }
          : {}),
      });
      // A bad address-book field never blocks the notes: say so, plainly.
      if (bookResult.status === 'skipped') setWarningMessage(bookResult.message);
      setErrorMessage(null);
      setPassword('');
      setNeedsPassword(false);
      setMode('export');
      setExportPayload('');
      setIsEncryptedBackup(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Failed to import notes.');
    } finally {
      setIsImporting(false);
    }
  }, [address, chainId, importAccount, importPayload, needsPassword, password, poolSession, isInitializing, refreshNotes, resetMessages, toast, isStellar, stellarImportBackup, stellarImportRequestBackup, closeAccountRecoveryModal]);

  const subtitle = useMemo(() => {
    if (!address) {
      return 'Connect your wallet to export or import the local note backup for this chain.';
    }
    return `Account ${truncateAddress(address)} on chain ${chainId}`;
  }, [address, chainId]);

  return (
    <AccountRecoveryModalContext.Provider
      value={{ openExportNotesModal, openImportNotesModal, closeAccountRecoveryModal }}
    >
      {children}
      <Modal
        animationType={isMobileSheet ? 'slide' : 'fade'}
        transparent
        visible={isOpen}
        onRequestClose={closeAccountRecoveryModal}
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
                <Text className="font-pp-bold text-[26px] leading-[30px] text-text">
                  {mode === 'export' ? 'Export Notes' : 'Import Notes'}
                </Text>
                <Text className="font-pp-regular text-[13px] leading-[18px] text-text-secondary">
                  {subtitle}
                  {address ? <CopyIconButton value={address} /> : null}
                </Text>
              </View>
              <Pressable
                className="h-[36px] w-[36px] items-center justify-center rounded-control border border-border-light"
                onPress={closeAccountRecoveryModal}
              >
                {/* nw-keep(data-color): close glyph color is the text theme token into the vector-icon sink */}
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            </View>


            {statusMessage ? (
              <View className="mb-[12px] rounded-control border border-[#98B975] bg-[#F5FAEE] px-[14px] py-[12px]">
                <Text className="font-pp-regular text-[12px] leading-[18px] text-[#6E8A42]">{statusMessage}</Text>
              </View>
            ) : null}

            {warningMessage ? (
              <View className="mb-[12px] rounded-control border border-[#E1C26B] bg-[#FFF9E8] px-[14px] py-[12px]">
                <Text className="font-pp-regular text-[12px] leading-[18px] text-[#8A6B1F]">{warningMessage}</Text>
              </View>
            ) : null}

            {errorMessage ? (
              <View className="mb-[12px] rounded-control border border-[#F2B8B5] bg-[#FFF4F4] px-[14px] py-[12px]">
                <Text className="font-pp-regular text-[12px] leading-[18px] text-[#C24131]">{errorMessage}</Text>
              </View>
            ) : null}

            <ScrollView className="max-h-[420px] min-h-[280px] grow-0" contentContainerClassName="grow">
              {mode === 'export' ? (
                <>
                  {!exportPayload && (
                    <View className="my-[8px] gap-[8px]">
                      {/* Stellar backups are always sealed (SDK exportAccountSealed). */}
                      {!isStellar && (
                      <Pressable
                        className="mb-[4px] flex-row items-center gap-[8px]"
                        onPress={() => setUseEncryption((v) => !v)}
                      >
                        <View className={`h-[18px] w-[18px] items-center justify-center rounded-control border border-border ${useEncryption ? 'bg-text' : ''}`}>
                          {useEncryption && <Text className={`text-center text-[11px] leading-[14px] ${colorScheme === 'dark' ? 'text-[#000]' : 'text-[#fff]'}`}>✓</Text>}
                        </View>
                        <Text className="font-pp-regular text-[13px] text-text">
                          Encrypt with password
                        </Text>
                      </Pressable>
                      )}
                      {!isStellar && !useEncryption && (
                        <Text className="font-pp-regular text-[12px] leading-[17px] text-text-muted" testID="backup-recipients-encrypted-only">
                          Recipients are only saved in password-protected backups.
                        </Text>
                      )}
                      {(useEncryption || isStellar) && (
                        <>
                          <TextInput
                            secureTextEntry
                            autoCapitalize="none"
                            autoCorrect={false}
                            value={password}
                            onChangeText={setPassword}
                            placeholder="Password (min 8 characters)"
                            // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                            placeholderTextColor={colors.textMuted}
                            className={`h-[40px] rounded-control border border-border-light px-[12px] font-pp-regular text-[14px] text-text ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
                          />
                          <TextInput
                            secureTextEntry
                            autoCapitalize="none"
                            autoCorrect={false}
                            value={confirmPassword}
                            onChangeText={setConfirmPassword}
                            placeholder="Confirm password"
                            // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                            placeholderTextColor={colors.textMuted}
                            className={`h-[40px] rounded-control border border-border-light px-[12px] font-pp-regular text-[14px] text-text ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
                          />
                        </>
                      )}
                      <Pressable
                        className="mt-[4px] h-[38px] items-center justify-center rounded-control bg-text px-[18px]"
                        onPress={handlePrepareExport}
                        disabled={isPreparingExport}
                      >
                        <Text className={`font-pp-medium text-[14px] ${colorScheme === 'dark' ? 'text-[#000]' : 'text-[#fff]'}`}>
                          {isPreparingExport ? 'Preparing...' : 'Generate Backup'}
                        </Text>
                      </Pressable>
                    </View>
                  )}
                  {exportPayload ? (
                    <>
                      <Text className="mb-[8px] font-pp-medium text-[12px] leading-[18px] text-text-secondary">
                        {isEncryptedBackup ? 'Password-encrypted backup' : 'Plain backup payload'}
                      </Text>
                      <TextInput
                        multiline
                        editable={false}
                        selectTextOnFocus
                        value={exportPayload}
                        placeholder="No local backup available yet."
                        // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                        placeholderTextColor={colors.textMuted}
                        className={`min-h-[280px] rounded-inner border border-border-light px-[14px] py-[14px] font-pp-regular text-[12px] leading-[18px] text-text ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
                        // nw-keep(platform-css): textAlignVertical is not css-interop-compatible — the [textAlignVertical:top] arbitrary class compiles to nothing on native, dropping the multiline top-align
                        style={{ textAlignVertical: 'top' }}
                      />
                    </>
                  ) : null}
                </>
              ) : (
                <>
                <TextInput
                  multiline
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={importPayload}
                  onChangeText={handleImportPayloadChange}
                  placeholder="Paste backup JSON here"
                  // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                  placeholderTextColor={colors.textMuted}
                  className={`min-h-[280px] rounded-inner border border-border-light px-[14px] py-[14px] font-pp-regular text-[12px] leading-[18px] text-text ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
                  // nw-keep(platform-css): textAlignVertical is not css-interop-compatible — the [textAlignVertical:top] arbitrary class compiles to nothing on native, dropping the multiline top-align
                  style={{ textAlignVertical: 'top' }}
                />
                {needsPassword && (
                  <View className="my-[8px] gap-[8px]">
                    <Text className="font-pp-regular text-[12px] text-text-secondary">
                      This backup is password-protected.
                    </Text>
                    <TextInput
                      secureTextEntry
                      autoCapitalize="none"
                      autoCorrect={false}
                      value={password}
                      onChangeText={setPassword}
                      placeholder="Enter password"
                      // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                      placeholderTextColor={colors.textMuted}
                      className={`h-[40px] rounded-control border border-border-light px-[12px] font-pp-regular text-[14px] text-text ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
                    />
                  </View>
                )}
                </>
              )}
            </ScrollView>

            <View className="mt-[18px] flex-row flex-wrap justify-end gap-[10px]">
              {mode === 'export' ? (
                <>
                  {Platform.OS === 'web' ? (
                    <>
                      <Pressable
                        className="h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px]"
                        onPress={handleCopy}
                        disabled={!exportPayload || isPreparingExport}
                      >
                        <Text className="font-pp-medium text-[14px] text-text">Copy</Text>
                      </Pressable>
                      <Pressable
                        className="h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px]"
                        onPress={handleDownload}
                        disabled={!exportPayload || isPreparingExport}
                      >
                        <Text className="font-pp-medium text-[14px] text-text">Download</Text>
                      </Pressable>
                    </>
                  ) : (
                    <Pressable
                      className="h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px]"
                      onPress={handleShare}
                      disabled={!exportPayload || isPreparingExport}
                    >
                      <Text className="font-pp-medium text-[14px] text-text">Share</Text>
                    </Pressable>
                  )}
                  <Pressable
                      className="h-[46px] min-w-[132px] items-center justify-center rounded-control bg-button-primary px-[18px]"
                      onPress={closeAccountRecoveryModal}
                    >
                    <Text className="font-pp-medium text-[14px] text-button-primary-text">
                      {isPreparingExport ? 'Preparing...' : 'Done'}
                    </Text>
                  </Pressable>
                </>
              ) : (
                <>
                  {Platform.OS === 'web' ? (
                    <Pressable
                      className="h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px]"
                      onPress={handlePickFile}
                    >
                      <Text className="font-pp-medium text-[14px] text-text">Load File</Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    className="h-[46px] min-w-[120px] items-center justify-center rounded-control border border-border bg-transparent px-[18px]"
                    onPress={closeAccountRecoveryModal}
                  >
                    <Text className="font-pp-medium text-[14px] text-text">Cancel</Text>
                  </Pressable>
                  <Pressable
                    className="h-[46px] min-w-[132px] items-center justify-center rounded-control bg-button-primary px-[18px]"
                    onPress={handleImport}
                    disabled={isImporting}
                  >
                    <Text className="font-pp-medium text-[14px] text-button-primary-text">
                      {isImporting ? 'Importing...' : 'Import Notes'}
                    </Text>
                  </Pressable>
                </>
              )}
            </View>
          </View>
        </View>
      </Modal>
    </AccountRecoveryModalContext.Provider>
  );
}
