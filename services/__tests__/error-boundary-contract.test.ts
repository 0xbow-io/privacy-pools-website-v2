/**
 * A QA session broke the client to a white screen on 2026-09-22 and nothing
 * reached Sentry. Both halves were true by construction: nothing caught a
 * render error, so React unmounted the tree and left an empty body, and this
 * app only reports events it CONSTRUCTS from a fixed union, so an uncaught
 * React error was never going to appear there on its own.
 *
 * A source check, because mounting the real tree needs a DOM this suite does
 * not have, and the properties worth pinning are structural: the boundary
 * exists, it is mounted ABOVE the providers, and it does not hand raw error
 * text to telemetry on a production build.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(new URL('.', import.meta.url).pathname, '..', '..');
const BOUNDARY = readFileSync(join(ROOT, 'components/app-error-boundary.tsx'), 'utf8');
const LAYOUT = readFileSync(join(ROOT, 'app/_layout.tsx'), 'utf8');

describe('the app has a render-crash boundary', () => {
  test('it implements the React error-boundary contract', () => {
    expect(BOUNDARY).toContain('getDerivedStateFromError');
    expect(BOUNDARY).toContain('componentDidCatch');
  });

  test('it is mounted above every provider', () => {
    // Underneath wagmi or the SDK provider it could not catch the crashes that
    // produced the white page in the first place.
    const boundaryAt = LAYOUT.indexOf('<AppErrorBoundary>');
    const wagmiAt = LAYOUT.indexOf('<WagmiProvider');
    expect(boundaryAt).toBeGreaterThan(-1);
    expect(wagmiAt).toBeGreaterThan(-1);
    expect(boundaryAt).toBeLessThan(wagmiAt);
  });

  test('it renders a recovery surface rather than nothing', () => {
    expect(BOUNDARY).toContain('app-error-boundary');
    expect(BOUNDARY).toMatch(/Reload/);
  });

  test('it reports through the constructed-event path, with a declared key', () => {
    expect(BOUNDARY).toContain("reportTelemetry('client-failed'");
    // Never a bare captureException: that is the door the whole telemetry
    // design closes, and a render error is the worst thing to open it for.
    expect(BOUNDARY).not.toContain('captureException');
  });

  test('raw error text goes in the diagnostic block, which staging gates', () => {
    // `detail` is part of TelemetryDiagnostic, and the constructor drops the
    // whole block unless the session is on staging. Putting the message
    // anywhere else would ship it to production.
    const reportCall = BOUNDARY.slice(BOUNDARY.indexOf("reportTelemetry('client-failed'"));
    const call = reportCall.slice(0, reportCall.indexOf('});'));
    expect(call).toContain('detail:');
    expect(call).toContain('stage:');
  });
});
