// Classifier unit tests for the NativeWind-port audit tool (report mode v1).
// Fixture snippets exercise every sink kind the tool claims to detect.
import { describe, expect, test } from 'bun:test';
import {
  auditSource,
  auditRepo,
  collectViolations,
  classNameTokenCssProp,
  findCoActiveClassConflicts,
  isColorLiteral,
  rawDomBorderMissingStyle,
  NW_KEEP_CATEGORIES,
} from './audit-nativewind';
import * as path from 'node:path';

describe('isColorLiteral', () => {
  test('hex forms', () => {
    expect(isColorLiteral('#fff')).toBe(true);
    expect(isColorLiteral('#FFFF')).toBe(true);
    expect(isColorLiteral('#00daf8')).toBe(true);
    expect(isColorLiteral('#00DAF8CC')).toBe(true);
    expect(isColorLiteral('#gggggg')).toBe(false);
    expect(isColorLiteral('#12345')).toBe(false);
  });
  test('functional + named forms', () => {
    expect(isColorLiteral('rgba(0,0,0,0.5)')).toBe(true);
    expect(isColorLiteral('rgb(10, 20, 30)')).toBe(true);
    expect(isColorLiteral('hsl(120, 50%, 50%)')).toBe(true);
    expect(isColorLiteral('transparent')).toBe(true);
    expect(isColorLiteral('white')).toBe(true);
    expect(isColorLiteral('Deposit')).toBe(false);
    expect(isColorLiteral('100%')).toBe(false);
    expect(isColorLiteral('center')).toBe(false);
  });
});

describe('auditSource — StyleSheet detection', () => {
  test('counts StyleSheet.create and collects color literals inside it', () => {
    const r = auditSource(
      'fixture.tsx',
      `import { StyleSheet } from 'react-native';
       const styles = StyleSheet.create({
         box: { backgroundColor: '#19B091', borderColor: 'rgba(0,0,0,0.2)', width: 10 },
         label: { color: 'white', textAlign: 'center' },
       });`,
    );
    expect(r.styleSheetCreateCount).toBe(1);
    expect(r.styleSheetRefs.map((s) => s.kind)).toEqual(['create']);
    expect(r.colorLiterals.map((c) => c.value).sort()).toEqual(['#19B091', 'rgba(0,0,0,0.2)', 'white']);
    expect(r.colorLiterals.every((c) => c.context === 'stylesheet-create')).toBe(true);
    expect(r.hasStyles).toBe(true);
  });

  test('detects non-create StyleSheet refs (absoluteFill, flatten, hairlineWidth)', () => {
    const r = auditSource(
      'fixture.tsx',
      `import { StyleSheet } from 'react-native';
       const a = StyleSheet.absoluteFill;
       const b = StyleSheet.flatten([a]);
       const w = StyleSheet.hairlineWidth;`,
    );
    expect(r.styleSheetCreateCount).toBe(0);
    expect(r.styleSheetRefs.map((s) => s.kind).sort()).toEqual(['absoluteFill', 'flatten', 'hairlineWidth']);
    expect(r.hasStyles).toBe(true);
  });
});

describe('auditSource — JSX style sinks', () => {
  test('plain style prop with object literal', () => {
    const r = auditSource('fixture.tsx', `const x = <View style={{ flex: 1, backgroundColor: '#000000' }} />;`);
    expect(r.sinks).toHaveLength(1);
    expect(r.sinks[0]).toMatchObject({ kind: 'jsx-style', name: 'style', element: 'View', valueKind: 'object-literal' });
    expect(r.colorLiterals).toEqual([{ value: '#000000', line: 1, context: 'inline-style' }]);
  });

  test('style array + reference', () => {
    const r = auditSource('fixture.tsx', `const x = <Animated.View style={[styles.a, { opacity: fade }]} />;`);
    expect(r.sinks[0]).toMatchObject({ kind: 'jsx-style', element: 'Animated.View', valueKind: 'array-literal' });
  });

  test('Pressable style callback is classified separately', () => {
    const r = auditSource(
      'fixture.tsx',
      `const x = <Pressable style={({ pressed }) => [styles.btn, pressed && { opacity: 0.5 }]} />;`,
    );
    expect(r.sinks[0]).toMatchObject({ kind: 'jsx-style-callback', element: 'Pressable', valueKind: 'function' });
  });

  test('contentContainerStyle-family props are jsx-namedStyle sinks', () => {
    const r = auditSource(
      'fixture.tsx',
      `const x = <ScrollView contentContainerStyle={{ paddingTop: 8 }} />;
       const y = <QRCode logoContainerStyle={{ borderRadius: 4 }} />;`,
    );
    expect(r.sinks.map((s) => [s.kind, s.name, s.element])).toEqual([
      ['jsx-namedStyle', 'contentContainerStyle', 'ScrollView'],
      ['jsx-namedStyle', 'logoContainerStyle', 'QRCode'],
    ]);
  });
});

