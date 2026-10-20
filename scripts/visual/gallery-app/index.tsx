// NativeWind compatibility gallery (F-B evidence fixture — harness-owned).
//
// Served ONLY by the harness dev server (PPV2_NW_GALLERY=1 switches the
// expo-router root to this directory — see app.config.js); it is never a
// production route and its utilities never enter production CSS
// (tailwind.config.js gates the gallery content globs on the same variable;
// scripts/visual/perf-baseline.ts asserts the prod export is clean).
//
// Cells 0-9 are EQUIVALENCE cells: both halves render the same structure and
// the same specimen text; the harness (scripts/visual/capture-gallery.ts)
// crops each specimen pair and pixel-diffs left vs right, plus asserts
// computed styles. Cells E1/E2 are EVIDENCE PROBES — explicitly NOT
// equivalence claims (their behavior is what is being measured).
//
// Verification scope: WEB VERIFIED via the pinned-browser harness; NATIVE
// UNVERIFIED (native exports are blocked by the vendored SDK's fs/promises
// import — recorded in nativewind-fb-gates.md gate e).
//
// Determinism notes: no animation loops (static Animated.Value), the RN
// Modal is closed by default and opened by the capture script via testID,
// the dropdowns default open, Floating UI panels are statically open, and
// the two `fixed` badges sit bottom-right of the viewport.
import React, { useState } from 'react';
import {
  Animated,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { vars } from 'nativewind';
import { Ionicons } from '@expo/vector-icons';
import Svg, { Circle, Rect } from 'react-native-svg';
import { FloatingProbe } from '@/scripts/visual/gallery-src/floating-probe';
import { galleryAnimRegistrationRequested } from './_layout';

const ACCENT = '#7c3aed';
const CELL_BG = '#eef2ff';

function Cell({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <View style={cellStyles.cell}>
      <Text style={cellStyles.title}>{title}</Text>
      {note ? <Text style={cellStyles.note}>{note}</Text> : null}
      <View style={cellStyles.row}>{children}</View>
    </View>
  );
}

function Half({ label, children }: { label: 'StyleSheet' | 'className'; children: React.ReactNode }) {
  return (
    <View style={cellStyles.half}>
      <Text style={cellStyles.halfLabel}>{label}</Text>
      {children}
    </View>
  );
}

const cellStyles = StyleSheet.create({
  cell: { gap: 6, borderWidth: 1, borderColor: '#d1d5db', borderRadius: 8, padding: 12, backgroundColor: '#ffffff' },
  title: { fontSize: 14, fontWeight: '700', color: '#111827' },
  note: { fontSize: 11, color: '#6b7280' },
  row: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  half: { flex: 1, minWidth: 240, gap: 4 },
  halfLabel: { fontSize: 10, color: '#9ca3af', textTransform: 'uppercase' },
});

// ------------------------------------------------------ equivalence cells ---

/** 0. Basic utility probe — identical specimen text on both sides. */
function UtilityProbe() {
  return (
    <Cell title="0 — Utility classes" note="Basic Tailwind utilities on core RN components.">
      <Half label="StyleSheet">
        <View style={probeStyles.box} testID="nwg-probe-ss">
          <Text style={probeStyles.boxText}>probe box</Text>
        </View>
      </Half>
      <Half label="className">
        <View className="rounded-lg bg-indigo-600 p-3" testID="nwg-probe-nw">
          <Text className="text-sm font-bold text-white">probe box</Text>
        </View>
      </Half>
    </Cell>
  );
}
const probeStyles = StyleSheet.create({
  box: { borderRadius: 8, backgroundColor: '#4f46e5', padding: 12 },
  boxText: { fontSize: 14, lineHeight: 20, fontWeight: '700', color: '#ffffff' },
});

/** 1. Semantic CSS variable consumed via an arbitrary class (F-C's core mechanism). */
function SemanticVarProbe() {
  return (
    <Cell title="1 — Semantic var" note="Parent sets --nwg-accent via vars(); child consumes it with bg-[var(--nwg-accent)].">
      <Half label="StyleSheet">
        <View>
          <View style={varStyles.swatch} testID="nwg-var-ss" />
        </View>
      </Half>
      <Half label="className">
        <View style={vars({ '--nwg-accent': ACCENT })}>
          <View className="h-8 w-24 rounded bg-[var(--nwg-accent)]" testID="nwg-var-nw" />
        </View>
      </Half>
    </Cell>
  );
}
const varStyles = StyleSheet.create({
  swatch: { height: 32, width: 96, borderRadius: 4, backgroundColor: ACCENT },
});

/**
 * 2. Animated node — the WRAPPER migration pattern as the equivalence pair:
 * the Animated node carries ONLY the animated style; a plain child View
 * carries the className statics. (Direct className on Animated.View is the
 * E1 evidence probe below, NOT an equivalence claim.)
 */
const animatedX = new Animated.Value(24); // static — never started, deterministic
function AnimatedProbe() {
  return (
    <Cell title="2 — Animated + residual style (wrapper pattern)" note="Animated node keeps only animated styles (nw-keep: animated is node-scoped); statics live on a plain child View as classes.">
      <Half label="StyleSheet">
        <View style={animStyles.track}>
          <Animated.View style={{ transform: [{ translateX: animatedX }] }} testID="nwg-anim-ss">
            <View style={animStyles.puck} />
          </Animated.View>
        </View>
      </Half>
      <Half label="className">
        <View className="h-10 w-40 justify-center rounded bg-gray-200">
          <Animated.View style={{ transform: [{ translateX: animatedX }] }} testID="nwg-anim-nw">
            <View className="h-6 w-6 rounded-full bg-indigo-600" />
          </Animated.View>
        </View>
      </Half>
    </Cell>
  );
}
const animStyles = StyleSheet.create({
  track: { height: 40, width: 160, justifyContent: 'center', borderRadius: 4, backgroundColor: '#e5e7eb' },
  puck: { height: 24, width: 24, borderRadius: 12, backgroundColor: '#4f46e5' },
});

/** 3. ScrollView contentContainerStyle vs contentContainerClassName. */
function ScrollProbe() {
  const chips = ['one', 'two', 'three', 'four'];
  return (
    <Cell title="3 — contentContainerStyle" note="NativeWind remaps contentContainerClassName on ScrollView.">
      <Half label="StyleSheet">
        <ScrollView horizontal style={scrollStyles.scroller} contentContainerStyle={scrollStyles.content} testID="nwg-scroll-ss">
          {chips.map((c) => (
            <View key={c} style={scrollStyles.chip}><Text style={scrollStyles.chipText}>{c}</Text></View>
          ))}
        </ScrollView>
      </Half>
      <Half label="className">
        <ScrollView horizontal className="h-14 rounded bg-gray-100" contentContainerClassName="items-center gap-2 p-3" testID="nwg-scroll-nw">
          {chips.map((c) => (
            <View key={c} className="rounded-full bg-indigo-100 px-3 py-1"><Text className="text-xs text-indigo-900">{c}</Text></View>
          ))}
        </ScrollView>
      </Half>
    </Cell>
  );
}
const scrollStyles = StyleSheet.create({
  scroller: { height: 56, borderRadius: 4, backgroundColor: '#f3f4f6' },
  content: { alignItems: 'center', gap: 8, padding: 12 },
  chip: { borderRadius: 9999, backgroundColor: '#e0e7ff', paddingHorizontal: 12, paddingVertical: 4 },
  chipText: { fontSize: 12, lineHeight: 16, color: '#312e81' },
});

/** 4. Backdrop-blur overlay inside the cell + position:fixed badges (web-only CSS). */
function OverlayProbe() {
  const stripes = ['#f87171', '#fbbf24', '#34d399', '#60a5fa', '#a78bfa'];
  return (
    <Cell title="4 — backdrop overlay + fixed" note="backdropFilter/`fixed` are web-only (nw-keep: platform-css today). Identical fixed badges render bottom-right of the viewport (distinguished by position: SS right-2, NW right-24).">
      <Half label="StyleSheet">
        <View style={overlayStyles.frame} testID="nwg-overlay-ss">
          <View style={overlayStyles.stripes}>
            {stripes.map((c) => (
              <View key={c} style={[overlayStyles.stripe, { backgroundColor: c }]} />
            ))}
          </View>
          <View style={overlayStyles.blur} />
        </View>
      </Half>
      <Half label="className">
        <View className="h-14 overflow-hidden rounded" testID="nwg-overlay-nw">
          <View className="h-full flex-row">
            {stripes.map((c) => (
              <View key={c} style={{ backgroundColor: c }} className="flex-1" />
            ))}
          </View>
          <View className="absolute inset-0 bg-white/20 backdrop-blur-[3px]" />
        </View>
      </Half>
      {Platform.OS === 'web' && (
        <>
          <View style={overlayStyles.fixedBadge} testID="nwg-fixed-ss">
            <Text style={overlayStyles.fixedText}>fixed</Text>
          </View>
          <View className="fixed bottom-2 right-24 rounded bg-indigo-600 px-2 py-1" testID="nwg-fixed-nw">
            <Text className="text-[10px] leading-3 text-white">fixed</Text>
          </View>
        </>
      )}
    </Cell>
  );
}
const overlayStyles = StyleSheet.create({
  frame: { height: 56, overflow: 'hidden', borderRadius: 4 },
  stripes: { height: '100%', flexDirection: 'row' },
  stripe: { flex: 1 },
  blur: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(255,255,255,0.2)',
    ...(Platform.OS === 'web' ? ({ backdropFilter: 'blur(3px)' } as any) : null),
  },
  fixedBadge: {
    position: 'fixed' as any,
    bottom: 8,
    right: 8,
    borderRadius: 4,
    backgroundColor: '#4f46e5',
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  fixedText: { fontSize: 10, lineHeight: 12, color: '#ffffff' },
});

/**
 * 5. The FULL DROPDOWN_ZINDEX_PATTERN.md contract, stateful on both sides:
 * conditional row z-index, overflow-visible chain, click-away overlay at
 * z-index 9998 (position:fixed — web-only, like the documented pattern), a
 * negative-z divider, and Android `elevation` as a residual style prop on
 * the className dropdown (elevation has no class equivalent). Menus default
 * OPEN for the deterministic shot; the harness exercises click-away.
 */
function DropdownProbe() {
  const rows = [
    { id: 'a', name: 'Row with open menu' },
    { id: 'b', name: 'Sibling row below' },
  ];
  const [ssOpenId, setSsOpenId] = useState<string | null>('a');
  const [nwOpenId, setNwOpenId] = useState<string | null>('a');
  return (
    <Cell title="5 — dropdown z-index pattern" note="Full DROPDOWN_ZINDEX_PATTERN.md contract incl. fixed click-away overlay (z-9998) and elevation (residual style prop on the className dropdown — no class equivalent).">
      <Half label="StyleSheet">
        <View style={ddStyles.card} testID="nwg-dd-ss">
          <View style={ddStyles.table}>
            {rows.map((row, i) => (
              <View key={row.id} style={ssOpenId === row.id ? ddStyles.rowOpen : ddStyles.row}>
                <View style={ddStyles.tableRow}>
                  <View style={ddStyles.colName}><Text style={ddStyles.rowText}>{row.name}</Text></View>
                  <View style={ddStyles.colMenu}>
                    <Pressable onPress={() => setSsOpenId(row.id)} testID={`nwg-dd-ss-trigger-${row.id}`}>
                      <Text style={ddStyles.rowText}>⋮</Text>
                    </Pressable>
                    {ssOpenId === row.id && (
                      <>
                        <Pressable style={ddStyles.overlay} onPress={() => setSsOpenId(null)} testID="nwg-dd-ss-overlay" />
                        <View style={ddStyles.dropdown} testID="nwg-dd-ss-menu">
                          <View style={ddStyles.dropdownItem}><Text style={ddStyles.rowText}>Option 1</Text></View>
                          <View style={ddStyles.dropdownItem}><Text style={ddStyles.rowText}>Option 2</Text></View>
                        </View>
                      </>
                    )}
                  </View>
                </View>
                {i < rows.length - 1 && <View style={ddStyles.divider} />}
              </View>
            ))}
          </View>
        </View>
      </Half>
      <Half label="className">
        <View className="z-[99999] overflow-visible rounded border border-gray-300 bg-white p-2" testID="nwg-dd-nw">
          <View className="relative overflow-visible">
            {rows.map((row, i) => (
              <View key={row.id} className={nwOpenId === row.id ? 'relative z-[99999] overflow-visible' : 'relative z-[1] overflow-visible'}>
                <View className="relative flex-row items-center overflow-visible">
                  <View className="relative z-[1] flex-1 p-2"><Text className="text-xs text-gray-900">{row.name}</Text></View>
                  <View className="relative z-[99999] w-6 items-center justify-center overflow-visible">
                    <Pressable onPress={() => setNwOpenId(row.id)} testID={`nwg-dd-nw-trigger-${row.id}`}>
                      <Text className="text-xs text-gray-900">⋮</Text>
                    </Pressable>
                    {nwOpenId === row.id && (
                      <>
                        <Pressable className="fixed inset-0 z-[9998]" onPress={() => setNwOpenId(null)} testID="nwg-dd-nw-overlay" />
                        {/* elevation: Android-only, no class equivalent — residual style prop */}
                        <View
                          className="absolute right-0 top-7 z-[99999] min-w-[160px] rounded-none border border-gray-300 bg-white"
                          style={{ elevation: 99999 }}
                          testID="nwg-dd-nw-menu"
                        >
                          <View className="bg-white p-2"><Text className="text-xs text-gray-900">Option 1</Text></View>
                          <View className="bg-white p-2"><Text className="text-xs text-gray-900">Option 2</Text></View>
                        </View>
                      </>
                    )}
                  </View>
                </View>
                {i < rows.length - 1 && <View className="relative -z-[1] h-px w-full bg-gray-300" />}
              </View>
            ))}
          </View>
        </View>
      </Half>
    </Cell>
  );
}
const ddStyles = StyleSheet.create({
  card: { zIndex: 99999, overflow: 'visible', borderWidth: 1, borderColor: '#d1d5db', borderRadius: 4, backgroundColor: '#ffffff', padding: 8 },
  table: { position: 'relative', overflow: 'visible' },
  row: { position: 'relative', zIndex: 1, overflow: 'visible' },
  rowOpen: { position: 'relative', zIndex: 99999, overflow: 'visible' },
  tableRow: { flexDirection: 'row', alignItems: 'center', position: 'relative', overflow: 'visible' },
  colName: { flex: 1, padding: 8, position: 'relative', zIndex: 1 },
  colMenu: { width: 24, alignItems: 'center', justifyContent: 'center', position: 'relative', zIndex: 99999, overflow: 'visible' },
  overlay: { position: 'fixed' as any, top: 0, left: 0, right: 0, bottom: 0, zIndex: 9998 },
  dropdown: { position: 'absolute', top: 28, right: 0, minWidth: 160, borderRadius: 0, borderWidth: 1, borderColor: '#d1d5db', backgroundColor: '#ffffff', zIndex: 99999, elevation: 99999 },
  dropdownItem: { backgroundColor: '#ffffff', padding: 8 },
  divider: { height: 1, width: '100%', position: 'relative', zIndex: -1, backgroundColor: '#d1d5db' },
  rowText: { fontSize: 12, lineHeight: 16, color: '#111827' },
});

/** 6. RN Modal (portals to document.body on web); equal trigger buttons, shared portal content with an SS-vs-NW swatch pair. */
function ModalProbe() {
  const [open, setOpen] = useState(false);
  return (
    <Cell title="6 — RN Modal portal" note="RN-Web Modal portals to document.body; classes must still resolve there. The two in-modal swatches are the equivalence pair.">
      <Half label="StyleSheet">
        <Pressable style={modalStyles.button} onPress={() => setOpen(true)} testID="nwg-open-modal">
          <Text style={modalStyles.buttonText}>Open modal</Text>
        </Pressable>
      </Half>
      <Half label="className">
        <Pressable className="self-start rounded bg-indigo-600 px-3 py-2" onPress={() => setOpen(true)} testID="nwg-open-modal-nw">
          <Text className="text-xs leading-4 text-white">Open modal</Text>
        </Pressable>
        <Modal visible={open} transparent animationType="none" onRequestClose={() => setOpen(false)}>
          <View className="flex-1 items-center justify-center bg-black/50">
            <View className="w-64 gap-2 rounded-xl bg-white p-6" testID="nwg-modal-content">
              <Text className="text-sm font-bold text-gray-900">className inside Modal</Text>
              <View style={modalStyles.swatch} testID="nwg-modal-ss-swatch" />
              <View className="h-4 w-24 rounded bg-indigo-600" testID="nwg-modal-nw-swatch" />
              <Pressable className="mt-2 items-center rounded bg-gray-200 p-2" onPress={() => setOpen(false)} testID="nwg-close-modal">
                <Text className="text-xs text-gray-900">Close</Text>
              </Pressable>
            </View>
          </View>
        </Modal>
      </Half>
    </Cell>
  );
}
const modalStyles = StyleSheet.create({
  button: { alignSelf: 'flex-start', borderRadius: 4, backgroundColor: '#4f46e5', paddingHorizontal: 12, paddingVertical: 8 },
  buttonText: { fontSize: 12, lineHeight: 16, color: '#ffffff' },
  swatch: { height: 16, width: 96, borderRadius: 4, backgroundColor: '#4f46e5' },
});

/** 7. SVG custom visual props (fill/stroke stay props — nw-keep: svg-or-canvas). */
function SvgProbe() {
  const art = (
    <Svg width={96} height={40} viewBox="0 0 96 40">
      <Rect x={4} y={4} width={40} height={32} rx={6} fill={ACCENT} stroke="#312e81" strokeWidth={2} />
      <Circle cx={72} cy={20} r={16} fill="#34d399" stroke="#065f46" strokeWidth={2} />
    </Svg>
  );
  return (
    <Cell title="7 — SVG visual props" note="fill/stroke are SVG props, not styles (nw-keep: svg-or-canvas); the className side only classes the wrapper.">
      <Half label="StyleSheet">
        <View style={svgStyles.wrap} testID="nwg-svg-ss">{art}</View>
      </Half>
      <Half label="className">
        <View className="self-start rounded bg-gray-100 p-2" testID="nwg-svg-nw">{art}</View>
      </Half>
    </Cell>
  );
}
const svgStyles = StyleSheet.create({
  wrap: { alignSelf: 'flex-start', borderRadius: 4, backgroundColor: '#f3f4f6', padding: 8 },
});

/** 8. Third-party style boundary: Ionicons keeps its color/size prop API — one identical icon per side. */
function ThirdPartyProbe() {
  return (
    <Cell title="8 — third-party boundary (Ionicons)" note="Both sides use the supported color/size prop API (nw-keep: third-party-style-api); only the wrapper differs. The className-pass-through question is probe E2.">
      <Half label="StyleSheet">
        <View style={iconStyles.wrap} testID="nwg-icon-ss">
          <Ionicons name="shield-checkmark" size={24} color={ACCENT} />
        </View>
      </Half>
      <Half label="className">
        <View className="flex-row items-center gap-2 self-start rounded bg-gray-100 p-2" testID="nwg-icon-nw">
          <Ionicons name="shield-checkmark" size={24} color={ACCENT} />
        </View>
      </Half>
    </Cell>
  );
}
const iconStyles = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', borderRadius: 4, backgroundColor: '#f3f4f6', padding: 8 },
});

