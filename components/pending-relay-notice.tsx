import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';
import { getChainConfig } from '@/config/chains';
import { useToast } from '@/components/toast-provider';
import { canOverride, PENDING_RELAY_OVERRIDE_AFTER_MS, PENDING_RELAY_TTL_MS } from '@/services/pending-relays-core';
import {
  overridePendingRelay,
  readPendingRelays,
  subscribePendingRelays,
  type PendingRelay,
} from '@/services/pending-relays-store';

/** The relayed receipt wait gives up after this long; past it, a relay is slow. */
const SLOW_AFTER_MS = 3 * 60 * 1000;

const METHOD_LABEL: Record<string, string> = {
  relayTransfer: 'Transfer',
  relayWithdrawal: 'Withdrawal',
  relayRegisterAndWithdrawal: 'Withdrawal',
  relayWithAnnounce: 'Withdrawal',
  relayBatchWithdrawal: 'Withdrawal',
  relaySwap: 'Swap',
};

function reportText(record: PendingRelay): string {
  const chain = getChainConfig(record.chainId);
  return [
    'Privacy Pools: relayed transaction not confirmed',
    `Network: ${chain?.name ?? record.chainId} (${record.chainId})`,
    `Operation: ${METHOD_LABEL[record.method] ?? record.method} (${record.method})`,
    `Relayed tx: ${record.txHash}`,
    `Sent to relayer: ${new Date(record.at).toISOString()}`,
    `Relayer: ${chain?.relayerBaseUrl ?? 'unknown'}`,
  ].join('\n');
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard) {
      await navigator.clipboard.writeText(value);
    } else {
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(value);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Relays this account sent on `chainId` that have not been seen on-chain yet.
 *
 * Shown on the forms that could spend the same notes again, so the user knows
 * why a new send is refused, can hand support what the relayer team needs, and
 * after a while can choose to send again anyway. Reads local state only.
 */
export function PendingRelayNotice({ chainId, owner }: { chainId: number; owner: string | null | undefined }) {
  const all = useSyncExternalStore(subscribePendingRelays, readPendingRelays, readPendingRelays);
  const { toast } = useToast();
  const [now, setNow] = useState(() => Date.now());
  const ownerKey = owner ? owner.toLowerCase() : null;
  const pending = useMemo(
    () => all.filter((r) => r.chainId === chainId
      && r.overriddenAt === undefined
      && (r.owner === null || r.owner === ownerKey)
      // The store only drops expired records on its next read/write; a screen
      // that stays mounted through the TTL must not keep showing one until
      // then. `now` ticks below, so this reevaluates on its own.
      && now - r.at < PENDING_RELAY_TTL_MS),
    [all, chainId, ownerKey, now],
  );

  useEffect(() => {
    if (pending.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [pending.length]);

  const copyReport = useCallback(async (record: PendingRelay) => {
    if (await copyText(reportText(record))) {
      toast({ title: 'Report details copied' });
    } else {
      toast({ title: 'Could not copy report details', variant: 'destructive' });
    }
  }, [toast]);

  if (pending.length === 0) return null;

  return (
    <View className="w-full gap-[8px]">
      {pending.map((record) => {
        // `now` ticks every 30s; a record newer than the last tick reads as just sent.
        const ageMs = Math.max(0, now - record.at);
        const minutes = Math.max(1, Math.round(ageMs / 60_000));
        const label = (METHOD_LABEL[record.method] ?? 'Transaction').toLowerCase();
        const slow = ageMs >= SLOW_AFTER_MS;
        const overridable = canOverride(record, now);
        return (
          <View key={record.id} className="w-full border rounded-control p-[12px] gap-[8px] border-warning bg-warning-bg">
            <Text className="text-[13px] leading-[19px] font-pp-bold text-warning">
              A {label} is still pending ({minutes} min)
            </Text>
            <Text className="text-[13px] leading-[19px] font-pp-regular text-warning">
              The relayer accepted it, but it has not been included in a block yet. It can still land, so the funds it
              spends are held for it and sending them again is paused. Your balance and history update on their own once
              it settles.
            </Text>
            {slow && (
              <Text className="text-[13px] leading-[19px] font-pp-regular text-warning">
                This is slower than normal, which usually means a problem on the relayer&apos;s side. If it is still
                pending after {Math.round(PENDING_RELAY_OVERRIDE_AFTER_MS / 60_000)} minutes, please report it and
                include the details below. They contain the relayed transaction hash.
              </Text>
            )}
            <View className="flex-row flex-wrap gap-[8px]">
              <Pressable
                className="border rounded-control px-[12px] py-[6px] border-warning"
                onPress={() => { void copyReport(record); }}
              >
                <Text className="text-[12px] font-pp-medium text-warning">Copy report details</Text>
              </Pressable>
              {overridable && (
                <Pressable
                  className="border rounded-control px-[12px] py-[6px] border-warning"
                  onPress={() => overridePendingRelay(record.id)}
                >
                  <Text className="text-[12px] font-pp-medium text-warning">Send anyway</Text>
                </Pressable>
              )}
            </View>
            {overridable && (
              <Text className="text-[12px] leading-[17px] font-pp-regular text-warning">
                Send anyway only if you believe it was dropped. If it lands after all, the new attempt fails at the relayer
                and nothing is spent twice.
              </Text>
            )}
          </View>
        );
      })}
    </View>
  );
}
