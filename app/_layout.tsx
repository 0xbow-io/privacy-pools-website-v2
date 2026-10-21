import 'react-native-reanimated';
import { Platform } from 'react-native';
import '../shims';
// Tailwind/NativeWind stylesheet — imported ONCE, here (never from
// app/+html.tsx: that file renders in a Node context at export time).
import '../global.css';
// cssInterop startup registrations (Animated/Reanimated className support) —
// MUST stay above every component import so registration completes before
// any app JSX element is created. See components/nativewind-interop.ts.
import '../components/nativewind-interop';
import { DarkTheme, DefaultTheme, ThemeProvider as NavigationThemeProvider } from 'expo-router/react-navigation';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import * as SplashScreen from 'expo-splash-screen';
import { useFonts } from 'expo-font';
import { Geist_400Regular, Geist_500Medium, Geist_600SemiBold, Geist_700Bold } from '@expo-google-fonts/geist';
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { useEffect } from 'react';
// reanimated must be imported at the top-level before other imports
import { WagmiProvider } from 'wagmi';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { activitySignal, ALWAYS_ACTIVE } from '@/services/activity-signal';
import { isRateLimitError } from '@/services/rpc-log-chunking';

import { AppErrorBoundary } from '@/components/app-error-boundary';
import { ThemeProvider, useTheme } from '@/components/theme-provider';
import { NativeThemeRoot } from '@/components/native-theme-root';
import { useNativeTopInset } from '@/hooks/use-native-top-inset';
import { Colors } from '@/constants/theme';
import { DebugProvider } from '@/components/debug-provider';
import { SdkProvider } from '@/components/sdk-provider';
import { PoolsProvider } from '@/components/pools-provider';
import { WalletTokensProvider } from '@/components/wallet-tokens-provider';
import { SupportedChainGuard } from '@/components/supported-chain-guard';
import { DepositModalProvider } from '@/components/deposit-modal-provider';
import { WithdrawModalProvider } from '@/components/withdraw-modal-provider';
import { RagequitModalProvider } from '@/components/ragequit-modal-provider';
import { TransferModalProvider } from '@/components/transfer-modal-provider';
import { AccountRecoveryModalProvider } from '@/components/account-recovery-modal-provider';
import { PaymentRequestBackupModalProvider } from '@/components/payment-request-backup-modal-provider';
import { PaymentRequestModalProvider } from '@/components/payment-request-modal-provider';
import { AuditExportModalProvider } from '@/components/audit-export-modal-provider';
import { AccountingModalProvider } from '@/components/accounting-modal-provider';
import { ViewingKeyModalProvider } from '@/components/viewing-key-modal-provider';
import { PaymentRequestsModalProvider } from '@/components/payment-requests-modal-provider';
import { OriginProofModalProvider } from '@/components/origin-proof-modal-provider';
import { SwapModalProvider } from '@/components/swap-modal-provider';
import { TxActivityProvider } from '@/components/tx-activity-provider';
import { startPublicFeeds, stopPublicFeeds } from '@/services/public-feeds';
import { initErrorReport } from '@/services/error-reports';
import { getSupportedChains } from '@/config/chains';
import { ACTIVE_ENVIRONMENT } from '@/config/environments';
import { ToastProvider } from '@/components/toast-provider';
import { StatusNotifier } from '@/components/status-notifier';
import { WalletConnectModalProvider } from '@/components/wallet-connect-modal-provider';
import { MobileAccountKeysProvider } from '@/components/mobile-account-keys-provider';
import { SeedDerivationModalProvider } from '@/components/seed-derivation-modal-provider';
import { KeystoreRegistrationModalProvider } from '@/components/keystore-registration-modal-provider';
import { ImportNoteModalProvider } from '@/components/import-note-modal-provider';
import { CustomRpcModalProvider } from '@/components/custom-rpc-modal-provider';
import { EmbeddedWalletProvider } from '@/components/embedded-wallet-provider';
import { PasskeyAccountProvider } from '@/components/passkey-account-provider';
import { SmartWalletOnboardingOverlay } from '@/components/smart-wallet/onboarding-overlay';
import { MobileNav } from '@/components/mobile-nav';
import { GlobalSheets } from '@/components/global-sheets';
import { ConnectBalanceLanding } from '@/components/connect-balance-landing';
import { ModalUrlBridge } from '@/components/modal-url-bridge';
import { config, initialState } from '@/config/wagmi';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SuiProvider } from '@/components/sui-provider';
import { StellarWalletProvider } from '@/components/stellar-wallet-provider';
import { useStellarAccountBinding } from '@/hooks/use-stellar-session';
import { ChainProvider } from '@/components/chain-provider';
import { installNetworkTrace } from '@/services/perf-trace';

