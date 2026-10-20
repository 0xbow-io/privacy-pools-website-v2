import { View, Text, Pressable, Platform } from 'react-native';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';
import { useBackHandler } from '@/hooks/use-back-handler';

const WEB_OVERLAY_POSITION = Platform.select({ web: { position: 'fixed' }, default: { position: 'absolute' } }) as Record<string, string>;
import Ionicons from '@expo/vector-icons/Ionicons';
// One resolver for every chain mark (network selector, token badge, this).
// The hand-drawn per-chain SVGs that used to live here were unreachable: the
// options list hardcoded EthIcon for all of them.
import { ChainLogo, chainLogoChainFor } from '@/components/ui/chain-logo';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { getChainConfig, supportedEvmChainIds } from '@/config/chains';

type ChainOption = {
  id: string;
  name: string;
  /** Numeric chain id, so the mark can be resolved the same way everywhere. */
  chainId: number;
  icon: (props: { size?: number }) => React.JSX.Element;
  circleColor: string;
};

/** Brand tint per chain slug; anything unlisted falls back to the ETH blue. */
const CHAIN_CIRCLE_COLORS: Record<string, string> = {
  ethereum: '#627EEA',
  sepolia: '#627EEA',
  citrea: '#F7931A',
};

/**
 * Derived from the build's ACTUAL chain set, not hardcoded. This was a
 * one-entry literal (sepolia or eth), so the staging build — which serves
 * mainnet + Citrea + Sepolia — offered a single chain in the pool-page and
 * balances dropdowns, and a Citrea pool showed "Sepolia" as its only option.
 *
 * `id` stays the chain's `name` slug because that is what the pool routes are
 * built from (getPoolDetailPath → /chains/<name>/<symbol>).
 */
export const CHAIN_OPTIONS: ChainOption[] = supportedEvmChainIds
  .map((chainId) => getChainConfig(chainId))
  .filter((chain): chain is NonNullable<typeof chain> => !!chain)
  .map((chain) => ({
    id: chain.name.toLowerCase(),
    name: chain.displayName,
    chainId: chain.id,
    // Every chain used to get EthIcon verbatim, so the pool page's "Select
    // Chain" row rendered five identical Ethereum diamonds (Artem, QA
    // 2026-08-28) — the same wrong-logo family as the network selector and the
    // token chain badge, in a third place. One resolver for all of them.
    icon: ({ size = 16 }: { size?: number }) => (
      <ChainLogo chain={chainLogoChainFor(chain.id)} size={size} />
    ),
    circleColor: CHAIN_CIRCLE_COLORS[chain.name.toLowerCase()] ?? '#627EEA',
  }));

type ChainSelectorProps = {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  selectedChain: string;
  onSelectChain: (chainId: string) => void;
  /** Subset of CHAIN_OPTIONS to show. Defaults to all. */
  chains?: ChainOption[];
};

export function ChainSelector({ open, onToggle, onClose, selectedChain, onSelectChain, chains }: ChainSelectorProps) {
  useBackHandler(open, onClose);
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];

  const visibleChains = chains ?? CHAIN_OPTIONS;
  const activeChain = visibleChains.find((c) => c.id === selectedChain) || visibleChains[0];

  return (
    <View className="relative z-[99999] overflow-visible">
      <Pressable
        className="h-[28px] w-[28px] items-center justify-center rounded-[4px] border border-[#DCDEDF] bg-[#FFFFFF]"
        onPress={onToggle}
        accessibilityRole="button"
        accessibilityLabel={`Select chain, current ${activeChain.name}`}
      >
        {/* The CLOSED trigger showed Ethereum's mark for every chain too, so a
            Citrea or BNB pool page displayed an Ethereum button until you
            opened the dropdown. Its own chain's mark, same resolver. */}
        <activeChain.icon size={18} />
      </Pressable>
      {open && (
        <>
          <Pressable
            className="inset-0 z-[9998]"
            // nw-keep(platform-css): fixed-on-web / absolute-on-native overlay position (no className path)
            style={WEB_OVERLAY_POSITION}
            onPress={onClose}
          />
          <View
            className="absolute right-0 top-[28px] z-[99999] min-w-[165px] rounded-card border border-border-light bg-menu-background p-[6px]"
            // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
            style={DROPDOWN_SHADOW}
          >
            {visibleChains.map((chain) => (
              <Pressable
                key={chain.id}
                className="flex-row items-center gap-[10px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                onPress={() => {
                  onSelectChain(chain.id);
                  onClose();
                }}
              >
                <chain.icon size={18} />
                <Text className="font-pp-regular text-[14px] text-text">
                  {chain.name}
                </Text>
                {chain.id === selectedChain && (
                  // nw-keep(data-color): checkmark glyph color (theme token) into the vector-icon sink
                  // nw-keep(third-party-style-api): margin-left auto positioning on the vector-icon (no className path)
                  <Ionicons name="checkmark" size={14} color={colors.text} style={{ marginLeft: 'auto' }} />
                )}
              </Pressable>
            ))}
          </View>
        </>
      )}
    </View>
  );
}
