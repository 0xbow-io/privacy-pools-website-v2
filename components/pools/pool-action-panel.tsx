import { useShareAmountField } from '@/hooks/use-share-amount-field';
// RULE (Pat 2026-10-21): underlying is DISPLAY ONLY. All maths, MAX,
// amounts, validation, quotes, relayer and on-chain values stay in shares
// (exact strings/bigints). Never convert an amount to underlying and back,
// never feed a displayed underlying figure into an operation.
// Display headlines use underlying through shareBalanceDisplay; shares appear
// only in the (i) hint, in fields labelled with the share symbol, or while the
// rate is unknown. Never print a share count under the underlying symbol.
import { useBalanceDisplay } from '@/hooks/use-balance-display';
import { ShareCountHint } from '@/components/pools/share-count-hint';
import { sameSymbol } from '@/services/symbol-match';
import { useMemo, useState } from 'react';
import { WEB_NO_OUTLINE } from '@/components/ui/web-style-shims';
import { Pressable, Text, TextInput, View } from 'react-native';

import { formatUnits } from 'viem';
import { Card } from '@/components/ui/card';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { usePools } from '@/components/pools-provider';
import { getTokenMetadataBySymbol } from '@/config/tokens';
import { intentSwapsEnabledForChain } from '@/config/intent-swaps';
import { swapSurfaceEnabled } from '@/config/intent-lockdown';
import { useChainRouter } from '@/hooks/use-chain-router';
import { parseTokenAmount, sanitizeAmountInput } from '@/services/token-amount';
import { tokenIconFor } from '@/components/pools/pool-page-shared';
import { displayTokenSymbol} from '@/services/share-display';

/**
 * Always-visible action panel for a pool page — the pool-scoped cousin of the
 * home page's ActionHub (components/home/action-hub.tsx): pick an action, type
 * an amount, press the CTA and the matching modal opens pre-filled.
 *
 * Deliberately money-dumb: it owns NO transaction, proof, relay or submit
 * logic, and it does not open modals itself. Launching is the OWNER's job —
 * the page passes `onLaunch`, so every action reaches its modal through the
 * page's existing wallet-connect gate (`gated()` in pool-page-content.tsx,
 * hardened for Sui in bccccfd). There is deliberately no second path.
 */
export type PoolPanelAction = 'deposit' | 'withdraw' | 'transfer' | 'swap' | 'request';

type Tab = {
  key: PoolPanelAction;
  label: string;
  cta: string;
  hint: string;
  /** Spends the SHIELDED balance → percentage chips + the funded-action gate. */
  spendsPool: boolean;
  showAmount: boolean;
};

const TABS: readonly Tab[] = [
  { key: 'deposit', label: 'Deposit', cta: 'Review deposit', hint: 'Funds enter the pool and join the crowd.', spendsPool: false, showAmount: true },
  { key: 'withdraw', label: 'Withdraw', cta: 'Review withdrawal', hint: 'Exit to any address with a private proof.', spendsPool: true, showAmount: true },
  { key: 'transfer', label: 'Transfer', cta: 'Review transfer', hint: 'Move value inside the pool. No public trace.', spendsPool: true, showAmount: true },
  // Intent swaps: flag-gated (EXPO_PUBLIC_INTENT_SWAPS) AND EVM-only — the tab
  // is filtered out below by exactly the rule action-hub / my-privacy-pools
  // already use, never a second one.
  { key: 'swap', label: 'Swap', cta: 'Review swap', hint: 'Exit to a different token via a proof-bound route.', spendsPool: true, showAmount: true },
  { key: 'request', label: 'Request', cta: 'Create a request', hint: 'Share a link, get paid privately.', spendsPool: false, showAmount: false },
];

/** Quick-fill fractions of the spendable balance. 100 = MAX. */
const PERCENTS: readonly { label: string; value: number }[] = [
  { label: '25%', value: 25 },
  { label: '50%', value: 50 },
  { label: '75%', value: 75 },
  { label: 'MAX', value: 100 },
];

