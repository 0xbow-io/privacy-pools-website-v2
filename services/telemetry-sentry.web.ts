/**
 * The Sentry client, configured to be able to report almost nothing.
 *
 * Ported from the v1 hardening (`src/instrumentation-client.ts` in
 * privacy-pools-website) after the 2026-09-10 disclosure, where Sentry had
 * been receiving the wallet address, the withdrawal amount and the recipient
 * as ordinary error context.
 *
 * Two independent layers, either of which would be enough on its own:
 *
 * 1. Nothing is COLLECTED. `defaultIntegrations: false` removes the automatic
 *    exporters - global error and unhandled-rejection handlers, fetch/XHR and
 *    console breadcrumbs, history breadcrumbs, the HTTP context (page URL,
 *    referrer, user agent), linked errors, session tracking. Only events this
 *    app hands over deliberately exist at all.
 * 2. Nothing crosses over. `beforeSend` replaces whatever it was given with an
 *    event CONSTRUCTED from an allowlist (services/telemetry-event.ts). Even a
 *    caller that passes a raw SDK error, and even a future Sentry version that
 *    starts attaching something new, cannot get a value out through it.
 *
 * Layer 1 makes layer 2 cheap; layer 2 is what holds when someone re-enables
 * an integration to debug something and forgets to take it back out.
 *
 * `replaysSessionSampleRate` and friends are deliberately NOT set here: those
 * options only exist when the replay integration is installed, and it is not.
 * The integration list is the control, and it is empty.
 */

import {
  privateTelemetryEvent,
  type IncomingEvent,
  type TelemetryMeta,
} from '@/services/telemetry-event';

let client: Promise<typeof import('@sentry/react')> | undefined;

export function initSentry(dsn: string, meta: TelemetryMeta): boolean {
  if (client) return true;
  client = import('@sentry/react').then((Sentry) => {
    Sentry.init({
      dsn,
      // No automatic collection of any kind. See the note above.
      defaultIntegrations: false,
      integrations: [],
      sendDefaultPii: false,
      // Traces name routes and carry timing. A timing series is an activity
      // channel in its own right - see docs/privacy-request-discipline.md.
      tracesSampleRate: 0,
      // Breadcrumbs are the classic accidental exporter: a fetch breadcrumb
      // carries the URL, and a URL carries whatever was in the query string.
      maxBreadcrumbs: 0,
      attachStacktrace: false,
      // Client reports are an extra outbound envelope counting discarded
      // events. Harmless in content, but this app makes no request it has not
      // decided to make.
      sendClientReports: false,
      beforeBreadcrumb: () => null,
      beforeSendTransaction: () => null,
      // The cast is the honest shape of what this does: the returned event is
      // NOT the one Sentry handed over and does not claim to be. It is a new
      // object built from an allowlist, and Sentry's ErrorEvent type describes
      // the input, not the output.
      beforeSend: (event) =>
        privateTelemetryEvent(event as unknown as IncomingEvent, meta) as unknown as typeof event | null,
    });
    return Sentry;
  });
  // A failed download can be retried by the next initialization.
  void client.catch(() => { client = undefined; });
  return true;
}

/**
 * Hand one report to the client.
 *
 * The payload goes in `contexts.telemetry` because that is where
 * `privateTelemetryEvent` reads its allowlist from. Anything else put on the
 * event - here, on the scope, or by Sentry itself - is discarded before the
 * event leaves.
 */
export function sendTelemetryEvent(telemetry: Record<string, unknown>): void {
  // Promise callbacks retain startup reports while the client downloads.
  // With no configured client, reporting remains a no-op.
  void client?.then((Sentry) => {
    Sentry.captureEvent({ contexts: { telemetry } });
  }).catch(() => {});
}
