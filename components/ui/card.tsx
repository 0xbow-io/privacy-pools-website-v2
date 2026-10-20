import { View, ViewProps } from 'react-native';

type CardProps = ViewProps & {
  children: React.ReactNode;
  noPadding?: boolean;
};

export function Card({ children, style, className, noPadding, ...props }: CardProps) {
  return (
    <View
      className={`overflow-hidden rounded-card border border-border bg-card-background${
        noPadding ? '' : ' p-[24px]'
      }${className ? ` ${className}` : ''}`}
      // nw-keep(forwarded-style-contract): caller style applies LAST — callers deliberately override overflow:hidden
      // (DROPDOWN_ZINDEX_PATTERN.md) and card colors via style during the dual-run window
      style={style}
      {...props}
    >
      {children}
    </View>
  );
}
