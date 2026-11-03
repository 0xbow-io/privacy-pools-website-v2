import { useState, type ComponentProps, type ReactNode } from 'react';
import { Image, Platform, Pressable, ScrollView, Text, View, useWindowDimensions, type ImageSourcePropType } from 'react-native';
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';

import { useTabBarClearance } from '@/hooks/use-tab-bar-clearance';
import { Card } from '@/components/ui/card';
import { Footer } from '@/components/ui/footer';
import { Header } from '@/components/ui/header';
import { SUPPORT_TELEGRAM_URL } from '@/config/support';
import { ECOSYSTEM_PARTNERS, PARTNER_CATEGORIES, type EcosystemPartner, type PartnerCategory } from '@/config/ecosystem';

const SDK_QUICKSTART_URL = 'https://privacy-pools-v2-docs.vercel.app/introduction/quickstart';
const GITHUB_URL = 'https://github.com/0xbow-io/privacy-pools-v2-monorepo';

const PARTNER_LOGOS: Record<string, ImageSourcePropType> = {
  'kohaku-sdk': require('@/assets/images/ecosystem/kohaku-sdk.png'),
  // Official site favicon (https://casberi.app), rasterized locally for native Image.
  casberi: require('@/assets/images/ecosystem/casberi.png'),
  // Official touch icon: https://nymis.io/apple-touch-icon.png
  nymis: require('@/assets/images/ecosystem/nymis.png'),
  brevis: require('@/assets/images/ecosystem/brevis.png'),
  ambire: require('@/assets/images/ecosystem/ambire.png'),
  cloaked: require('@/assets/images/ecosystem/cloaked.png'),
  'veil-cash': require('@/assets/images/ecosystem/veil-cash.png'),
  zfi: require('@/assets/images/ecosystem/zfi.png'),
  'shielded-eth': require('@/assets/images/ecosystem/shielded-eth.png'),
  wenwithdraw: require('@/assets/images/ecosystem/wenwithdraw.png'),
  'defillama-privacy': require('@/assets/images/ecosystem/defillama-privacy.png'),
};

// Keep real anchors on web: open-in-new-tab, copy-link and keyboard navigation
// should work just as they do elsewhere on the site.
function ExternalLink({ href, children, ...props }: Omit<ComponentProps<typeof Pressable>, 'children'> & { href: string; children: ReactNode }) {
  const linkProps = Platform.OS === 'web'
    ? { href, hrefAttrs: { target: '_blank', rel: 'noopener noreferrer' } }
    : { onPress: () => { void openBrowserAsync(href, { presentationStyle: WebBrowserPresentationStyle.AUTOMATIC }); } };
  return <Pressable accessibilityRole="link" {...linkProps} {...props}>{children}</Pressable>;
}

function ExternalArrow({ primary = false }: { primary?: boolean }) {
  return (
    <Text aria-hidden={true} accessible={false} className={`ecosystem-arrow w-[18px] shrink-0 text-center font-pp-sans-medium text-[15px] leading-[20px] ${primary ? 'text-button-primary-text' : 'text-text-secondary'}`}>
      ↗
    </Text>
  );
}

