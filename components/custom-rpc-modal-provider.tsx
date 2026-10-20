/**
 * Custom RPC modal: point each chain at your own node.
 *
 * ONE FIELD PER CHAIN, deliberately. An RPC endpoint answers for exactly one
 * chain, so a single field was never the right shape: the storage underneath
 * was always a per-chain map, but a form bound to the chain you happened to be
 * on meant setting four chains required switching chain four times, which
 * reads as "this does not support multichain" (Pat, 2026-09-11).
 *
 * Hosted providers give one key and a per-chain URL that differs by a network
 * token, so when we recognise one we OFFER to fill the rest. Offer, not apply:
 * a derived URL is a guess about someone else's scheme, and it only ever fills
 * rows the user left empty.
 *
 * The endpoint is baked into the config layer at module load
 * (config/custom-rpc.ts), so saving reloads the page. The URL stays between
 * this form, localStorage and viem: never to the ASP, the relayer or any other
 * service, and never in a URL query string. See
 * docs/privacy-request-discipline.md.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';

import { useTheme } from '@/components/theme-provider';
import { SENSITIVE_INPUT_ID_PREFIX } from '@/components/debug-provider';
import { Colors } from '@/constants/theme';
import { getChainConfig, supportedChainIds } from '@/config/chains';
import {
  activeCustomRpcUrl,
  ACTIVE_CUSTOM_RPC_PERSISTENCE,
  applyCustomRpcMany,
  deriveSiblingRpcUrls,
  detectRpcProvider,
  probeRpcUrl,
  previewCustomRpcMany,
  skippedChainIds,
  RPC_PROBE_MESSAGES,
  validateCustomRpcUrl,
} from '@/config/custom-rpc';
import { ACTIVE_TOR_SETTINGS, SUGGESTED_TOR_GATEWAY, TOR_ON_DEVICE, TOR_PROVIDERS, saveTorSettings, torNeedsGateway, validateTorGatewayFor, type TorProviderId } from '@/config/tor';
import { HoverHint } from '@/components/ui/hover-hint';
import { reloadAppAsync } from 'expo';
import { createTorFetch, probeTorGateway, TOR_PROBE_STEP_TEXT, TOR_PROBE_TIMEOUT_MS, torFetchIfActive } from '@/services/tor-fetch';

type CustomRpcModalContextType = {
  /**
   * `torOnly` opens the same form showing only the Tor section, for the
   * "Connect with Tor" entry point. One form rather than two, because the two
   * settings are saved together and a second modal would have to duplicate
   * that, but Tor alone is a complete and sensible choice: it changes how
   * calls travel and leaves them going to our endpoints, so someone who wants
   * it should not have to walk past a wall of endpoint fields to find it.
   */
  openCustomRpcModal: (options?: { torOnly?: boolean }) => void;
  closeCustomRpcModal: () => void;
};

const CustomRpcModalContext = createContext<CustomRpcModalContextType>({
  openCustomRpcModal: () => {},
  closeCustomRpcModal: () => {},
});

export function useCustomRpcModal() {
  return useContext(CustomRpcModalContext);
}

// A refused write (private mode, blocked site data) must not read as a save:
// the reload would land on the endpoint the user just tried to change.
const STORAGE_REFUSED = 'Could not save. This browser is blocking site data for this page.';
const DEVICE_STORAGE_REFUSED = 'Could not save. This device refused to store the setting. Try again.';

const PROVIDER_LABELS: Record<string, string> = {
  alchemy: 'Alchemy',
  ankr: 'Ankr',
  drpc: 'dRPC',
  dappnode: 'DAppNode',
};

/** EVM only: a Sui endpoint comes from config/sui.ts, not from these records. */
function editableChains(): { chainId: number; name: string }[] {
  return supportedChainIds
    .map((chainId) => ({ chainId, config: getChainConfig(chainId) }))
    .filter((entry) => entry.config?.chainType === 'evm')
    .map((entry) => ({ chainId: entry.chainId, name: entry.config!.displayName }));
}

type RowStatus = 'idle' | 'checking' | 'ok' | 'fail';

type RowState = {
  /** The draft in the field. */
  value: string;
  /** Result of the last test request for this row. */
  status: RowStatus;
  /** What is in force this page load, so "already set" is visible. */
  saved: string | undefined;
  /** Blocks saving. */
  error: string | null;
  /** Does not block saving; a second press goes ahead anyway. */
  warning: string | null;
};

/**
 * The Tor block, as its own component so it can render in either position.
 *
 * Extracted for ordering, not for reuse: it is rendered before the endpoint
 * fields when the user arrived through "Connect with Tor" and after them
 * otherwise, and the alternative was a hundred duplicated lines. Keeping it a
 * component rather than a variable inside the provider also keeps the
 * provider's body free of JSX, which is what services/__tests__/custom-rpc-modal.test.ts
 * evaluates.
 */
