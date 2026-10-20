import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import { useAccount } from 'wagmi';
import { useMultiChainWallet } from '@/hooks/use-multi-chain-wallet';
import { useCurrentWallet } from '@mysten/dapp-kit';
import { useDepositModal } from '@/components/deposit-modal-provider';
import { useWithdrawModal } from '@/components/withdraw-modal-provider';
import { useTransferModal } from '@/components/transfer-modal-provider';
import { usePaymentRequestModal } from '@/components/payment-request-modal-provider';
import { useWalletConnectModal } from '@/components/wallet-connect-modal-provider';
import { useSeedDerivationModal } from '@/components/seed-derivation-modal-provider';
import { usePoolSession } from '@/hooks/use-pool-session';
import { installUiUrlGuard, subscribeUiUrl } from '@/components/ui-url-events';

/**
 * Web-only history bridge for the action modals: deposit, withdraw, send,
 * request, connect. expo-router 55 downgrades same-path query-param pushes to
 * replaceState, so we write the History API directly:
 *
 * - Opening a modal (any code path) pushes a marked `?modal=<name>` entry on
 *   top of the current URL, preserving other params.
 * - Browser back pops the entry and the popstate listener closes the modal —
 *   landing on the previous URL state. Forward reopens it.
 * - Closing via the modal's own × pops our marked entry so back/forward stay
 *   coherent; unrecognized entries are rewritten in place instead.
 * - Deep links (/?modal=deposit as the first entry) are re-based to
 *   [url-without-modal, url-with-modal] and the modal opens on load.
 *
 * Money-modal deep links are only honored when the app can actually open
 * them (wallet connected, or an account-key session for the relayed flows —
 * mirroring useRequireConnection). Otherwise the modal openers bail out to
 * the wallet picker, and a `?modal=deposit` entry under a `?modal=connect`
 * entry would trap back/forward in a connect loop. Un-openable params are
 * stripped from the URL instead — never converted into a picker bounce.
 *
 * Renders nothing; mount once inside all five providers. Native is a no-op.
 */

const MODAL_HISTORY_STATE_KEY = '__ppv2ModalEntry';

type ModalName = 'deposit' | 'withdraw' | 'send' | 'request' | 'connect';
const MODAL_NAMES: ModalName[] = ['deposit', 'withdraw', 'send', 'request', 'connect'];

function getModalParam(): ModalName | null {
  const value = new URL(window.location.href).searchParams.get('modal');
  return MODAL_NAMES.includes(value as ModalName) ? (value as ModalName) : null;
}

function urlWithModal(name: ModalName): string {
  const url = new URL(window.location.href);
  url.searchParams.set('modal', name);
  return `${url.pathname}${url.search}${url.hash}`;
}

function urlWithoutModal(): string {
  const url = new URL(window.location.href);
  url.searchParams.delete('modal');
  return `${url.pathname}${url.search}${url.hash}`;
}

function isObjectState(state: unknown): state is Record<string, unknown> {
  return typeof state === 'object' && state !== null && !Array.isArray(state);
}

function isMarkedModalEntry(): boolean {
  return isObjectState(window.history.state) && window.history.state[MODAL_HISTORY_STATE_KEY] === true;
}

function markedState(): Record<string, unknown> {
  return { ...(isObjectState(window.history.state) ? window.history.state : {}), [MODAL_HISTORY_STATE_KEY]: true };
}

function strippedState(): unknown {
  if (!isObjectState(window.history.state)) return window.history.state;
  const next = { ...window.history.state };
  delete next[MODAL_HISTORY_STATE_KEY];
  return next;
}

