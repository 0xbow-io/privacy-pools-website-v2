// Arbitrary-property native-compile probe tests (P5).
//
// Guards against the NativeWind bug class where an arbitrary-PROPERTY class
// (`[<prop>:<value>]`, e.g. `[textAlignVertical:top]`) compiles to NOTHING on
// native — silently dropping the style on iOS/Android while still working on
// web, so the visual gate never catches it. P3 found this with
// `[textAlignVertical:top]` and moved those sinks to `style` props + nw-keep.
//
// The whole-repo gate at the bottom asserts the tree stays clean; the unit
// tests prove the pipeline has teeth (it WOULD flag a re-introduced sink) and
// that extraction never false-positives on comments or TS type annotations.
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import {
  compilesToNativeDeclaration,
  extractClassNameTexts,
  findArbitraryProps,
  scanRepo,
} from './arbitrary-prop-native-compile';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');

describe('compilesToNativeDeclaration', () => {
  test('css-interop-mappable properties produce a native declaration', () => {
    expect(compilesToNativeDeclaration('max-width', '720px').ok).toBe(true);
    expect(compilesToNativeDeclaration('gap', '8px').ok).toBe(true);
    expect(compilesToNativeDeclaration('min-height', '96px').ok).toBe(true);
  });

  test('textAlignVertical compiles to NOTHING on native (the known P3 bug)', () => {
    const r = compilesToNativeDeclaration('textAlignVertical', 'top');
    expect(r.ok).toBe(false);
    // css-interop flags it explicitly.
    expect(JSON.stringify(r.warnings)).toContain('IncompatibleNativeProperty');
  });

  test('the kebab spelling is equally incompatible', () => {
    expect(compilesToNativeDeclaration('text-align-vertical', 'top').ok).toBe(false);
  });

  test('custom properties compile to NOTHING on native (silently — no warning)', () => {
    // `[--my-var:…]` sets a CSS var on web; css-interop 0.2.6 drops the
    // declaration entirely, without even an IncompatibleNativeProperty
    // warning — the stealthiest form of the bug class.
    expect(compilesToNativeDeclaration('--my-var', '5px').ok).toBe(false);
  });

  test('vendor-prefixed properties compile to NOTHING on native', () => {
    expect(compilesToNativeDeclaration('-webkit-line-clamp', '2').ok).toBe(false);
  });
});

describe('findArbitraryProps', () => {
  test('matches a standalone arbitrary property', () => {
    expect(findArbitraryProps('min-h-[96px] [textAlignVertical:top] text-text')).toEqual([
      { raw: '[textAlignVertical:top]', prop: 'textAlignVertical', value: 'top' },
    ]);
  });

  test('matches a variant-prefixed arbitrary property', () => {
    const f = findArbitraryProps('dark:[mask-type:luminance]');
    expect(f).toEqual([{ raw: '[mask-type:luminance]', prop: 'mask-type', value: 'luminance' }]);
  });

  test('ignores arbitrary VALUES (utility-prefixed brackets)', () => {
    expect(findArbitraryProps('p-[20px] bg-[#FAFAFA] w-[720px] text-[12px] rounded-[14px]')).toEqual([]);
  });

  test('ignores arbitrary VARIANTS (`[&_svg]:` / `[&:hover]:`)', () => {
    expect(findArbitraryProps('[&_svg]:size-4 [&:hover]:bg-red-500')).toEqual([]);
  });

  test('matches custom properties and vendor-prefixed properties', () => {
    // Both are spellings Tailwind accepts in the arbitrary-property position
    // and emits verbatim — and both drop on native (verified below).
    expect(findArbitraryProps('[--my-var:5px] [-webkit-line-clamp:2]')).toEqual([
      { raw: '[--my-var:5px]', prop: '--my-var', value: '5px' },
      { raw: '[-webkit-line-clamp:2]', prop: '-webkit-line-clamp', value: '2' },
    ]);
  });
});

describe('extractClassNameTexts — never leaks comments or TS types', () => {
  // A textAlignVertical mention inside an nw-keep COMMENT (as it appears across
  // the real ported modals) and a TS tuple type must NOT be extracted; only the
  // live className literals are.
  const fixture = `
    // nw-keep(platform-css): the [textAlignVertical:top] arbitrary class compiles to nothing on native
    type Cfg = readonly [enabled: boolean, minAmount: bigint];
    const A = <input className="min-h-[96px] rounded-[14px] max-w-[720px]" style={{ textAlignVertical: 'top' }} />;
    const B = <View className={\`p-[8px] \${dark ? '[textAlignVertical:top]' : 'text-text'}\`} />;
  `;

  test('extracts only className literals', () => {
    const texts = extractClassNameTexts('fixture.tsx', fixture).map((t) => t.text);
    // A's string literal + B's template statics and branch literals.
    expect(texts).toEqual([
      'min-h-[96px] rounded-[14px] max-w-[720px]',
      'p-[8px] ',
      '[textAlignVertical:top]',
      'text-text',
    ]);
    // The comment's textAlignVertical and the TS tuple must be absent.
    const joined = texts.join('\n');
    expect(joined).toContain('min-h-[96px]');
    expect(joined).not.toContain('nw-keep');
    expect(joined).not.toContain('enabled: boolean');
  });

  test('an nw-keep comment INSIDE the className braces is not scanned either', () => {
    // `getText()` on the whole className expression spans interior comments —
    // an nw-keep note inside the braces mentioning the moved arbitrary class
    // would false-positive the gate. Literal-only extraction must not.
    const withInnerComment = `
      const C = <View className={cn(
        'min-h-[96px]',
        // nw-keep(platform-css): [textAlignVertical:top] was moved to a style prop
        cond && 'text-text',
      )} />;
    `;
    const texts = extractClassNameTexts('fixture.tsx', withInnerComment);
    const hits = texts
      .flatMap((t) => findArbitraryProps(t.text))
      .filter((a) => !compilesToNativeDeclaration(a.prop, a.value).ok);
    expect(texts.map((t) => t.text)).toEqual(['min-h-[96px]', 'text-text']);
    expect(hits).toEqual([]);
  });

  test('a textAlignVertical inside a real className IS still caught downstream', () => {
    // The ${dark ? '[textAlignVertical:top]' : …} in className B is a genuine
    // sink — the pipeline must flag it (comment/type mentions must not).
    const texts = extractClassNameTexts('fixture.tsx', fixture);
    const hits = texts
      .flatMap((t) => findArbitraryProps(t.text))
      .filter((a) => !compilesToNativeDeclaration(a.prop, a.value).ok);
    expect(hits.map((h) => h.raw)).toEqual(['[textAlignVertical:top]']);
  });
});

describe('whole-repo gate', () => {
  test('no arbitrary-property class in app/ or components/ compiles to nothing on native', () => {
    const hits = scanRepo(ROOT);
    if (hits.length > 0) {
      const lines = hits
        .map((h) => `  ${h.file}:${h.line}  ${h.raw} — property "${h.prop}" drops on native; move to a style prop with nw-keep`)
        .join('\n');
      throw new Error(`arbitrary-property classes that compile to nothing on native:\n${lines}`);
    }
    expect(hits).toEqual([]);
  });
});
