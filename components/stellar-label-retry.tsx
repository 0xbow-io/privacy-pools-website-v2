/**
 * Shown on a Stellar deposit's success state when the deposit landed but its
 * ASP registration (`register_label`, the second Freighter approval) did not.
 * Until that is re-sent the ASP never sees the deposit, so it would sit in
 * "pending" forever with nothing telling the user why.
 */
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

export function StellarLabelRetryNotice({ retry }: { retry: () => Promise<boolean> }) {
  const [busy, setBusy] = useState(false);
  return (
    <View className="w-full items-center gap-[8px] py-[4px]" testID="stellar-label-retry">
      <Text className="max-w-[340px] text-center text-[12px] leading-[17px] text-text-secondary font-pp-regular">
        Deposit landed, but it was not sent for approval yet. Retry, or tap Sync later.
      </Text>
      <Pressable
        disabled={busy}
        accessibilityRole="button"
        className={`rounded-[8px] border border-border px-[14px] py-[8px] ${busy ? 'opacity-50' : ''}`}
        onPress={() => {
          setBusy(true);
          void retry().finally(() => setBusy(false));
        }}
      >
        <Text className="text-[14px] text-text font-pp-medium">{busy ? 'Approve in Freighter...' : 'Send for approval'}</Text>
      </Pressable>
    </View>
  );
}