/** 9. Floating-UI-positioned element — platform-split specimen (web: real hook; native: no-op). */
function FloatingCell() {
  return (
    <Cell title="9 — Floating UI" note="floatingStyles stays an inline style (nw-keep: floating-ui); panel cosmetics are classes. Web verified; native renders a no-op (DOM-only library).">
      <Half label="StyleSheet">
        <FloatingProbe variant="ss" />
      </Half>
      <Half label="className">
        <FloatingProbe variant="nw" />
      </Half>
    </Cell>
  );
}

// -------------------------------------------- evidence probes (NOT pairs) ---

/**
 * E1. Direct className on RN Animated.View. MEASURED BEHAVIOR depends only on
 * whether a cssInterop(Animated.View) registration ran at startup (see
 * _layout.tsx — two isolated page loads):
 *   default load  → className is silently DROPPED (residual style survives).
 *   ?animReg=1    → className applies (registered before any JSX element).
 * Registration is global for elements created AFTER the call — F-C must pick
 * a deterministic startup registration point or mandate the wrapper pattern.
 */
function AnimatedDirectEvidence() {
  const registered = galleryAnimRegistrationRequested();
  return (
    <Cell
      title="E1 — Animated direct className (evidence probe)"
      note={`NOT an equivalence pair. This load: ${registered ? 'cssInterop(Animated.View) registered at startup — classes should APPLY' : 'no registration — classes should be DROPPED'}.`}
    >
      <Half label="className">
        <View className="h-10 w-40 justify-center rounded bg-gray-200">
          <Animated.View
            className="h-6 w-6 rounded-full bg-indigo-600"
            style={{ transform: [{ translateX: animatedX }] }}
            testID="nwg-anim-direct"
          />
        </View>
      </Half>
    </Cell>
  );
}

