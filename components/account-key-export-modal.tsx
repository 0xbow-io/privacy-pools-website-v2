import { useCallback, useEffect, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { usePoolSession } from '@/hooks/use-pool-session';

// A fixed grouped-dots mask: constant length so it never leaks the real key's
// size, and spaced so it wraps cleanly instead of clipping to one line.
const MASKED_KEY = Array.from({ length: 44 }, () => '••••').join(' ');

/**
 * Shows the portable account key (the deterministic derivation signature) so
 * the user can sign in elsewhere without a wallet. Spend-grade secret — the
 * copy is deliberately scary, and the key is masked behind a Reveal toggle
 * (shoulder-surfing, screen shares, screenshots). Copy still writes the real
 * key while masked, so hiding it costs no usability.
 */
export function AccountKeyExportModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { exportAccountKey } = usePoolSession();
  const [result, setResult] = useState<{ source: typeof exportAccountKey; key: string } | null>(null);
  const accountKey = visible && result?.source === exportAccountKey ? result.key : null;
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Masked by default (spend-grade secret); the user taps Reveal to see it.
  // Re-masks when the modal closes so the next open starts hidden.
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setResult(null);
    setError(null);
    setCopied(false);
    setRevealed(false);
    if (!visible) return;
    let cancelled = false;
    exportAccountKey()
      .then((key) => { if (!cancelled) setResult({ source: exportAccountKey, key }); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, [visible, exportAccountKey]);

  const copy = useCallback(async () => {
    if (!accountKey) return;
    try {
      if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(accountKey);
      } else {
        const Clipboard = await import('expo-clipboard');
        await Clipboard.setStringAsync(accountKey);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Copy failure isn't worth surfacing; the key is selectable on screen.
    }
  }, [accountKey]);

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center bg-[rgba(0,0,0,0.5)] p-[20px]">
        <View className="w-full max-w-[460px] gap-[14px] rounded-card border border-border bg-card-background p-[24px]">
          <Text className="font-pp-bold text-[20px] leading-[24px] text-text">Export account key</Text>
          <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
            This key rebuilds your account anywhere. Paste it into “Sign in with an
            account key” on another browser to see balances and withdraw or transfer
            without connecting a wallet.
          </Text>
          <View className="rounded-control border border-danger px-[12px] py-[10px]">
            <Text className="font-pp-medium text-[12px] leading-[17px] text-danger">
              Anyone holding this key can spend your shielded balance and read every note,
              past and future. Treat it like a seed phrase. Never share it or paste it
              anywhere you don’t trust.
            </Text>
          </View>
          {error ? (
            <Text className="font-pp-regular text-[12px] text-danger">{error}</Text>
          ) : (
            <View className="gap-[6px]">
              {accountKey ? (
                <Pressable
                  onPress={() => setRevealed((v) => !v)}
                  accessibilityRole="button"
                  accessibilityLabel={revealed ? 'Hide account key' : 'Reveal account key'}
                  className="flex-row items-center gap-[4px] self-end py-[2px]"
                >
                  {/* nw-keep(data-color): reveal-toggle icon color (theme token) into the vector-icon sink */}
                  <Ionicons name={revealed ? 'eye-off-outline' : 'eye-outline'} size={14} color={colors.textSecondary} />
                  <Text className="font-pp-medium text-[12px] text-text-secondary">
                    {revealed ? 'Hide' : 'Reveal'}
                  </Text>
                </Pressable>
              ) : null}
              <Text
                selectable={revealed}
                numberOfLines={4}
                className={`rounded-control border border-border-light px-[10px] py-[8px] font-pp-mono text-[11px] ${revealed ? 'text-text' : 'text-text-muted'}`}
              >
                {accountKey ? (revealed ? accountKey : MASKED_KEY) : 'Unlocking…'}
              </Text>
            </View>
          )}
          <View className="flex-row justify-end gap-[10px]">
            <Pressable onPress={onClose} className="items-center rounded-control border border-border-light px-[14px] py-[10px]">
              <Text className="font-pp-medium text-[13px] text-text">Close</Text>
            </Pressable>
            <Pressable
              onPress={copy}
              disabled={!accountKey}
              className={`items-center rounded-control bg-button-primary px-[18px] py-[10px] ${accountKey ? 'opacity-100' : 'opacity-50'}`}
            >
              <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">
                {copied ? 'Copied!' : 'Copy key'}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}