function TorSection({
  colors, colorScheme, checking,
  torEnabled, setTorEnabled,
  torProvider, setTorProvider,
  torGateway, setTorGateway,
  torAcceptedSuggested, setTorAcceptedSuggested,
  torProbing, torStatus, torChecked, torError, setTorChecked, setTorError,
  usingSuggestedGateway, testTorGateway,
}: {
  colors: (typeof Colors)['light'];
  colorScheme: 'light' | 'dark';
  checking: boolean;
  torEnabled: boolean;
  setTorEnabled: React.Dispatch<React.SetStateAction<boolean>>;
  torProvider: TorProviderId;
  setTorProvider: (value: TorProviderId) => void;
  torGateway: string;
  setTorGateway: (value: string) => void;
  torAcceptedSuggested: boolean;
  setTorAcceptedSuggested: React.Dispatch<React.SetStateAction<boolean>>;
  torProbing: boolean;
  torStatus: string | null;
  torChecked: boolean;
  torError: string | null;
  setTorChecked: (value: boolean) => void;
  setTorError: (value: string | null) => void;
  usingSuggestedGateway: boolean;
  testTorGateway: () => void;
}) {
  const selectedProvider = TOR_PROVIDERS.find((provider) => provider.id === torProvider);
  const needsGateway = !TOR_ON_DEVICE && (selectedProvider?.needsGateway ?? true);
  return (<>
            {/*
              Tor. Independent of the endpoints above on purpose: those
              change WHERE a call goes, this changes HOW it travels, and the
              useful combination is both at once or Tor on its own over our
              endpoints. See config/tor.ts for the gateway trust boundary,
              which is why the address is the user's to supply and there is
              no default.
            */}
            <View className="h-[1px] bg-border-light" />
            <Pressable
              className="flex-row items-center gap-[10px]"
              onPress={() => setTorEnabled((on) => !on)}
              testID="custom-rpc-tor"
              accessibilityRole="checkbox"
              accessibilityState={{ checked: torEnabled }}
            >
              {/* nw-keep(data-color): checkbox glyph color is a theme token into the vector-icon sink */}
              <Ionicons
                name={torEnabled ? 'checkbox' : 'square-outline'}
                size={18}
                color={torEnabled ? colors.buttonPrimary : colors.textMuted}
              />
              <Text className="flex-1 font-pp-regular text-[12px] leading-[17px] text-text">
                Send RPC calls through anon-rpc
              </Text>
            </Pressable>

            {torEnabled && (
              <View className="gap-[6px]">
                {/* The anon-rpc network the client runs on (config/tor.ts
                    TOR_PROVIDERS). Nothing is picked for the user: tor-js is
                    only the starting chip, and nothing runs until Test or Save. On a
                    device only Tor (Arti) is listed. */}
                <View className="flex-row flex-wrap items-center gap-[6px]" testID="custom-rpc-tor-provider">
                  {TOR_PROVIDERS.map((provider) => {
                    const selected = provider.id === torProvider;
                    return (
                      <Pressable
                        key={provider.id}
                        className={`rounded-[10px] border px-[12px] py-[6px] ${selected ? 'border-button-primary' : 'border-border'}`}
                        onPress={() => { if (!selected) { setTorProvider(provider.id); setTorError(null); setTorChecked(false); } }}
                        disabled={checking || torProbing}
                        testID={`custom-rpc-tor-provider-${provider.id}`}
                        accessibilityRole="radio"
                        accessibilityState={{ checked: selected }}
                      >
                        <Text className="font-pp-medium text-[12px] text-text">{provider.label}</Text>
                      </Pressable>
                    );
                  })}
                  {selectedProvider && !TOR_ON_DEVICE && (
                    <HoverHint hint={selectedProvider.hint} testID="custom-rpc-tor-provider-hint" wrap>
                      {/* nw-keep(data-color): glyph colour is a runtime theme token (vector-icon sink) */}
                      <Ionicons name="information-circle-outline" size={14} color={colors.textMuted} />
                    </HoverHint>
                  )}
                </View>
                {torProvider === 'nox' && (
                  <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted" testID="custom-rpc-tor-nox-demo">
                    Nox is a demo network. Expect it to be slow or to go away.
                  </Text>
                )}
                {/* On a device the client dials Tor relays itself, and Nym and
                    Nox bring their own way in, so there is no gateway to name
                    or accept for those. */}
                {needsGateway && (<>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  value={torGateway}
                  onChangeText={(value) => { setTorGateway(value); setTorAcceptedSuggested(false); setTorError(null); setTorChecked(false); }}
                  // The shape, using the loopback address and the gateway's
                  // default port, because running one locally is the common
                  // case. A placeholder rather than a value: the certhash is
                  // unique to each gateway and printed at its startup, so
                  // there is no address that could be filled in for someone.
                  placeholder="127.0.0.1:12298:uEi..."
                  // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                  placeholderTextColor={colors.textMuted}
                  editable={!checking && !torProbing}
                  testID="custom-rpc-tor-gateway"
                  // Same treatment as an endpoint: the gateway names a host
                  // the user chose and must not ride the debug clickstream.
                  nativeID={`${SENSITIVE_INPUT_ID_PREFIX}custom-rpc-tor-gateway`}
                  className={`rounded-[12px] border border-border-light px-[14px] py-[12px] font-pp-regular text-[13px] leading-[18px] text-text ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
                />
                {/* Only when we are suggesting one. Accepting OUR gateway is
                    its own decision: the gateway sees that this browser
                    connected, so it must not arrive as a side effect of
                    ticking "send over Tor". */}
                {usingSuggestedGateway && (
                  <Pressable
                    className="flex-row items-center gap-[10px]"
                    onPress={() => setTorAcceptedSuggested((on) => !on)}
                    testID="custom-rpc-tor-accept-suggested"
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: torAcceptedSuggested }}
                  >
                    {/* nw-keep(data-color): checkbox glyph color is a theme token into the vector-icon sink */}
                    <Ionicons
                      name={torAcceptedSuggested ? 'checkbox' : 'square-outline'}
                      size={18}
                      color={torAcceptedSuggested ? colors.buttonPrimary : colors.textMuted}
                    />
                    <Text className="flex-1 font-pp-regular text-[12px] leading-[17px] text-text">
                      Use the gateway we suggest. It will see that you connected, but not what you asked for.
                    </Text>
                  </Pressable>
                )}
                </>)}
                <View className="flex-row items-center justify-between gap-[10px]">
                  <Text className="flex-1 font-pp-regular text-[11px] leading-[16px] text-text-muted">
                    {TOR_ON_DEVICE
                      ? 'Tor runs on this device. No gateway needed.'
                      : needsGateway
                        ? 'Works with our endpoints, so you do not need your own. A browser cannot reach the network on its own, so tor-js connects through a gateway. The one you pick sees that you connected, never what you asked for. Paste the ip:port:certhash address printed by a gateway you run, or accept ours above.'
                        : 'Works with our endpoints. No gateway needed.'}
                  </Text>
                  <Pressable
                    className="rounded-[10px] border border-border bg-transparent px-[12px] py-[8px]"
                    onPress={testTorGateway}
                    disabled={torProbing}
                    testID="custom-rpc-tor-test"
                  >
                    <Text className="font-pp-medium text-[12px] text-text">
                      {torProbing ? 'Checking' : 'Test'}
                    </Text>
                  </Pressable>
                </View>
                {torProbing && torStatus && (
                  <View className="flex-row items-center gap-[6px]" testID="custom-rpc-tor-status">
                    <ActivityIndicator size="small" color={colors.textMuted} />
                    <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted">{torStatus}</Text>
                  </View>
                )}
                {!torProbing && torChecked && !torError && (
                  <Text className="font-pp-regular text-[11px] leading-[16px] text-[#2E9B5B]" testID="custom-rpc-tor-ok">
                    {needsGateway ? 'Connected through that gateway.' : 'Connected.'}
                  </Text>
                )}
                {torError && (
                  <Text className="font-pp-regular text-[11px] leading-[16px] text-[#C24131]" testID="custom-rpc-tor-error">
                    {torError}
                  </Text>
                )}
                <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted">
                  {TOR_ON_DEVICE
                    ? 'Building a circuit takes a while, and every call is slower over anon-rpc.'
                    : 'Connecting takes a while, and every call is slower over anon-rpc. The client is only downloaded once you turn this on.'}
                </Text>
              </View>
            )}
            <View className="h-[1px] bg-border-light" />
  </>);
}

export function CustomRpcModalProvider({ children }: { children: React.ReactNode }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width: windowWidth } = useWindowDimensions();
  const isMobileSheet = windowWidth <= 540;

  const [visible, setVisible] = useState(false);
  const [rows, setRows] = useState<Record<number, RowState>>({});
  const [checking, setChecking] = useState(false);
  // Set once the probe has warned about something; a second press saves anyway.
  const [confirmable, setConfirmable] = useState(false);
  // Ticked by default, so doing nothing gives the behaviour that shipped
  // before this option existed.
  const [persist, setPersist] = useState(ACTIVE_CUSTOM_RPC_PERSISTENCE === 'local');
  const [formError, setFormError] = useState<string | null>(null);
  // Whether the per-chain endpoint section is shown. False only when the form
  // was opened as "Connect with Tor" and nothing is configured, so that entry
  // point is about one setting rather than a form with one relevant row.
  const [showEndpoints, setShowEndpoints] = useState(true);
  // Opened from "Connect with Tor": Tor leads and the endpoint fields follow
  // it. Ordering matters more than it looks, because the endpoint section is
  // long enough to push Tor off the bottom of a short window, which is how the
  // one setting the user came for ends up below the one they did not.
  const [torFirst, setTorFirst] = useState(false);

  // Tor. Seeded from what is in force this page load, like the rows above.
  const [torEnabled, setTorEnabled] = useState(ACTIVE_TOR_SETTINGS.enabled);
  const [torProvider, setTorProvider] = useState<TorProviderId>(ACTIVE_TOR_SETTINGS.provider);
  // Prefilled with the gateway we suggest, when we are running one, so the
  // common case is a tick rather than tracking down an address. Anything the
  // user already saved wins: a suggestion must never overwrite a choice.
  const [torGateway, setTorGateway] = useState(ACTIVE_TOR_SETTINGS.gatewayUrl || SUGGESTED_TOR_GATEWAY);
  // Accepting OUR gateway is its own decision, not a side effect of ticking
  // "send over Tor". The box below carries it, and saving refuses without it.
  const [torAcceptedSuggested, setTorAcceptedSuggested] = useState(
    ACTIVE_TOR_SETTINGS.gatewayUrl.length > 0 && ACTIVE_TOR_SETTINGS.gatewayUrl === SUGGESTED_TOR_GATEWAY,
  );
  const [torProbing, setTorProbing] = useState(false);
  // The step a running Test has reached, shown under it instead of a bare "Checking".
  const [torStatus, setTorStatus] = useState<string | null>(null);
  const [torChecked, setTorChecked] = useState(false);
  const [torError, setTorError] = useState<string | null>(null);

  const chains = useMemo(() => editableChains(), []);

  /**
   * Two endpoints per line, on a window wide enough to hold the modal at 680.
   *
   * The list is one row per EVM network and it only grows, so stacked it was
   * the tallest thing in the app while each field used a third of its line.
   * Pairing them roughly halves the height, which is what lets the form fit
   * an ordinary laptop window instead of running off the bottom of it.
   *
   * Two networks stay stacked: a single pair reads as a stray column and
   * saves one row of height, which is not worth the narrower fields.
   */
  const twoColumn = windowWidth >= 720 && chains.length > 2;

  // True only while the box actually holds the address we suggested. Typing
  // over it makes this false, which drops the confirmation requirement along
  // with the suggestion it applied to.
  // Only for a provider that takes a gateway: Nym and Nox have nothing to accept.
  const usingSuggestedGateway = SUGGESTED_TOR_GATEWAY.length > 0 && torGateway.trim() === SUGGESTED_TOR_GATEWAY
    && !TOR_ON_DEVICE && torNeedsGateway(torProvider);
  // Probing a new endpoint is still an RPC call. Turning Tor off in a draft
  // must not expose the current session before the user saves and reloads.
  const draftTorFetch = useMemo(() => visible && torEnabled && (!usingSuggestedGateway || torAcceptedSuggested)
    ? createTorFetch(torGateway, torProvider) : null,
  [visible, torEnabled, torGateway, torProvider, usingSuggestedGateway, torAcceptedSuggested]);
  useEffect(() => () => draftTorFetch?.close(), [draftTorFetch]);
  const rpcFetch = draftTorFetch ?? torFetchIfActive();

  // The probe awaits network I/O and the form stays usable, so the
  // post-await code must read what the rows are NOW, not what the closure
  // captured before the request went out.
  const latestRows = useRef(rows);
  useEffect(() => { latestRows.current = rows; }, [rows]);
  const latestSettings = useRef({ torEnabled, torProvider, torGateway, torAcceptedSuggested, persist });
  useEffect(() => { latestSettings.current = { torEnabled, torProvider, torGateway, torAcceptedSuggested, persist }; }, [torEnabled, torProvider, torGateway, torAcceptedSuggested, persist]);
  const formEpoch = useRef(0);
  const routeEpoch = useRef(0);
  const torProbeAbort = useRef<AbortController | null>(null);

  // A verdict and a "Save anyway" confirmation belong to the route tested.
  // Changing providers must also invalidate endpoint tests still in flight.
  useEffect(() => {
    routeEpoch.current++;
    setConfirmable(false);
    setRows((prev) => Object.fromEntries(Object.entries(prev).map(([id, row]) => [
      id, { ...row, status: 'idle' as const, warning: null },
    ])));
  }, [torEnabled, torProvider, torGateway, torAcceptedSuggested]);

  // Closing the form or changing the draft revokes an explicit Test. Merely
  // rendering or selecting a provider never starts a client or sends a call.
  useEffect(() => {
    setTorProbing(false);
    setTorStatus(null);
    setTorChecked(false);
    setTorError(null);
    return () => {
      torProbeAbort.current?.abort();
      torProbeAbort.current = null;
    };
  }, [visible, torEnabled, torProvider, torGateway, torAcceptedSuggested]);

  const openCustomRpcModal = useCallback((options?: { torOnly?: boolean }) => {
    torProbeAbort.current?.abort();
    torProbeAbort.current = null;
    // Opened from "Connect with Tor", the endpoint rows start hidden. Anyone
    // who already has an endpoint saved sees them anyway: hiding a setting
    // that is in force would misrepresent what the app is doing.
    // A device has no custom endpoint setting (it is web-only localStorage),
    // so the form there is the anon-rpc section alone.
    setTorFirst(TOR_ON_DEVICE || !!options?.torOnly);
    setShowEndpoints(!TOR_ON_DEVICE && (!options?.torOnly || editableChains().some(({ chainId }) => !!activeCustomRpcUrl(chainId))));
    const next: Record<number, RowState> = {};
    for (const { chainId } of editableChains()) {
      const saved = activeCustomRpcUrl(chainId);
      next[chainId] = { value: saved ?? '', saved, status: 'idle', error: null, warning: null };
    }
    formEpoch.current++;
    latestRows.current = next;
    setRows(next);
    setChecking(false);
    setPersist(ACTIVE_CUSTOM_RPC_PERSISTENCE === 'local');
    // Ticked on arrival from "Connect with Tor": pressing that and finding an
    // unticked box asks the user to state their intent twice. Nothing is saved
    // until Save, so this proposes rather than applies.
    setTorEnabled(options?.torOnly ? true : ACTIVE_TOR_SETTINGS.enabled);
    setTorProvider(ACTIVE_TOR_SETTINGS.provider);
    setTorGateway(ACTIVE_TOR_SETTINGS.gatewayUrl || SUGGESTED_TOR_GATEWAY);
    setTorAcceptedSuggested(
      ACTIVE_TOR_SETTINGS.gatewayUrl.length > 0 && ACTIVE_TOR_SETTINGS.gatewayUrl === SUGGESTED_TOR_GATEWAY,
    );
    setTorProbing(false);
    setTorStatus(null);
    setTorChecked(false);
    setTorError(null);
    setFormError(null);
    setConfirmable(false);
    setVisible(true);
  }, []);

  const closeCustomRpcModal = useCallback(() => {
    formEpoch.current++;
    torProbeAbort.current?.abort();
    torProbeAbort.current = null;
    setVisible(false);
  }, []);

  const ctx = useMemo(
    () => ({ openCustomRpcModal, closeCustomRpcModal }),
    [openCustomRpcModal, closeCustomRpcModal],
  );

  const editRow = useCallback((chainId: number, value: string) => {
    // Any edit invalidates a warning the user has not acted on yet, so the
    // "Save anyway" state cannot carry over onto a different value.
    setConfirmable(false);
    setFormError(null);
    setRows((prev) => ({ ...prev, [chainId]: { ...prev[chainId], value, status: 'idle', error: null, warning: null } }));
  }, []);

  /**
   * The one row whose value we can rewrite for the others, if any. Only offered
   * when there is actually somewhere to put it, so the button never appears and
   * then does nothing.
   */
  const prefill = useMemo(() => {
    for (const { chainId } of chains) {
      const value = rows[chainId]?.value?.trim();
      if (!value) continue;
      const provider = detectRpcProvider(value);
      if (!provider) continue;
      const derived = deriveSiblingRpcUrls(value, chainId, chains.map((c) => c.chainId));
      const empty = Object.keys(derived)
        .map(Number)
        .filter((id) => !rows[id]?.value?.trim());
      if (empty.length === 0) return { provider, derived: {} as Record<number, string>, count: 0 };
      return {
        provider,
        derived: Object.fromEntries(empty.map((id) => [id, derived[id]])) as Record<number, string>,
        count: empty.length,
      };
    }
    return undefined;
  }, [chains, rows]);

  /**
   * Send one test request per row and show the verdict beside it.
   *
   * A derived URL is a guess about someone else's URL scheme, so the honest
   * thing is to check it in front of the user rather than present it as fact
   * (Pat, 2026-09-11). The same button re-checks rows that were typed by hand,
   * because a typo and a bad guess fail identically and neither is visible
   * until something goes looking.
   */
  const testRows = useCallback(async (chainIds: number[]) => {
    const epoch = formEpoch.current;
    const route = routeEpoch.current;
    if (torEnabled) {
      const gateway = validateTorGatewayFor(torProvider, torGateway);
      if (!gateway.ok) { setTorError(gateway.message); return; }
      if (usingSuggestedGateway && !torAcceptedSuggested) {
        setTorError('Tick the box to use the gateway we suggest, or paste your own address.');
        return;
      }
    }
    const targets = chainIds.filter((chainId) => {
      const raw = latestRows.current[chainId]?.value?.trim() ?? '';
      return raw.length > 0 && validateCustomRpcUrl(raw).ok;
    });
    if (targets.length === 0) return;
    setRows((prev) => {
      const next = { ...prev };
      for (const chainId of targets) next[chainId] = { ...next[chainId], status: 'checking', warning: null };
      return next;
    });
    await Promise.all(targets.map(async (chainId) => {
      const before = latestRows.current[chainId]?.value?.trim() ?? '';
      const checked = validateCustomRpcUrl(before);
      if (!checked.ok) return;
      const result = await probeRpcUrl(checked.url, chainId, {
        fetchImpl: rpcFetch ?? undefined, timeoutMs: rpcFetch ? TOR_PROBE_TIMEOUT_MS : undefined,
      });
      if (formEpoch.current !== epoch || routeEpoch.current !== route) return;
      setRows((prev) => {
        // The field may have moved while this was in flight. A verdict about a
        // URL that is no longer in the box would be a green tick next to
        // something nobody checked.
        if ((prev[chainId]?.value?.trim() ?? '') !== before) return prev;
        return {
          ...prev,
          [chainId]: {
            ...prev[chainId],
            status: result.outcome === 'ok' ? 'ok' : 'fail',
            warning: result.outcome === 'ok'
              ? null
              : RPC_PROBE_MESSAGES[result.outcome as Exclude<typeof result.outcome, 'ok'>],
          },
        };
      });
    }));
  }, [torEnabled, torProvider, torGateway, usingSuggestedGateway, torAcceptedSuggested, rpcFetch]);

  const applyPrefill = useCallback(() => {
    if (!prefill || prefill.count === 0) return;
    const filled = Object.keys(prefill.derived).map(Number);
    setRows((prev) => {
      const next = { ...prev };
      for (const [key, url] of Object.entries(prefill.derived)) {
        const id = Number(key);
        next[id] = { ...next[id], value: url, status: 'idle', error: null, warning: null };
      }
      latestRows.current = next;
      return next;
    });
    setConfirmable(false);
    // Check what was just guessed, immediately, without waiting for a save.
    void testRows(filled);
  }, [prefill, testRows]);

  const testAll = useCallback(() => {
    void testRows(chains.map(({ chainId }) => chainId));
  }, [chains, testRows]);

  /*
   * The networks this form is about to stop querying.
   *
   * Filling one field switches the account-key sweep to the user's endpoints
   * and stops falling back to the defaults for the rest, so the rest go
   * unqueried. That is the point, but it also means a balance disappears, and
   * a balance that disappears without being mentioned is the worst version of
   * this change. Read from the DRAFT rows rather than what is saved, so the
   * warning appears while typing rather than after the reload.
   */
  const draftEntries = Object.fromEntries(chains.flatMap(({ chainId }) => {
    const raw = rows[chainId]?.value?.trim() ?? '';
    return raw === (rows[chainId]?.saved ?? '') ? [] : [[chainId, raw || null]];
  }));
  const skippedIds = skippedChainIds(chains.map(({ chainId }) => chainId), previewCustomRpcMany(draftEntries));
  const skipped = chains.filter(({ chainId }) => skippedIds.includes(chainId));

  const handleSave = useCallback(async (useOurs = false) => {
    if (checking) return;
    const epoch = formEpoch.current;
    const route = routeEpoch.current;
    setFormError(null);
    // On a device only the anon-rpc choice is saved, and the transports are
    // rebuilt by reloading the JS bundle, the device's page reload.
    if (TOR_ON_DEVICE) {
      if (!saveTorSettings({ enabled: torEnabled, gatewayUrl: '', provider: torProvider })) {
        setFormError(DEVICE_STORAGE_REFUSED);
        return;
      }
      formEpoch.current++;
      setVisible(false);
      if (torEnabled !== ACTIVE_TOR_SETTINGS.enabled || torProvider !== ACTIVE_TOR_SETTINGS.provider) {
        void reloadAppAsync('anon-rpc setting changed');
      }
      return;
    }
    const gateway = torEnabled ? validateTorGatewayFor(torProvider, torGateway) : null;
    if (gateway && !gateway.ok) {
      setTorError(gateway.message);
      return;
    }
    // Ours needs the tick. Refusing here rather than saving without it is the
    // point: the alternative is routing someone through a gateway they never
    // agreed to, because it happened to be in the box already.
    if (torEnabled && usingSuggestedGateway && !torAcceptedSuggested) {
      setTorError('Tick the box to use the gateway we suggest, or paste your own address.');
      return;
    }

    // 1. Validate everything first, so a bad row is reported before any probe
    //    goes out and before anything is written.
    //
    //    Only rows the user actually CHANGED go into the write. Including
    //    untouched rows re-enabled the cross-tab clobber the storage merge
    //    exists to prevent: another tab sets chain 1, this tab (loaded before
    //    that) saves chain 10, and chain 1 gets written back from this tab's
    //    stale empty field, deleting the other tab's endpoint (kimi,
    //    2026-09-11).
    // Reset also clears endpoints from another environment, otherwise a hidden
    // override would keep every visible empty chain excluded from discovery.
    const entries: Record<number, string | null> = useOurs
      ? Object.fromEntries(Object.keys(previewCustomRpcMany({})).map(key => [key, null])) : {};
    const errors: Record<number, string> = {};
    for (const { chainId } of useOurs ? [] : chains) {
      const raw = rows[chainId]?.value?.trim() ?? '';
      const saved = rows[chainId]?.saved;
      if (raw.length === 0) {
        if (saved) entries[chainId] = null;
        continue;
      }
      const checked = validateCustomRpcUrl(raw);
      if (!checked.ok) errors[chainId] = checked.message;
      else if (checked.url !== saved) entries[chainId] = checked.url;
    }
    if (Object.keys(errors).length > 0) {
      setRows((prev) => {
        const next = { ...prev };
        for (const [key, message] of Object.entries(errors)) {
          next[Number(key)] = { ...next[Number(key)], error: message, warning: null };
        }
        return next;
      });
      return;
    }

    // 2. Probe what is about to be written. Unchanged rows are not re-probed:
    //    that would add latency and tell an endpoint we are still here, for no
    //    new information.
    if (!confirmable) {
      const changed = Object.keys(entries)
        .map(Number)
        .filter((chainId) => typeof entries[chainId] === 'string');
      if (changed.length > 0) {
        setChecking(true);
        const results = await Promise.all(
          changed.map(async (chainId) => ({
            chainId,
            result: await probeRpcUrl(entries[chainId] as string, chainId, {
              fetchImpl: rpcFetch ?? undefined, timeoutMs: rpcFetch ? TOR_PROBE_TIMEOUT_MS : undefined,
            }),
          })),
        );
        if (formEpoch.current !== epoch) return;
        setChecking(false);

        // The probe awaited network I/O and the fields stayed editable.
        // If anything moved under it, the verdict describes a value that is no
        // longer in the form: going on would either save a stale URL or let a
        // "Save anyway" consent given for URL X apply to URL Y, unprobed, which
        // is precisely the wrong-row mistake the probe exists to catch (kimi,
        // 2026-09-11). Ask for another press instead.
        const moved = latestRows.current;
        const settings = latestSettings.current;
        if (routeEpoch.current !== route
          || chains.some(({ chainId }) => (moved[chainId]?.value?.trim() ?? '') !== (rows[chainId]?.value?.trim() ?? ''))
          || settings.torEnabled !== torEnabled || settings.torProvider !== torProvider || settings.torGateway !== torGateway
          || settings.torAcceptedSuggested !== torAcceptedSuggested || settings.persist !== persist) {
          setFormError('A field changed while the endpoints were being checked. Press Save again.');
          return;
        }

        const warnings = results.filter((r) => r.result.outcome !== 'ok');
        if (warnings.length > 0) {
          setRows((prev) => {
            const next = { ...prev };
            for (const { chainId, result } of warnings) {
              next[chainId] = {
                ...next[chainId],
                status: 'fail',
                warning: RPC_PROBE_MESSAGES[result.outcome as Exclude<typeof result.outcome, 'ok'>],
              };
            }
            return next;
          });
          // Warn rather than block: a browser probe fails for reasons that say
          // nothing about whether the node serves the app (a proxy, a refused
          // CORS preflight, a node that does not implement eth_chainId), and
          // blocking would break the self-hosted setups this exists for.
          setConfirmable(true);
          return;
        }
        setRows((prev) => {
          const next = { ...prev };
          for (const { chainId } of results) next[chainId] = { ...next[chainId], status: 'ok', warning: null };
          return next;
        });
      }
    }

    const pendingSkipped = skippedChainIds(chains.map(({ chainId }) => chainId), previewCustomRpcMany(entries));
    if ((!useOurs && pendingSkipped.join(',') !== skippedIds.join(',')) || (useOurs && pendingSkipped.length > 0)) {
      setFormError('RPC settings changed in another tab. Review the excluded networks and press Save again.');
      return;
    }

    // 3. Tor, before the endpoints, because applyCustomRpcMany reloads the
    //    page and anything written after it would be lost. A ticked box with
    //    an unusable gateway is refused here rather than stored: storing it
    //    would leave someone believing they are on Tor while nothing is.
    const torSettings = { enabled: torEnabled, gatewayUrl: gateway?.ok ? gateway.url : '', provider: torProvider };
    if (!saveTorSettings(torSettings)) {
      setFormError(STORAGE_REFUSED);
      return;
    }

    // 4. One write, one reload, however many rows changed.
    if (!applyCustomRpcMany(entries, persist ? 'local' : 'session')) {
      setFormError(STORAGE_REFUSED);
      return;
    }
    formEpoch.current++;
    setVisible(false);
  }, [checking, chains, rows, confirmable, persist, torEnabled, torProvider, torGateway, usingSuggestedGateway, torAcceptedSuggested, skippedIds, rpcFetch]);

  /**
   * Check the gateway before saving.
   *
   * Loads the selected client and checks a Tor exit or a fixed public RPC
   * response through it. It is slow by nature; the button says so.
   */
  const testTorGateway = useCallback(async () => {
    if (!torEnabled || torProbing || torProbeAbort.current) return;
    const epoch = formEpoch.current;
    const gateway = validateTorGatewayFor(torProvider, torGateway);
    if (!gateway.ok) {
      setTorError(gateway.message);
      setTorChecked(false);
      return;
    }
    if (!TOR_ON_DEVICE && usingSuggestedGateway && !torAcceptedSuggested) {
      setTorError('Tick the box to use the gateway we suggest, or paste your own address.');
      return;
    }
    setTorProbing(true);
    setTorError(null);
    // A new Test replaces the last result rather than showing it beside "Checking".
    setTorChecked(false);
    setTorStatus(null);
    const controller = new AbortController();
    torProbeAbort.current = controller;
    const result = await probeTorGateway(gateway.url, undefined, torProvider, (step) => {
      if (formEpoch.current === epoch && torProbeAbort.current === controller) setTorStatus(TOR_PROBE_STEP_TEXT[step]);
    }, controller.signal);
    if (formEpoch.current !== epoch || torProbeAbort.current !== controller) return;
    torProbeAbort.current = null;
    setTorProbing(false);
    setTorStatus(null);
    if (latestSettings.current.torGateway !== torGateway || latestSettings.current.torProvider !== torProvider
      || !latestSettings.current.torEnabled) return;
    setTorChecked(true);
    setTorError(result.ok ? null : result.message);
  }, [torEnabled, torProbing, torProvider, torGateway, usingSuggestedGateway, torAcceptedSuggested]);

  const handleUseOurs = useCallback(() => {
    void handleSave(true);
  }, [handleSave]);

  const anySaved = chains.some(({ chainId }) => rows[chainId]?.saved) || Object.keys(previewCustomRpcMany({})).length > 0;
  const anyFilled = chains.some(({ chainId }) => (rows[chainId]?.value?.trim() ?? '').length > 0);

  // Any row that was derived rather than typed is still showing a guess until
  // it has been tested, which is what the copy above asks the user to do.
  const anyDerived = chains.some(({ chainId }) => {
    const value = rows[chainId]?.value?.trim() ?? '';
    return value.length > 0 && value !== rows[chainId]?.saved && rows[chainId]?.status === 'idle';
  });


  return (
    <CustomRpcModalContext.Provider value={ctx}>
      {children}
      <Modal
        visible={visible}
        transparent
        animationType={isMobileSheet ? 'slide' : 'fade'}
        onRequestClose={closeCustomRpcModal}
      >
        <Pressable className="absolute inset-0 bg-[rgba(0,0,0,0.6)]" onPress={closeCustomRpcModal} />
        <View
          className={`flex-1 items-center ${isMobileSheet ? 'justify-end p-0' : 'justify-center p-[20px]'}`}
          pointerEvents="box-none"
        >
          <View
            className={`w-full overflow-hidden border border-border bg-card-background ${isMobileSheet ? 'max-w-full max-h-[94%] rounded-t-[24px] rounded-b-none border-b-0 pt-[26px]' : `${twoColumn ? 'max-w-[680px]' : 'max-w-[460px]'} max-h-[88%] rounded-[20px]`}`}
          >
            {/* nw-keep(data-color): sheet grabber fill is a runtime theme token (no class value) */}
            {isMobileSheet && (
              <View
                className="absolute top-[10px] z-[10] h-[4px] w-[44px] self-center rounded-[2px]"
                style={{ backgroundColor: colors.border }}
              />
            )}

            {/*
              Three bands: a pinned header, a scrolling middle, a pinned
              footer. It used to be one ScrollView holding everything
              including Save, and on a short window Save sat below the fold
              with the page behind it not scrolling, so the form could not be
              completed at all. QA got out of it by making the browser window
              smaller, which is the wrong direction and the giveaway (Mike,
              2026-09-22: "so can't click confirm on custom rpc").

              `shrink-0` on the bands and `min-h-0` on the scroller are what
              make that hold on web: without min-h-0 a flex child refuses to
              shrink below its content, the middle band pushes the footer past
              the bottom edge, and the whole arrangement quietly degrades back
              into the bug it replaced.
            */}
            <View className="shrink-0 flex-row items-center justify-between px-[20px] pb-[14px] pt-[20px]">
              {/* Named after the door the user came through. Calling it
                  Custom RPC after they pressed "Connect with Tor" reads as
                  the wrong dialog. */}
              <Text className="font-pp-bold text-[18px] text-text">{torFirst ? 'Connect with anon-rpc' : 'Custom RPC'}</Text>
              <Pressable onPress={closeCustomRpcModal} hitSlop={8} testID="custom-rpc-close">
                {/* nw-keep(data-color): close glyph color is the text-secondary theme token into the vector-icon sink */}
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>

            <ScrollView
              // The native sheet sizes to its content, so flex-1 (basis 0)
              // collapsed this band to nothing there. Web keeps the bounded
              // window it scrolls within.
              className={TOR_ON_DEVICE ? 'grow-0' : 'min-h-0 flex-1'}
              contentContainerClassName="gap-[14px] px-[20px] pb-[16px]"
              // Hides the web scrollbar. The band still scrolls by wheel,
              // trackpad, touch drag and keyboard; only the bar is gone.
              showsVerticalScrollIndicator={false}
              testID="custom-rpc-scroll"
            >
              {torFirst && (
                <Text className="font-pp-regular text-[13px] leading-[18px] text-text-muted">
                  Send this app&apos;s calls through anon-rpc. This works with our endpoints, so there is nothing else to set up.
                </Text>
              )}

              {/* Tor leads when that is what the user came for. */}
              {torFirst && <TorSection
                colors={colors} colorScheme={colorScheme} checking={checking}
                torEnabled={torEnabled} setTorEnabled={setTorEnabled}
                torProvider={torProvider} setTorProvider={setTorProvider}
                torGateway={torGateway} setTorGateway={setTorGateway}
                torAcceptedSuggested={torAcceptedSuggested} setTorAcceptedSuggested={setTorAcceptedSuggested}
                torProbing={torProbing} torStatus={torStatus} torChecked={torChecked} torError={torError}
                setTorChecked={setTorChecked} setTorError={setTorError}
                usingSuggestedGateway={usingSuggestedGateway} testTorGateway={testTorGateway}
              />}

              {showEndpoints && (
              <Text className="font-pp-regular text-[13px] leading-[18px] text-text-muted">
                Send this app&apos;s calls to your own nodes instead of ours. One endpoint per network. Once you set one, networks left empty are excluded from the account scan. Clear every endpoint to use ours again.
              </Text>
              )}

              {showEndpoints && (<>
              {/*
                A free endpoint answers, so the form goes green, and then the
                account takes about twenty minutes to appear because discovery
                is thousands of queries and a public gateway rate-limits them.
                Nothing is broken and nothing looks broken, which is the worst
                shape a wait can have, so it is said here rather than found
                out (Mike, 2026-09-22, after a 20 minute login on a public
                gateway).
              */}
              <View className="flex-row items-start gap-[8px] rounded-[8px] bg-background-secondary p-[10px]">
                {/* nw-keep(data-color): hint glyph color is the text-muted theme token into the vector-icon sink */}
                <Ionicons name="time-outline" size={14} color={colors.textMuted} />
                <Text className="flex-1 font-pp-regular text-[12px] leading-[17px] text-text-muted" testID="custom-rpc-speed-notice">
                  We recommend using your own RPC. On a free public endpoint, expect your account to take around 20 minutes to load.
                </Text>
              </View>

              <View className={twoColumn ? 'flex-row flex-wrap justify-between gap-y-[14px]' : 'gap-[14px]'}>
              {chains.map(({ chainId, name }) => {
                const row = rows[chainId];
                return (
                  // Two per line when there is room. `justify-between` on the
                  // wrapper does the gutter, so an odd last row sits left
                  // rather than stretching to fill the line.
                  //
                  // Both widths are static classes rather than a style object:
                  // an inline style here is an unclassified sink and the
                  // NativeWind audit fails the build over it, rightly, since
                  // there is nothing runtime about either value.
                  <View key={chainId} className={`gap-[6px] ${twoColumn ? 'w-[48.5%]' : 'w-full'}`}>
                    <View className="flex-row items-center justify-between">
                      <Text className="font-pp-medium text-[12px] text-text-secondary">{name}</Text>
                      <View className="flex-row items-center gap-[8px]">
                        {row?.saved && (
                          <Text className="font-pp-regular text-[11px] text-text-muted">in use</Text>
                        )}
                        {/* nw-keep(data-color): verdict glyph colors are literal status colors into the vector-icon sink */}
                        {row?.status === 'checking' && <ActivityIndicator size="small" color={colors.textMuted} />}
                        {row?.status === 'ok' && (
                          <Ionicons name="checkmark-circle" size={16} color="#2E9B5B" testID={`custom-rpc-ok-${chainId}`} />
                        )}
                        {row?.status === 'fail' && (
                          <Ionicons name="close-circle" size={16} color="#C24131" testID={`custom-rpc-fail-${chainId}`} />
                        )}
                      </View>
                    </View>
                    <TextInput
                      autoCapitalize="none"
                      autoCorrect={false}
                      keyboardType="url"
                      value={row?.value ?? ''}
                      onChangeText={(value) => editRow(chainId, value)}
                      placeholder="https://my-node.example/rpc"
                      // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                      placeholderTextColor={colors.textMuted}
                      editable={!checking}
                      testID={`custom-rpc-input-${chainId}`}
                      // Keeps the value out of the debug clickstream, which
                      // records every other field edit and can be exported.
                      nativeID={`${SENSITIVE_INPUT_ID_PREFIX}custom-rpc-${chainId}`}
                      className={`rounded-[12px] border border-border-light px-[14px] py-[12px] font-pp-regular text-[13px] leading-[18px] text-text ${colorScheme === 'dark' ? 'bg-[#121314]' : 'bg-[#FAFAFA]'}`}
                    />
                    {row?.error && (
                      <Text className="font-pp-regular text-[11px] leading-[16px] text-[#C24131]" testID={`custom-rpc-error-${chainId}`}>
                        {row.error}
                      </Text>
                    )}
                    {row?.warning && (
                      <Text className="font-pp-regular text-[11px] leading-[16px] text-[#B26B00]" testID={`custom-rpc-warning-${chainId}`}>
                        {row.warning}
                      </Text>
                    )}
                  </View>
                );
              })}
              </View>

              {prefill && prefill.count > 0 && (
                <Pressable
                  className="rounded-[12px] border border-border bg-transparent px-[14px] py-[10px]"
                  onPress={applyPrefill}
                  testID="custom-rpc-prefill"
                >
                  <Text className="font-pp-medium text-[12px] text-text">
                    {`That looks like ${PROVIDER_LABELS[prefill.provider] ?? prefill.provider}. Fill the other ${prefill.count === 1 ? 'network' : `${prefill.count} networks`} from it.`}
                  </Text>
                </Pressable>
              )}

              {/* Below the prefill button on purpose: the button is the
                  one-click way out of this warning, so it should already have
                  been read by the time the warning explains why it matters. */}
              {skipped.length > 0 && (
                <View
                  className="flex-row items-start gap-[8px] rounded-[8px] border border-[#E0A93B] bg-transparent p-[10px]"
                  testID="custom-rpc-skipped"
                >
                  {/* nw-keep(data-color): warning glyph color is a literal status color into the vector-icon sink */}
                  <Ionicons name="alert-circle-outline" size={14} color="#B26B00" />
                  <Text className="flex-1 font-pp-regular text-[12px] leading-[17px] text-[#B26B00]">
                    {`${skipped.length === 1 ? '1 network has' : `${skipped.length} networks have`} no endpoint: ${skipped
                      .map(({ name }) => name)
                      .join(', ')}. Once you save, those are not checked at all and your funds there will not show. Fill them in to see everything.`}
                  </Text>
                </View>
              )}

              {anyFilled && (
                <View className="flex-row items-center justify-between gap-[10px]">
                  <Text className="flex-1 font-pp-regular text-[11px] leading-[16px] text-text-muted">
                    {anyDerived
                      ? 'Filled from the one you entered, so please check each is right. A tick means it answered for that network.'
                      : 'A tick means the endpoint answered for that network.'}
                  </Text>
                  <Pressable
                    className="rounded-[10px] border border-border bg-transparent px-[12px] py-[8px]"
                    onPress={testAll}
                    testID="custom-rpc-test-all"
                  >
                    <Text className="font-pp-medium text-[12px] text-text">Test all</Text>
                  </Pressable>
                </View>
              )}
              {prefill && prefill.count === 0 && prefill.provider === 'dappnode' && (
                <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted">
                  DAppNode runs a separate node per network, so the others have to be set by hand.
                </Text>
              )}
              </>)}

              {/* The way back to the endpoint fields from the Tor-only view.
                  One way only: once they are showing, hiding them again would
                  put a draft the user has typed out of sight while it still
                  saves. */}
              {!showEndpoints && !TOR_ON_DEVICE && (
                <Pressable
                  className="flex-row items-center gap-[10px]"
                  onPress={() => setShowEndpoints(true)}
                  testID="custom-rpc-show-endpoints"
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: false }}
                >
                  {/* nw-keep(data-color): checkbox glyph color is a theme token into the vector-icon sink */}
                  <Ionicons name="square-outline" size={18} color={colors.textMuted} />
                  <Text className="flex-1 font-pp-regular text-[12px] leading-[17px] text-text">
                    Also send to my own endpoints instead of ours
                  </Text>
                </Pressable>
              )}

              {formError && (
                <View className="rounded-[12px] border border-[#F2B8B5] bg-[#FFF4F4] px-[14px] py-[12px]">
                  <Text className="font-pp-regular text-[12px] leading-[18px] text-[#C24131]" testID="custom-rpc-error">
                    {formError}
                  </Text>
                </View>
              )}

              {!TOR_ON_DEVICE && (
              <View className="flex-row items-start gap-[8px] rounded-[8px] bg-background-secondary p-[10px]">
                {/* nw-keep(data-color): warning glyph color is the text-muted theme token into the vector-icon sink */}
                <Ionicons name="eye-outline" size={14} color={colors.textMuted} />
                <Text className="flex-1 font-pp-regular text-[12px] leading-[17px] text-text-muted">
                  Whoever runs an endpoint sees the requests this app makes from your browser.
                </Text>
              </View>
              )}

              {!torFirst && <TorSection
                colors={colors} colorScheme={colorScheme} checking={checking}
                torEnabled={torEnabled} setTorEnabled={setTorEnabled}
                torProvider={torProvider} setTorProvider={setTorProvider}
                torGateway={torGateway} setTorGateway={setTorGateway}
                torAcceptedSuggested={torAcceptedSuggested} setTorAcceptedSuggested={setTorAcceptedSuggested}
                torProbing={torProbing} torStatus={torStatus} torChecked={torChecked} torError={torError}
                setTorChecked={setTorChecked} setTorError={setTorError}
                usingSuggestedGateway={usingSuggestedGateway} testTorGateway={testTorGateway}
              />}

              {TOR_ON_DEVICE ? (
                <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted">
                  Saving restarts the app.
                </Text>
              ) : (<>
              <Pressable
                className="flex-row items-center gap-[10px]"
                onPress={() => setPersist((on) => !on)}
                testID="custom-rpc-persist"
                accessibilityRole="checkbox"
                accessibilityState={{ checked: persist }}
              >
                {/* nw-keep(data-color): checkbox glyph color is a theme token into the vector-icon sink */}
                <Ionicons
                  name={persist ? 'checkbox' : 'square-outline'}
                  size={18}
                  color={persist ? colors.buttonPrimary : colors.textMuted}
                />
                <Text className="flex-1 font-pp-regular text-[12px] leading-[17px] text-text">
                  Keep these after I close this tab
                </Text>
              </Pressable>
              <Text className="font-pp-regular text-[11px] leading-[16px] text-text-muted">
                {persist
                  ? 'Saving reloads the page.'
                  : 'Saving reloads the page. These endpoints stay for this tab only and are gone when you close it.'}
              </Text>
              </>)}
            </ScrollView>

            {/*
              Pinned. This is the band that was unreachable, so it is the one
              band that never scrolls: whatever the window height, Save is on
              screen. The top border tells the eye where the scrolling stops,
              which also makes it obvious that there is more above.
            */}
            <View className="shrink-0 flex-row flex-wrap items-center justify-end gap-[10px] border-t border-border-light px-[20px] py-[14px]">
              {/* Clearing endpoints is meaningless while they are hidden, and
                  the Tor-only view never hides a saved one, so this cannot be
                  the only way to reach a setting that is in force. */}
              {anySaved && showEndpoints && (
                <Pressable
                  className="h-[46px] min-w-[120px] items-center justify-center rounded-[12px] border border-border bg-transparent px-[18px]"
                  onPress={handleUseOurs}
                  disabled={checking}
                  testID="custom-rpc-use-ours"
                >
                  <Text className="font-pp-medium text-[14px] text-text">Use our RPCs</Text>
                </Pressable>
              )}
              <Pressable
                className="h-[46px] min-w-[132px] flex-row items-center justify-center gap-[8px] rounded-[12px] bg-button-primary px-[18px]"
                onPress={() => { void handleSave(); }}
                disabled={checking}
                testID="custom-rpc-save"
              >
                {checking && <ActivityIndicator size="small" color={colors.buttonPrimaryText} />}
                <Text className="font-pp-medium text-[14px] text-button-primary-text">
                  {checking ? 'Checking' : confirmable ? 'Save anyway' : 'Save'}
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </CustomRpcModalContext.Provider>
  );
}
