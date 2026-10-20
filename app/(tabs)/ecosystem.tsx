import { useMemo, useState, type ReactNode } from 'react';
import { SUPPORT_TELEGRAM_URL } from '@/config/support';
import {
  Image,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
  type ImageSourcePropType,
} from 'react-native';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import Ionicons from '@expo/vector-icons/Ionicons';
import { openBrowserAsync, WebBrowserPresentationStyle } from 'expo-web-browser';

import { Footer } from '@/components/ui/footer';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';
import { Header } from '@/components/ui/header';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import {
  ECOSYSTEM_PARTNERS,
  PARTNER_CATEGORIES,
  type EcosystemPartner,
  type PartnerCategory,
  type PartnerStatus,
} from '@/config/ecosystem';

const CATEGORY_COLORS: Record<'light' | 'dark', Record<PartnerCategory, string>> = {
  // defi is the cyan brand hue: deep on the light canvas (legible as text),
  // bright on the dark one.
  light: {
    wallet: '#5bc0de',
    defi: '#006877',
    privacy: '#9B59B6',
    sdk: '#4D4D4D',
    analytics: '#3B82F6',
    payments: '#BA6B5D',
    tools: '#f4b740',
    infrastructure: '#2E8B8B',
  },
  dark: {
    wallet: '#5bc0de',
    defi: '#00ACC4',
    privacy: '#9B59B6',
    sdk: '#4D4D4D',
    analytics: '#3B82F6',
    payments: '#BA6B5D',
    tools: '#f4b740',
    infrastructure: '#2E8B8B',
  },
};

function statusBadge(status: PartnerStatus, colors: (typeof Colors)['light']): { bg: string; color: string; label: string } {
  switch (status) {
    case 'live':
      return { bg: colors.successBg, color: colors.success, label: 'Live' };
    case 'building':
      return { bg: colors.warningBg, color: colors.warning, label: 'Building' };
    default:
      return { bg: colors.backgroundSecondary, color: colors.textSecondary, label: 'Announced' };
  }
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function openExternal(url: string) {
  if (Platform.OS === 'web') {
    if (typeof window !== 'undefined') {
      window.open(url, '_blank', 'noopener,noreferrer');
    } else {
      Linking.openURL(url);
    }
  } else {
    openBrowserAsync(url, { presentationStyle: WebBrowserPresentationStyle.AUTOMATIC });
  }
}

// Lightweight masonry: distribute items across N independent columns so cards
// of different heights pack tightly instead of leaving the row-aligned gaps a
// flex-wrap grid produces. Round-robin keeps the visual reading order (the
// first items stay top-left). The RN equivalent of the CSS multi-column trick.
function MasonryGrid<T,>({
  items,
  columns,
  gap,
  keyOf,
  renderItem,
}: {
  items: T[];
  columns: number;
  gap: number;
  keyOf: (item: T) => string;
  renderItem: (item: T) => ReactNode;
}) {
  const cols: T[][] = Array.from({ length: columns }, () => []);
  items.forEach((item, i) => cols[i % columns].push(item));
  return (
    // nw-keep(measured-or-inset): column gap is the caller's runtime layout metric
    <View className="flex-row items-start" style={{ gap }}>
      {cols.map((colItems, ci) => (
        // nw-keep(measured-or-inset): per-column gap is the caller's runtime layout metric
        <View key={`col-${ci}`} className="flex-1" style={{ gap }}>
          {colItems.map((item) => (
            <View key={keyOf(item)}>{renderItem(item)}</View>
          ))}
        </View>
      ))}
    </View>
  );
}

export default function EcosystemScreen() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];

  return (
    <View className="flex-1 bg-background">
      <Header />
      <ScrollView className="flex-1" contentContainerClassName="grow pt-[20px] pb-[20px] px-[20px]">
        <View className="mx-auto w-full max-w-[1100px] grow gap-[32px]">
          <Hero />
          <PartnersSection />
          <BottomCTA />
          {Platform.OS === 'web' && <Footer />}
        </View>
      </ScrollView>
      {Platform.OS !== 'web' && (
        <View>
          <Footer />
        </View>
      )}
    </View>
  );
}

