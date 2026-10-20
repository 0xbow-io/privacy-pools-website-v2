import { createElement, useCallback, useEffect, useMemo, useRef } from 'react';
import { Animated, PanResponder, Platform, View, type PanResponderInstance } from 'react-native';

/** Drag distance past which the sheet dismisses on release. */
const CLOSE_DISTANCE = 110;
/** Flick speed (px/ms) that dismisses regardless of distance. */
const CLOSE_VELOCITY = 0.6;

type WebPointerEvent = {
  clientY: number;
  pointerId: number;
  currentTarget: { setPointerCapture?: (id: number) => void; releasePointerCapture?: (id: number) => void };
};

export interface SheetDrag {
  /** Native: spread onto the drag area. */
  panHandlers: PanResponderInstance['panHandlers'];
  /** Web: pointer handlers for the raw-DOM drag area. */
  webHandlers: Record<string, (e: WebPointerEvent) => void>;
  /** Downward offset from the finger, ADDED to the sheet's slide-in translateY. */
  dragY: Animated.Value;
}

/**
 * Swipe-down-to-dismiss for a bottom sheet, on web and native.
 *
 * WHY NOT react-native-gesture-handler + Reanimated: both are installed, but
 * nothing in this app has ever mounted GestureHandlerRootView, and RNGH
 * gestures are inert without it — that route means a root-level provider plus
 * converting every sheet from Animated.Value to shared values.
 *
 * WHY NOT PanResponder ON WEB: it is the obvious choice and it does not work
 * here. Verified in-browser: with panHandlers on the sheet header the sheet did
 * not move by a single pixel under a 200px mouse drag, whether the handlers sat
 * on a className'd View or an unstyled one. RN-Web's responder system never
 * delivered the gesture. So web uses a raw-DOM pointer-event island instead —
 * the same escape hatch StatusBadgeWebTooltip uses for hover — while native
 * keeps PanResponder, which is the right tool there.
 *
 * Attach to the sheet's HEADER via `SheetDragArea`, not the whole sheet: a body
 * that is a ScrollView would otherwise lose its scrolling.
 */
export function useSheetDrag({
  height,
  onClose,
  enabled = true,
}: {
  height: number;
  onClose: () => void;
  enabled?: boolean;
}): SheetDrag {
  const dragY = useRef(new Animated.Value(0)).current;
  // Refs so handlers built once always read current values — rebuilding them
  // mid-gesture would drop the drag.
  const heightRef = useRef(height);
  heightRef.current = height;
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const settleBack = useCallback(() => {
    Animated.spring(dragY, {
      toValue: 0,
      tension: 70,
      friction: 12,
      // JS driver: composed with the sheet's own JS-driven slide.
      useNativeDriver: false,
    }).start();
  }, [dragY]);

  /** Shared release decision, so web and native dismiss on the same terms. */
  const release = useCallback(
    (dy: number, velocity: number) => {
      if (!(dy > CLOSE_DISTANCE || velocity > CLOSE_VELOCITY)) {
        settleBack();
        return;
      }
      const remaining = Math.max(0, heightRef.current - dy);
      Animated.timing(dragY, {
        toValue: heightRef.current,
        duration: Math.min(240, Math.max(90, remaining * 0.45)),
        useNativeDriver: false,
      }).start(() => {
        onCloseRef.current();
        dragY.setValue(0);
      });
    },
    [dragY, settleBack],
  );

  // ---- native ------------------------------------------------------------
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => enabledRef.current,
        onMoveShouldSetPanResponder: (_evt, g) =>
          enabledRef.current && g.dy > 6 && Math.abs(g.dy) > Math.abs(g.dx),
        onPanResponderMove: (_evt, g) => dragY.setValue(Math.max(0, g.dy)),
        onPanResponderRelease: (_evt, g) => release(g.dy, g.vy),
        onPanResponderTerminate: settleBack,
      }),
    [dragY, release, settleBack],
  );

  // ---- web ---------------------------------------------------------------
  // Pointer tracking runs on WINDOW listeners for the duration of the gesture,
  // rather than on the element or via setPointerCapture. Both alternatives were
  // tried in-browser and each broke one half of the requirement:
  //   - capture on pointerdown  -> all moves arrive, but the click is retargeted
  //                                to the capturing div, so the close/back
  //                                buttons inside the header stopped working;
  //   - no capture at all       -> the buttons work, but the very first move
  //                                already lands outside a ~46px header, so the
  //                                element never sees it and no drag ever starts.
  // Window listeners give both: every move is seen, and because the pointer is
  // never captured a press that does not move stays an ordinary click.
  /** Movement needed before a press is treated as a drag rather than a tap. */
  const DRAG_THRESHOLD = 6;
  const startY = useRef(0);
  const startT = useRef(0);
  const lastY = useRef(0);
  const dragging = useRef(false);
  const detach = useRef<(() => void) | null>(null);

  const webHandlers = useMemo(() => {
    const cleanup = () => {
      detach.current?.();
      detach.current = null;
    };

    const onWindowMove = (ev: { clientY: number }) => {
      const dy = ev.clientY - startY.current;
      if (!dragging.current) {
        if (dy <= DRAG_THRESHOLD) return;
        dragging.current = true;
      }
      lastY.current = ev.clientY;
      dragY.setValue(Math.max(0, dy));
    };

    const onWindowUp = () => {
      cleanup();
      if (!dragging.current) return; // a tap: let the click through untouched
      dragging.current = false;
      const dy = Math.max(0, lastY.current - startY.current);
      const elapsed = Math.max(1, Date.now() - startT.current);
      release(dy, dy / elapsed);
    };

    return {
      onPointerDown: (e: WebPointerEvent) => {
        if (!enabledRef.current || typeof window === 'undefined') return;
        cleanup();
        dragging.current = false;
        startY.current = e.clientY;
        lastY.current = e.clientY;
        startT.current = Date.now();
        const move = onWindowMove as unknown as EventListener;
        const up = onWindowUp as unknown as EventListener;
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
        detach.current = () => {
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
        };
      },
    };
  }, [dragY, release]);

  // Never leave window listeners behind if the sheet unmounts mid-gesture.
  useEffect(() => () => detach.current?.(), []);

  // Clear the offset whenever dragging is switched off, so the next open starts
  // flush against the bottom edge.
  useEffect(() => {
    if (!enabled) dragY.setValue(0);
  }, [enabled, dragY]);

  return { panHandlers: panResponder.panHandlers, webHandlers, dragY };
}

/**
 * The draggable region of a sheet. Renders a raw <div> on web (so pointer
 * events are real DOM events) and a plain View on native.
 */
export function SheetDragArea({
  drag,
  testID,
  children,
}: {
  drag: SheetDrag;
  testID?: string;
  children: React.ReactNode;
}) {
  if (Platform.OS === 'web') {
    return createElement(
      'div',
      {
        ...drag.webHandlers,
        'data-testid': testID,
        // nw-keep(platform-css): raw-DOM island — web-only CSS on a real <div> (touch-action stops the browser claiming the vertical gesture for page scrolling before our handler sees it; cursor signals the affordance). No className path exists on a createElement div.
        style: { touchAction: 'none', cursor: 'grab' },
      },
      children,
    );
  }
  return (
    <View testID={testID} {...drag.panHandlers}>
      {children}
    </View>
  );
}
