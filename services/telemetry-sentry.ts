/**
 * Native build: there is no error reporter.
 *
 * Metro picks `.web.ts` over this file for web, so `@sentry/react` - a DOM
 * library - is never resolved into a native bundle. Sentry on native is a
 * different SDK with a config plugin and a native build step; until that is
 * done deliberately, native reports nothing rather than half-reporting
 * through a package that was not built for it.
 *
 * Follow-up: patcito/0xbow-remote#24.
 */
import type { TelemetryMeta } from '@/services/telemetry-event';

export function initSentry(_dsn: string, _meta: TelemetryMeta): boolean {
  return false;
}

export function sendTelemetryEvent(_telemetry: Record<string, unknown>): void {
  /* no reporter on native */
}