/** E2. Ionicons className pass-through probe. */
function IoniconsClassNameEvidence() {
  const IoniconsAny = Ionicons as any; // probe: className on an unregistered 3rd-party component
  return (
    <Cell title="E2 — Ionicons className pass-through (evidence probe)" note="NOT an equivalence pair. MEASURED: className passes through to the inner RNW Text and APPLIES (text-emerald-600 colors the glyph). Treated as non-contractual — third-party-style-api exceptions stand.">
      <Half label="className">
        <View className="self-start rounded bg-gray-100 p-2">
          <IoniconsAny name="shield-checkmark" size={24} className="text-emerald-600" testID="nwg-icon-classname-probe" />
        </View>
      </Half>
    </Cell>
  );
}

// ----------------------------------------------------------------- page ---

export default function NwGallery() {
  return (
    <ScrollView style={pageStyles.page} contentContainerStyle={pageStyles.content}>
      <Text style={pageStyles.h1} testID="nwg-title">NativeWind compatibility gallery</Text>
      <Text style={cellStyles.note}>Cells 0-9: identical visual, StyleSheet (left) vs className (right) — harness-diffed per cell. E1/E2: evidence probes, not equivalence claims.</Text>
      <UtilityProbe />
      <SemanticVarProbe />
      <AnimatedProbe />
      <ScrollProbe />
      <OverlayProbe />
      <DropdownProbe />
      <ModalProbe />
      <SvgProbe />
      <ThirdPartyProbe />
      <FloatingCell />
      <AnimatedDirectEvidence />
      <IoniconsClassNameEvidence />
    </ScrollView>
  );
}

const pageStyles = StyleSheet.create({
  page: { flex: 1, backgroundColor: CELL_BG },
  content: { gap: 12, padding: 24, maxWidth: 720, width: '100%', alignSelf: 'center', paddingBottom: 96 },
  h1: { fontSize: 18, fontWeight: '700', color: '#111827' },
});