describe('auditSource — navigation options, createElement, CSSProperties', () => {
  test('navigation-options style keys inside object literals', () => {
    const r = auditSource(
      'fixture.tsx',
      `const opts = { tabBarStyle: { height: 60, backgroundColor: '#111111' }, headerStyle: hdr };`,
    );
    expect(r.sinks.map((s) => [s.kind, s.name, s.valueKind])).toEqual([
      ['navigation-options', 'tabBarStyle', 'object-literal'],
      ['navigation-options', 'headerStyle', 'reference'],
    ]);
    expect(r.colorLiterals).toEqual([{ value: '#111111', line: 1, context: 'navigation-options' }]);
  });

  test('createElement style props', () => {
    const r = auditSource(
      'fixture.ts',
      `import { createElement } from 'react';
       const el = React.createElement('div', { style: { position: 'fixed' }, className: 'x' });
       const el2 = createElement('span', { containerStyle: someRef });`,
    );
    expect(r.sinks.map((s) => [s.kind, s.name, s.valueKind])).toEqual([
      ['createElement-style', 'style', 'object-literal'],
      ['createElement-style', 'containerStyle', 'reference'],
    ]);
  });

  test('React.CSSProperties type references', () => {
    const r = auditSource(
      'fixture.tsx',
      `const s: React.CSSProperties = { position: 'fixed' };
       function f(x: CSSProperties) { return x; }`,
    );
    expect(r.sinks.filter((s) => s.kind === 'css-properties-type').map((s) => s.name).sort()).toEqual([
      'CSSProperties',
      'React.CSSProperties',
    ]);
  });
});

describe('auditSource — visual color props', () => {
  test('SVG and icon color props, literal captured when static', () => {
    const r = auditSource(
      'fixture.tsx',
      `const x = <Circle fill="#00daf8" stroke={color} />;
       const y = <Ionicons name="water" color={colors.primary} />;
       const z = <Stop stopColor="#7000ff" />;
       const t = <TextInput placeholderTextColor="rgba(0,0,0,0.4)" />;`,
    );
    const byName = Object.fromEntries(r.colorProps.map((p) => [`${p.element}.${p.name}`, p.literal ?? null]));
    expect(byName).toEqual({
      'Circle.fill': '#00daf8',
      'Circle.stroke': null,
      'Ionicons.color': null,
      'Stop.stopColor': '#7000ff',
      'TextInput.placeholderTextColor': 'rgba(0,0,0,0.4)',
    });
    expect(r.hasStyles).toBe(true);
  });

  test('non-color props named color-ish are not double-counted as sinks', () => {
    const r = auditSource('fixture.tsx', `const x = <View testID="a" onLayout={f} />;`);
    expect(r.sinks).toHaveLength(0);
    expect(r.colorProps).toHaveLength(0);
    expect(r.hasStyles).toBe(false);
  });
});

describe('auditSource — JSX spread attributes', () => {
  test('spread-only files are still flagged (spreads can carry style)', () => {
    const r = auditSource(
      'fixture.tsx',
      `export function HapticTab(props: Props) {
         return <PlatformPressable {...props} onPressIn={f} />;
       }`,
    );
    expect(r.sinks).toHaveLength(1);
    expect(r.sinks[0]).toMatchObject({ kind: 'jsx-spread', element: 'PlatformPressable', valueKind: 'reference' });
    expect(r.hasStyles).toBe(true);
  });

  test('spread on member-expression component records the dotted tag', () => {
    const r = auditSource('fixture.tsx', `const x = <Animated.View {...animatedProps} style={{ opacity: 1 }} />;`);
    expect(r.sinks.map((s) => [s.kind, s.element])).toEqual([
      ['jsx-spread', 'Animated.View'],
      ['jsx-style', 'Animated.View'],
    ]);
  });
});