// `networkMode: 'always'` for MUTATIONS, deliberately.
//
// Every wagmi WRITE hook (useSendTransaction, useSignTypedData, useSwitchChain,
// useConnect) is a TanStack mutation, and TanStack's default networkMode is
// 'online': Mutation.execute() asks retryer.canStart() -> onlineManager.isOnline()
// and, when that is false, PAUSES the mutation *before mutationFn ever runs*
// (query-core mutation.js:89, retryer.js:43+118). mutateAsync then hands back a
// promise that neither resolves nor rejects until a browser 'online' or 'focus'
// event calls resumePausedMutations().
//
// onlineManager flips false on ONE browser 'offline' event and stays false for
// the life of the page. navigator.onLine is famously wrong (VPN flips, wifi
// roam, laptop sleep/wake), so a single spurious event wedges every wallet
// write in the tab: the deposit modal sat forever on "Requesting token
// approval..." with NOTHING in MetaMask -- eth_sendTransaction was never handed
// to the provider at all -- and only a reload cleared it, because onlineManager
// re-initialises to true on a fresh page (QA, USDC on OP).
//
// A browser extension is not a network resource, so TanStack's connectivity
// verdict has no business gating it. QUERIES keep the default: those really do
// hit the RPC and should back off when the network is gone.
//
// QUERY defaults (2026-10-01, Mike's prod session: 469 ASP throttle answers in
// ten minutes, with every one of them retried):
//   - `retry`: never retry a rate limit. Retrying a throttle is the client
//     asking harder, and the ASP backoff (services/asp-backoff.ts) would fail
//     the retry instantly anyway. Anything else gets two retries, not three.
//   - `refetchOnWindowFocus: false`: coming back to the tab (or back from the
//     wallet popup) refetched every stale query at once, a burst timed to the
//     user. Polls resume on their own cadence instead.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => !isRateLimitError(error) && failureCount < 2,
      refetchOnWindowFocus: false,
    },
    mutations: { networkMode: 'always' },
  },
});

// React Query's "focused" is the app's activity signal (services/activity-signal.ts):
// visible, not frozen, and focused or touched in the last five minutes. While
// inactive, refetchInterval polls skip their ticks (none of the ASP queries
// set refetchIntervalInBackground) and resume on their next tick, no burst.
// A presence signal, not a funds signal. Native keeps the default listener.
const activity = activitySignal();
if (activity !== ALWAYS_ACTIVE) {
  focusManager.setEventListener((setFocused) => {
    setFocused(activity.isActive());
    return activity.subscribe((active) => setFocused(active));
  });
}

SplashScreen.preventAutoHideAsync();

export const unstable_settings = {
  anchor: '(tabs)',
};

function RootLayoutNav() {
  const { colorScheme } = useTheme();
  const baseTheme = colorScheme === 'dark' ? DarkTheme : DefaultTheme;
  // Pushed pages start below the status bar on native (0 on web).
  const topInset = useNativeTopInset();
  // Route transitions reveal the navigator underneath the page. Keep that
  // surface on the same background token as every screen.
  const navigationTheme = {
    ...baseTheme,
    colors: { ...baseTheme.colors, background: Colors[colorScheme].background },
  };

  return (
    <NavigationThemeProvider value={navigationTheme}>
      {/* No route gets the default native header. Every page draws its own
          chrome (components/ui/header.tsx, or a page-level back control), so a
          bare bar titled after the route file rendered above it — reported on
          /transactions, 2026-08-31. Two ways it leaked: this list is opt-OUT,
          so a route added later (stats, passkey-spike, yield-preview,
          chains/sui) inherited a header nobody chose, and /transactions'
          suppression was gated on a feature flag. A screen that genuinely
          wants a header now says so explicitly below; nothing can leak one by
          being forgotten here. */}
      <Stack
        screenOptions={{
          headerShown: false,
          // nw-keep(navigation-options): native-stack contentStyle option (runtime safe-area inset), no className path
          contentStyle: { paddingTop: topInset },
        }}
      >
        {/* import-note/[encoded] used to keep the native header for its back
            arrow. It was the only unstyled bar left in the app (Pat,
            2026-08-31); the page now renders its own themed "Back to Privacy
            Pools" row in EVERY state, so the arrow has nothing left to do. */}
        {/* Pushed from the mobile bottom bar. Set statically here rather than
            from inside the route, where setOptions only lands after mount —
            i.e. after the transition it configures has already begun. */}
        <Stack.Screen
          name="explore/[section]"
          options={{
            animation: 'slide_from_right',
            // nw-keep(navigation-options): the page applies its own safe-area inset
            contentStyle: { paddingTop: 0 },
          }}
        />
        {/* These draw their own top edge (SafeAreaView in (tabs), insets in the page). */}
        <Stack.Screen
          name="(tabs)"
          options={{
            // nw-keep(navigation-options): the tabs layout's SafeAreaView owns the top edge
            contentStyle: { paddingTop: 0 },
          }}
        />
        <Stack.Screen
          name="card"
          options={{
            // nw-keep(navigation-options): the card screen applies its own safe-area inset
            contentStyle: { paddingTop: 0 },
          }}
        />
        {['wallet-receive', 'wallet-settings'].map((name) => (
          <Stack.Screen
            key={name}
            name={name}
            options={{
              // nw-keep(navigation-options): these screens wrap themselves in SafeAreaView, which owns the top edge
              contentStyle: { paddingTop: 0 },
            }}
          />
        ))}
        {/* Expo template leftover, unreachable from the app; its own "Go to
            home screen" link dismisses it, so it needs no header and no
            placeholder title. */}
        <Stack.Screen name="modal" options={{ presentation: 'modal' }} />
      </Stack>
      {/* nw-keep(third-party-style-api): expo-status-bar `style` selects the native status-bar
          bar-style ('auto'|'light'|'dark'), not a RN/CSS style. No className path. */}
      <StatusBar style="auto" />
    </NavigationThemeProvider>
  );
}

