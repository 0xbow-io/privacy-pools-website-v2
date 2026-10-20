import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Linking, Pressable, ScrollView, useWindowDimensions, Text, View } from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';
import QRCode from 'react-native-qrcode-svg';

import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { encodeOriginProof, buildVerifyUrl, type OriginProofV1 } from '@/services/audit-receipt';

// Surface for a single "proof of origin" (from the transactions row menu):
// shows a QR + verify link the user hands to an auditor to prove a public
// withdrawal/exit traces to their own clean deposit.

type OriginProofContextType = {
  openOriginProof: (proof: OriginProofV1) => void;
  closeOriginProof: () => void;
};
const OriginProofContext = createContext<OriginProofContextType>({
  openOriginProof: () => {},
  closeOriginProof: () => {},
});
export function useOriginProof() { return useContext(OriginProofContext); }

export function OriginProofModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;
  const [proof, setProof] = useState<OriginProofV1 | null>(null);
  const [copied, setCopied] = useState(false);

  const openOriginProof = useCallback((p: OriginProofV1) => { setProof(p); setCopied(false); }, []);
  const closeOriginProof = useCallback(() => setProof(null), []);

  const encoded = proof ? encodeOriginProof(proof) : '';
  const verifyUrl = proof ? buildVerifyUrl(encoded) : '';
  const qrTooBig = verifyUrl.length > 1500;

  const copy = useCallback(async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) await navigator.clipboard.writeText(verifyUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  }, [verifyUrl]);

  const value = useMemo(() => ({ openOriginProof, closeOriginProof }), [openOriginProof, closeOriginProof]);

  return (
    <OriginProofContext.Provider value={value}>
      {children}
      <Modal animationType={isMobileSheet ? 'slide' : 'fade'} transparent visible={!!proof} onRequestClose={closeOriginProof}>
        <View className={`flex-1 items-center bg-[rgba(0,0,0,0.5)] ${isMobileSheet ? 'justify-end p-0' : 'justify-center p-[20px]'}`}>
          <View className={`w-full gap-[14px] border border-border bg-card-background p-[24px] ${isMobileSheet ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border-b-0 pt-[26px]' : 'max-w-[460px] rounded-card'}`}>
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isMobileSheet && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]" style={{ backgroundColor: colors.border }} />}
            <View className="flex-row items-start justify-between gap-[12px]">
              <View className="flex-1 gap-[4px]">
                <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PROOF OF ORIGIN</Text>
                <Text className="font-pp-bold text-[19px] leading-[24px] text-text">Prove you control these funds</Text>
              </View>
              <Pressable className="h-[36px] w-[36px] items-center justify-center rounded-control border border-border-light" onPress={closeOriginProof}>
                {/* nw-keep(data-color): close glyph color is the text theme token into the vector-icon sink */}
                <Ionicons name="close" size={18} color={colors.text} />
              </Pressable>
            </View>

            <ScrollView className="max-h-[460px]" contentContainerClassName="items-center gap-[14px]">
              <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
                Share this with an auditor. They can confirm on-chain that this public {proof?.target.type === 'exit' ? 'exit' : 'withdrawal'} is
                tied to a note you control in a single Privacy Pools lineage, and see its current ASP status,
                without exposing your other activity. (It shows lineage control, not that you were the original
                depositor.)
              </Text>

              {qrTooBig ? (
                <View className="w-full rounded-control bg-background-secondary p-[12px]">
                  <Text className="text-center font-pp-regular text-[12px] leading-[17px] text-text-secondary">Use the link below to share.</Text>
                </View>
              ) : (
                <View className="rounded-control bg-[#FFFFFF] p-[12px]">
                  {/* nw-keep(svg-or-canvas): fixed QR module/background colors (theme-independent for scannability; QRCode color props) */}
                  {verifyUrl ? <QRCode value={verifyUrl} size={172} backgroundColor="#FFFFFF" color="#000000" /> : null}
                </View>
              )}

              <Pressable className="w-full flex-row items-center gap-[10px] rounded-control border border-border-light px-[12px] py-[10px]" onPress={copy}>
                <Text className="flex-1 font-pp-regular text-[11px] leading-[15px] text-text-secondary" numberOfLines={2}>{verifyUrl}</Text>
                {/* nw-keep(data-color): copy/check glyph color is the text-secondary theme token into the vector-icon sink */}
                <Ionicons name={copied ? 'checkmark' : 'copy-outline'} size={16} color={colors.textSecondary} />
              </Pressable>

              <View className="flex-row justify-center gap-[8px]">
                <Pressable className="items-center justify-center rounded-control border border-border-light px-[16px] py-[10px]" onPress={copy}>
                  <Text className="font-pp-medium text-[13px] text-text">{copied ? 'Copied' : 'Copy link'}</Text>
                </Pressable>
                <Pressable className="items-center justify-center rounded-control border border-border-light px-[16px] py-[10px]" onPress={() => verifyUrl && Linking.openURL(verifyUrl)}>
                  <Text className="font-pp-medium text-[13px] text-text">Open</Text>
                </Pressable>
              </View>

              <View className="w-full rounded-control bg-background-secondary p-[12px]">
                <Text className="text-center font-pp-regular text-[12px] leading-[17px] text-text-muted">
                  The link between your funds and this transaction isn&apos;t publicly visible. It&apos;s
                  revealed only to whoever you share this with.
                </Text>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </OriginProofContext.Provider>
  );
}