describe('auditSource — nw-keep annotations', () => {
  test('valid categories parse with reasons', () => {
    const r = auditSource(
      'fixture.tsx',
      `const s = {
         // nw-keep(animated): opacity rides an Animated.Value
         opacity: fade,
         /* nw-keep(platform-css): position:fixed is web-only */
         position: 'fixed' as any,
       };`,
    );
    expect(r.nwKeep).toEqual([
      { category: 'animated', reason: 'opacity rides an Animated.Value', line: 2, valid: true },
      { category: 'platform-css', reason: 'position:fixed is web-only', line: 4, valid: true },
    ]);
  });

  test('unknown category is flagged invalid', () => {
    const r = auditSource('fixture.tsx', `// nw-keep(because-reasons): trust me`);
    expect(r.nwKeep).toHaveLength(1);
    expect(r.nwKeep[0].valid).toBe(false);
  });

  test('known category with an empty reason is flagged invalid', () => {
    const r = auditSource('fixture.tsx', `// nw-keep(animated):`);
    expect(r.nwKeep).toHaveLength(1);
    expect(r.nwKeep[0]).toMatchObject({ category: 'animated', reason: '', valid: false });
  });

  test('multiple annotations on one line are all collected', () => {
    const r = auditSource('fixture.tsx', `/* nw-keep(animated): a */ const x = 1; // nw-keep(platform-css): b`);
    expect(r.nwKeep.map((k) => k.category)).toEqual(['animated', 'platform-css']);
    expect(r.nwKeep.every((k) => k.valid)).toBe(true);
  });

  test('taxonomy matches the plan', () => {
    expect([...NW_KEEP_CATEGORIES].sort()).toEqual([
      'animated',
      'data-color',
      'floating-ui',
      'forwarded-style-contract',
      'measured-or-inset',
      'navigation-options',
      'platform-css',
      'root-vars',
      'svg-or-canvas',
      'third-party-style-api',
    ]);
  });
});