// On Sui the pool serves exactly one asset: native SUI in MIST (9 decimals).
// The EVM token registry has no entry for it (config/tokens.ts), which is why
// action-hub keeps a Sui-only token list — same reason, same constant.
const SUI_DECIMALS = 9;

// RN-web only style for stripping the browser focus ring; cast needed for
// React Native Web compatibility (web-only CSS property).

export function PoolActionPanel({
  poolToken,
  tokenPriceUsd,
  depositPriceUsd,
  depositSymbol,
  depositDecimals,
  actionsDisabled,
  narrow,
  onLaunch,
}: {
  /** The pool page's asset — the panel is single-asset by construction. */
  poolToken: string;
  /** USD price for ONE unit of the pool asset as the spend tabs denominate it (a share on a share pool). */
  tokenPriceUsd: number;
  /**
   * Deposit denomination when it differs from the pool asset: on a share pool a
   * deposit is paid in the UNDERLYING (USDC), so its preview prices and labels
   * the amount as USDC, not as ppUSDC (codex on 523ba00). Defaults to the pool asset.
   */
  depositPriceUsd?: number;
  depositSymbol?: string;
  depositDecimals?: number;
  /**
   * Stage-aware gate from services/action-gate.ts (fundedActionsDisabled):
   * nothing spendable → the pool-spending CTAs are inert. Same flag the page's
   * action bar consumes; never recomputed here.
   */
  actionsDisabled: boolean;
  /** Stacked (full-width) presentation instead of the 50/50 pair. */
  narrow: boolean;
  /**
   * Opens the action's modal. The OWNER supplies this so the launch keeps
   * running through the page's existing wallet-connect gate.
   */
  onLaunch: (action: PoolPanelAction, amount: string) => void;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { data, isLoading: poolsLoading } = usePools();
  const symbol = poolToken.toUpperCase();

  // Availability: the swap tab needs the flag AND a configured processor for
  // the chain the swap FLOW acts on — the app's active chain (the pool's
  // chain on this page), matching action-hub and the swap modal itself. It
  // briefly gated on useChainId() (the wagmi store), which advertised a tab
  // whose modal then ran on a different chain whenever store and selection
  // split. EVM-only either way.
  const { isSui: isSuiChain, isStellar, activeChainId } = useChainRouter();
  const isSui = isSuiChain || isStellar;
  const swapAvailable = intentSwapsEnabledForChain(activeChainId) && !isSui;
  // The Swap tab exists only when swaps can actually run here. The intent
  // LOCKDOWN hides it (config/intent-lockdown.ts); ?swap=true lifts it.
  const swapSurface = swapSurfaceEnabled();
  const tabs = useMemo(
    () => TABS.filter((t) => t.key !== 'swap' || (swapSurface && swapAvailable)),
    [swapSurface, swapAvailable],
  );

  const [requested, setRequested] = useState<PoolPanelAction>('deposit');
  // A tab that stops being available (swap flag flips, chain switches to Sui)
  // degrades to Deposit rather than leaving a selected-but-hidden tab.
  const action = tabs.some((t) => t.key === requested) ? requested : 'deposit';
  const active = TABS.find((t) => t.key === action)!;
  // What the typed amount IS on the active tab: the pool asset on spend tabs,
  // the underlying on Deposit (when the page says so).
  const amountSymbol = active.spendsPool ? symbol : (depositSymbol ?? symbol).toUpperCase();
  const amountPriceUsd = active.spendsPool ? tokenPriceUsd : (depositPriceUsd ?? tokenPriceUsd);

  const poolDecimals = isStellar
    ? 7
    : isSui
    ? SUI_DECIMALS
    : getTokenMetadataBySymbol(symbol, activeChainId)?.decimals ?? 18;
  // A Deposit on a share pool is typed in the UNDERLYING (6 for USDC, not the
  // share's 18): the deposit modal re-clamps the prefill at that precision, so
  // clamp here the same way or the panel accepts digits the modal drops.
  const decimals = active.spendsPool ? poolDecimals : (depositDecimals ?? poolDecimals);

  // Raw keystrokes as typed; everything downstream reads `amount`, the same
  // value re-clamped to the asset's CURRENT precision at read time. That keeps
  // the field at the asset's decimals if the resolved precision ever changes
  // (chain selection settling — over-precision input parses to 0n downstream)
  // without a setState-in-effect cascade.
  const [typedAmount, setTypedAmount] = useState('');
  const amount = sanitizeAmountInput(typedAmount, decimals);

  // Spendable = the provider's EXACT active balance for this asset (never the
  // rounded display value, never pending): the same field action-hub's
  // tap-to-max consumes. Not re-derived here.
  // Chain-matched: myPools spans chains now, and a symbol held only on
  // another chain would otherwise feed this form's max-fill (kimi review,
  // finding 2) — the proof can only spend the ACTIVE chain's notes.
  const pool = data.myPools.find((p) => sameSymbol(p.name, symbol) && p.chainId === activeChainId);
  const spendableExact = pool?.balanceTokenExact ?? '0';
  const balanceDisplay = useBalanceDisplay(activeChainId);
  const balanceView = balanceDisplay(spendableExact, symbol, activeChainId, pool?.tokenAddress);
  const amountField = useShareAmountField({ amount, symbol, chainId: activeChainId, maxSharesExact: spendableExact, capKnown: !poolsLoading, onAmountResolved: setTypedAmount, underlyingEntry: action === 'withdraw' || action === 'transfer' });

  /**
   * Fill the amount with a fraction of the spendable balance. Base-unit
   * integer math with floor division, so a quick-fill can NEVER exceed the
   * real balance, and the value still lands in state through the shared
   * sanitizer — no raw writes.
   */
  const fillPercent = (percent: number) => {
    const base = parseTokenAmount(spendableExact, decimals);
    // Nothing spendable → leave the field alone rather than typing a "0".
    if (base === 0n) return;
    const part = percent >= 100 ? base : (base * BigInt(percent)) / 100n;
    setTypedAmount(sanitizeAmountInput(formatUnits(part, decimals), decimals));
  };

  const amountNum = parseFloat(amount) || 0;
  const ctaDisabled = active.spendsPool && actionsDisabled;
  const TokenIcon = tokenIconFor(symbol);

  return (
    // 50/50 half in the pair, full width when stacked. Height comes from the
    // row (align-items: stretch) and from the body's floor below — never from
    // the selected tab.
    <Card noPadding className={narrow ? 'w-full' : 'flex-1'}>
      {/* Action tabs — one row, unavailable actions are absent, not disabled. */}
      <View className="flex-row gap-[4px] border-b border-b-border-light p-[8px]">
        {tabs.map((t) => {
          const selected = t.key === action;
          return (
            <Pressable
              key={t.key}
              onPress={() => setRequested(t.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              // Pressed/selected states are class-authored: a `style` FUNCTION
              // on a className'd Pressable is wrapped into an array by
              // css-interop and never invoked, which silently drops the fill.
              className={`flex-1 items-center justify-center rounded-control px-[2px] py-[8px] ${selected ? 'bg-button-primary' : 'bg-transparent active:bg-background-secondary'}`}
            >
              <Text
                numberOfLines={1}
                className={`text-[12px] leading-[16px] ${selected ? 'font-pp-semi-bold text-button-primary-text' : 'font-pp-medium text-text-secondary'}`}
              >
                {t.label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* CONSTANT-HEIGHT BODY. `min-h` is a floor above the tallest tab's
          content (every text block is line-capped, so that bound holds), and
          `grow` + `justify-center` absorb the slack. Vertically centred. So
          flipping tabs cannot change the card's height, and the card still
          stretches to its 50/50 partner instead of leaving dead space. */}
      <View className="grow justify-center gap-[12px] min-h-[300px] p-[16px]">
        <Text numberOfLines={2} className="text-center font-pp-regular text-[12px] leading-[16px] text-text-muted">
          {active.hint}
        </Text>

        {active.showAmount ? (
          <View className="gap-[8px] rounded-inner border border-border bg-background-secondary p-[14px]">
            <View className="flex-row items-center gap-[10px]">
              <TextInput
                value={active.spendsPool ? amountField.value : amount}
                onChangeText={(text) => setTypedAmount(sanitizeAmountInput(active.spendsPool ? amountField.toShares(text) : text, decimals))}
                placeholder="0"
                // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                placeholderTextColor={colors.textMuted}
                keyboardType="decimal-pad"
                accessibilityLabel={`Amount to ${action}`}
                className="min-w-0 flex-1 p-0 font-pp-bold text-[28px] leading-[34px] text-text"
                // nw-keep(platform-css): web-only focus-ring removal (outlineStyle) — null on native
                style={WEB_NO_OUTLINE}
              />
              {/* Token pill — the pool's asset, shown not chosen: a pool page
                  is single-asset, so there is nothing to switch. */}
              <View className="flex-row items-center gap-[6px] rounded-pill border border-border bg-card-background px-[10px] py-[5px]">
                <TokenIcon size={18} />
                <Text numberOfLines={1} className="font-pp-semi-bold text-[13px] text-text">
                  {active.spendsPool ? amountField.symbol : displayTokenSymbol(amountSymbol)}
                </Text>
              </View>
            </View>
            <View className="flex-row flex-wrap items-center justify-between gap-[8px]">
              <Text numberOfLines={1} className="font-pp-regular text-[11px] leading-[14px] text-text-muted">
                ${(active.spendsPool ? balanceDisplay(amount || '0', symbol, activeChainId).usd : amountNum * amountPriceUsd).toLocaleString('en-US', { maximumFractionDigits: 2 })}
              </Text>
              <Text numberOfLines={1} className="font-pp-regular text-[11px] leading-[14px] text-text-muted">
                {active.spendsPool
                  ? `Spendable: ${balanceView.text}`
                  : 'From your wallet balance'}
              </Text>
              {active.spendsPool ? <ShareCountHint hint={balanceView.hint} /> : null}
            </View>
          </View>
        ) : (
          <View className="gap-[6px] rounded-inner bg-background-secondary p-[14px]">
            <Text numberOfLines={1} className="font-pp-semi-bold text-[14px] leading-[18px] text-text">
              Request a private payment
            </Text>
            <Text numberOfLines={2} className="font-pp-regular text-[12px] leading-[17px] text-text-secondary">
              Share a payment link. Review identity details before sharing.
            </Text>
          </View>
        )}

        {/* Percentage quick-fill — only for the actions that spend the pool
            balance, which is the only max this page owns exactly. Deposits are
            capped by the WALLET balance; the deposit modal owns that number,
            so we don't fake a percentage of it here. */}
        {active.spendsPool && (
          <View className="flex-row gap-[8px]">
            {PERCENTS.map((p) => (
              <Pressable
                key={p.label}
                onPress={() => fillPercent(p.value)}
                accessibilityRole="button"
                accessibilityLabel={`Fill ${p.label} of the spendable balance`}
                className="flex-1 items-center justify-center rounded-control border border-border bg-card-background py-[7px] active:bg-background-secondary"
              >
                <Text numberOfLines={1} className="font-pp-medium text-[11px] leading-[14px] text-text-secondary">
                  {p.label}
                </Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* CTA — hands off to the owner's gated launcher. */}
        <Pressable
          onPress={() => onLaunch(action, amount)}
          disabled={ctaDisabled}
          accessibilityRole="button"
          className={`items-center justify-center rounded-inner bg-button-primary py-[13px] active:bg-button-primary-pressed ${ctaDisabled ? 'opacity-40' : 'opacity-100'}`}
        >
          <Text numberOfLines={1} className="font-pp-medium text-[15px] leading-[19px] text-center text-button-primary-text">
            {active.cta}
          </Text>
        </Pressable>

        {ctaDisabled ? (
          <Text numberOfLines={1} className="text-center font-pp-regular text-[11px] leading-[14px] text-text-muted">
            Nothing spendable yet. Deposit first.
          </Text>
        ) : null}
      </View>
    </Card>
  );
}