export function ModalUrlBridge() {
  const deposit = useDepositModal();
  const withdraw = useWithdrawModal();
  const transfer = useTransferModal();
  const payment = usePaymentRequestModal();
  const wallet = useWalletConnectModal();
  const seedDerivation = useSeedDerivationModal();
  const { status } = useAccount();
  // Chain-aware connection state: when the Sui session drives the app, wagmi
  // reports disconnected even though the Sui modals can open — gating deep
  // links on wagmi alone stripped every Sui `?modal=` entry.
  const { isConnected } = useMultiChainWallet();
  const { identityMode } = usePoolSession();

  // Inline (hub-hosted) flows are NOT modals: they live under `?action=…`
  // owned by the router, so the bridge must treat them as closed — otherwise
  // every hub tab press pushes/pops a `?modal=` history entry against the
  // router's own navigation and the page hard-reloads.
  const modals: Record<ModalName, { isOpen: boolean; open: () => void; close: () => void }> = {
    deposit: { isOpen: deposit.isOpen, open: () => deposit.openDepositModal(), close: deposit.closeDepositModal },
    withdraw: { isOpen: withdraw.isOpen && !withdraw.inlineActive, open: () => withdraw.openWithdrawModal(), close: withdraw.closeWithdrawModal },
    send: { isOpen: transfer.isOpen && !transfer.inlineActive && !transfer.isConsolidating, open: () => transfer.openTransferModal(), close: transfer.closeTransferModal },
    request: { isOpen: payment.isOpen && !payment.inlineActive && payment.mode === 'request', open: () => payment.openRequestPaymentModal(), close: payment.closePaymentRequestModal },
    connect: { isOpen: wallet.isOpen, open: () => { void wallet.open(); }, close: wallet.close },
  };
  const modalsRef = useRef(modals);
  modalsRef.current = modals;

  // Whether each modal's opener would actually show it, mirroring the
  // providers' own useRequireConnection gates: deposits post from the wallet
  // (wallet required); withdraw/send/request are relayed, so a wallet-less
  // account-key session is enough; the picker itself always opens.
  const keySession = identityMode === 'key';
  const canOpen: Record<ModalName, boolean> = {
    deposit: isConnected,
    withdraw: isConnected || keySession,
    send: isConnected || keySession,
    request: isConnected || keySession,
    connect: true,
  };
  const canOpenRef = useRef(canOpen);
  canOpenRef.current = canOpen;

  // Which modal we believe owns the current `?modal=` entry.
  const trackedRef = useRef<ModalName | null>(null);
  // A modal we've asked to open but haven't observed open yet (providers may
  // route through the unlock dialog first when keys aren't derived). The
  // watcher must not retire the URL entry while the open is still in flight.
  const pendingOpenRef = useRef<ModalName | null>(null);
  const deepLinkHandledRef = useRef(false);
  // Unlock-dialog tracking for pending opens: if the dialog closes and the
  // target modal never materializes (the user cancelled the unlock), the
  // pending open is dead and its URL entry must be retired — otherwise Back
  // could re-trigger the stale deep link + unlock prompt indefinitely.
  const seedWasOpenRef = useRef(false);
  const cancelCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Deferred because a SUCCESSFUL unlock also passes through the same
  // "dialog closed, nothing open yet" state: the seed provider resumes the
  // follow-up action via setTimeout(continuation, 0) and the target modal
  // only shows on the following render. The check re-reads live state when
  // it fires, so the settle window just needs to comfortably outlast that
  // chain; if the pending open is still unresolved by then, the unlock was
  // dismissed (cancel, or a path that never runs the continuation) and the
  // stale entry is retired.
  const CANCELLED_UNLOCK_SETTLE_MS = 120;
  const runCancelledUnlockCheck = () => {
    cancelCheckTimerRef.current = null;
    if (!pendingOpenRef.current) return;
    if (seedWasOpenRef.current) return; // unlock dialog is showing again
    const m = modalsRef.current;
    if (MODAL_NAMES.some((n) => m[n].isOpen)) return; // watcher owns it now
    pendingOpenRef.current = null;
    trackedRef.current = null;
    if (getModalParam()) {
      if (isMarkedModalEntry()) {
        window.history.back();
      } else {
        window.history.replaceState(strippedState(), '', urlWithoutModal());
      }
    }
  };

  // Deep-linked modal. Wait for wallet auto-reconnect to settle — wagmi's
  // status AND dapp-kit's (a restoring Sui session reports 'connecting') — so
  // a connected user's `?modal=deposit` isn't judged against the transient
  // disconnected state, then either honor the link (re-base so back closes
  // it instead of leaving the site, and open it) or strip the param.
  const { connectionStatus: suiStatus } = useCurrentWallet();
  const reconnecting =
    status === 'connecting' || status === 'reconnecting' || suiStatus === 'connecting';
  const deepLinkGraceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    if (deepLinkHandledRef.current) return;
    const name = getModalParam();
    if (!name) {
      deepLinkHandledRef.current = true;
      return;
    }
    if (reconnecting) {
      // A connection attempt started while the grace timer was pending:
      // cancel it — judgment restarts cleanly when the reconnect settles,
      // instead of the timer stripping the param mid-connect.
      if (deepLinkGraceTimerRef.current !== null) {
        clearTimeout(deepLinkGraceTimerRef.current);
        deepLinkGraceTimerRef.current = null;
      }
      return;
    }
    const honor = (n: ModalName) => {
      // Desktop vault home runs deposits INLINE in the action hub — a
      // `?modal=deposit` deep link (or a pre-inline bookmark) lands on the
      // hub's Shield tab instead of the modal the desktop UX removed.
      if (
        n === 'deposit'
        && window.innerWidth > 540
        && window.location.pathname === '/'
      ) {
        deepLinkHandledRef.current = true;
        const url = new URL(window.location.href);
        url.searchParams.delete('modal');
        url.searchParams.set('action', 'shield');
        window.history.replaceState(strippedState(), '', `${url.pathname}${url.search}${url.hash}`);
        return;
      }
      deepLinkHandledRef.current = true;
      installUiUrlGuard();
      if (!isMarkedModalEntry()) {
        const withModal = urlWithModal(n);
        window.history.replaceState(strippedState(), '', urlWithoutModal());
        window.history.pushState(markedState(), '', withModal);
      }
      trackedRef.current = n;
      pendingOpenRef.current = n;
      modalsRef.current[n].open();
    };
    if (!canOpenRef.current[name]) {
      // Not openable *yet*. A restored Sui session flips the active chain one
      // render AFTER dapp-kit reports connected (the chain provider's effect
      // runs after ours), so judging immediately would strip valid Sui links.
      // Give the wallet state a short grace window; a connection flip re-runs
      // this effect (isConnected dep) and opens the modal before the timer
      // fires. Only when nothing connects is the param removed.
      if (deepLinkGraceTimerRef.current === null) {
        deepLinkGraceTimerRef.current = setTimeout(() => {
          deepLinkGraceTimerRef.current = null;
          if (deepLinkHandledRef.current) return;
          const n = getModalParam();
          if (!n) {
            deepLinkHandledRef.current = true;
            return;
          }
          if (canOpenRef.current[n]) {
            honor(n);
            return;
          }
          deepLinkHandledRef.current = true;
          window.history.replaceState(strippedState(), '', urlWithoutModal());
        }, 1500);
      }
      return;
    }
    if (deepLinkGraceTimerRef.current !== null) {
      clearTimeout(deepLinkGraceTimerRef.current);
      deepLinkGraceTimerRef.current = null;
    }
    honor(name);
  }, [reconnecting, isConnected]);

  // Clear a pending deep-link grace timer on unmount.
  useEffect(() => {
    return () => {
      if (deepLinkGraceTimerRef.current !== null) {
        clearTimeout(deepLinkGraceTimerRef.current);
        deepLinkGraceTimerRef.current = null;
      }
    };
  }, []);

  // Open/close watcher: keep the URL in step with whichever modal is shown.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const openName = MODAL_NAMES.find((n) => modals[n].isOpen) ?? null;
    // Unlock dialog just closed while an open is still pending and nothing is
    // shown: schedule the cancelled-unlock check (see its comment for why it
    // must wait rather than retiring the entry right here).
    const seedOpen = seedDerivation.isOpen;
    if (pendingOpenRef.current && seedWasOpenRef.current && !seedOpen && openName === null) {
      if (cancelCheckTimerRef.current === null) {
        cancelCheckTimerRef.current = setTimeout(runCancelledUnlockCheck, CANCELLED_UNLOCK_SETTLE_MS);
      }
    }
    seedWasOpenRef.current = seedOpen;
    if (pendingOpenRef.current) {
      if (openName === null) return; // requested open still in flight
      pendingOpenRef.current = null; // it (or another modal) actually opened
    }
    const prev = trackedRef.current;
    if (openName === prev) return;
    trackedRef.current = openName;
    const param = getModalParam();
    if (openName) {
      if (param !== openName) {
        installUiUrlGuard();
        window.history.pushState(markedState(), '', urlWithModal(openName));
      }
    } else if (prev && param === prev) {
      // Closed from inside the modal (×, success, …): retire the URL entry.
      if (isMarkedModalEntry()) {
        window.history.back();
      } else {
        window.history.replaceState(strippedState(), '', urlWithoutModal());
      }
    }
  });

  // Clear any scheduled cancelled-unlock check on unmount.
  useEffect(() => {
    return () => {
      if (cancelCheckTimerRef.current !== null) {
        clearTimeout(cancelCheckTimerRef.current);
        cancelCheckTimerRef.current = null;
      }
    };
  }, []);

  // Back/forward: the URL is the source of truth.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return;
    const onPopstate = () => {
      const name = getModalParam();
      const m = modalsRef.current;
      pendingOpenRef.current = null;
      if (name && !canOpenRef.current[name]) {
        // Stale entry for a modal we can no longer open (signed out since):
        // strip it in place rather than bouncing through the wallet picker.
        window.history.replaceState(strippedState(), '', urlWithoutModal());
        for (const n of MODAL_NAMES) {
          if (m[n].isOpen) m[n].close();
        }
        trackedRef.current = null;
        return;
      }
      for (const n of MODAL_NAMES) {
        if (n === name) {
          if (!m[n].isOpen) {
            pendingOpenRef.current = n;
            m[n].open();
          }
        } else if (m[n].isOpen) {
          m[n].close();
        }
      }
      // Sync the watcher so it doesn't pop a second entry for this change.
      trackedRef.current = name;
    };
    // Via ui-url-events, not a direct 'popstate' listener: the guard there
    // suppresses modal-only popstates for expo-router and re-dispatches to
    // subscribers like us.
    return subscribeUiUrl(onPopstate);
  }, []);

  return null;
}
