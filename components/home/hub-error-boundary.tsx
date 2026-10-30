/**
 * A render crash inside the action card (Shield, Withdraw, Send, Swap, Request)
 * should take the CARD down, not the whole app.
 *
 * Until 2026-10-30 the only boundary was the root one (components/app-error-boundary),
 * so selecting one token in the Swap tab's Receiving picker replaced the entire
 * page with "Something broke on this screen" (Artem, 2026-10-30). Here the card
 * alone is replaced, the rest of the page stays, and "Try again" remounts the card
 * from its own state, which clears whatever selection had made it throw.
 *
 * It reports the same way the root boundary does: through the constructed-event
 * path, with identifiers only (class, first component, message shape, build
 * position), never the message or the stack. Like the root boundary it renders no
 * app state and calls no hook.
 */
import React from 'react';
import { Pressable, Text, View } from 'react-native';

import { reportErrorReport } from '@/services/error-reports';
import { firstComponentName, firstFramePosition } from '@/services/crash-frame';
import { errorShape } from '@/services/error-shape';

// onRetry: a modal shell keeps its open state in its provider, so a bare remount
// would draw the same shell again. The provider passes its close, so Try again
// leaves the user on a clean page.
//
// retryable=false is for a flow whose close is blocked (a swap mid-proof, a
// withdrawal in flight): Try again would remount the same crashing shell and do
// nothing, so no button is shown and the user is told to reload.
// retryLabel: what the button says (a shell's retry is a close).
type Props = { children: React.ReactNode; onRetry?: () => void; retryable?: boolean; retryLabel?: string };
type State = { crashed: boolean; attempt: number };

export class HubErrorBoundary extends React.Component<Props, State> {
  state: State = { crashed: false, attempt: 0 };

  static getDerivedStateFromError(): Partial<State> {
    return { crashed: true };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error('[HubErrorBoundary] action card crashed', error, info?.componentStack);
    try {
      reportErrorReport('client-failed', {}, {
        stage: 'render',
        detail: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      }, {
        errorName: error instanceof Error ? error.name : typeof error,
        componentFrame: firstComponentName(info?.componentStack),
        errorShape: errorShape(error instanceof Error ? error.message : undefined),
        componentPosition: firstFramePosition(info?.componentStack),
      });
    } catch {
      /* Reporting must never be the reason the fallback fails to render. */
    }
  }

  private retry = (): void => {
    try {
      this.props.onRetry?.();
    } catch {
      /* A failing close must not trap the user in the fallback. */
    }
    // A new key remounts the card, so its own state starts clean.
    this.setState((s) => ({ crashed: false, attempt: s.attempt + 1 }));
  };

  render(): React.ReactNode {
    if (this.state.crashed) {
      const retryable = this.props.retryable !== false;
      return (
        <View
          testID="hub-error-boundary"
          className="items-center justify-center gap-[10px] rounded-card border border-border bg-background px-[20px] py-[32px]"
        >
          <Text className="text-center font-pp-bold text-[18px] text-text">Something broke here</Text>
          <Text className="max-w-[360px] text-center font-pp-regular text-[14px] leading-[20px] text-text-secondary">
            {retryable
              ? 'Your funds are safe: this is the form failing to draw, not a transaction.'
              : 'Reload the page. Your funds are safe: this is the form failing to draw, and the operation in progress is not interrupted.'}
          </Text>
          {retryable && (
            <Pressable
              onPress={this.retry}
              accessibilityRole="button"
              testID="hub-error-boundary-retry"
              className="mt-[4px] rounded-control bg-text px-[20px] py-[11px]"
            >
              <Text className="font-pp-medium text-[14px] text-background">{this.props.retryLabel ?? 'Try again'}</Text>
            </Pressable>
          )}
        </View>
      );
    }
    return <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>;
  }
}
