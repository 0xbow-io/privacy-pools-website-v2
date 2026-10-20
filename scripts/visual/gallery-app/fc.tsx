// F-C theme-foundation probes (harness-owned evidence fixture — same
// construction guarantees as index.tsx: served only under PPV2_NW_GALLERY=1,
// never a production route, utilities never in production CSS).
//
// Probes (asserted by scripts/visual/capture-gallery.ts):
//
//  FC1 — CSS-var flow into RN-Web BODY PORTALS: this route puts the app's
//        real root classes (pp-v3 [+ dark]) on document.documentElement at
//        module evaluation (services/theme-dom.ts — the same algorithm the
//        provider/bootstrap use), renders one swatch consuming
//        `var(--pp-button-primary)` in the page and an identical one inside
//        an RN Modal (which portals to document.body on web). The harness
//        opens the modal, asserts BOTH compute to the exact legacy hex
//        (#D2F4FB for v3 light), and crop-diffs the two swatches.
//
//  FC2 — the F-C Animated DECISION mechanism, app-side: a direct-className
//        RN Animated.View. Default load = no registration → className is
//        DROPPED; ?animReg=1 load = the real components/nativewind-interop.ts
//        module runs at gallery-root startup (see _layout.tsx) → APPLIES.
//
//  FC3 — Reanimated probes: Reanimated's View, Text, and ScrollView are
//        DIFFERENT components from their RN Animated counterparts, each
//        needing its own registration; all three are asserted in both loads
//        (dropped without registration / applied with the app module, which
//        registers them — Text and ScrollView cover the P1 manifest files
//        hello-wave.tsx and parallax-scroll-view.tsx). Static styles only —
//        no animation loops, keeping captures deterministic.
//
//  FC4 — toggle timing (provider-level): a REAL ThemeProvider wraps a
//        toggle button; the harness records the context-rendered label, the
//        root `dark` class, and the resolved --pp-background var on EVERY
//        animation frame around a real click — zero MIXED frames allowed
//        (the provider reconciles in a layout effect, so context and CSS
//        sinks can never disagree for a painted frame).
//
// Native Modal/portal probes remain BLOCKED by the vendored SDK's
// fs/promises native-export failure (recorded in the F-B/F-C gates docs).
import React, { useState } from 'react';
import { Animated, Modal, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import Reanimated from 'react-native-reanimated';
import { applyRootThemeClasses } from '@/services/theme-dom';
import { ThemeProvider, useTheme } from '@/components/theme-provider';

// Root classes at MODULE EVALUATION (pre-render), mirroring what the
// +html.tsx bootstrap does pre-paint in the real app. The gallery router
// root has no +html.tsx, so the route seeds its own classes; `?color=dark`
// exercises the dark half of the set.
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  const dark =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('color') === 'dark';
  applyRootThemeClasses(document.documentElement, 3, dark ? 'dark' : 'light');
}

// Static residual animated values — deterministic (no loops), and they prove
// the animated style channel survives alongside className.
const rnTranslate = new Animated.Value(24);

function VarSwatch({ testID }: { testID: string }) {
  return (
    <View
      testID={testID}
      className="h-6 w-24 rounded bg-[var(--pp-button-primary)]"
    />
  );
}