export default function EcosystemScreen() {
  const tabClearance = useTabBarClearance();
  const { width } = useWindowDimensions();
  const compact = width < 700;

  return (
    <View className="flex-1 bg-background">
      <Header />
      <ScrollView className="flex-1" contentContainerClassName="grow px-[20px]"
        // nw-keep(measured-or-inset): clearance for the shared floating bottom bar.
        contentContainerStyle={{ paddingBottom: 20 + tabClearance }}
      >
        <View className="mx-auto w-full max-w-[1100px] grow" testID="ecosystem-page">
          <View className={compact ? 'gap-[16px] pb-[36px] pt-[36px]' : 'gap-[20px] pb-[48px] pt-[56px]'}>
            <Text role="heading" aria-level={1} className={`font-pp-sans-medium text-text ${compact ? 'text-[34px] leading-[40px] tracking-[-1px]' : 'text-[48px] leading-[54px] tracking-[-1.5px]'}`}>
              Building on Privacy Pools
            </Text>
            <Text className="max-w-[600px] font-pp-sans text-[17px] leading-[28px] text-text-secondary">
              Wallets, apps, and tools bringing Privacy Pools to more people.
            </Text>
            <ExternalLink href={SDK_QUICKSTART_URL} testID="ecosystem-hero-docs" className="ecosystem-control active:opacity-80 self-start min-h-[44px] flex-row items-center gap-[10px] rounded-pill bg-button-primary px-[20px] py-[12px]">
              <Text className="font-pp-sans-medium text-[14px] text-button-primary-text">Read the SDK docs</Text>
              <ExternalArrow primary />
            </ExternalLink>
          </View>
          <PartnersSection />
          <Card className="my-[48px]">
            <View className={`gap-[24px] ${width < 1040 ? '' : 'flex-row items-center justify-between'}`}>
              <View className="min-w-0 flex-1 gap-[10px]">
                <Text role="heading" aria-level={2} className="font-pp-sans-medium text-[26px] leading-[34px] tracking-[-0.5px] text-text">Build with Privacy Pools</Text>
                <Text className="max-w-[520px] font-pp-sans text-[15px] leading-[24px] text-text-secondary">Bring privacy to your product with our open-source SDK.</Text>
              </View>
              <View className="flex-row flex-wrap items-center gap-[12px]">
                <ExternalLink href={SDK_QUICKSTART_URL} className="ecosystem-control active:opacity-80 min-h-[44px] flex-row items-center gap-[10px] rounded-pill bg-button-primary px-[20px] py-[12px]">
                  <Text className="font-pp-sans-medium text-[14px] text-button-primary-text">Explore the SDK</Text>
                  <ExternalArrow primary />
                </ExternalLink>
                <ExternalLink href={GITHUB_URL} className="ecosystem-control active:opacity-80 min-h-[44px] flex-row items-center gap-[10px] rounded-pill border border-border px-[16px] py-[12px] hover:bg-background-secondary">
                  <Text className="font-pp-sans-medium text-[14px] text-text">View on GitHub</Text>
                  <ExternalArrow />
                </ExternalLink>
                <ExternalLink href={SUPPORT_TELEGRAM_URL} className="ecosystem-control active:opacity-80 min-h-[44px] flex-row items-center gap-[10px] rounded-pill border border-border px-[16px] py-[12px] hover:bg-background-secondary">
                  <Text className="font-pp-sans-medium text-[14px] text-text">Join Telegram</Text>
                  <ExternalArrow />
                </ExternalLink>
              </View>
            </View>
          </Card>
          {Platform.OS === 'web' && <Footer />}
        </View>
      </ScrollView>
      {Platform.OS !== 'web' && <View className="px-[20px] pb-[20px]"><Footer /></View>}
    </View>
  );
}

