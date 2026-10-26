import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useAccount } from 'wagmi';
import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useActiveEvmChain } from '@/hooks/use-active-evm-chain';
import { getChainConfig } from '@/config/chains';
import { LEGACY_CONFIG } from '@/config/env';
import { buildViewingKeyOverview, VIEWING_KEY_FACTS } from '@/services/viewing-key-overview';
import { getCachedViewingKey, isViewingKeyRegistryFresh } from '@/services/viewing-key-cache';
import { useAccounting } from '@/components/accounting-modal-provider';

/**
 * The account viewing key, in a modal of its own (Privacy & keys -> Viewing
 * Key). It used to be a collapsible section at the bottom of "Export for
 * accounting", where its PERMANENT / SEES EVERYTHING warning sat right under
 * the export's "without exposing your master key" promise and read as a
 * contradiction (boss, 2026-08-29). The two are different things: the export
 * discloses selected transactions; this key reads everything. So they no
 * longer share a modal, and each points at the other where it helps.
 */
type ViewingKeyModalContextType = {
  openViewingKey: () => void;
  closeViewingKey: () => void;
  isOpen: boolean;
};

const ViewingKeyModalContext = createContext<ViewingKeyModalContextType>({
  openViewingKey: () => {},
  closeViewingKey: () => {},
  isOpen: false,
});

export function useViewingKeyModal() {
  return useContext(ViewingKeyModalContext);
}