describe('rawDomBorderMissingStyle (CONFIG-02, preflight OFF)', () => {
  test('width-bearing utilities without a style are flagged', () => {
    expect(rawDomBorderMissingStyle('border border-gray-300 bg-white')).toBe(true);
    expect(rawDomBorderMissingStyle('border-2 p-2')).toBe(true);
    expect(rawDomBorderMissingStyle('border-t')).toBe(true);
    expect(rawDomBorderMissingStyle('border-b-2')).toBe(true);
    expect(rawDomBorderMissingStyle('border-[3px]')).toBe(true);
    expect(rawDomBorderMissingStyle('divide-y')).toBe(true);
    expect(rawDomBorderMissingStyle('divide-x-2')).toBe(true);
    expect(rawDomBorderMissingStyle('hover:border rounded')).toBe(true);
  });

  test('an explicit border style satisfies the invariant', () => {
    expect(rawDomBorderMissingStyle('border border-solid border-gray-300')).toBe(false);
    expect(rawDomBorderMissingStyle('border-2 border-dashed')).toBe(false);
    expect(rawDomBorderMissingStyle('divide-y divide-dotted')).toBe(false);
    expect(rawDomBorderMissingStyle('border border-none')).toBe(false);
  });

  test('colors, radius and table utilities alone are not width-bearing', () => {
    expect(rawDomBorderMissingStyle('border-gray-300 bg-white')).toBe(false);
    expect(rawDomBorderMissingStyle('rounded-lg rounded-t-xl')).toBe(false);
    expect(rawDomBorderMissingStyle('border-collapse border-spacing-2')).toBe(false);
    expect(rawDomBorderMissingStyle('text-xs p-2')).toBe(false);
  });

  test('flags raw-DOM elements only; RN components are exempt (RNW defaults solid)', () => {
    const raw = auditSource('fixture.tsx', `const A = () => <div className="border bg-white" />;`);
    expect(raw.rawDomBorderIssues).toHaveLength(1);
    expect(raw.rawDomBorderIssues[0]).toMatchObject({ element: 'div', className: 'border bg-white' });

    const rn = auditSource('fixture.tsx', `const B = () => <View className="border bg-white" />;`);
    expect(rn.rawDomBorderIssues).toHaveLength(0);

    const solid = auditSource('fixture.tsx', `const C = () => <button className="border border-solid" />;`);
    expect(solid.rawDomBorderIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Enforcement: inline style-sink classification (adjacent nw-keep)
// ---------------------------------------------------------------------------

describe('inline style-sink classification (fail-mode input)', () => {
  test('inline object with an nw-keep inside the opening tag is classified', () => {
    const r = auditSource(
      'fixture.tsx',
      `const x = (
        <View
          // nw-keep(animated): opacity rides an Animated.Value
          style={{ opacity: fade }}
        />
      );`,
    );
    expect(r.sinks[0]).toMatchObject({ kind: 'jsx-style', classified: true });
  });

  test('inline object with a `{/* nw-keep */}` JSX-child comment one line above is classified', () => {
    const r = auditSource(
      'fixture.tsx',
      `const x = (
        <View>
          {/* nw-keep(data-color): runtime hue background, no class token */}
          <Text style={{ color: hue.fg }}>{label}</Text>
        </View>
      );`,
    );
    const textSink = r.sinks.find((s) => s.element === 'Text');
    expect(textSink?.classified).toBe(true);
  });

  test('inline object with NO adjacent nw-keep is unclassified (flagged)', () => {
    const r = auditSource('fixture.tsx', `const x = <View style={{ opacity: fade, position: 'absolute' }} />;`);
    expect(r.sinks[0]).toMatchObject({ kind: 'jsx-style', classified: false });
  });

  test('a reference-valued style prop is never treated as debt (classified undefined)', () => {
    const r = auditSource('fixture.tsx', `const x = <View style={StyleSheet.absoluteFill} />;`);
    expect(r.sinks[0]).toMatchObject({ kind: 'jsx-style', valueKind: 'reference' });
    expect(r.sinks[0].classified).toBeUndefined();
  });

  test('an inline object behind `cond && ...` is an inline sink and needs an nw-keep', () => {
    const bare = auditSource('fixture.tsx', `const x = <View style={cond && { color: 'red' }} />;`);
    expect(bare.sinks[0]).toMatchObject({ kind: 'jsx-style', valueKind: 'object-literal', classified: false });

    const kept = auditSource(
      'fixture.tsx',
      `const x = (
        <View
          // nw-keep(data-color): runtime hue, no class token
          style={cond && { color: hue }}
        />
      );`,
    );
    expect(kept.sinks[0]?.classified).toBe(true);

    // `a || b` with reference-only operands is NOT debt.
    const refs = auditSource('fixture.tsx', `const x = <View style={maybeStyles || styles.fallback} />;`);
    expect(refs.sinks[0].classified).toBeUndefined();
  });

  test('an nw-keep for one element does NOT classify the next sibling (no bleed)', () => {
    const r = auditSource(
      'fixture.tsx',
      `const x = (
        <View>
          {/* nw-keep(animated): opacity rides an Animated.Value */}
          <A style={{ opacity: fade }} />
          <B style={{ color: 'red' }} />
        </View>
      );`,
    );
    expect(r.sinks.find((s) => s.element === 'A')?.classified).toBe(true);
    expect(r.sinks.find((s) => s.element === 'B')?.classified).toBe(false);
  });

  test('an nw-keep above the PARENT does not classify a child sink', () => {
    const r = auditSource(
      'fixture.tsx',
      `const x = (
        // nw-keep(animated): annotates the wrapper element
        <View>
          <Text style={{ opacity: fade }} />
        </View>
      );`,
    );
    expect(r.sinks.find((s) => s.element === 'Text')?.classified).toBe(false);
  });

  test('a navigation-options keep does not bleed into the next style key', () => {
    const r = auditSource(
      'fixture.tsx',
      `const opts = {
        // nw-keep(navigation-options): computed tab bar height
        tabBarStyle: { height: 60 },
        headerStyle: { backgroundColor: '#000000' },
      };`,
    );
    expect(r.sinks.find((s) => s.name === 'tabBarStyle')?.classified).toBe(true);
    expect(r.sinks.find((s) => s.name === 'headerStyle')?.classified).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Co-active conflicting-class rule (kimi P3 §7)
// ---------------------------------------------------------------------------

describe('classNameTokenCssProp — canonical property mapping', () => {
  test('guarded families map to a single side-specific property', () => {
    expect(classNameTokenCssProp('justify-center')).toBe('justify-content');
    expect(classNameTokenCssProp('items-end')).toBe('align-items');
    expect(classNameTokenCssProp('max-w-[560px]')).toBe('max-width');
    expect(classNameTokenCssProp('w-full')).toBe('width');
    expect(classNameTokenCssProp('p-[24px]')).toBe('padding');
    expect(classNameTokenCssProp('pt-[26px]')).toBe('padding-top');
    expect(classNameTokenCssProp('hover:pt-2')).toBe('padding-top'); // variant prefix stripped
    expect(classNameTokenCssProp('-mt-2')).toBe('margin-top');
  });

  test('out-of-scope utilities map to null', () => {
    expect(classNameTokenCssProp('flex-1')).toBeNull();
    expect(classNameTokenCssProp('rounded-[12px]')).toBeNull();
    expect(classNameTokenCssProp('bg-card-background')).toBeNull();
    expect(classNameTokenCssProp('whitespace-nowrap')).toBeNull();
  });
});

describe('findCoActiveClassConflicts', () => {
  test('same property, different value across base/conditional is a conflict', () => {
    expect(findCoActiveClassConflicts(['justify-center'], ['justify-end'])).toEqual([
      { property: 'justify-content', baseToken: 'justify-center', conditionalToken: 'justify-end' },
    ]);
    expect(findCoActiveClassConflicts(['pt-[10px]'], ['pt-[20px]'])).toHaveLength(1);
  });

  test('shorthand vs longhand is NOT a conflict (documented limitation)', () => {
    // p-[24px] owns `padding`; pt-[26px] owns `padding-top` — different keys.
    expect(findCoActiveClassConflicts(['p-[24px]'], ['pt-[26px]'])).toEqual([]);
    expect(findCoActiveClassConflicts(['p-[24px]'], ['pb-[32px]', 'pt-[14px]'])).toEqual([]);
  });

  test('keyword mode-switch (max-w-full / w-screen) in the conditional is exempt', () => {
    expect(findCoActiveClassConflicts(['max-w-[560px]'], ['max-w-full'])).toEqual([]);
    expect(findCoActiveClassConflicts(['w-[200px]'], ['w-screen'])).toEqual([]);
  });

  test('identical tokens and out-of-scope tokens never conflict', () => {
    expect(findCoActiveClassConflicts(['justify-center'], ['justify-center'])).toEqual([]);
    expect(findCoActiveClassConflicts(['flex-1', 'rounded-lg'], ['gap-2'])).toEqual([]);
  });
});

describe('auditSource — co-active conflict on a className template literal', () => {
  test('a base+conditional same-property override is recorded', () => {
    const r = auditSource(
      'fixture.tsx',
      "const x = <View className={`items-center justify-center ${sheet ? 'justify-end' : ''}`} />;",
    );
    expect(r.classConflicts).toHaveLength(1);
    expect(r.classConflicts[0]).toMatchObject({
      element: 'View',
      property: 'justify-content',
      baseToken: 'justify-center',
      conditionalToken: 'justify-end',
    });
  });

  test('the P3-accepted `p-[X] ${sheet ? pt-[Y] : ""}` refinement is not flagged', () => {
    const r = auditSource(
      'fixture.tsx',
      "const x = <View className={`gap-[14px] p-[24px] ${sheet ? 'pt-[26px] rounded-t-[24px]' : 'rounded-[20px]'}`} />;",
    );
    expect(r.classConflicts).toEqual([]);
  });

  test('plain-string classNames can never conflict (no conditional segment)', () => {
    const r = auditSource('fixture.tsx', `const x = <View className="justify-center justify-end" />;`);
    expect(r.classConflicts).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Whole-repo enforcement gate: the committed tree must be violation-free
// ---------------------------------------------------------------------------

describe('collectViolations — the real repo is fully classified (fail mode exits 0)', () => {
  test('no StyleSheet.create / unclassified sink / invalid nw-keep / raw-DOM border / co-active conflict', () => {
    const root = path.resolve(new URL('.', import.meta.url).pathname, '..');
    const violations = collectViolations(auditRepo(root));
    if (violations.length > 0) {
      throw new Error(
        `audit found ${violations.length} unclassified styling violation(s):\n` +
          violations.map((v) => `  ${v.file}:${v.line} [${v.kind}] ${v.detail}`).join('\n'),
      );
    }
    expect(violations).toEqual([]);
  });
});