function Hero() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];

  return (
    <View className="pt-[48px] pb-[40px] border-b border-b-border-light">
      <Text className="mb-[16px] text-[11px] tracking-[2px] text-text-secondary font-pp-semi-bold">
        ECOSYSTEM
      </Text>
      <Text className="mb-[16px] text-[36px] leading-[42px] tracking-[-1px] text-text font-pp-bold">
        Building on{'\n'}Privacy Pools
      </Text>
      <Text className="mb-[32px] max-w-[640px] text-[15px] leading-[24px] text-text-secondary font-pp-regular">
        Discover projects integrating compliant privacy into their products, and build your own on
        the same SDK.
      </Text>
      <View className="flex-row flex-wrap gap-[12px]">
        <Pressable
          onPress={() => openExternal('https://privacy-pools-v2-docs.vercel.app/introduction/quickstart.html')}
          className="flex-row items-center gap-[8px] rounded-control border border-button-primary bg-button-primary px-[24px] py-[12px]"
        >
          <Text className="text-[13px] text-button-primary-text font-pp-semi-bold">
            Integrate with Privacy Pools
          </Text>
          {/* nw-keep(data-color): CTA glyph color is the scheme-resolved buttonPrimaryText token fed to the vector-icon sink */}
          <Ionicons name="arrow-forward" size={12} color={colors.buttonPrimaryText} />
        </Pressable>
        <Pressable
          onPress={() => openExternal('https://privacy-pools-v2-docs.vercel.app/introduction/quickstart.html')}
          className="flex-row items-center gap-[8px] rounded-control border border-text bg-transparent px-[24px] py-[12px]"
        >
          <Text className="text-[13px] text-text font-pp-semi-bold">
            Read the SDK Docs
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

function PartnersSection() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  // Two-up only when each card can actually afford it. A partner card is a
  // 176px logo square beside its text, so at tablet widths (iPad mini portrait
  // is 768) half the row leaves ~180px for the words and every title
  // truncates. One readable column beats two clipped ones.
  const cols = width < 900 ? 1 : 2;
  const [activeCategory, setActiveCategory] = useState<PartnerCategory | 'all'>('all');
  const [catMoreOpen, setCatMoreOpen] = useState(false);
  // Below this width the full category row doesn't fit, so the secondary
  // categories (SDK onward) collapse into a "More" dropdown.
  const catCompact = width < 768;
  const primaryCats = catCompact ? PARTNER_CATEGORIES.slice(0, 4) : PARTNER_CATEGORIES;
  const overflowCats = catCompact ? PARTNER_CATEGORIES.slice(4) : [];
  const catMoreActive = overflowCats.some((c) => c.value === activeCategory);

  const filteredPartners = useMemo(() => {
    if (activeCategory === 'all') return ECOSYSTEM_PARTNERS;
    return ECOSYSTEM_PARTNERS.filter((p) => p.categories.includes(activeCategory));
  }, [activeCategory]);

  // Featured partnerships (e.g. the Ethereum Foundation's Kohaku SDK) render
  // full-width and first; the rest flow into the masonry grid below.
  const featuredPartners = useMemo(
    () => filteredPartners.filter((p) => p.featured),
    [filteredPartners],
  );
  const restPartners = useMemo(
    () => filteredPartners.filter((p) => !p.featured),
    [filteredPartners],
  );

  return (
    <View className="w-full">
      <View className="w-full flex-row flex-wrap items-center justify-between gap-[16px] pt-[32px] pb-[20px]">
        <View className="flex-row items-center gap-[8px]">
          <Text className="text-[18px] text-text font-pp-bold">
            Ecosystem Partners
          </Text>
          <Text className="text-[12px] text-text-secondary font-pp-bold">
            ({filteredPartners.length})
          </Text>
        </View>
        <View className="z-[20] flex-row flex-wrap gap-[8px]">
          {primaryCats.map((cat) => {
            const active = activeCategory === cat.value;
            return (
              <Pressable
                key={cat.value}
                onPress={() => { setCatMoreOpen(false); setActiveCategory(cat.value); }}
                className={`rounded-pill border px-[14px] py-[6px] ${active ? 'border-text bg-text' : 'border-border-light bg-transparent'}`}
              >
                <Text
                  className={`text-[12px] ${active ? 'text-background font-pp-semi-bold' : 'text-text-secondary font-pp-medium'}`}
                >
                  {cat.label}
                </Text>
              </Pressable>
            );
          })}
          {overflowCats.length > 0 && (
            <View className="relative">
              <Pressable
                onPress={() => setCatMoreOpen((v) => !v)}
                className={`flex-row items-center gap-[4px] rounded-pill border px-[14px] py-[6px] ${catMoreActive ? 'border-text bg-text' : 'border-border-light bg-transparent'}`}
              >
                <Text className={`text-[12px] ${catMoreActive ? 'text-background font-pp-semi-bold' : 'text-text-secondary font-pp-medium'}`}>
                  More
                </Text>
                {/* nw-keep(data-color): chevron glyph color is a theme token fed to the vector-icon sink */}
                <Ionicons name={catMoreOpen ? 'chevron-up' : 'chevron-down'} size={12} color={catMoreActive ? colors.background : colors.textSecondary} />
              </Pressable>
              {catMoreOpen && (
                <View
                  className="absolute left-0 top-[38px] z-[1000] min-w-[150px] rounded-card border border-border-light bg-menu-background p-[6px]"
                  // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                  style={DROPDOWN_SHADOW}
                >
                  {overflowCats.map((cat) => {
                    const active = activeCategory === cat.value;
                    return (
                      <Pressable
                        key={cat.value}
                        onPress={() => { setCatMoreOpen(false); setActiveCategory(cat.value); }}
                        className="rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                      >
                        <Text className={`text-[13px] ${active ? 'text-text font-pp-semi-bold' : 'text-text-secondary font-pp-medium'}`}>
                          {cat.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
          )}
        </View>
      </View>

      {featuredPartners.length > 0 ? (
        <View className="mb-[16px] w-full gap-[16px]">
          {featuredPartners.map((partner) => (
            <PartnerCard key={partner.slug} partner={partner} featured />
          ))}
        </View>
      ) : null}

      <MasonryGrid
        items={restPartners}
        columns={cols}
        gap={16}
        keyOf={(p) => p.slug}
        renderItem={(partner) => <PartnerCard partner={partner} />}
      />
    </View>
  );
}

// Partner brand marks, keyed by slug. Some come with their own solid background
// (Brevis orange, Shielded ETH black); the transparent ones render on the
// tile's neutral surface. Kept here rather than in config/ecosystem.ts so the
// pure data module stays free of bundler-only require() asset references.
const PARTNER_LOGOS: Record<string, ImageSourcePropType> = {
  'kohaku-sdk': require('@/assets/images/ecosystem/kohaku-sdk.png'),
  brevis: require('@/assets/images/ecosystem/brevis.png'),
  ambire: require('@/assets/images/ecosystem/ambire.png'),
  cloaked: require('@/assets/images/ecosystem/cloaked.png'),
  'veil-cash': require('@/assets/images/ecosystem/veil-cash.png'),
  zfi: require('@/assets/images/ecosystem/zfi.png'),
  'shielded-eth': require('@/assets/images/ecosystem/shielded-eth.png'),
  wenwithdraw: require('@/assets/images/ecosystem/wenwithdraw.png'),
  'defillama-privacy': require('@/assets/images/ecosystem/defillama-privacy.png'),
};

// The partner brand mark. Renders the real logo on a neutral, theme-aware tile
// (a subtle border keeps the dark solid-background marks from disappearing into
// the card in dark mode); partners without a logo fall back to the lettered
// brand-color tile.
/**
 * Partner logo sizes, taken from feat/ui-overhaul — the layout that reads
 * better. A 176px square beside the copy (84 when the card stacks) instead of
 * the 40px favicon-sized tile this page had: at that size the logos were the
 * least legible thing on a page whose whole job is recognising projects.
 *
 * The big square also does the layout work. With the description clamped to a
 * fixed line count, the logo is always the tallest element in a card, so it —
 * not the text — sets the height, and every card in the grid matches.
 */
const PARTNER_LOGO_SIZE = 176;
const PARTNER_LOGO_SIZE_SM = 84;

function PartnerLogo({ partner, size = PARTNER_LOGO_SIZE }: { partner: EcosystemPartner; size?: number }) {
  const logo = PARTNER_LOGOS[partner.slug];
  const radius = Math.round(size * 0.09);
  if (logo) {
    return (
      <View
        className="shrink-0 items-center justify-center overflow-hidden border border-border-light bg-card-background"
        // nw-keep(measured-or-inset): logo square is a JS-breakpoint size, with a radius proportional to it
        style={{ width: size, height: size, borderRadius: radius }}
      >
        {/* nw-keep(measured-or-inset): RN-Web Image needs its dimensions on the
            `style` sink. ClassName width/height doesn't reach the
            resizeMode:cover sizing path, so the logo renders unsized and clipped
            by the tile. */}
        <Image source={logo} style={{ width: size, height: size }} resizeMode="cover" />
      </View>
    );
  }
  return (
    <View
      className="shrink-0 items-center justify-center"
      // nw-keep(data-color): fallback tile uses the partner's runtime brand color (not a theme token)
      // nw-keep(measured-or-inset): matches the image square above
      style={{ backgroundColor: partner.logoColor, width: size, height: size, borderRadius: radius }}
    >
      {/* nw-keep(measured-or-inset): initial scales with the logo square, which is a JS-breakpoint value */}
      <Text className="text-[#ffffff] font-pp-bold" style={{ fontSize: Math.round(size * 0.34) }}>
        {partner.logoText}
      </Text>
    </View>
  );
}

function PartnerCard({ partner, featured }: { partner: EcosystemPartner; featured?: boolean }) {
  const { width } = useWindowDimensions();
  // Below this the card stacks into a narrow column, where a 176px square would
  // dominate; it drops to the smaller one.
  const wideCard = width >= 640;
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const categoryColors = CATEGORY_COLORS[colorScheme];
  const status = statusBadge(partner.status, colors);

  return (
      <Pressable
        onPress={() => openExternal(partner.url)}
        className={`min-h-[184px] flex-row items-stretch gap-[16px] rounded-control bg-background ${featured ? 'border-2 border-button-primary p-[24px]' : 'border border-border-light p-[20px]'}`}
      >
        {/* Logo beside the copy, not above it — the feat/ui-overhaul layout. */}
        <PartnerLogo partner={partner} size={wideCard ? PARTNER_LOGO_SIZE : PARTNER_LOGO_SIZE_SM} />

        <View className="min-w-0 flex-1 gap-[12px]">
        <View className="flex-row items-start justify-between gap-[12px]">
          <View className="min-w-0 flex-1">
            <Text numberOfLines={2} className="text-[16px] text-text font-pp-semi-bold">
              {partner.name}
            </Text>
            <Text numberOfLines={1} className="text-[11px] text-text-secondary font-pp-medium">
              {hostname(partner.url)}
            </Text>
          </View>
          {/* nw-keep(data-color): status badge background is a status-dependent theme token (runtime lookup) */}
          <View className="rounded-pill px-[10px] py-[4px]" style={{ backgroundColor: status.bg }}>
            {/* nw-keep(data-color): status label color is a status-dependent theme token (runtime lookup) */}
            <Text className="text-[10px] tracking-[0.5px] font-pp-semi-bold" style={{ color: status.color }}>
              {status.label.toUpperCase()}
            </Text>
          </View>
        </View>

        {/* Clamp the description so the cards read as one system — a partner
            blurb never balloons one card far past its neighbors. */}
        <Text
          numberOfLines={4}
          className="flex-1 text-[12px] leading-[18px] text-text-secondary font-pp-regular"
        >
          {partner.description}
        </Text>

        {/* No ASSETS row: only some partners had one, so the cards disagreed on
            how many metadata lines they carried and read as inconsistent.
            CHAINS is the opposite case. Every partner declares one, so it reads
            uniformly, and it carries the information the removed single-letter
            badges used to (three partners name their chain nowhere else). */}
        {partner.chains.length > 0 || partner.integration || partner.launchDate ? (
          <View className="gap-[4px] border-t border-t-border-light pt-[12px]">
            {partner.chains.length > 0 ? (
              <View className="flex-row items-baseline gap-[8px]">
                <Text className="w-[62px] text-[9px] tracking-[0.8px] text-text-muted font-pp-semi-bold">
                  CHAINS
                </Text>
                <Text
                  className="flex-1 text-[11px] text-text-secondary font-pp-medium"
                  numberOfLines={1}
                >
                  {partner.chains.join(', ')}
                </Text>
              </View>
            ) : null}
            {partner.integration ? (
              <View className="flex-row items-baseline gap-[8px]">
                <Text className="w-[62px] text-[9px] tracking-[0.8px] text-text-muted font-pp-semi-bold">
                  VIA
                </Text>
                <Text
                  className="flex-1 text-[11px] text-text-secondary font-pp-medium"
                  numberOfLines={1}
                >
                  {partner.integration}
                </Text>
              </View>
            ) : null}
            {partner.launchDate ? (
              <View className="flex-row items-baseline gap-[8px]">
                <Text className="w-[62px] text-[9px] tracking-[0.8px] text-text-muted font-pp-semi-bold">
                  LAUNCHED
                </Text>
                <Text
                  className="flex-1 text-[11px] text-text-secondary font-pp-medium"
                  numberOfLines={1}
                >
                  {partner.launchDate}
                </Text>
              </View>
            ) : null}
          </View>
        ) : null}

        {/* Categories only. The per-chain badges that used to sit opposite were
            a single letter in a grey circle (chain[0] — "B" for BNB), which read
            as a stray character rather than a chain: the chain is already named
            in the CHAINS row above. */}
        <View className="mt-[8px] flex-row flex-wrap items-center gap-[8px]">
          <View className="flex-row flex-wrap gap-[6px]">
            {partner.categories.map((cat) => (
              // nw-keep(data-color): category tag border is a per-category brand color (runtime data, not a theme token)
              <View
                key={cat}
                className="rounded-pill border px-[10px] py-[4px]"
                style={{ borderColor: categoryColors[cat] }}
              >
                {/* nw-keep(data-color): category label color is a per-category brand color (runtime data) */}
                <Text
                  className="text-[10px] tracking-[0.5px] font-pp-semi-bold"
                  style={{ color: categoryColors[cat] }}
                >
                  {cat.toUpperCase()}
                </Text>
              </View>
            ))}
          </View>
        </View>
        </View>
      </Pressable>
  );
}

function BottomCTA() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];

  return (
    <View className="mt-[48px] w-full items-center border-t border-t-border-light py-[64px]">
      <Text className="mb-[12px] text-[22px] text-text font-pp-bold">
        Build with Privacy Pools
      </Text>
      <Text className="mb-[28px] max-w-[500px] text-[14px] leading-[22px] text-center text-text-secondary font-pp-regular">
        Everything you need to integrate compliant privacy into your product. Open source,
        permissionless, production-ready.
      </Text>
      <View className="flex-row flex-wrap justify-center gap-[12px]">
        <Pressable
          onPress={() => openExternal('https://privacy-pools-v2-docs.vercel.app/introduction/what-is-pp-v2.html')}
          className="flex-row items-center gap-[8px] rounded-control border border-button-primary bg-button-primary px-[24px] py-[12px]"
        >
          <Text className="text-[13px] text-button-primary-text font-pp-semi-bold">
            Read the Docs
          </Text>
        </Pressable>
        <Pressable
          onPress={() => openExternal('https://github.com/0xbow-io')}
          className="flex-row items-center gap-[8px] rounded-control border border-text bg-transparent px-[24px] py-[12px]"
        >
          {/* nw-keep(data-color): github glyph color is a theme token fed to the vector-icon sink */}
          <Ionicons name="logo-github" size={14} color={colors.text} />
          <Text className="text-[13px] text-text font-pp-semi-bold">
            View on GitHub
          </Text>
        </Pressable>
        <Pressable
          onPress={() => openExternal('mailto:hello@0xbow.io')}
          className="flex-row items-center gap-[8px] rounded-control border border-text bg-transparent px-[24px] py-[12px]"
        >
          {/* nw-keep(data-color): mail glyph color is a theme token fed to the vector-icon sink */}
          <Ionicons name="mail-outline" size={14} color={colors.text} />
          <Text className="text-[13px] text-text font-pp-semi-bold">
            Talk to the Team
          </Text>
        </Pressable>
        <Pressable
          onPress={() => openExternal(SUPPORT_TELEGRAM_URL)}
          className="flex-row items-center gap-[8px] rounded-control border border-text bg-transparent px-[24px] py-[12px]"
        >
          {/* nw-keep(data-color): telegram glyph color is a theme token fed to the vector-icon sink */}
          <MaterialIcons name="telegram" size={14} color={colors.text} />
          <Text className="text-[13px] text-text font-pp-semi-bold">
            Join Telegram
          </Text>
        </Pressable>
      </View>
    </View>
  );
}
