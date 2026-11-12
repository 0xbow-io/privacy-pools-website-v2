import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { usePathname, useRootNavigationState, useRouter } from 'expo-router';
import { ActiveDesignVariant } from '@/constants/theme';
import { usePools } from '@/components/pools-provider';
import { useAccount } from 'wagmi';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { usePoolSession } from '@/hooks/use-pool-session';
import { useWalletUnlockGate } from '@/hooks/use-wallet-unlock-gate';
import { useChainRouter } from '@/hooks/use-chain-router';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import {
  decideConnectLandingInvariant,
  hasAnyBalance,
  hasPublicDepositActivity,
  shouldOpenSeedOnConnectLanding,
  type ConnectLandingPhase,
} from '@/services/connect-landing';
import {
  getUiParam,
  installUiUrlGuard,
  notifyUiUrl,
  pushUiParamEntry,
  replaceMissingUiParam,
  setUiParamEntry,
  subscribeUiUrl,
  type UiUrlEvent,
} from '@/components/ui-url-events';

type LandingMachine = {
  phase: ConnectLandingPhase;
  stopReason: 'navigation' | 'managed-dismiss' | null;
};

type LandingMachineAction =
  | { type: 'arm' }
  | { type: 'land' }
  | { type: 'stop'; reason: Exclude<LandingMachine['stopReason'], null> }
  /** A fresh connection or different identity starts a new one-shot cycle. */
  | { type: 'reset' };

const INITIAL_MACHINE: LandingMachine = { phase: 'waiting', stopReason: null };

/** Monotonic lifecycle per identity: waiting -> armed -> enforcing, or
 *  terminal stopped — until a fresh connection or identity change (reset). */
function reduceLandingMachine(state: LandingMachine, action: LandingMachineAction): LandingMachine {
  if (action.type === 'reset') return INITIAL_MACHINE;
  if (state.phase === 'stopped') return state;
  if (action.type === 'stop') return { phase: 'stopped', stopReason: action.reason };
  if (action.type === 'arm' && state.phase === 'waiting') return { phase: 'armed', stopReason: null };
  if (action.type === 'land' && state.phase === 'armed') return { phase: 'enforcing', stopReason: null };
  return state;
}

type LiveUiUrl = {
  pathname: string;
  panel: string | null;
  /** A managed overlay (wallet picker `?modal=connect`, tx detail, …) is on
   *  top. Landing under one is a trap: the overlay's close pops ITS history
   *  entry, taking a panel pushed after it along — which then reads as the
   *  user dismissing a panel they never saw. */
  overlay: boolean;
  revision: number;
};

const OVERLAY_PARAMS = ['modal', 'tx', 'connect', 'notifications'] as const;

function overlayFromSearch(search: string): boolean {
  const params = new URLSearchParams(search);
  return OVERLAY_PARAMS.some((key) => params.get(key) !== null);
}

function readLiveUiUrl(revision = 0): LiveUiUrl {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    return { pathname: '/', panel: null, overlay: false, revision };
  }
  return {
    pathname: window.location.pathname,
    panel: getUiParam('panel'),
    overlay: overlayFromSearch(window.location.search),
    revision,
  };
}

function panelFromSnapshot(search: string): string | null {
  return new URLSearchParams(search).get('panel');
}

/**
 * Land a FRESHLY CONNECTED funded identity on My balances and keep that
 * landing visible until the user makes a real choice.
 *
 * "Freshly connected" is the policy, not an optimisation: the landing follows
 * the ACT of connecting (or importing a key, or switching accounts) in this
 * page session. A session merely RESTORED at boot — refresh `/` while already
 * connected — does not redirect: the user asked for the home page and gets it.
 * Mechanically, a fresh connect is a connect that follows a WITNESSED settled
 * signed-out moment in this mount; a boot restore goes connecting/reconnecting
 * → connected without ever being settled-disconnected, so it never qualifies.
 *
 * Signing out mid-session resets the whole machine — the panel close that
 * accompanies a logout used to be recorded as the user dismissing the landing,
 * which silently killed it for the NEXT connect of the same wallet.
 *
 * There is deliberately no settle clock, retry clock, or polling watchdog.
 * React state supplies identity/router/pool changes, while the UI-URL channel
 * supplies every managed History mutation. Once the first landing enters the
 * `enforcing` phase, a silent router/History strip is another state change and
 * the invariant is restored on the current entry. A managed close/switch or a
 * route change moves the machine to terminal `stopped` for this mount.
 */