// Count and time every request from the first one: the balance-load
// latency we are chasing is dominated by request VOLUME, and a hook that
// installs after mount misses the opening burst. No-ops off web.
if (Platform.OS === 'web') installNetworkTrace();

export default function RootLayout() {
  const [fontsLoaded] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_600SemiBold,
    Geist_700Bold,
    // Icon fallback metrics also move the card's first layout on web.
    ...(Platform.OS === 'web' ? { ...Ionicons.font, ...MaterialIcons.font } : {}),
  });

  useEffect(() => {
    if (fontsLoaded) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded]);

  // Public feeds run on a fixed wall-clock grid from the moment the app
  // loads, independently of which screen is mounted and of whether a
  // transaction is in flight. Started here rather than in a provider so the
  // cadence cannot be tied to any part of the tree the user's navigation can
  // unmount. See services/public-feed-scheduler.ts.
  useEffect(() => {
    startPublicFeeds();
    return () => stopPublicFeeds();
  }, []);

  // Error reporting. Off entirely without EXPO_PUBLIC_SENTRY_DSN, and web
  // only. Started here, above every provider, so an egress refusal raised
  // during startup is still relayed. What may be reported is decided in
  // services/error-reports-event.ts, by construction from an allowlist.
  // The failure tags name a chain or an asset only from these lists.
  useEffect(() => initErrorReport({
    knownChainIds: getSupportedChains().map((chain) => chain.id),
    // Native symbols too: SUI and XLM are configured on the chain, not in tokensByChain.
    knownAssetSymbols: [...new Set([
      ...Object.values(ACTIVE_ENVIRONMENT.tokensByChain).flatMap((tokens) => Object.values(tokens).map((token) => token.symbol)),
      ...getSupportedChains().map((chain) => chain.nativeCurrency.symbol),
    ])],
  }), []);

  if (!fontsLoaded) {
    return null;
  }

  return (
    // Gesture root: the jelly bottom bar's drag/press gestures (RNGH) need it
    // on native; on web it's a plain View.
    /* nw-keep(third-party-style-api): GestureHandlerRootView takes a style prop, not className */
    <GestureHandlerRootView style={{ flex: 1 }}>
    {/* Outside every provider on purpose. A crash in wagmi, react-query, the
        chain guard or the SDK provider is exactly the kind that used to leave a
        white page, and a boundary mounted underneath them cannot catch it. */}
    <AppErrorBoundary>
    <WagmiProvider config={config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>
        <SuiProvider>
        <StellarWalletProvider>
        <StellarAccountBinder />
        <ChainProvider>
        <SupportedChainGuard />
        <ThemeProvider>
        <NativeThemeRoot>
          {/* ToastProvider just inside the theme: every surface below — flow
              providers, recovery/backup modals, copy buttons. Can toast. */}
          <ToastProvider>
          <DebugProvider>
            <TxActivityProvider>
              {/* SdkProvider above the wallet modal so the picker's
                  account-key sign-in can reach the session context. */}
              <SdkProvider>
                {/* Native only (web is a passthrough): account keys imported
                    from the web and saved on the phone. Above the wallet
                    modal, which opens it. */}
                <MobileAccountKeysProvider>
                {/* Native passkey EOA sign-in + account picker (no-op on web). Above
                    the wallet modal, which shows its panel. */}
                <PasskeyAccountProvider>
                <WalletConnectModalProvider>
                  <EmbeddedWalletProvider>
                  {/* Chain endpoint settings: only needs the chain router and
                      the theme, so it sits above the flow modals. */}
                  <CustomRpcModalProvider>
                  <SeedDerivationModalProvider>
                   <KeystoreRegistrationModalProvider>
                    {/* Below the registration provider: a claim that registers
                        the wallet marks it registered there. */}
                    <ImportNoteModalProvider>
                      <AccountRecoveryModalProvider>
                        <PaymentRequestBackupModalProvider>
                          {/* PoolsProvider sits ABOVE the modal providers, not
                              below them. Those providers render the shared
                              TokenSelectSheet directly (Shield's asset picker,
                              deposit's Pay-with, both Receive-as pickers), and
                              that sheet reads shielded balances through the
                              THROWING usePools(). Mounted underneath, every one
                              of those pickers crashed the flow on open.
                              Nothing here depends on it the other way round:
                              PoolsProvider's own inputs (wagmi, the SDK session,
                              notes, tx-activity, chain router) all come from
                              higher up, and none of the modal providers consume
                              usePools. */}
                          {/* Wallet-holdings polling lives here too, for the same reason: a
                              query mounted inside a screen (the old ActionHub-local hook)
                              has its refetch interval start and stop with that screen,
                              which told a custom RPC operator exactly when the user
                              navigated. This provider outlives every screen. */}
                          <WalletTokensProvider>
                          <PoolsProvider>
                          <DepositModalProvider>
                            <WithdrawModalProvider>
                              <RagequitModalProvider>
                                <TransferModalProvider>
                                  <PaymentRequestModalProvider>
                                    <AuditExportModalProvider>
                                        {/* The swap modal reads pool balances and
                                            the status notifier the activity feed. */}
                                        <SwapModalProvider>
                                          <AccountingModalProvider>
                                            <ViewingKeyModalProvider>
                                            <OriginProofModalProvider>
                                              <PaymentRequestsModalProvider>
                                                <StatusNotifier />
                                                <ModalUrlBridge />
                                                <RootLayoutNav />
                                                {/* Phone navigation, app-wide: it replaces the
                                                    header's hamburger, so it cannot live inside a
                                                    single screen. */}
                                                {/* Sends an account that already holds funds
                                                    to its balances panel on connect (one-shot). */}
                                                <ConnectBalanceLanding />
                                                <MobileNav />
                                                {/* Sheets that must escape every screen's
                                                    stacking context, and be reachable from any
                                                    route. */}
                                                <GlobalSheets />
                                                <SmartWalletOnboardingOverlay />
                                              </PaymentRequestsModalProvider>
                                            </OriginProofModalProvider>
                                            </ViewingKeyModalProvider>
                                          </AccountingModalProvider>
                                        </SwapModalProvider>
                                    </AuditExportModalProvider>
                                  </PaymentRequestModalProvider>
                                </TransferModalProvider>
                              </RagequitModalProvider>
                            </WithdrawModalProvider>
                          </DepositModalProvider>
                          </PoolsProvider>
                          </WalletTokensProvider>
                        </PaymentRequestBackupModalProvider>
                      </AccountRecoveryModalProvider>
                    </ImportNoteModalProvider>
                   </KeystoreRegistrationModalProvider>
                  </SeedDerivationModalProvider>
                  </CustomRpcModalProvider>
                  </EmbeddedWalletProvider>
                </WalletConnectModalProvider>
                </PasskeyAccountProvider>
                </MobileAccountKeysProvider>
              </SdkProvider>
            </TxActivityProvider>
          </DebugProvider>
          </ToastProvider>
        </NativeThemeRoot>
        </ThemeProvider>
        </ChainProvider>
        </StellarWalletProvider>
        </SuiProvider>
      </QueryClientProvider>
    </WagmiProvider>
    </AppErrorBoundary>
    </GestureHandlerRootView>
  );
}

/** Keeps the shared Stellar account bound to the Stellar wallet (renders nothing). */
function StellarAccountBinder() {
  useStellarAccountBinding();
  return null;
}
