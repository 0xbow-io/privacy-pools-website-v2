import { View, Text, Pressable, Platform } from 'react-native';
import { useBackHandler } from '@/hooks/use-back-handler';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';

const WEB_OVERLAY_POSITION = Platform.select({ web: { position: 'fixed' }, default: { position: 'absolute' } }) as Record<string, string>;
import Svg, { Path, Circle, Rect } from 'react-native-svg';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { ChainLogo, chainLogoChainFor } from '@/components/ui/chain-logo';

// nw-keep(svg-or-canvas): the icon components below carry fixed brand/chrome
// fill+stroke literals baked into their SVG artwork (no className path).
function ChevronDownIcon({ color = '#282828' }: { color?: string }) {
  return (
    <Svg width={20} height={20} viewBox="0 0 20 20" fill="none">
      <Path d="M6.17917 7.15411L10 10.9749L13.8208 7.15411L15 8.33328L10 13.3333L5 8.33328L6.17917 7.15411Z" fill={color} />
    </Svg>
  );
}

function CheckboxChecked() {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Rect width={16} height={16} fill="#262626" />
      <Path d="M6.5 11.207L2 6.707L2.707 6L6.5 9.7925L13.293 3L14 3.707L6.5 11.207Z" fill="white" />
    </Svg>
  );
}

function CheckboxUnchecked() {
  return (
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Rect x={0.5} y={0.5} width={15} height={15} stroke="#999999" strokeWidth={1} />
    </Svg>
  );
}

/** One selectable chain (from the app's actually-supported chains). */
export type ChainFilterOption = { id: number; label: string; chainType: string };



type BlockchainFilterProps = {
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  /** The chains that appear in the current feed. */
  options: ChainFilterOption[];
  /** Selected chain ids; empty = All Chains. */
  selected: Set<number>;
  onChange: (next: Set<number>) => void;
  /**
   * Which edge the menu hangs from. Default 'start' is right for the
   * transactions feed, where the control sits in a left-aligned filter row.
   * The Explore pools table puts its Chain control on the card's right edge,
   * where a left-hung 165px menu would spill ~60px outside the card.
   */
  align?: 'start' | 'end';
};

export function BlockchainFilter({ open, onToggle, onClose, options, selected, onChange, align = 'start' }: BlockchainFilterProps) {
  useBackHandler(open, onClose);
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const isAll = selected.size === 0;

  const toggleChain = (id: number | 'all') => {
    if (id === 'all') { onChange(new Set()); return; }
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    onChange(next);
  };

  const label = isAll
    ? 'All'
    : options.filter((o) => selected.has(o.id)).map((o) => o.label).join(', ') || 'All';

  // Conditional z-index, matching the sibling filters in transactions.tsx:
  // this is the filter that wraps to a second line first.
  return (
    <View className={`relative overflow-visible ${open ? 'z-[99999]' : 'z-[1]'}`}>
      <Pressable className="-mx-[6px] flex-row items-center gap-[4px] rounded-control px-[6px]" onPress={onToggle}>
        <Text className="font-pp-regular text-[12px] text-text-secondary">
          Chain: {label}
        </Text>
        {/* nw-keep(data-color): chevron fill color (theme token) into the SVG icon (no className path) */}
        <ChevronDownIcon color={colors.textSecondary} />
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
            className={`absolute top-[28px] z-[99999] min-w-[200px] rounded-card border border-border-light bg-menu-background p-[6px] ${
              align === 'end' ? 'right-0' : 'left-0'
            }`}
            // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
            style={DROPDOWN_SHADOW}
          >
            {[{ id: 'all' as const, label: 'All Chains', chainType: '' }, ...options].map((chain) => {

              const checked = chain.id === 'all' ? isAll : selected.has(chain.id);
              return (
                <View key={String(chain.id)}>
                  <Pressable className="flex-row items-center gap-[12px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={() => toggleChain(chain.id)}>
                    {/* shrink-0: the widest row ("BNB Chain" with its logo)
                        overflowed the sheet's width and the checkbox took the
                        squeeze, rendering 5px wide (Pat, 2026-09-04). */}
                    <View className="shrink-0">{checked ? <CheckboxChecked /> : <CheckboxUnchecked />}</View>
                    <View className="flex-row items-center gap-[10px]">
                      {/* Per-CHAIN mark (chainLogoChainFor), not one glyph per
                          chain TYPE: keying off chainType drew the Ethereum
                          logo for Sepolia, Optimism and Citrea alike. Same
                          component the header's chain selector uses. */}
                      {chain.id !== 'all' && <View className="shrink-0"><ChainLogo chain={chainLogoChainFor(chain.id)} size={16} /></View>}
                      <Text className="font-pp-regular text-[14px] text-text" numberOfLines={1}>
                        {chain.label}
                      </Text>
                    </View>
                  </Pressable>
                </View>
              );
            })}
          </View>
        </>
      )}
    </View>
  );
}
