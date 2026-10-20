import { View, Text, Pressable } from 'react-native';

type EmptyStateProps = {
  message?: string;
  linkText?: string;
  onLinkPress?: () => void;
};

export function EmptyState({
  message = 'to view data',
  linkText = 'Connect wallet',
  onLinkPress,
}: EmptyStateProps) {
  return (
    <View className="relative h-[195px] items-center justify-center overflow-hidden">
      {/* Large Dashed Ellipse */}
      <View className="absolute h-[430px] w-[430px] rounded-[215px] border border-dashed border-border-light" />

      {/* Text */}
      <View className="flex-row items-center">
        <Pressable onPress={onLinkPress}>
          <Text className="font-pp-medium text-[16px] leading-[19.2px] text-text underline">
            {linkText}
          </Text>
        </Pressable>
        <Text className="font-pp-medium text-[16px] leading-[19.2px] text-text">
          {message}
        </Text>
      </View>
    </View>
  );
}
