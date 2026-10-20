import { View, Text } from 'react-native';
import { EthereumIcon } from './ethereum-icon';
import { isTestnetChain, STELLAR_TESTNET_ID, SUI_TESTNET_ID } from '@/config/chains';
import { SuiIcon } from './sui-icon';
import { StellarIcon } from './stellar-icon';
import { CitreaIcon } from './citrea-icon';
import { BnbIcon } from './bnb-icon';
import { ArbitrumIcon } from './arbitrum-icon';

export type ChainLogoChain = 'ethereum' | 'sepolia' | 'sui-testnet' | 'stellar-testnet' | 'optimism' | 'citrea' | 'bnb' | 'base' | 'arbitrum' | 'robinhood';

/**
 * Map a numeric chain id onto the logo variant, testnet-ness included — so a
 * caller can never render Sepolia as bare Ethereum by forgetting the check.
 */
export function chainLogoChainFor(chainId: number): ChainLogoChain {
  if (chainId === SUI_TESTNET_ID) return 'sui-testnet';
  if (chainId === STELLAR_TESTNET_ID) return 'stellar-testnet';
  if (chainId === 10) return 'optimism';
  // Citrea (a Bitcoin L2, native cBTC) is its own mark: falling through to
  // 'ethereum' put the Ethereum logo next to Ethereum's own row in the chain
  // filter, with nothing to tell them apart (QA 2026-08-18).
  if (chainId === 4114) return 'citrea';
  // BNB Chain, same reasoning as Citrea: it is not an Ethereum-branded network
  // and its native asset is BNB, so falling through to 'ethereum' put the
  // Ethereum mark on every BNB row in the network selector (Pat, 2026-08-28).
  if (chainId === 56) return 'bnb';
  if (chainId === 8453) return 'base';
  if (chainId === 42161) return 'arbitrum';
  if (chainId === 4663) return 'robinhood';
  return isTestnetChain(chainId) ? 'sepolia' : 'ethereum';
}

type ChainLogoProps = {
  chain: ChainLogoChain;
  size?: number;
  /**
   * Draw the testnet watermark. A caller that draws its own (ChainBadge,
   * which also honours testnetLabel={false}) turns this off so the pill is
   * never doubled.
   */
  testnetLabel?: boolean;
};

/**
 * The yellow "testnet" watermark every test-network visual carries, exported
 * so token/asset icons (TokenNetworkIcon's ChainBadge, the tx table's
 * AssetChainMark) render the SAME label as the network selector — a Sepolia
 * row must never read as plain Ethereum.
 */
export function TestnetPill({ size }: { size: number }) {
  const badgeFont = Math.max(6, Math.round(size * 0.34));
  return (
    <Text
      numberOfLines={1}
      className="absolute -bottom-[4px] -right-[8px] overflow-hidden rounded-[3px] bg-[#F4B740] px-[2px] font-pp-medium text-[#1a1a1a]"
      // nw-keep(svg-or-canvas): badge type scales with the size prop (fontSize/lineHeight derived at runtime)
      style={{
        fontSize: badgeFont,
        lineHeight: badgeFont + 2,
      }}
    >
      testnet
    </Text>
  );
}

/**
 * Chain logo chip: Ethereum / Sui mark in a brand-colored circle, with a
 * "testnet" watermark bottom-right for test networks (Sepolia, Sui Testnet).
 */
