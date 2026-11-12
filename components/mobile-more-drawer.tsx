import { useEffect, useState } from 'react';
import { Linking, Platform, Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { usePathname } from 'expo-router';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { NAV_MENU_ICONS, navItems } from '@/components/ui/header';
import { footerLinks } from '@/components/ui/footer';
import { isInternalHref } from '@/config/legal/routes';
import { NewsletterModal } from '@/components/newsletter-modal';
import { useAppNavigation } from '@/hooks/use-app-navigation';
import { BottomSheet } from '@/components/ui/bottom-sheet';

/** Which pane of the drawer is showing. */
type Pane = 'main' | 'info';

/**
 * The mobile bottom bar's "More" drawer.
 *
 * Holds the page navigation that used to live in the header's hamburger, so a
 * phone has exactly one navigation surface (the bottom bar) instead of two.
 * A second pane behind "Info" carries the about/docs links that used to be the
 * page footer — also removed on mobile, where a nine-link footer under every
 * scroll was pure noise.
 *
 * Both lists are imported from their original owners (navItems /
 * NAV_MENU_ICONS from the header, footerLinks from the footer) so there is no
 * second copy to drift.
 */
export function MobileMoreDrawer({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const navigateTo = useAppNavigation();
  const pathname = usePathname();
  const [pane, setPane] = useState<Pane>('main');
  const [newsletterOpen, setNewsletterOpen] = useState(false);

  // Always reopen on the main pane — coming back to a sub-list you left behind
  // reads as a bug. (Lost when the sheet chrome moved to <BottomSheet>; the old
  // reset lived in the open animation effect that went with it.)
  useEffect(() => {
    if (visible) setPane('main');
  }, [visible]);

  // The drawer's page list, derived from the header's rather than copied. A
  // row that duplicates a bar tab one layer up reads as two different places,
  // so the bar's own pages are filtered out: "My Pools" (it is `/`, the
  // Shield tab), "Portfolio" and "Explore" (bar tabs of their own).
  const mainItems = navItems.filter(
    (item) => item.label !== 'My Pools' && item.label !== 'Explore' && item.label !== 'Portfolio',
  );

  const go = (href: string) => {
    onClose();
    navigateTo(href);
  };

  const openLink = (href: string, action?: 'newsletter') => {
    if (action === 'newsletter') {
      onClose();
      setTimeout(() => setNewsletterOpen(true), 60);
      return;
    }
    if (isInternalHref(href)) {
      go(href);
      return;
    }
    if (href && href !== '#') Linking.openURL(href);
  };

  return (
    <>
      <BottomSheet
        visible={visible}
        onClose={onClose}
        headerLeft={
          pane === 'info' ? (
            <Pressable
              onPress={() => setPane('main')}
              className="flex-row items-center gap-[4px]"
              accessibilityRole="button"
              accessibilityLabel="Back"
              testID="more-drawer-back"
              hitSlop={8}
            >
              {/* nw-keep(data-color): back chevron uses the primary theme token into the vector-icon sink */}
              <Ionicons name="chevron-back" size={17} color={colors.primary} />
              <Text className="font-pp-sans-semi-bold text-[17px] text-text">Info</Text>
            </Pressable>
          ) : (
            <Text className="font-pp-sans-semi-bold text-[17px] text-text">More</Text>
          )
        }
        testID="more-drawer"
        dragTestID="more-drag-area"
        closeTestID="more-drawer-close"
        bodyContentClassName="px-[10px] pb-[26px] pt-[4px]"
      >
        {pane === 'main' ? (
          <>
            {mainItems.map((item) => {
              const isActive = pathname === item.href;
              return (
                <Pressable
                  key={item.href}
                  onPress={() => go(item.href)}
                  className={`flex-row items-center gap-[13px] rounded-inner px-[12px] py-[13px] active:bg-background-secondary ${isActive ? 'bg-primary-soft' : ''}`}
                  accessibilityRole="link"
                  accessibilityState={{ selected: isActive }}
                  testID={`more-nav-${item.label}`}
                >
                  {/* nw-keep(data-color): destination glyph switches between two runtime theme tokens (vector-icon sink) */}
                  <Ionicons
                    name={NAV_MENU_ICONS[item.label] ?? 'ellipse-outline'}
                    size={19}
                    color={isActive ? colors.primary : colors.textSecondary}
                  />
                  <Text className={`flex-1 text-[15px] ${isActive ? 'font-pp-sans-semi-bold text-primary' : 'font-pp-sans-medium text-text'}`}>
                    {item.label}
                  </Text>
                  {/* No chevron: these rows GO somewhere, they don't open a
                      deeper list. The disclosure arrow is reserved for Info
                      below, the one row that actually has a sub-menu. */}
                </Pressable>
              );
            })}

            <View className="my-[8px] h-[1px] self-stretch bg-border-light" />

            {/* The about/docs links live one level down — they are reference
                material, not navigation, and outnumber the pages above. */}
            <Pressable
              onPress={() => setPane('info')}
              className="flex-row items-center gap-[13px] rounded-inner px-[12px] py-[13px] active:bg-background-secondary"
              accessibilityRole="button"
              testID="more-nav-info"
            >
              {/* nw-keep(data-color): info glyph uses the secondary theme token into the vector-icon sink */}
              <Ionicons name="information-circle-outline" size={19} color={colors.textSecondary} />
              <Text className="flex-1 font-pp-sans-medium text-[15px] text-text">Info</Text>
              {/* nw-keep(data-color): row chevron uses the muted theme token into the vector-icon sink */}
              <Ionicons name="chevron-forward" size={15} color={colors.textMuted} />
            </Pressable>
          </>
        ) : (
          footerLinks.map((link) => (
            <Pressable
              key={link.label}
              onPress={() => openLink(link.href, link.action)}
              className="flex-row items-center gap-[13px] rounded-inner px-[12px] py-[12px] active:bg-background-secondary"
              accessibilityRole="link"
              testID={`more-info-${link.label}`}
            >
              <Text className="flex-1 font-pp-sans-medium text-[14.5px] text-text">{link.label}</Text>
              {/* nw-keep(data-color): trailing glyph uses the muted theme token into the vector-icon sink */}
              <Ionicons
                name={link.action === 'newsletter' ? 'mail-outline' : isInternalHref(link.href) ? 'chevron-forward' : 'open-outline'}
                size={15}
                color={colors.textMuted}
              />
            </Pressable>
          ))
        )}
      </BottomSheet>

      <NewsletterModal visible={newsletterOpen} onClose={() => setNewsletterOpen(false)} />
    </>
  );
}
