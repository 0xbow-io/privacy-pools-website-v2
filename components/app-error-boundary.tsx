/**
 * The last thing between a render crash and a white page.
 *
 * On 2026-09-22 a QA session broke the client to a white screen and nothing
 * reached Sentry. Both halves of that were true by construction: nothing in the
 * app caught a render error, so React unmounted the tree and left an empty
 * body, and this app only ever reports events it CONSTRUCTS from a fixed union
 * (services/telemetry-event.ts), so an uncaught React error was never going to
 * appear there on its own.
 *
 * WHAT IT DOES NOT DO, and must not.
 *
 * It does not send the error. Not the message, not the stack, not the component
 * trace. The whole telemetry design is that callers name a message from a fixed
 * list and pass booleans, with "deliberately no parameter that could carry" a
 * note. A render error is the WORST case for that rule, not an exception to it:
 * the message is whatever some library interpolated, and on this app that can
 * be an address, an amount, or a value derived from a note. So the report is
 * `client-failed` and nothing else on production.
 *
 * On STAGING, where `diagnosticsAllowed` is already true because the session is
 * pointed at test contracts, the error text rides along in the diagnostic block
 * the telemetry module already gates. That is where the stack a developer wants
 * actually comes from, and it costs nothing in production because the gate is
 * applied in the constructor rather than here.
 *
 * The recovery UI is deliberately plain: it renders no app state, calls no
 * hook, and reads no context. A boundary that needs the tree it is replacing is
 * a boundary that white-screens twice.
 */
import React from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

import { reportTelemetry } from '@/services/telemetry';

type Props = { children: React.ReactNode };
type State = { crashed: boolean };

/**
 * Reload the document.
 *
 * Web only by construction: this app ships to the browser, and a native build
 * has no equivalent that is safe to call from here. On native the button is
 * hidden rather than made to do nothing.
 */
/**
 * The name of the component the crash came from, if the stack names one.
 *
 * React writes the stack as lines of `    at Name (file:line)`, innermost
 * first, so the first name is the component that threw. Only the NAME is
 * taken: the file and position go nowhere, and the constructor drops anything
 * that is not a bare identifier anyway, which is what makes this safe to send
 * from a production session.
 *
 * A minified bundle may have renamed the component, in which case this is a
 * short meaningless name rather than a wrong one, and `errorName` still says
 * what kind of failure it was.
 */
function firstComponentName(componentStack: string | null | undefined): string | undefined {
  if (!componentStack) return undefined;
  for (const line of componentStack.split('\n')) {
    const name = /^\s*(?:at\s+)?([A-Za-z_$][A-Za-z0-9_$]*)/.exec(line)?.[1];
    if (name) return name;
  }
  return undefined;
}

function reloadDocument(): void {
  if (Platform.OS !== 'web') return;
  try {
    globalThis.location?.reload();
  } catch {
    /* A blocked or absent location is not worth a second crash. */
  }
}

export class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { crashed: false };

  static getDerivedStateFromError(): State {
    return { crashed: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    // The console keeps the whole thing, for whoever has devtools open. It
    // never leaves the machine.
    console.error('[AppErrorBoundary] render crashed', error, info?.componentStack);
    try {
      reportTelemetry('client-failed', {}, {
        stage: 'render',
        // Staging, or a session with debug mode on: `diagnosticsAllowed` drops
        // the whole block anywhere else, in the constructor, so this line
        // cannot travel by being forgotten here.
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }, {
        // EVERY environment, prod included. Two identifiers, no values: enough
        // to tell a TypeError in the swap modal from one in the pools provider
        // without knowing anything about the person who hit it.
        errorName: error instanceof Error ? error.name : typeof error,
        componentFrame: firstComponentName(info?.componentStack),
      });
    } catch {
      /* Reporting must never be the reason the fallback fails to render. */
    }
  }

  render(): React.ReactNode {
    if (!this.state.crashed) return this.props.children;
    return (
      <View
        testID="app-error-boundary"
        className="flex-1 items-center justify-center gap-[12px] bg-background px-[24px]"
      >
        <Text className="text-center font-pp-bold text-[20px] text-text">Something broke on this screen</Text>
        <Text className="max-w-[420px] text-center font-pp-regular text-[14px] leading-[20px] text-text-secondary">
          Your funds are safe: this is the page failing to draw, not a transaction. Reloading usually fixes it.
        </Text>
        {Platform.OS === 'web' && (
          <Pressable
            onPress={reloadDocument}
            accessibilityRole="button"
            testID="app-error-boundary-reload"
            className="mt-[4px] rounded-control bg-text px-[20px] py-[11px]"
          >
            <Text className="font-pp-medium text-[14px] text-background">Reload</Text>
          </Pressable>
        )}
      </View>
    );
  }
}
