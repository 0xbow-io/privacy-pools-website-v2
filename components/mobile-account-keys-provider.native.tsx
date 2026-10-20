import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, AppState, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import * as SecureStore from 'expo-secure-store';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { Modal } from '@/components/ui/modal';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useBackHandler } from '@/hooks/use-back-handler';
import { MobileAccountKeysContext, type MobileAccountKeysView } from '@/components/mobile-account-keys-context';
import {
  formatTransferCode,
  generateTransferCode,
  isTransferPayload,
  openAccountKeyTransfer,
} from '@/services/account-key-transfer';
import { transferKdf } from '@/services/account-key-transfer-kdf';
import {
  MAX_ACCOUNT_KEY_NAME,
  createAccountKeyStore,
  keyInUse,
  reconcileActiveId,
  retryTransientOnce,
  type AccountKeyList,
  type ListedAccountKey,
  type SecureKV,
  type StoredAccountKey,
} from '@/services/mobile-account-key-store';

// This device only, never in a backup, readable once the phone is unlocked.
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

const secureKV: SecureKV = {
  get: (key) => SecureStore.getItemAsync(key, SECURE_OPTIONS),
  set: (key, value) => SecureStore.setItemAsync(key, value, SECURE_OPTIONS),
  remove: (key) => SecureStore.deleteItemAsync(key, SECURE_OPTIONS),
};

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// 'failed': a decrypt failed. The camera stays off until the user taps
// Try again, so the same QR is not re-scanned into another 64 MiB Argon2id.
type SheetView = 'list' | 'code' | 'scan' | 'opening' | 'failed';

const BOOT_RETRY_MS = [500, 1500, 4000, 10000];

/**
 * Native: account keys imported from the web, kept in SecureStore. The
 * active one drives the session exactly like a pasted account key
 * (signInWithAccountKey), and signs back in on the next launch.
 *
 * Import: the phone makes the transfer code (memory only, gone when the
 * sheet closes), the user types it on the web, the phone scans the QR and
 * decrypts. Nothing here makes a network request.
 */
