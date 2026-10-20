import { useCallback, useMemo, useRef } from 'react';
import { Animated, Easing, Platform, Pressable } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { useSyncEverything } from '@/hooks/use-sync-everything';
import { DrawerHostContext } from '@/components/home/drawer-host';
import { BottomSheet } from '@/components/ui/bottom-sheet';
import { PanelSections, PANEL_TITLES, type DrawerSection } from '@/components/home/explore-panel';

export type { DrawerSection };

/** Share of the viewport the sheet covers at rest (spec: ~70–80%). */
const SHEET_HEIGHT_RATIO = 0.78;

/**
 * The MOBILE presentation of the exploratory surfaces: a bottom sheet covering
 * ~78% of the screen. Desktop home renders the same content as the right-hand
 * column of a split screen instead (see home-screen.tsx); the caller decides
 * which, so this is unconditionally a sheet.
 *
 * All sheet chrome — scrim, slide, drag-to-dismiss, handle, header — is the
 * shared <BottomSheet>, so this and the More / Notifications sheets cannot
 * drift apart again. Content inside lays out as stacked cards rather than wide
 * tables, which comes from the shell reporting `surface: 'sheet'` on the
 * explore-panel context.
 */
export function ActivityDrawer({
  visible,
  section,
  onClose,
}: {
  visible: boolean;
  section: DrawerSection;
  onClose: () => void;
}) {
  // Hand-off: let the sheet settle before the next overlay mounts, so a Deposit
  // pressed inside it never opens underneath it. Only native needs the wait —
  // on web the provider modals stack above the sheet anyway.
  const handoff = useRef(new Animated.Value(0)).current;
  const runAndClose = useCallback(
    (action: () => void) => {
      Animated.timing(handoff, {
        toValue: 1,
        duration: 240,
        easing: Easing.in(Easing.cubic),
        useNativeDriver: Platform.OS !== 'web',
      }).start(() => {
        handoff.setValue(0);
        onClose();
        setTimeout(action, 30);
      });
    },
    [handoff, onClose],
  );
  const hostValue = useMemo(() => ({ runAndClose }), [runAndClose]);
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  // FB #11: on mobile this sheet covers the screen, so the header's refresh is
  // behind the scrim and My balances had no way to update at all. Same handler
  // as that button, via the shared hook, so the two cannot diverge.
  const { sync, syncing } = useSyncEverything();

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={PANEL_TITLES[section]}
      heightRatio={SHEET_HEIGHT_RATIO}
      // On native this must be an RN Modal: unlike the web fixed layer, the
      // host screen there is not a full-viewport overlay.
      nativeModal
      testID="activity-drawer"
      dragTestID="drawer-drag-area"
      closeTestID="drawer-close"
      headerRight={(
        <Pressable
          onPress={() => { void sync(); }}
          disabled={syncing}
          accessibilityRole="button"
          accessibilityLabel="Refresh balances and activity"
          testID="drawer-sync"
          hitSlop={8}
          className={`h-[30px] w-[30px] items-center justify-center rounded-inner bg-background-secondary ${syncing ? 'opacity-50' : 'opacity-100'}`}
        >
          {/* nw-keep(data-color): glyph colour is the secondary theme token into the vector-icon sink */}
          <Ionicons name="sync-outline" size={15} color={colors.textSecondary} />
        </Pressable>
      )}
    >
      <DrawerHostContext.Provider value={hostValue}>
        <PanelSections section={section} onClose={onClose} />
      </DrawerHostContext.Provider>
    </BottomSheet>
  );
}