export default function FcProbes() {
  const [modalOpen, setModalOpen] = useState(false);
  return (
    <View style={styles.page}>
      <Text style={styles.marker}>NativeWind F-C theme gallery</Text>

      <View style={styles.cell}>
        <Text style={styles.title}>FC1 — var(--pp-*) in page vs RN-Web body portal</Text>
        <Text style={styles.note}>
          documentElement carries pp-v3 (+ dark when ?color=dark); both swatches consume
          var(--pp-button-primary).
        </Text>
        <VarSwatch testID="nwg-fc-var-page" />
        {/* Scheme-sensitive token (background differs light/dark on v3, unlike
            the CTA fill) — the ?color=dark load asserts this one flips. */}
        <View testID="nwg-fc-var-bg" className="h-6 w-24 rounded bg-[var(--pp-background)]" />
        <Pressable testID="nwg-fc-open-modal" onPress={() => setModalOpen(true)} style={styles.button}>
          <Text style={styles.buttonText}>open portal modal</Text>
        </Pressable>
        <Modal visible={modalOpen} transparent animationType="none" onRequestClose={() => setModalOpen(false)}>
          <View style={styles.modalBackdrop}>
            <View style={styles.modalCard} testID="nwg-fc-modal-content">
              <Text style={styles.note}>swatch below lives in a document.body portal</Text>
              <VarSwatch testID="nwg-fc-var-portal" />
              <Pressable testID="nwg-fc-close-modal" onPress={() => setModalOpen(false)} style={styles.button}>
                <Text style={styles.buttonText}>close</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </View>

      <View style={styles.cell}>
        <Text style={styles.title}>FC2 — RN Animated.View, direct className (app-module registration)</Text>
        <Text style={styles.note}>
          default load: dropped (transparent, 0-size; residual transform survives) · ?animReg=1:
          24×24 indigo puck, translated 24px.
        </Text>
        <View style={styles.probeLane}>
          <Animated.View
            testID="nwg-fc-anim-direct"
            className="h-6 w-6 rounded bg-indigo-600"
            style={{ transform: [{ translateX: rnTranslate }] }}
          />
        </View>
      </View>

      <View style={styles.cell}>
        <Text style={styles.title}>FC3 — Reanimated View / Text / ScrollView, direct className</Text>
        <Text style={styles.note}>
          separate components from their RN Animated counterparts — asserted dropped in the
          default load and applied under ?animReg=1 (the app module registers all three).
        </Text>
        <View style={styles.probeLane}>
          <Reanimated.View
            testID="nwg-fc-reanimated"
            className="h-6 w-6 rounded bg-emerald-600"
            style={{ transform: [{ translateX: 24 }] }}
          />
        </View>
        <Reanimated.Text testID="nwg-fc-reanimated-text" className="text-[16px] text-emerald-600">
          reanimated text probe
        </Reanimated.Text>
        <Reanimated.ScrollView
          testID="nwg-fc-reanimated-scroll"
          className="h-10 w-40 rounded bg-emerald-600"
          contentContainerClassName="p-2"
        >
          <View testID="nwg-fc-reanimated-scroll-child" style={styles.scrollChild} />
        </Reanimated.ScrollView>
      </View>

      <ThemeProvider>
        <View style={styles.cell}>
          <Text style={styles.title}>FC4 — provider toggle timing (context vs CSS sinks)</Text>
          <Text style={styles.note}>
            the harness samples label + dark class + resolved var on every animation frame around
            a real click — layout-effect reconcile means no mixed frame can ever paint.
          </Text>
          <ToggleProbe />
        </View>
      </ThemeProvider>
    </View>
  );
}

function ToggleProbe() {
  const { colorScheme, toggleColorScheme } = useTheme();
  return (
    <View style={styles.probeLane}>
      <Pressable testID="nwg-fc-toggle" onPress={toggleColorScheme} style={styles.button}>
        {/* context value rendered so the harness can cross-check it too */}
        <Text style={styles.buttonText} testID="nwg-fc-toggle-label">{`scheme:${colorScheme}`}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, gap: 16, padding: 24, backgroundColor: '#f8fafc' },
  marker: { fontSize: 18, fontWeight: '700', color: '#111827' },
  cell: { gap: 8, borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, padding: 12, backgroundColor: '#ffffff' },
  title: { fontSize: 14, fontWeight: '700', color: '#111827' },
  note: { fontSize: 11, color: '#6b7280' },
  probeLane: { height: 32, justifyContent: 'center' },
  scrollChild: { height: 48, width: 48 },
  button: { alignSelf: 'flex-start', backgroundColor: '#111827', borderRadius: 6, paddingHorizontal: 10, paddingVertical: 6 },
  buttonText: { color: '#ffffff', fontSize: 12 },
  modalBackdrop: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.4)' },
  modalCard: { gap: 8, backgroundColor: '#ffffff', borderRadius: 8, padding: 16, minWidth: 320 },
});
