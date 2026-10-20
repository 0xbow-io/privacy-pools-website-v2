import { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, ScrollView, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useToast } from '@/components/toast-provider';
import { EXPLORE_TAB_BAR_CLEARANCE } from '@/components/home/explore-tab-bar';
import { OrigamiCard } from '@/components/card/origami-card.native';

/**
 * `/card`, native app only. Invites the user to create their card and starts
 * with account activation.
 */
export function CardScreen() {
  const insets = useSafeAreaInsets();
  const { toast } = useToast();

  // Copy and button rise in after the card lands.
  const rise = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(rise, {
      toValue: 1,
      duration: 600,
      delay: 350,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [rise]);
  const riseY = rise.interpolate({ inputRange: [0, 1], outputRange: [18, 0] });

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow items-center justify-center px-[24px]"
      // nw-keep(measured-or-inset): safe-area top inset and clearance for the floating bottom bar
      contentContainerStyle={{ paddingTop: insets.top + 24, paddingBottom: EXPLORE_TAB_BAR_CLEARANCE + insets.bottom + 24 }}
    >
      <OrigamiCard />

      <Animated.View
        className="mt-[40px] w-full items-center"
        // nw-keep(animated): copy fades and rises in after the card
        style={{ opacity: rise, transform: [{ translateY: riseY }] }}
      >
        <Text className="mb-[12px] text-center font-pp-sans-bold text-[30px] leading-[36px] text-text">
          Create your private card
        </Text>
        <Text className="mb-[32px] max-w-[320px] text-center font-pp-sans text-[16px] leading-[23px] text-text-secondary">
          It takes about two minutes. Activate once, then start spending.
        </Text>

        <Pressable
          onPress={() => toast({ title: 'Account activation is coming soon.' })}
          accessibilityRole="button"
          testID="card-activate-account"
          className="h-[56px] w-full max-w-[360px] items-center justify-center rounded-pill bg-button-primary active:opacity-80"
        >
          <Text className="font-pp-sans-semi-bold text-[17px] text-button-primary-text">Activate account</Text>
        </Pressable>
      </Animated.View>
    </ScrollView>
  );
}