export function MobileAccountKeysProvider({ children }: { children: ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { signInWithAccountKey, signOutAccountKey, identityMode, keyFingerprint } = usePoolSession();
  const store = useMemo(() => createAccountKeyStore(secureKV), []);
  // The session's full identity (address + signatures) when it is an account
  // key. This, not the stored active id nor the address, says which saved key
  // is in use: a key pasted in the wallet modal becomes the session without
  // passing through this store, and one address can have several keys.
  const liveKeyFingerprint = identityMode === 'key' ? keyFingerprint : null;

  const [list, setList] = useState<AccountKeyList>({ keys: [], activeId: null });
  // False until the store has been read once; nothing reconciles against an unread list.
  const [loaded, setLoaded] = useState(false);
  // Sign-ins this provider started and has not seen finish.
  const [signingIn, setSigningIn] = useState(0);
  const [visible, setVisible] = useState(false);
  const [view, setView] = useState<SheetView>('list');
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const scanLockRef = useRef(false);
  // Bumped whenever the import is abandoned, so a late decrypt is dropped.
  const importEpochRef = useRef(0);

  /** The store's contents, or null when it could not be read (never "empty"). */
  const refresh = useCallback(async () => {
    try {
      const next = await store.list();
      setList(next);
      setLoaded(true);
      return next;
    } catch {
      return null;
    }
  }, [store]);

  // After a write we know succeeded, a failed re-read must not leave the
  // screen on the old state: fold the row and active id in locally.
  const refreshAfterWrite = useCallback(async (entry: ListedAccountKey) => {
    if (await refresh()) return;
    setList((prev) => ({
      keys: prev.keys.some((k) => k.id === entry.id) ? prev.keys : [...prev.keys, entry],
      activeId: entry.id,
    }));
  }, [refresh]);

  // A switch from here (write the new active id, then sign in) is counted
  // from its first write to the end of the sign-in, so the reconcile below
  // never sees "active = new, session = old" and flips it back.
  const switching = useCallback(async <T,>(run: () => Promise<T>): Promise<T> => {
    setSigningIn((n) => n + 1);
    try {
      return await run();
    } finally {
      setSigningIn((n) => n - 1);
    }
  }, []);

  // Once more on a transient key-source switch (KeySourceChangedError).
  const signIn = useCallback(
    (secret: string) => retryTransientOnce(() => signInWithAccountKey(secret)),
    [signInWithAccountKey],
  );

  const activate = useCallback((id: string) => switching(async () => {
    const secret = await store.secret(id);
    if (!secret) throw new Error('This key could not be read. Remove it and import it again.');
    await store.setActive(id);
    const row = list.keys.find((k) => k.id === id);
    if (row) await refreshAfterWrite(row);
    else await refresh();
    await signIn(secret);
  }), [switching, store, list.keys, refreshAfterWrite, refresh, signIn]);

  // Launch: sign back in with the active key, once the store is readable.
  // A failed read (keystore locked, transient error) is retried with backoff
  // and on return to the foreground, never taken as "no keys".
  const bootRef = useRef<'pending' | 'running' | 'done'>('pending');
  const boot = useCallback(async (): Promise<boolean> => {
    if (bootRef.current !== 'pending') return true;
    bootRef.current = 'running';
    const current = await refresh();
    if (!current) {
      bootRef.current = 'pending';
      return false;
    }
    bootRef.current = 'done';
    if (current.activeId) {
      try {
        await activate(current.activeId);
      } catch {
        // The session surfaces its own error; the key stays saved.
      }
    }
    return true;
  }, [refresh, activate]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    const tick = async () => {
      if (cancelled) return;
      const ok = await boot();
      if (!ok && !cancelled && attempt < BOOT_RETRY_MS.length) {
        timer = setTimeout(() => { void tick(); }, BOOT_RETRY_MS[attempt++]);
      }
    };
    void tick();
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void boot();
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, [boot]);

  // Keep the stored active id on the key actually in use, so launch resumes
  // the key the user last used: a saved key pasted in the wallet modal
  // becomes active, an unsaved one clears it. Skipped while a sign-in from
  // here is in flight (the session still shows the previous key).
  // The rendered list can be stale (a re-read failed), so the decision is
  // made again on a fresh read, and a failed read changes nothing.
  useEffect(() => {
    if (!loaded || signingIn > 0) return;
    if (reconcileActiveId(list, liveKeyFingerprint) === undefined) return;
    let cancelled = false;
    void (async () => {
      const fresh = await refresh();
      if (cancelled || !fresh) return;
      const next = reconcileActiveId(fresh, liveKeyFingerprint);
      if (next === undefined) return;
      await store.setActive(next);
      await refresh();
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [loaded, signingIn, list, liveKeyFingerprint, store, refresh]);

  const inUseId = keyInUse(list, liveKeyFingerprint);

  const resetImport = useCallback(() => {
    importEpochRef.current++;
    setCode(null);
    scanLockRef.current = false;
  }, []);

  const open = useCallback((next: MobileAccountKeysView = 'list') => {
    setError(null);
    setRenaming(null);
    resetImport();
    if (next === 'import') {
      setCode(generateTransferCode());
      setView('code');
    } else {
      setView('list');
    }
    setVisible(true);
    void refresh();
  }, [refresh, resetImport]);

  const close = useCallback(() => {
    setVisible(false);
    setView('list');
    setError(null);
    setRenaming(null);
    resetImport();
  }, [resetImport]);
  useBackHandler(visible, close);

  const signedOut = useCallback(() => {
    void store.setActive(null).then(refresh, refresh);
  }, [store, refresh]);

  const startImport = useCallback(() => {
    setError(null);
    importEpochRef.current++;
    scanLockRef.current = false;
    setCode(generateTransferCode());
    setView('code');
  }, []);

  const onScanned = useCallback(async (result: BarcodeScanningResult) => {
    if (scanLockRef.current || !code) return;
    if (!isTransferPayload(result.data)) return; // keep scanning past other QRs
    scanLockRef.current = true;
    const epoch = importEpochRef.current;
    setView('opening');
    setError(null);
    let encoded: string;
    try {
      encoded = await openAccountKeyTransfer({ code, payload: result.data, kdf: transferKdf });
    } catch (err) {
      if (importEpochRef.current !== epoch) return;
      // Stay locked: the same QR is likely still in view, and every pass is
      // another 64 MiB Argon2id. Only Try again unlocks the camera.
      setError(errorText(err));
      setView('failed');
      return;
    }
    // Closed while decrypting: the user walked away, so keep nothing.
    if (importEpochRef.current !== epoch) return;
    await switching(async () => {
      let entry: ListedAccountKey;
      try {
        entry = await store.add(encoded);
      } catch (err) {
        setError(errorText(err));
        setView('failed');
        return;
      }
      setCode(null);
      // The key is saved: show it even if the re-read fails.
      await refreshAfterWrite(entry);
      setView('list');
      setBusyId(entry.id);
      try {
        await signIn(encoded);
        close();
      } catch (err) {
        // Saved, but the session did not start: stay on the list to retry.
        setError(errorText(err));
      } finally {
        setBusyId(null);
      }
    });
  }, [code, store, refreshAfterWrite, signIn, close, switching]);

  const retryScan = useCallback(() => {
    setError(null);
    scanLockRef.current = false;
    setView('scan');
  }, []);

  const switchTo = useCallback(async (entry: StoredAccountKey) => {
    if (busyId) return;
    setBusyId(entry.id);
    setError(null);
    try {
      await activate(entry.id);
      close();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyId(null);
    }
  }, [busyId, activate, close]);

  const saveRename = useCallback(async () => {
    if (!renaming) return;
    try {
      await store.rename(renaming.id, renaming.name);
      setRenaming(null);
      await refresh();
    } catch (err) {
      setError(errorText(err));
    }
  }, [renaming, store, refresh]);

  const confirmRemove = useCallback((entry: StoredAccountKey) => {
    Alert.alert('Remove key?', `${entry.name} is deleted from this phone.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void (async () => {
            // Sign out only when the session IS this row (same full identity),
            // not another key for the same address, not the last one picked.
            const isSession = inUseId === entry.id;
            await store.remove(entry.id);
            if (isSession) {
              signOutAccountKey();
              await store.setActive(null).catch(() => undefined);
            }
          })().catch((err) => setError(errorText(err))).finally(() => { void refresh(); });
        },
      },
    ]);
  }, [inUseId, store, signOutAccountKey, refresh]);

  const value = useMemo(() => ({
    available: true,
    count: list.keys.length,
    open,
    signedOut,
  }), [list.keys.length, open, signedOut]);

  return (
    <MobileAccountKeysContext.Provider value={value}>
      {children}
      <Modal animationType="slide" transparent visible={visible} onRequestClose={close}>
        <View className="flex-1 justify-end bg-[rgba(0,0,0,0.5)]">
          <Pressable className="absolute inset-0" onPress={close} accessibilityLabel="Close" />
          <View className="max-h-[90%] gap-[14px] rounded-t-[18px] border-t border-border bg-card-background p-[20px] pb-[28px]">
            <View className="flex-row items-center justify-between">
              <Text className="font-pp-semi-bold text-[18px] text-text">
                {view === 'list' ? 'Account keys' : 'Import account key from web'}
              </Text>
              <Pressable onPress={close} accessibilityRole="button" accessibilityLabel="Close" hitSlop={8}>
                <Text className="px-[8px] font-pp-semi-bold text-[28px] leading-[28px] text-text-secondary">×</Text>
              </Pressable>
            </View>

            {view === 'list' ? (
              <KeyList
                colors={colors}
                list={list}
                busyId={busyId}
                inUseId={inUseId}
                renaming={renaming}
                setRenaming={setRenaming}
                onSaveRename={saveRename}
                onSwitch={switchTo}
                onRemove={confirmRemove}
                onImport={startImport}
              />
            ) : null}

            {view === 'code' && code ? (
              <View className="gap-[14px]">
                <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
                  On the web, open Export account key to mobile and type this code.
                </Text>
                <Text
                  selectable={false}
                  testID="ak-transfer-code"
                  className="rounded-control border border-border px-[12px] py-[16px] text-center font-pp-mono text-[26px] tracking-[3px] text-text"
                >
                  {formatTransferCode(code)}
                </Text>
                <Text className="font-pp-regular text-[12px] text-text-muted">Never share this code.</Text>
                <Pressable
                  onPress={retryScan}
                  className="items-center rounded-control bg-button-primary py-[12px]"
                >
                  <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">Scan QR</Text>
                </Pressable>
              </View>
            ) : null}

            {(view === 'scan' || view === 'opening' || view === 'failed') && code ? (
              <Scanner
                colors={colors}
                state={view}
                code={code}
                onScanned={onScanned}
                onRetry={retryScan}
                onBack={() => { setError(null); setView('code'); }}
              />
            ) : null}

            {error ? <Text className="font-pp-regular text-[12px] text-danger">{error}</Text> : null}
          </View>
        </View>
      </Modal>
    </MobileAccountKeysContext.Provider>
  );
}

function KeyList({
  colors, list, busyId, inUseId, renaming, setRenaming, onSaveRename, onSwitch, onRemove, onImport,
}: {
  colors: typeof Colors.light;
  list: AccountKeyList;
  busyId: string | null;
  /** The saved key the live session is (by address), or null. */
  inUseId: string | null;
  renaming: { id: string; name: string } | null;
  setRenaming: (r: { id: string; name: string } | null) => void;
  onSaveRename: () => void;
  onSwitch: (entry: StoredAccountKey) => void;
  onRemove: (entry: StoredAccountKey) => void;
  onImport: () => void;
}) {
  return (
    <View className="gap-[12px]">
      {list.keys.length === 0 ? (
        <Text className="font-pp-regular text-[13px] text-text-secondary">No keys on this phone yet.</Text>
      ) : (
        <ScrollView className="max-h-[360px]" contentContainerClassName="gap-[8px]">
          {list.keys.map((entry) => {
            const active = inUseId === entry.id;
            const editing = renaming?.id === entry.id;
            return (
              <View
                key={entry.id}
                className={`flex-row items-center gap-[10px] rounded-[8px] border px-[12px] py-[10px] ${active ? 'border-primary' : 'border-border-light'}`}
              >
                <Pressable
                  className="flex-1 gap-[2px]"
                  disabled={editing || active || !!busyId}
                  onPress={() => onSwitch(entry)}
                  accessibilityRole="button"
                  accessibilityLabel={`Use ${entry.name}`}
                >
                  {editing ? (
                    <TextInput
                      value={renaming.name}
                      onChangeText={(name) => setRenaming({ id: entry.id, name })}
                      onSubmitEditing={onSaveRename}
                      autoFocus
                      maxLength={MAX_ACCOUNT_KEY_NAME}
                      returnKeyType="done"
                      className="border-b border-border py-[2px] font-pp-medium text-[15px] text-text"
                    />
                  ) : (
                    <Text className="font-pp-medium text-[15px] text-text" numberOfLines={1}>{entry.name}</Text>
                  )}
                  <Text className="font-pp-mono text-[12px] text-text-muted">
                    {shortAddress(entry.address)}{active ? '  ·  In use' : ''}
                  </Text>
                </Pressable>
                {busyId === entry.id ? <ActivityIndicator color={colors.textSecondary} /> : null}
                {editing ? (
                  <Pressable onPress={onSaveRename} hitSlop={8} accessibilityRole="button" accessibilityLabel="Save name">
                    <Ionicons name="checkmark" size={20} color={colors.text} />
                  </Pressable>
                ) : (
                  <Pressable onPress={() => setRenaming({ id: entry.id, name: entry.name })} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Rename ${entry.name}`}>
                    <Ionicons name="pencil-outline" size={18} color={colors.textSecondary} />
                  </Pressable>
                )}
                <Pressable onPress={() => onRemove(entry)} hitSlop={8} accessibilityRole="button" accessibilityLabel={`Remove ${entry.name}`}>
                  <Ionicons name="trash-outline" size={18} color={colors.textSecondary} />
                </Pressable>
              </View>
            );
          })}
        </ScrollView>
      )}
      <Pressable onPress={onImport} className="items-center rounded-control bg-button-primary py-[12px]" testID="ak-import-from-web">
        <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">Import account key from web</Text>
      </Pressable>
    </View>
  );
}

