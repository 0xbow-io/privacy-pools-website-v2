import { View, Text, Image } from 'react-native';
import Svg, { Path, Circle } from 'react-native-svg';
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
            ? 'items-center justify-center overflow-hidden bg-[#4DA2FF]'
            : isOptimism
              ? 'items-center justify-center overflow-hidden bg-[#FF0421]'
              : 'items-center justify-center overflow-hidden bg-[#627EEA]'
        }
        // nw-keep(svg-or-canvas): prop-driven geometry for the brand circle (size prop)
        // nw-keep(data-color): fixed brand backgrounds stay independent of the app theme.
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          ...(isCitrea ? { backgroundColor: '#FFFFFF' } : {}),
          // Same runtime-style reason as Citrea above: a newly introduced
          // bg-[#F0B90B] class is absent from the generated CSS until Tailwind
          // regenerates, which renders the chip transparent.
          ...(isBnb ? { backgroundColor: '#F0B90B' } : {}),
          // Inset the complete blue square within a white circular chip.
          ...(isBase ? { backgroundColor: '#FFFFFF' } : {}),
          // These assets supply their own backgrounds and silhouettes.
          ...(isArbitrum ? { backgroundColor: 'transparent' } : {}),
          ...(isRobinhood ? { backgroundColor: 'transparent' } : {}),
          // Stellar's mark is black-on-white in its own brand; a near-black
          // chip keeps the white mark legible in both themes.
          ...(isStellar ? { backgroundColor: '#0F0F0F' } : {}),
        }}
      >
        {isSui ? (
          <SuiIcon width={size * 0.5} height={size * 0.62} color="#FFFFFF" />
        ) : isOptimism ? (
          // Official OP Mainnet mark: https://optimism.io/brand (not the OP token).
          <Svg width={size} height={size} viewBox="0 0 1024 1024">
            <Circle cx={512} cy={512} r={512} fill="#FF0421" />
            <Path d="M512.337 60C709.109 60 868.674 219.564 868.674 416.336C868.674 613.11 709.109 772.676 512.337 772.676V963.972C315.563 963.972 156 804.406 156 607.635C156 410.861 315.563 251.298 512.337 251.298V60ZM510.686 335.693C471.976 413.412 413.762 471.624 336.043 510.334V513.637C413.762 552.346 471.976 610.558 510.686 688.277H513.988C552.695 610.558 610.91 552.346 688.629 513.637V510.334C610.91 471.624 552.695 413.412 513.988 335.693H510.686Z" fill="#FAFAF9" />
          </Svg>
        ) : isCitrea ? (
          <CitreaIcon width={size * 0.94} height={size * 0.94} />
        ) : isBnb ? (
          <BnbIcon width={size * 0.72} height={size * 0.72} />
        ) : isStellar ? (
          <StellarIcon width={size * 0.6} height={size * 0.51} color="#FFFFFF" />
        ) : isArbitrum ? (
          // Official Arbitrum full-color icon.
          <ArbitrumIcon width={size} height={size} />
        ) : isRobinhood ? (
          // Official compact avatar: https://docs.robinhood.com/chain/brand-guidelines/
          <Image
            source={require('@/assets/images/chains/robinhood.png')}
            accessibilityIgnoresInvertColors
            resizeMode="contain"
            // nw-keep(svg-or-canvas): scale the avatar within the circular chip.
            style={{ width: size, height: size }}
          />
        ) : isBase ? (
          // Official blue square: https://github.com/base/brand-kit/blob/eba9e730be34f8c9ae7f9a21f32cc6aafebe2ad1/logo/TheSquare/Digital/Base_square_blue.svg
          <Svg width={size * 0.6} height={size * 0.6} viewBox="0 0 1280 1280">
            <Path d="M0,101.12c0-34.64,0-51.95,6.53-65.28,6.25-12.76,16.56-23.07,29.32-29.32C49.17,0,66.48,0,101.12,0h1077.76c34.63,0,51.96,0,65.28,6.53,12.75,6.25,23.06,16.56,29.32,29.32,6.52,13.32,6.52,30.64,6.52,65.28v1077.76c0,34.63,0,51.96-6.52,65.28-6.26,12.75-16.57,23.06-29.32,29.32-13.32,6.52-30.65,6.52-65.28,6.52H101.12c-34.64,0-51.95,0-65.28-6.52-12.76-6.26-23.07-16.57-29.32-29.32-6.53-13.32-6.53-30.65-6.53-65.28V101.12Z" fill="#0000FF" />
          </Svg>
        ) : (
          <EthereumIcon width={size * 0.56} height={size * 0.56} />
        )}
      </View>
      {isTestnet && testnetLabel && <TestnetPill size={size} />}
    </View>
  );
}