function PartnersSection() {
  const [activeCategory, setActiveCategory] = useState<PartnerCategory | 'all'>('all');
  const { width } = useWindowDimensions();
  const [containerWidth, setContainerWidth] = useState(Math.min(width - 40, 1100));
  const twoColumns = containerWidth >= 660;
  const partners = ECOSYSTEM_PARTNERS.filter((partner) => activeCategory === 'all' || partner.categories.includes(activeCategory));

  return (
    <View className="gap-[24px]">
      <View role="group" accessibilityLabel="Filter projects by category" className="flex-row flex-wrap gap-[8px]">
        {PARTNER_CATEGORIES.map((category) => {
          const selected = activeCategory === category.value;
          return (
            <Pressable key={category.value} accessibilityRole="button" accessibilityState={{ selected }} aria-pressed={selected}
              onPress={() => setActiveCategory(category.value)}
              className="ecosystem-control group active:opacity-80 min-h-[44px] justify-center rounded-pill py-[6px]"
            >
              <View testID={`ecosystem-filter-pill-${category.value}`} className={`min-h-[32px] items-center justify-center rounded-pill px-[14px] py-[6px] ${selected ? 'bg-button-primary' : 'bg-background-secondary group-hover:bg-border-light'}`}>
                <Text className={`font-pp-sans-medium text-[13px] leading-[20px] ${selected ? 'text-button-primary-text' : 'text-text-secondary'}`}>{category.label}</Text>
              </View>
            </Pressable>
          );
        })}
      </View>
      {/* Row-major source order stays the keyboard and screen-reader order.
          Cards stretch to their row, but never clamp their descriptions. */}
      <View className="flex-row flex-wrap items-stretch gap-[16px]" testID="ecosystem-grid" onLayout={(event) => setContainerWidth(event.nativeEvent.layout.width)}>
        {partners.map((partner) => {
          const featured = activeCategory === 'all' && !!partner.featured;
          return (
            <View key={partner.slug} className="min-w-0"
              // nw-keep(measured-or-inset): two equal columns with one 16px gutter; featured projects span the unfiltered grid.
              style={{ width: twoColumns && !featured ? (containerWidth - 16) / 2 : '100%' }}
            >
              <PartnerCard partner={partner} featured={featured} wide={containerWidth >= 860 && featured} />
            </View>
          );
        })}
      </View>
    </View>
  );
}

function PartnerLogo({ partner, size }: { partner: EcosystemPartner; size: number }) {
  const logo = PARTNER_LOGOS[partner.slug];
  return (
    <View className="shrink-0 items-center justify-center overflow-hidden rounded-control border border-border-light bg-background-secondary"
      testID={`ecosystem-logo-${partner.slug}`}
      // nw-keep(measured-or-inset): featured logos grow only in the unfiltered directory.
      style={{ width: size, height: size }}
    >
      {logo ? (
        // nw-keep(measured-or-inset): RN-Web Image requires explicit image dimensions.
        <Image source={logo} style={{ width: size, height: size }} resizeMode="contain" accessible={false} />
      ) : (
        <Text className="font-pp-sans-medium text-[22px] text-text">{partner.logoText}</Text>
      )}
    </View>
  );
}

function PartnerCard({ partner, featured, wide }: { partner: EcosystemPartner; featured: boolean; wide: boolean }) {
  const categories = partner.categories.map((value) => PARTNER_CATEGORIES.find((category) => category.value === value)?.label).filter(Boolean);
  const identity = (
    <Text role="heading" aria-level={2} className={`min-w-0 flex-1 font-pp-sans-medium text-text ${featured ? 'text-[20px] leading-[28px]' : 'text-[18px] leading-[24px]'}`}>{partner.name}</Text>
  );
  return (
    <ExternalLink href={partner.url} accessibilityLabel={`Visit ${partner.name}${Platform.OS === 'web' ? ' (opens in a new tab)' : ''}`}
      testID={`ecosystem-project-${partner.slug}`}
      className="ecosystem-project active:opacity-80 flex-1 rounded-card"
    >
      <Card className="flex-1">
        <View className={wide ? 'flex-row items-start gap-[24px]' : 'gap-[20px] flex-1'}>
          {wide ? <PartnerLogo partner={partner} size={80} /> : (
            <View className="flex-row items-center gap-[16px]">
              <PartnerLogo partner={partner} size={featured ? 80 : 56} />
              {identity}
              <ExternalArrow />
            </View>
          )}
          <View className={`min-w-0 flex-1 ${wide ? 'gap-[12px]' : 'gap-[20px]'}`}>
            {wide && identity}
            <Text className="font-pp-sans text-[15px] leading-[24px] text-text-secondary">{partner.description}</Text>
            <View className="mt-auto flex-row flex-wrap gap-[6px]">
                {categories.map((category) => (
                  <View key={category} className="rounded-pill bg-background-secondary px-[10px] py-[4px]">
                    <Text className="font-pp-sans-medium text-[12px] leading-[18px] text-text-secondary">{category}</Text>
                  </View>
                ))}
            </View>
          </View>
          {wide && <ExternalArrow />}
        </View>
      </Card>
    </ExternalLink>
  );
}