function Scanner({
  colors, state, code, onScanned, onRetry, onBack,
}: {
  colors: typeof Colors.light;
  state: 'scan' | 'opening' | 'failed';
  code: string;
  onScanned: (result: BarcodeScanningResult) => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const opening = state === 'opening';

  if (!permission) return <ActivityIndicator color={colors.textSecondary} />;
  if (!permission.granted) {
    return (
      <View className="gap-[12px]">
        <Text className="font-pp-regular text-[13px] text-text-secondary">Allow the camera to scan the QR.</Text>
        <Pressable
          onPress={() => { void requestPermission(); }}
          className="items-center rounded-control bg-button-primary py-[12px]"
        >
          <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">Allow camera</Text>
        </Pressable>
        <Pressable onPress={onBack} hitSlop={8}>
          <Text className="py-[6px] text-center font-pp-medium text-[12px] text-text-secondary underline">Back to code</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View className="gap-[12px]">
      <View className="aspect-square w-full overflow-hidden rounded-card bg-[#000000]">
        {state === 'scan' ? (
          <CameraView
            // nw-keep(third-party-style-api): CameraView is not css-interop registered, so it takes a plain style
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScanned}
          />
        ) : state === 'opening' ? (
          <View className="flex-1 items-center justify-center gap-[10px]">
            <ActivityIndicator color="#FFFFFF" />
            <Text className="font-pp-medium text-[13px] text-[#FFFFFF]">Decrypting…</Text>
          </View>
        ) : (
          <View className="flex-1 items-center justify-center p-[20px]">
            <Pressable
              onPress={onRetry}
              accessibilityRole="button"
              testID="ak-scan-retry"
              className="items-center rounded-control bg-button-primary px-[22px] py-[12px]"
            >
              <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">Try again</Text>
            </Pressable>
          </View>
        )}
      </View>
      <Text className="text-center font-pp-mono text-[14px] tracking-[2px] text-text-secondary">{formatTransferCode(code)}</Text>
      {!opening ? (
        <Pressable onPress={onBack} hitSlop={8}>
          <Text className="py-[6px] text-center font-pp-medium text-[12px] text-text-secondary underline">Back to code</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
