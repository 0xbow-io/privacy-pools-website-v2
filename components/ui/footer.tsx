import { useState } from 'react';
import { useRouter } from 'expo-router';
import { isInternalHref } from '@/config/legal/routes';
import { View, Text, Pressable, Linking, useWindowDimensions } from 'react-native';
import { NewsletterModal } from '@/components/newsletter-modal';
import { smartWalletActive } from '@/config/smart-wallet';

import { footerLinks, type FooterLink } from '@/config/footer-links';
export { footerLinks, type FooterLink } from '@/config/footer-links';

/**
 * At or below this width the footer does not render at all: its links live in
 * the bottom bar's More → Info drawer instead. Nine links stacked under every
 * scroll was noise on a phone, and the bottom bar now owns that corner.
 */
const FOOTER_HIDDEN_MAX_WIDTH = 768;

export function Footer() {
  const [newsletterOpen, setNewsletterOpen] = useState(false);
  const { width } = useWindowDimensions();
  const router = useRouter();

  // When the smart-wallet experience is on (native always, web when the flag is
  // set), these links live in Settings → About instead of a global footer.
  if (smartWalletActive()) return null;
  // Phones get these links from the bottom bar's More → Info drawer.
  if (width <= FOOTER_HIDDEN_MAX_WIDTH) return null;

  const handleLinkPress = (link: FooterLink) => {
    if (link.action === 'newsletter') {
      setNewsletterOpen(true);
      return;
    }
    if (isInternalHref(link.href)) {
      router.push(link.href as never);
      return;
    }
    if (link.href && link.href !== '#') {
      Linking.openURL(link.href);
    }
  };

  return (
    // The footer absorbs the page's leftover height and parks its links at the
    // bottom of that space, so a short page does not leave it floating under
    // the content with empty space beneath (Pat, 2026-08-28).
    //
    // `grow justify-end` rather than `mt-auto`: mt-auto was the obvious
    // spelling but produced computed margin-top 0 here (verified in the
    // browser — the rule never reached the page), while grow and justify-end
    // are used across ~40 files and demonstrably generate. On a page taller
    // than the viewport there is no leftover height, so this is a no-op.
    <View className="w-full native:max-w-[820px] native:mx-auto grow justify-end">
      <View className="flex-row flex-wrap items-center justify-center gap-[12px] py-[16px]">
        {footerLinks.map((link, index) => (
          <View key={link.label} className="flex-row items-center gap-[12px]">
            {index > 0 && (
              <Text className="font-pp-sans text-[12px] text-text-muted">
                ·
              </Text>
            )}
            <Pressable onPress={() => handleLinkPress(link)}>
              <Text className="font-pp-sans text-[12px] text-text-secondary">
                {link.label}
              </Text>
            </Pressable>
          </View>
        ))}
      </View>
      <NewsletterModal visible={newsletterOpen} onClose={() => setNewsletterOpen(false)} />
    </View>
  );
}