export function ChainLogo({ chain, size = 18, testnetLabel = true }: ChainLogoProps) {
  const isSui = chain === 'sui-testnet';
  const isStellar = chain === 'stellar-testnet';
  const isOptimism = chain === 'optimism';
  const isCitrea = chain === 'citrea';
  const isBnb = chain === 'bnb';
  const isBase = chain === 'base';
  const isArbitrum = chain === 'arbitrum';
  const isRobinhood = chain === 'robinhood';
  // Mainnets carry no badge; Optimism is a mainnet (the staging intents
  // deployment), so `!== 'ethereum'` would have mislabelled it "testnet".
  const isTestnet = chain === 'sepolia' || chain === 'sui-testnet' || chain === 'stellar-testnet';
  return (
    <View
      // nw-keep(svg-or-canvas): prop-driven geometry — the size prop scales the chip around the SVG chain mark
      style={{ width: size, height: size }}
    >
      <View
        className={
          isSui
            ? 'items-center justify-center bg-[#4DA2FF]'
            : isOptimism
              ? 'items-center justify-center bg-[#FF0420]'
              : 'items-center justify-center bg-[#627EEA]'
        }
        // nw-keep(svg-or-canvas): prop-driven geometry for the brand circle (size prop)
        // nw-keep(data-color): Citrea's brand fill rides a runtime style, not a
        // bg-[#F7931A] class — a NEWLY introduced arbitrary color class is
        // absent from the generated CSS until Tailwind regenerates, which
        // rendered the chip transparent (white mark on a white page = an empty
        // row in the chain filter).
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          ...(isCitrea ? { backgroundColor: '#F7931A' } : {}),
          // Same runtime-style reason as Citrea above: a newly introduced
          // bg-[#F0B90B] class is absent from the generated CSS until Tailwind
          // regenerates, which renders the chip transparent.
          ...(isBnb ? { backgroundColor: '#F0B90B' } : {}),
          // Base blue, runtime style for the same reason.
          ...(isBase ? { backgroundColor: '#0052FF' } : {}),
          // The Arbitrum logo is its own navy hexagon, so the chip goes clear
          // behind it. Robinhood near-black, runtime style for the same reason.
          ...(isArbitrum ? { backgroundColor: 'transparent' } : {}),
          ...(isRobinhood ? { backgroundColor: '#0F0F0F' } : {}),
          // Stellar's mark is black-on-white in its own brand; a near-black
          // chip keeps the white mark legible in both themes.
          ...(isStellar ? { backgroundColor: '#0F0F0F' } : {}),
        }}
      >
        {isSui ? (
          <SuiIcon width={size * 0.5} height={size * 0.62} color="#FFFFFF" />
        ) : isOptimism ? (
          // The OP mark is a white wordmark on the brand red — text renders it
          // faithfully at chip sizes without a new SVG asset.
          <Text
            numberOfLines={1}
            className="font-pp-medium text-white"
            // nw-keep(svg-or-canvas): glyph type scales with the size prop
            style={{ fontSize: Math.max(6, Math.round(size * 0.4)), lineHeight: size }}
          >
            OP
          </Text>
        ) : isCitrea ? (
          <CitreaIcon width={size * 0.72} height={size * 0.72} color="#FFFFFF" />
        ) : isBnb ? (
          <BnbIcon width={size * 0.72} height={size * 0.72} color="#FFFFFF" />
        ) : isStellar ? (
          <StellarIcon width={size * 0.6} height={size * 0.51} color="#FFFFFF" />
        ) : isArbitrum ? (
          // Official Arbitrum One logo (arbiscan.io/brandassets), full colour.
          <ArbitrumIcon width={size} height={size} />
        ) : isRobinhood ? (
          // Text mark, like OP: legible at chip sizes without a new SVG asset.
          <Text
            numberOfLines={1}
            className="font-pp-medium"
            // nw-keep(svg-or-canvas): glyph type scales with the size prop; brand
            // colour rides a runtime style (see the chip background above)
            style={{
              fontSize: Math.max(5, Math.round(size * 0.4)),
              lineHeight: size,
              color: '#CCFF00',
            }}
          >
            RH
          </Text>
        ) : isBase ? (
          // The Base mark is a white square on the brand blue.
          <View
            // nw-keep(svg-or-canvas): glyph geometry scales with the size prop
            style={{ width: size * 0.42, height: size * 0.42, borderRadius: size * 0.06, backgroundColor: '#FFFFFF' }}
          />
        ) : (
          <EthereumIcon width={size * 0.56} height={size * 0.56} />
        )}
      </View>
      {isTestnet && testnetLabel && <TestnetPill size={size} />}
    </View>
  );
}
