import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { Platform, Pressable, ScrollView, useWindowDimensions, View } from 'react-native';
import { Modal } from '@/components/ui/modal';
import type { ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { PaymentRequestsCard } from '@/components/payment-requests-card';

// Scroll viewport cap: web uses a viewport-relative 80vh, native a fixed 560px.
// Kept as a style sink because it's a runtime Platform split with no single
// className value (vh is web-only).
const SCROLL_MAX_HEIGHT: ViewStyle = Platform.OS === 'web'
  ? ({ maxHeight: '80vh' as unknown as number } as ViewStyle)
  : { maxHeight: 560 };

type PaymentRequestsModalContextType = {
  openPaymentRequestsModal: () => void;
  closePaymentRequestsModal: () => void;
};

const PaymentRequestsModalContext = createContext<PaymentRequestsModalContextType>({
  openPaymentRequestsModal: () => {},
  closePaymentRequestsModal: () => {},
});

export function usePaymentRequestsModal() {
  return useContext(PaymentRequestsModalContext);
}

// Lightweight standalone modal for the Payment Requests tracker — relocated
// out of the (removed) Manage page. The card fetches its own data and renders
// the open/fulfilled list; here we just frame it as a centered modal surface
// with a floating close button.
export function PaymentRequestsModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;
  const [isOpen, setIsOpen] = useState(false);

  const openPaymentRequestsModal = useCallback(() => setIsOpen(true), []);
  const closePaymentRequestsModal = useCallback(() => setIsOpen(false), []);

  const value = useMemo(
    () => ({ openPaymentRequestsModal, closePaymentRequestsModal }),
    [openPaymentRequestsModal, closePaymentRequestsModal],
  );

  return (
    <PaymentRequestsModalContext.Provider value={value}>
      {children}
      <Modal animationType={isMobileSheet ? 'slide' : 'fade'} transparent visible={isOpen} onRequestClose={closePaymentRequestsModal}>
        {/* justify/padding branches are mutually exclusive: co-active base+sheet classes
            resolve by CSS file order on web (center/20px win). Old style array was later-wins (end/0). */}
        <View className={`flex-1 items-center bg-[rgba(0,0,0,0.5)] ${isMobileSheet ? 'justify-end p-0' : 'justify-center p-[20px]'}`}>
          <View className={`relative w-full max-w-[560px] ${isMobileSheet ? 'max-w-full max-h-[94%] rounded-t-card rounded-b-none border border-border border-b-0 bg-card-background p-[12px] pt-[26px]' : ''}`}>
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isMobileSheet && <View className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]" style={{ backgroundColor: colors.border }} />}
            <Pressable
              className="absolute right-[10px] top-[10px] z-[10] h-[34px] w-[34px] items-center justify-center rounded-[17px] border border-border-light bg-card-background"
              onPress={closePaymentRequestsModal}
            >
              {/* nw-keep(data-color): close glyph color is the text theme token into the vector-icon sink */}
              <Ionicons name="close" size={18} color={colors.text} />
            </Pressable>
            <ScrollView
              className="w-full"
              // nw-keep(platform-css): scroll viewport cap is a runtime Platform split (web 80vh / native 560px) with no single className value
              style={SCROLL_MAX_HEIGHT}
              showsVerticalScrollIndicator={false}
            >
              {/* Mount only while open so the card's data fetch re-runs on each
                  open (web keeps Modal children mounted otherwise → stale list).
                  Re-issue opens the create modal. Close this one first. */}
              {isOpen ? <PaymentRequestsCard onNavigateAway={closePaymentRequestsModal} /> : null}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </PaymentRequestsModalContext.Provider>
  );
}
