import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import { Alert, Platform, Pressable, View } from 'react-native';

import { HoverHint } from '@/components/ui/hover-hint';
import { explorerNameFromUrl, explorerPrivacyText } from '@/services/explorer-privacy';

export { explorerNameFromUrl, explorerPrivacyText };

const DANGER = '#E11D48';

/**
 * A red warning triangle whose text only shows on hover (web) or tap (touch).
 * The text never renders inline (Mike, DEV-573 review). It makes no request.
 */
export function WarningTriangleHint({ text, size = 13 }: { text: string; size?: number }) {
  const icon = (
    // nw-keep(data-color): danger red into the vector-icon sink
    <Ionicons name="warning" size={size} color={DANGER} />
  );
  if (Platform.OS !== 'web') {
    return (
      <Pressable
        testID="explorer-privacy-hint"
        accessibilityRole="button"
        accessibilityLabel="Privacy warning"
        accessibilityHint={text}
        hitSlop={8}
        onPress={() => Alert.alert('Privacy warning', text)}
      >
        {icon}
      </Pressable>
    );
  }
  return (
    <HoverHint hint={text} wrap testID="explorer-privacy-hint">
      <View accessibilityRole="image" accessibilityLabel={`Privacy warning: ${text}`}>
        {icon}
      </View>
    </HoverHint>
  );
}

/** DEV-573: the triangle beside every external explorer link. */
export function ExplorerPrivacyHint({ explorerName, size = 13 }: { explorerName: string; size?: number }) {
  return <WarningTriangleHint text={explorerPrivacyText(explorerName)} size={size} />;
}
