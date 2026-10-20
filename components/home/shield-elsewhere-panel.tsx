import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { ChainLogo, chainLogoChainFor } from '@/components/ui/chain-logo';
import { formatUsdPrecise } from '@/services/format-fiat';
import { displayTokenSymbol } from '@/services/share-display';
import type { ShieldElsewhere } from '@/services/shield-elsewhere';
import type { WalletToken } from '@/services/wallet-tokens';

export const SHIELD_ELSEWHERE_PROMPT = 'To avoid high gas fees consider shielding on a different chain.';

const usd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : formatUsdPrecise(n));

function walletUsdOn(tokens: readonly WalletToken[]): number | null {
  let total = 0;
  let priced = false;
  for (const token of tokens) {
    if (token.suspicious || token.usdValue === null || !Number.isFinite(token.usdValue)) continue;
    total += token.usdValue;
    priced = true;
  }
  return priced ? total : null;
}

/**
 * Advisory: a small shield on an expensive chain, with the other chains it
 * could land on instead. Picking a pool keeps the wallet where it is and
 * routes the deposit there through the cross-chain shield. Never blocks.
 */
export function ShieldElsewherePanel({
  suggestion,
  sourceChainName,
  walletTokensOn,
  onPick,
}: {
  suggestion: ShieldElsewhere;
  sourceChainName: string;
  walletTokensOn: (chainId: number) => WalletToken[];
  onPick: (chainId: number, symbol: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <View className="w-full gap-[8px]">
      <Pressable
        onPress={() => setOpen((o) => !o)}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        testID="hub-shield-elsewhere"
        className="self-start"
      >
        <Text className="font-pp-sans text-[12px] leading-[17px] text-warning underline">{SHIELD_ELSEWHERE_PROMPT}</Text>
      </Pressable>
      {open && (
        <View className="w-full overflow-hidden rounded-inner border border-border-light bg-background-secondary" testID="hub-shield-elsewhere-panel">
          <Text className="px-[12px] pt-[10px] pb-[4px] font-pp-sans text-[11.5px] leading-[16px] text-text-muted">
            Every later withdraw, send or swap on {sourceChainName} pays its gas again, and gas can spike well above today&apos;s.
            {suggestion.directFeeUsd === null ? '' : ` Shielding here costs about ${usd(suggestion.directFeeUsd)} right now.`} Fees below are estimates, priced again when you pick.
          </Text>
          {suggestion.rows.map((row) => {
            const disabled = row.disabledReason !== null;
            const walletUsd = walletUsdOn(walletTokensOn(row.chainId));
            return (
              <View
                key={row.chainId}
                className={`flex-row flex-wrap items-center gap-x-[10px] gap-y-[6px] border-t border-border-light px-[12px] py-[10px] ${disabled ? 'opacity-50' : 'opacity-100'}`}
                testID={`hub-shield-elsewhere-row-${row.chainId}`}
                accessibilityState={{ disabled }}
              >
                <ChainLogo chain={chainLogoChainFor(row.chainId)} size={18} testnetLabel={false} />
                <View className="min-w-[140px] flex-1 gap-[1px]">
                  <Text className="font-pp-sans-medium text-[13px] text-text" numberOfLines={1}>{row.chainName}</Text>
                  <Text className="font-pp-sans text-[11.5px] text-text-muted" numberOfLines={2}>
                    {disabled
                      ? row.disabledReason
                      : `${row.feeUsd === null ? 'Fee estimate unavailable' : `~${usd(row.feeUsd)} est. to shield`}${walletUsd === null ? '' : ` · Wallet ${usd(walletUsd)}`}`}
                  </Text>
                </View>
                {!disabled && (
                  <View className="flex-row flex-wrap gap-[6px]">
                    {row.pools.map((pool) => (
                      <Pressable
                        key={pool.symbol}
                        onPress={() => {
                          setOpen(false);
                          onPick(row.chainId, pool.symbol);
                        }}
                        accessibilityRole="button"
                        accessibilityLabel={`Shield as ${displayTokenSymbol(pool.symbol)} on ${row.chainName}`}
                        testID={`hub-shield-elsewhere-pick-${row.chainId}-${pool.symbol}`}
                        className="rounded-full border border-border px-[10px] py-[4px] active:bg-primary-soft"
                      >
                        <Text className="font-pp-sans-medium text-[12px] text-text">{displayTokenSymbol(pool.symbol)}</Text>
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}
    </View>
  );
}