export function ConnectBalanceLanding() {
  const router = useRouter();
  const pathname = usePathname() ?? '/';
  const navState = useRootNavigationState();
  const routerReady = !!navState?.key;
  const { isConnected, address } = useMultiChainWallet();
  // wagmi's OWN lifecycle: 'connecting'/'reconnecting' mean the report isn't
  // final — arming or stop decisions taken mid-reconnect misread the session
  // (the boot-time false dismissal). Key sessions have no wagmi lifecycle and
  // count as settled.
  const { status: wagmiStatus } = useAccount();
  const walletSettled = wagmiStatus === 'connected' || wagmiStatus === 'disconnected';
  const { data, isLoading: poolsLoading } = usePools();
  const { keysReady, identityMode, sessionAddress } = usePoolSession();
  const { openSeedDerivationModal } = useSeedDerivationModal();

  // An imported account key is a complete wallet-less identity. It also wins
  // over a connected wallet, which is merely the payer while key mode is live.
  const keySessionAddress = identityMode === 'key' ? sessionAddress ?? undefined : undefined;
  const landingConnected = isConnected || !!keySessionAddress;
  const landingAddress = keySessionAddress ?? address;
  const sessionLocked = identityMode === 'wallet' && !keysReady;
  // The unlock dialog is the EVM session's. On Sui or Stellar it would ask
  // MetaMask to sign on Sepolia, never the chain's own wallet.
  const { isSui: chainIsSui, isStellar: chainIsStellar } = useChainRouter();
  const nonEvmChain = chainIsSui || chainIsStellar;

  const cachedBalance = hasAnyBalance(data.myPools);
  const feedHit = hasPublicDepositActivity(data.transactions, landingAddress);
  // The SAME number the home door renders ("My balances ($326)"): if the page
  // can show the user a balance, the landing has no business claiming it
  // cannot tell whether they are funded. Per-pool rows can lag this aggregate
  // (it comes straight from the stats snapshot), so it is its own signal.
  const statsUsd = data.myPoolsStats?.acceptedFundsUsd ?? 0;
  const funded =
    (data.myPoolsStats?.totalDeposits ?? 0) > 0
    || feedHit
    || cachedBalance
    || statsUsd > 0;

  const [machine, setMachine] = useState<LandingMachine>(INITIAL_MACHINE);
  const machineRef = useRef(machine);
  const send = useCallback((action: LandingMachineAction) => {
    const next = reduceLandingMachine(machineRef.current, action);
    if (next === machineRef.current) return;
    machineRef.current = next;
    setMachine(next);
  }, []);

  const [liveUiUrl, setLiveUiUrl] = useState<LiveUiUrl>(() => readLiveUiUrl());
  const liveUiUrlRef = useRef(liveUiUrl);
  const landingDismissedRef = useRef(false);
  const seedOpenedRef = useRef(false);

  // A `/?intro=true` load is an explicit ask for the marketing page — the
  // balances landing must not hijack it, even after the intro is dismissed
  // (the user is already mid-session by then). Latched for the page load.
  const introDemoRef = useRef(
    Platform.OS === 'web' && typeof window !== 'undefined'
      && new URL(window.location.href).searchParams.get('intro') === 'true',
  );

  // Fresh-connect witness: true once this mount has SEEN a settled signed-out
  // state. Only a connect that follows one is the user's act; a session
  // restored at boot never passes through it and must not redirect.
  const witnessedSignedOutRef = useRef(false);
  const prevConnectedRef = useRef<boolean | null>(null);
  const previousIdentityRef = useRef<string | null>(null);
  useEffect(() => {
    if (!landingConnected && walletSettled) witnessedSignedOutRef.current = true;
    const prev = prevConnectedRef.current;
    prevConnectedRef.current = landingConnected;
    if (prev === false && landingConnected && witnessedSignedOutRef.current) {
      // Navigation while signed out belongs to the previous visit. Connecting
      // deliberately starts a new landing/sign-in opportunity for this wallet.
      landingDismissedRef.current = false;
      seedOpenedRef.current = false;
      send({ type: 'reset' });
    }
    if (prev === true && !landingConnected) {
      // Sign-out ends the cycle. The panel close that rides along with a
      // logout is NOT the user dismissing the landing — recording it as one
      // silently killed the landing for the next connect of the same wallet.
      console.log('[PP-LAND] signed out; machine reset. The next connect gets a fresh landing');
      landingDismissedRef.current = false;
      seedOpenedRef.current = false;
      previousIdentityRef.current = null;
      witnessedSignedOutRef.current = true;
      send({ type: 'reset' });
    }
  }, [landingConnected, walletSettled, send]);

  // The landing is one-shot PER IDENTITY. Switching wallets mid-session (an
  // unfunded account whose cycle ended, then back to a funded one) must give
  // the new identity a fresh cycle — including clearing the previous
  // identity's dismissal and sign-in latches.
  useEffect(() => {
    if (!landingAddress || (!keySessionAddress && !walletSettled)) return;
    const prev = previousIdentityRef.current;
    previousIdentityRef.current = landingAddress;
    if (!prev || prev.toLowerCase() === landingAddress.toLowerCase()) return;
    console.log('[PP-LAND] identity changed; landing machine reset', JSON.stringify({
      previous: prev,
      current: landingAddress,
    }));
    landingDismissedRef.current = false;
    seedOpenedRef.current = false;
    // Switching accounts is as deliberate as connecting: the new identity
    // qualifies as freshly connected even without a signed-out gap.
    witnessedSignedOutRef.current = true;
    // The intro suppression belongs to the PREVIOUS identity's page view.
    introDemoRef.current = false;
    send({ type: 'reset' });
  }, [landingAddress, keySessionAddress, walletSettled, send]);

  // Returning funded sessions need an unlock invitation even without a fresh
  // landing. Share the one-shot latch, and reset it above before either opener
  // runs. The unlock gate excludes reconnecting, initializing, and key sessions.
  const { requiresWalletUnlock } = useWalletUnlockGate();
  useEffect(() => {
    if (seedOpenedRef.current || landingDismissedRef.current || machineRef.current.phase === 'stopped') return;
    if (Platform.OS === 'web' && (window.location.pathname !== '/' || overlayFromSearch(window.location.search))) return;
    if (!requiresWalletUnlock || !funded) return;
    seedOpenedRef.current = true;
    console.log('[PP-LAND] opening sign-in on load (locked session with a balance or deposits)');
    openSeedDerivationModal();
  }, [requiresWalletUnlock, funded, openSeedDerivationModal, liveUiUrl, machine.phase]);

  // Subscribe before any landing write. History wrappers publish silent
  // replaceState/pushState mutations as `history`; intentional panel controls
  // follow with a semantic notify, and Back/X traversal arrives as popstate.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    installUiUrlGuard();

    const syncFromLocation = (event?: UiUrlEvent) => {
      const next = readLiveUiUrl(liveUiUrlRef.current.revision + 1);
      liveUiUrlRef.current = next;

      const managedPanelChoice =
        event?.source === 'notify'
        && event.intent === 'panel-user-action';
      const managedBalancesTraversal =
        event?.source === 'popstate'
        && panelFromSnapshot(event.previous.search) === 'balances'
        && panelFromSnapshot(event.current.search) !== 'balances'
        // A pop whose departed entry carried an overlay param is that
        // overlay's own close traversal (e.g. the wallet picker), not the
        // user backing out of the balances panel.
        && !overlayFromSearch(event.previous.search);

      const navigationChoice = event?.intent === 'navigation-user-action'
        || (event?.previous.pathname === '/' && event.current.pathname !== '/');
      // Explicit choices win even before funding loads, and even immediately
      // after an automatic landing. Never treat a fast click as boot churn.
      if (managedPanelChoice || managedBalancesTraversal || navigationChoice) {
        landingDismissedRef.current = true;
        seedOpenedRef.current = true;
        send({ type: 'stop', reason: navigationChoice ? 'navigation' : 'managed-dismiss' });
      } else if (event?.changedManagedKeys.includes('panel')) {
        console.log('[PP-LAND] ui-url observation', JSON.stringify({
          source: event.source,
          panel: next.panel,
          pathname: next.pathname,
        }));
      }

      setLiveUiUrl(next);
    };

    syncFromLocation();
    return subscribeUiUrl(syncFromLocation);
  }, [send]);

  // Arm from current state, not from an edge. A restored account-key session
  // may be connected/funded before this component ever renders; routerReady is
  // the only prerequisite, and staying true still drives this effect.
  // DEBUG: every early-return below used to be silent, so a landing that never
  // armed produced only 'phase: waiting' noise with no cause. Log the blocking
  // gate — once per distinct reason, not per render, or wagmi churn floods it.
  const lastArmBlockRef = useRef<string | null>(null);
  const logArmBlocked = useCallback((reason: string, extra?: Record<string, unknown>) => {
    if (lastArmBlockRef.current === reason) return;
    lastArmBlockRef.current = reason;
    console.log('[PP-LAND] arming blocked', JSON.stringify({ reason, ...extra }));
  }, []);

  useEffect(() => {
    if (machineRef.current.phase !== 'waiting') return;
    if (introDemoRef.current) {
      logArmBlocked('intro=true page load. Landing suppressed for this view');
      return;
    }
    if (!routerReady || !landingConnected || !landingAddress) {
      logArmBlocked(
        !routerReady
          ? 'router not ready'
          : !landingConnected
            ? 'not connected (no wallet, no key session)'
            : 'connected but no address yet',
        { routerReady, landingConnected, isConnected, identityMode, wagmiStatus },
      );
      return;
    }
    // wagmi's own report must be FINAL (a key session has no wagmi lifecycle
    // and arms regardless): arming mid-'reconnecting' reads a half-restored
    // session and made the boot decisions on stale identity.
    if (!keySessionAddress && !walletSettled) {
      logArmBlocked('wagmi still settling (connecting/reconnecting)', { wagmiStatus });
      return;
    }
    // During hydration, wait for Expo's path and the live History path to agree
    // instead of treating their transient disagreement as user navigation.
    if (Platform.OS === 'web' && liveUiUrl.pathname !== pathname) {
      logArmBlocked('expo pathname and browser URL disagree (hydration)', {
        expoPathname: pathname,
        livePathname: liveUiUrl.pathname,
      });
      return;
    }
    // THE POLICY GATE: only a fresh connect lands. A session restored at boot
    // arrives connected without this mount ever witnessing a signed-out state
    // — the user asked for `/` and keeps it.
    if (!witnessedSignedOutRef.current) {
      logArmBlocked('already connected at page load (restored session). Landing only follows a fresh connect', {
        wagmiStatus,
        identityMode,
      });
      return;
    }
    lastArmBlockRef.current = null;

    console.log('[PP-LAND] identity ready; arm landing', JSON.stringify({
      walletConnected: isConnected,
      identityMode,
      address: landingAddress,
      pathname,
      routerReady,
    }));
    send({ type: 'arm' });
    // machine.phase: re-run after an identity-change reset returns the
    // machine to 'waiting' (no other dep moves on that render).
  }, [identityMode, isConnected, landingAddress, landingConnected, keySessionAddress, logArmBlocked, machine.phase, walletSettled, wagmiStatus, liveUiUrl.pathname, pathname, routerReady, send]);

  // On web the BROWSER URL is the authority: every real navigation — router
  // push or raw History rewrite — moves location.pathname. Expo's usePathname
  // can report a transient non-home value during hydration while the address
  // bar never leaves '/', and treating that as the user's navigation stopped
  // the landing terminally right after an early wallet report (field trace:
  // machine stopped post-arm, then wagmi churned, then funded arrived — dead).
  const invariantPathname = Platform.OS === 'web' ? liveUiUrl.pathname : pathname;

  useEffect(() => {
    const phase = machineRef.current.phase;
    const decision = decideConnectLandingInvariant({
      // decideConnectLandingInvariant stays pure/tested; every live variant
      // is a "new design" since Classic (0) retired.
      isNewDesign: true,
      phase,
      routerReady,
      funded,
      pathname: invariantPathname,
      dismissed: landingDismissedRef.current,
      panel: liveUiUrl.panel,
    });

    console.log('[PP-LAND] invariant-check', JSON.stringify({
      phase,
      stopReason: machineRef.current.stopReason,
      decision,
      routerReady,
      pathname,
      livePathname: liveUiUrl.pathname,
      panel: liveUiUrl.panel,
      poolsLoading,
      funded,
      totalDeposits: data.myPoolsStats?.totalDeposits ?? 0,
      feedHit,
      noteBal: cachedBalance,
      // What the "My balances" door itself shows — if this is non-zero and the
      // landing still won't fire, funded-detection is not the problem.
      acceptedFunds: data.myPoolsStats?.acceptedFundsValue ?? null,
      acceptedFundsUsd: statsUsd,
      myPoolsCount: data.myPools?.length ?? 0,
      sessionLocked,
      identityMode,
      keysReady,
      wagmiStatus,
      landingConnected,
      designVariant: ActiveDesignVariant,
      address: landingAddress ?? null,
    }));

    if (decision === 'stop') {
      if (phase !== 'stopped') {
        console.log('[PP-LAND] navigation/choice stopped landing for this load', JSON.stringify({
          phase,
          invariantPathname,
          expoPathname: pathname,
          livePathname: liveUiUrl.pathname,
          dismissed: landingDismissedRef.current,
        }));
        send({ type: 'stop', reason: landingDismissedRef.current ? 'managed-dismiss' : 'navigation' });
      }
      return;
    }

    // Never write the panel while a managed overlay is on top: the landing's
    // entry would stack ABOVE the overlay's, and the overlay's close pop
    // (wallet picker after a successful connect) would take the panel with it.
    // Read the location DIRECTLY — an overlay entry pushed before the URL
    // wrappers installed never published an event, so state can be stale.
    const overlayNow = Platform.OS === 'web' && typeof window !== 'undefined'
      ? overlayFromSearch(window.location.search)
      : liveUiUrl.overlay;
    if ((decision === 'open' || decision === 'repair') && overlayNow) {
      console.log('[PP-LAND] managed overlay open; landing deferred');
      return;
    }

    // A present deep-link is still the first landing: enter enforcement and
    // evaluate the seed rule, but do not create a duplicate History entry.
    const firstLanding = phase === 'armed' && (decision === 'open' || decision === 'satisfied');
    if (firstLanding) {
      send({ type: 'land' });

      // Exactly once, at the first landing only. Public deposit evidence can
      // trigger the panel, but a persisted note balance means there is already
      // something useful to render and must not nag with another unlock.
      if (!seedOpenedRef.current) {
        const openSeed = shouldOpenSeedOnConnectLanding({
          firstLanding,
          sessionLocked,
          hasCachedBalance: cachedBalance,
          seedHandled: seedOpenedRef.current,
          nonEvmChain,
        });
        seedOpenedRef.current = true;
        if (openSeed) {
          console.log('[PP-LAND] opening sign-in immediately (locked, no cached balance)');
          openSeedDerivationModal();
        }
      }

      if (Platform.OS === 'web' && typeof window !== 'undefined') {
        installUiUrlGuard();
        if (liveUiUrl.panel === null) pushUiParamEntry('panel', 'balances');
        else if (liveUiUrl.panel !== 'balances') setUiParamEntry('panel', 'balances');
        // Even when the param was already present, make Home re-read it: its
        // first render can precede Expo's final URL hydration.
        notifyUiUrl();
      } else if (liveUiUrl.panel !== 'balances') {
        router.push({ pathname: '/', params: { panel: 'balances' } });
      }
      console.log('[PP-LAND] balances landing entered enforcement');
      return;
    }

    if (decision !== 'repair') return;

    // Silent History/router churn removed or replaced the param. Repair the
    // CURRENT entry (never push a retry entry), then publish the new snapshot.
    if (Platform.OS === 'web' && typeof window !== 'undefined') {
      installUiUrlGuard();
      if (liveUiUrl.panel === null) replaceMissingUiParam('panel', 'balances');
      else setUiParamEntry('panel', 'balances');
      notifyUiUrl();
      console.log('[PP-LAND] external URL strip repaired', JSON.stringify({ previousPanel: liveUiUrl.panel }));
    }
  }, [
    cachedBalance,
    data.myPools?.length,
    statsUsd,
    data.myPoolsStats?.acceptedFundsValue,
    data.myPoolsStats?.totalDeposits,
    feedHit,
    funded,
    identityMode,
    invariantPathname,
    keysReady,
    landingAddress,
    landingConnected,
    liveUiUrl,
    machine,
    openSeedDerivationModal,
    pathname,
    poolsLoading,
    router,
    routerReady,
    send,
    nonEvmChain,
    sessionLocked,
    wagmiStatus,
  ]);

  return null;
}