export function ViewingKeyModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;
  const { address, isConnected } = useAccount();
  const { keystoreManager, keysReady, sessionAddress } = usePoolSession();
  const { openAccounting } = useAccounting();
  // The account the viewing key belongs to: the PoolSession owner. In
  // account-key mode a connected wallet is only the payer, not the owner.
  const viewingKeyOwner = (sessionAddress ?? address) as `0x${string}` | undefined;
  const activeEvmChainId = useActiveEvmChain().id;
  // The derived X25519 PUBLIC key and whether the on-chain Keystore publishes
  // the same one. Only the public half is ever read here; the private half
  // decrypts the whole history and stays on the device.
  const derivedViewingPublicKey = useMemo(() => {
    if (!keysReady || !keystoreManager) return null;
    try { return String(keystoreManager.getViewingKeyPair().publicKey); } catch { return null; }
  }, [keysReady, keystoreManager]);
  // undefined = read in flight; null = read failed; the zero key = nothing published.
  const [onChainViewingKey, setOnChainViewingKey] = useState<string | null | undefined>(undefined);
  const viewingKeyOverview = useMemo(
    () => buildViewingKeyOverview(derivedViewingPublicKey, onChainViewingKey),
    [derivedViewingPublicKey, onChainViewingKey],
  );

  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const openViewingKey = useCallback(() => {
    setCopied(false);
    setIsOpen(true);
  }, []);
  const closeViewingKey = useCallback(() => setIsOpen(false), []);

  // Read the published viewing key while open. Same lookup the transfer
  // precheck's cache uses (the bulk ASP viewing-key registry).
  useEffect(() => {
    if (!isOpen || !viewingKeyOwner || !derivedViewingPublicKey) return;
    let cancelled = false;
    setOnChainViewingKey(undefined);
    (async () => {
      try {
        const cfg = getChainConfig(activeEvmChainId);
        if (!cfg?.contracts) return;
        // Same keystore the sign-in scheme detection reads (legacy pin first).
        const keystoreAddr = LEGACY_CONFIG?.keystore ?? cfg.contracts.keystoreAddress;
        // The bulk ASP registry copy, never a per-account RPC read. Stale reads as unknown (null).
        if (!isViewingKeyRegistryFresh(activeEvmChainId, keystoreAddr)) {
          if (!cancelled) setOnChainViewingKey(null);
          return;
        }
        const key = getCachedViewingKey(activeEvmChainId, viewingKeyOwner, keystoreAddr) ?? `0x${'0'.repeat(64)}`;
        if (!cancelled) setOnChainViewingKey(String(key));
      } catch (err) {
        console.warn('[ViewingKey] on-chain viewing key read failed', err instanceof Error ? err.message : String(err));
        if (!cancelled) setOnChainViewingKey(null);
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, viewingKeyOwner, derivedViewingPublicKey, activeEvmChainId]);

  const copy = useCallback(async (text: string) => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  }, []);

  const value = useMemo(() => ({ openViewingKey, closeViewingKey, isOpen }), [openViewingKey, closeViewingKey, isOpen]);

  return (
    <ViewingKeyModalContext.Provider value={value}>
      {children}
      <Modal animationType={isMobileSheet ? 'slide' : 'fade'} transparent visible={isOpen} onRequestClose={closeViewingKey}>
        <View className={`flex-1 items-center bg-[rgba(0,0,0,0.5)] ${isMobileSheet ? 'justify-end p-0' : 'justify-center p-[20px]'}`}>
          <View testID="viewing-key-overview" className={`w-full max-w-[560px] gap-[14px] border border-border bg-card-background p-[24px] ${isMobileSheet ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border-b-0 pt-[26px]' : 'rounded-[0px]'}`}>
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isMobileSheet && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]" style={{ backgroundColor: colors.border }} />}
            <View className="flex-row items-start justify-between gap-[12px]">
              <View className="flex-1 gap-[4px]">
                <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PRIVACY &amp; KEYS</Text>
                <Text className="font-pp-bold text-[20px] leading-[25px] text-text">Viewing key</Text>
              </View>
              <Pressable
                className="h-[36px] w-[36px] items-center justify-center rounded-[4px] border border-border-light"
                onPress={closeViewingKey}
                accessibilityRole="button"
                accessibilityLabel="Close"
              >
                {/* nw-keep(data-color): close glyph color is the text theme token into the vector-icon sink */}
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            </View>

            <ScrollView className="max-h-[540px]" contentContainerClassName="gap-[14px]">
              <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
                Senders encrypt notes to your public viewing key. The private half stays on this device and decrypts every note of this account.
              </Text>

              <View className="gap-[9px] rounded-[4px] border border-[#F4C449] bg-[#FCF2CE] p-[14px]">
                <View className="flex-row items-center gap-[6px]">
                  {/* nw-keep(data-color): warning glyph uses a fixed literal color into the vector-icon sink */}
                  <Ionicons name="warning" size={13} color="#7A5C10" />
                  <Text className="font-pp-bold text-[10px] tracking-[0.5px] text-[#7A5C10]">
                    PERMANENT · SEES EVERYTHING · NO REVOCATION
                  </Text>
                </View>
                {VIEWING_KEY_FACTS.map((fact) => (
                  <Text key={fact} className="font-pp-regular text-[12px] leading-[18px] text-[#7A5C10]">
                    {fact}
                  </Text>
                ))}
              </View>

              {/* The PUBLIC key: what senders encrypt to. Safe to show and copy.
                  The private key is never rendered anywhere. */}
              {isConnected || sessionAddress ? (
                <View className="gap-[6px]">
                  <View className="flex-row items-center justify-between gap-[8px] rounded-[4px] border border-border-light bg-card-background px-[12px] py-[9px]">
                    <Text
                      className="flex-1 font-pp-regular text-[11px] text-text"
                      numberOfLines={1}
                      testID="viewing-key-public"
                      accessibilityLabel={viewingKeyOverview.publicKey ? `Public viewing key ${viewingKeyOverview.publicKey}` : 'Public viewing key'}
                    >
                      {viewingKeyOverview.shortKey ?? (keysReady ? '—' : 'Sign in to derive your key')}
                    </Text>
                    <Text className="font-pp-medium text-[10px] tracking-[0.3px] text-text-muted">public viewing key</Text>
                    {viewingKeyOverview.publicKey ? (
                      <Pressable
                        onPress={() => copy(viewingKeyOverview.publicKey!)}
                        accessibilityRole="button"
                        accessibilityLabel="Copy public viewing key"
                        testID="viewing-key-copy"
                        hitSlop={6}
                      >
                        <Text className="font-pp-medium text-[11px] text-tint">{copied ? 'Copied' : 'Copy'}</Text>
                      </Pressable>
                    ) : null}
                  </View>
                  {viewingKeyOverview.publicKey ? (
                    <Text className="font-pp-regular text-[11px] leading-[16px] text-text-secondary" testID="viewing-key-status">
                      {onChainViewingKey === undefined ? 'Checking the published key...' : viewingKeyOverview.statusText}
                    </Text>
                  ) : null}
                </View>
              ) : (
                <Text className="font-pp-regular text-[12px] leading-[17px] text-text-secondary">
                  Connect or sign in to see this account's public viewing key.
                </Text>
              )}

              {/* The scoped alternative lives in its own modal; point there
                  instead of offering the private key here. */}
              <View className="gap-[8px] rounded-[4px] border border-border-light bg-background-secondary p-[12px]">
                <Text className="font-pp-regular text-[12px] leading-[17px] text-text-secondary">
                  Sharing the private key is not offered here. To show an accountant specific transactions, use Export for accounting: it discloses only what you select.
                </Text>
                <Pressable
                  className="self-start rounded-[4px] border border-border-light px-[12px] py-[8px]"
                  onPress={() => { closeViewingKey(); openAccounting(); }}
                  accessibilityRole="button"
                  testID="viewing-key-open-accounting"
                >
                  <Text className="font-pp-medium text-[12px] text-text">Open Export for accounting</Text>
                </Pressable>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </ViewingKeyModalContext.Provider>
  );
}
