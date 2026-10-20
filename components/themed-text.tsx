import { Text, type TextProps } from 'react-native';

import { useThemeColor } from '@/hooks/use-theme-color';

export type ThemedTextProps = TextProps & {
  lightColor?: string;
  darkColor?: string;
  type?: 'default' | 'title' | 'defaultSemiBold' | 'subtitle' | 'link';
};

// Static type variants, class-authored (exact px from the legacy StyleSheet).
const TYPE_CLASSES: Record<NonNullable<ThemedTextProps['type']>, string> = {
  default: 'text-[16px] leading-[24px]',
  defaultSemiBold: 'text-[16px] leading-[24px] font-semibold',
  title: 'text-[32px] font-bold leading-[32px]',
  subtitle: 'text-[20px] font-bold',
  link: 'text-[16px] leading-[30px]',
};

export function ThemedText({
  style,
  lightColor,
  darkColor,
  type = 'default',
  ...rest
}: ThemedTextProps) {
  const color = useThemeColor({ light: lightColor, dark: darkColor }, 'text');

  return (
    <Text
      className={TYPE_CLASSES[type]}
      // nw-keep(data-color): themed color (runtime lightColor/darkColor overrides) plus the link type's fixed color, which must
      // override the themed color exactly as the legacy cascade did — inline style is the only sink with that precedence
      // nw-keep(forwarded-style-contract): caller style applies LAST (dual-run contract)
      style={[{ color }, type === 'link' ? { color: '#0a7ea4' } : undefined, style]}
      {...rest}
    />
  );
}
