import { useState } from 'react';
import { View, Pressable, Text } from 'react-native';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';
import { Modal } from '@/components/ui/modal';
import Svg, { Circle } from 'react-native-svg';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { WarningTriangleHint } from '@/components/ui/explorer-privacy-hint';

export type TransactionRowMenuItem = {
  key: string;
  label: string;
  icon: React.ReactNode;
  onPress: () => void;
  color?: string;
  /** DEV-573: a privacy note shown under the label (red), e.g. on explorer links. */
  warning?: string;
};

export type TransactionRowMenuProps = {
  items: TransactionRowMenuItem[];
};

function MenuDotsIcon({ color }: { color: string }) {
  return (
    // nw-keep(svg-or-canvas): dot glyph fills fed the caller's color into the SVG circles (no className path)
    <Svg width={16} height={16} viewBox="0 0 16 16" fill="none">
      <Circle cx={8} cy={3} r={1.5} fill={color} />
      <Circle cx={8} cy={8} r={1.5} fill={color} />
      <Circle cx={8} cy={13} r={1.5} fill={color} />
    </Svg>
  );
}

// Native uses a full-screen Modal so the menu renders above anything else
// without worrying about parent stacking contexts.
export function TransactionRowMenu({ items }: TransactionRowMenuProps) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable className="rounded-card bg-background-secondary p-[4px]" onPress={() => setOpen(true)}>
        {/* nw-keep(data-color): muted glyph color (theme token) into the icon color prop (non-class sink) */}
        <MenuDotsIcon color={colors.textSecondary} />
      </Pressable>
      <Modal visible={open} transparent animationType="fade" onRequestClose={() => setOpen(false)}>
        <Pressable className="absolute inset-0 bg-[rgba(0,0,0,0.3)]" onPress={() => setOpen(false)} />
        <View
          className="absolute bottom-[40px] left-[20px] right-[20px] rounded-card border border-border-light bg-menu-background p-[6px]"
          // nw-keep(platform-css): the shared dropdown shadow, as on the web row menu
          style={DROPDOWN_SHADOW}
        >
          {items.map((item) => (
            // The hint and the row action are sibling controls, so a screen
            // reader reaches each one on its own (never a button in a button).
            <View key={item.key} className="flex-row items-center gap-[10px] rounded-pill px-[12px]">
              {item.warning ? <WarningTriangleHint text={item.warning} size={16} /> : item.icon}
              <Pressable
                accessibilityRole="menuitem"
                accessibilityLabel={item.label}
                className="flex-1 py-[12px]"
                onPress={() => {
                  setOpen(false);
                  item.onPress();
                }}
              >
                <View className="shrink">
                <Text
                  className="font-pp-regular text-[14px]"
                  // nw-keep(data-color): per-item override color (or theme token fallback) — runtime value, not a class token
                  style={{ color: item.color ?? colors.text }}
                >
                  {item.label}
                </Text>
                </View>
              </Pressable>
            </View>
          ))}
        </View>
      </Modal>
    </>
  );
}
