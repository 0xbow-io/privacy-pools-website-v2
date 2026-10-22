import { formatUnits } from 'viem';
// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
import { useBalanceDisplay } from '@/hooks/use-balance-display';

import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Pressable, ScrollView, useWindowDimensions, Text, View } from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';
import QRCode from 'react-native-qrcode-svg';

import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { getTokenMetadata} from '@/config/tokens';
import {
  encodePartialViewingKey,
  encodePartialViewingKeyBatch,
  buildVerifyUrl,
  type PartialViewingKeyV1,
} from '@/services/audit-receipt';



type AuditExportModalContextType = {
  /** One key per note — a multi-lineage transfer discloses several bundles
   *  in a single batch-encoded receipt. */
  openAuditExport: (bundle: PartialViewingKeyV1 | PartialViewingKeyV1[]) => void;
  closeAuditExport: () => void;
};

const AuditExportModalContext = createContext<AuditExportModalContextType>({
  openAuditExport: () => {},
  closeAuditExport: () => {},
});

export function useAuditExport() {
  return useContext(AuditExportModalContext);
}

function shortHex(value: string, lead = 6, tail = 4): string {
  if (!value) return '';
  if (value.length <= lead + tail + 2) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function AuditExportModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;

  const [bundles, setBundles] = useState<PartialViewingKeyV1[] | null>(null);
  const [copied, setCopied] = useState<'key' | 'link' | null>(null);

  const openAuditExport = useCallback((b: PartialViewingKeyV1 | PartialViewingKeyV1[]) => {
    setCopied(null);
    const list = Array.isArray(b) ? b : [b];
    setBundles(list.length > 0 ? list : null);
  }, []);
  const closeAuditExport = useCallback(() => setBundles(null), []);

  const ctx = useMemo(() => ({ openAuditExport, closeAuditExport }), [openAuditExport, closeAuditExport]);

  // First bundle drives the summary rows (all bundles of one receipt share
  // tx/recipient/token); the encoding carries EVERY bundle so each note's key
  // verifies against its own commitment.
  const bundle = bundles?.[0] ?? null;
  const encoded = bundles && bundles.length > 0
    ? (bundles.length > 1 ? encodePartialViewingKeyBatch(bundles) : encodePartialViewingKey(bundles[0]))
    : '';
  const verifyUrl = bundle ? buildVerifyUrl(encoded) : '';

  const balanceDisplay = useBalanceDisplay();
  const amountLabel = useMemo(() => {
    if (!bundles || bundles.length === 0) return '';
    const first = bundles[0];
    const meta = getTokenMetadata(first.tokenId, first.chainId);
    const decimals = meta.decimals ?? 18;
    const total = bundles.reduce((sum, b) => sum + BigInt(b.value), 0n);
    return balanceDisplay(formatUnits(total, decimals), meta.symbol, first.chainId, first.tokenId).text;
  }, [bundles, balanceDisplay]);

  const copy = useCallback(async (text: string, which: 'key' | 'link') => {
    try {
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(text);
      setCopied(which);
      setTimeout(() => setCopied((c) => (c === which ? null : c)), 1800);
    } catch {
      // ignore
    }
  }, []);

  return (
    <AuditExportModalContext.Provider value={ctx}>
      {children}
      <Modal visible={!!bundles} transparent animationType={isMobileSheet ? 'slide' : 'fade'} onRequestClose={closeAuditExport}>
        <Pressable className="absolute inset-0 bg-[rgba(0,0,0,0.6)]" onPress={closeAuditExport} />
        <View className={`flex-1 items-center ${isMobileSheet ? 'justify-end p-0' : 'justify-center p-[20px]'}`} pointerEvents="box-none">
          <View className={`w-full overflow-hidden border border-border bg-card-background ${isMobileSheet ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border-b-0 pt-[26px]' : 'max-w-[440px] max-h-[88%] rounded-card'}`}>
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isMobileSheet && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]" style={{ backgroundColor: colors.border }} />}
            <ScrollView contentContainerClassName="gap-[14px] p-[20px]" showsVerticalScrollIndicator={false}>
              <View className="flex-row items-center justify-between">
                <Text className="font-pp-bold text-[18px] text-text">
                  Partial viewing key
                </Text>
                <Pressable onPress={closeAuditExport} hitSlop={8}>
                  {/* nw-keep(data-color): close glyph color is the text-secondary theme token into the vector-icon sink */}
                  <Ionicons name="close" size={22} color={colors.textSecondary} />
                </Pressable>
              </View>

              <Text className="font-pp-regular text-[13px] leading-[18px] text-text-muted">
                {bundle?.kind === 'sent'
                  ? 'Proof of a payment you sent. Share it with an auditor. They can verify the amount, token and recipient on-chain without seeing any of your other transactions.'
                  : 'Proof of a note you hold. Share it with an auditor. They can verify the amount and token on-chain without seeing any of your other transactions.'}
              </Text>

              {/* Summary */}
              <View className="gap-[8px] rounded-[8px] border border-border-light p-[12px]">
                <Row label="Amount" value={amountLabel} mono />
                <Row
                  label={bundle?.kind === 'sent' ? 'To' : 'Owner'}
                  value={shortHex(bundle?.ownerAddress ?? '')}
                  mono
                />
                <Row label="Tx" value={shortHex(bundle?.txHash ?? '', 10, 8)} mono />
              </View>

              {/* QR of the verify link */}
              {verifyUrl ? (
                <View className="items-center py-[4px]">
                  <View className="rounded-[8px] bg-[#FFFFFF] p-[10px]">
                    {/* nw-keep(svg-or-canvas): fixed QR module/background colors (theme-independent for scannability; QRCode color props) */}
                    <QRCode value={verifyUrl} size={150} backgroundColor="#FFFFFF" color="#000000" />
                  </View>
                </View>
              ) : null}

              {/* Verify link */}
              <Text className="font-pp-medium text-[11px] uppercase tracking-[0.5px] text-text-secondary">
                Verification link
              </Text>
              <Pressable
                className="flex-row items-center justify-between gap-[8px] rounded-[8px] border border-border-light px-[12px] py-[10px]"
                onPress={() => copy(verifyUrl, 'link')}
              >
                <Text
                  numberOfLines={1}
                  className="flex-1 font-pp-regular text-[12px] text-text"
                >
                  {verifyUrl}
                </Text>
                {/* nw-keep(data-color): copy/check glyph color swaps success/text-secondary tokens into the vector-icon sink */}
                <Ionicons
                  name={copied === 'link' ? 'checkmark' : 'copy-outline'}
                  size={16}
                  color={copied === 'link' ? colors.success : colors.textSecondary}
                />
              </Pressable>

              {/* Raw key */}
              <Text className="font-pp-medium text-[11px] uppercase tracking-[0.5px] text-text-secondary">
                Partial viewing key
              </Text>
              <Pressable
                className="gap-[8px] rounded-[8px] border border-border-light p-[12px]"
                onPress={() => copy(encoded, 'key')}
              >
                <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted">
                  {encoded}
                </Text>
                <View className="flex-row items-center gap-[4px] self-end">
                  {/* nw-keep(data-color): copy/check glyph color swaps success/text-secondary tokens into the vector-icon sink */}
                  <Ionicons
                    name={copied === 'key' ? 'checkmark' : 'copy-outline'}
                    size={14}
                    color={copied === 'key' ? colors.success : colors.textSecondary}
                  />
                  <Text className={`font-pp-regular text-[11px] ${copied === 'key' ? 'text-success' : 'text-text-secondary'}`}>
                    {copied === 'key' ? 'Copied' : 'Tap to copy'}
                  </Text>
                </View>
              </Pressable>

              <View className="flex-row items-start gap-[8px] rounded-[8px] bg-background-secondary p-[10px]">
                {/* nw-keep(data-color): lock glyph color is the text-muted theme token into the vector-icon sink */}
                <Ionicons name="lock-closed-outline" size={14} color={colors.textMuted} />
                <Text className="flex-1 font-pp-regular text-[12px] leading-[17px] text-text-muted">
                  This key reveals only this one transaction, nothing else in your account.
                </Text>
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>
    </AuditExportModalContext.Provider>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View className="flex-row items-center justify-between gap-[12px]">
      <Text className="font-pp-regular text-[12px] text-text-muted">{label}</Text>
      <Text className={`text-[13px] text-text ${mono ? 'font-pp-regular' : 'font-pp-medium'}`}>
        {value}
      </Text>
    </View>
  );
}
