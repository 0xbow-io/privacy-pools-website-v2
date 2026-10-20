import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

// The landing page's one interactive rule: typing an amount in the top widget
// means the visitor is ACTING, so on web the page reduces to the form — the
// marketing (headline, story, scroll hint) steps aside and so do the resting
// activity/crowd/pools cards — and all of it returns on blur. It has been
// rewritten out of the page twice; these read the real expressions out of the
// source and run them, so a rewrite that drops the rule fails here instead of
// shipping.
function source(path: string) {
  return ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
const home = source('components/home/home-screen.tsx');
const hub = source('components/home/action-hub.tsx');

function find(root: ts.SourceFile, predicate: (node: ts.Node) => boolean): ts.Node {
  const search = (node: ts.Node): ts.Node | undefined => (predicate(node) ? node : ts.forEachChild(node, search));
  const result = ts.forEachChild(root, search);
  if (!result) throw new Error('expression not found');
  return result;
}
function variable(root: ts.SourceFile, name: string) {
  return (find(root, (node) => ts.isVariableDeclaration(node) && node.name.getText(root) === name) as ts.VariableDeclaration).initializer!;
}
function evaluate(root: ts.SourceFile, name: string, context: Record<string, unknown>): unknown {
  const js = ts.transpileModule(`const expression = ${variable(root, name).getText(root)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(context), `${js}\nreturn expression;`)(...Object.values(context));
}
/** The page as a visitor sees it, with only the typing state varying. */
function page({ inputFocused = false, hasAccount = false, splitMounted = false, os = 'web' } = {}) {
  const Platform = { OS: os };
  const hideHero = evaluate(home, 'hideHero', { hasAccount, splitMounted, inputFocused }) as boolean;
  const marketingSlot = evaluate(home, 'marketingSlot', { Platform, hideHero }) as boolean;
  const landingHero = evaluate(home, 'landingHero', { marketingSlot }) as boolean;
  const showPoolSummaries = evaluate(home, 'showPoolSummaries', { Platform, splitMounted, marketingSlot, hasAccount, inputFocused }) as boolean;
  return { hideHero, marketingSlot, landingHero, showPoolSummaries };
}

type Attribute = { name: string; value: string };
function attributesOf(root: ts.SourceFile, node: ts.Node): Attribute[] {
  return (node as ts.JsxSelfClosingElement | ts.JsxOpeningElement).attributes.properties
    .filter(ts.isJsxAttribute)
    .map((attribute) => ({ name: attribute.name.getText(root), value: attribute.initializer?.getText(root) ?? '' }));
}
/** The named element — `match` picks the right one where a tag repeats. */
function element(root: ts.SourceFile, tag: string, match?: (attributes: Attribute[]) => boolean): Attribute[] {
  const isTag = (n: ts.Node) =>
    (ts.isJsxSelfClosingElement(n) && n.tagName.getText(root) === tag)
    || (ts.isJsxOpeningElement(n) && n.tagName.getText(root) === tag);
  const node = find(root, (n) => isTag(n) && (!match || match(attributesOf(root, n))));
  return attributesOf(root, node);
}

describe('the marketing page steps aside while the visitor types', () => {
  test('a resting visitor gets the story, not the classic below-fold', () => {
    expect(page()).toMatchObject({ marketingSlot: true, landingHero: true, showPoolSummaries: false });
  });

  test('focusing the amount hides the headline, the story AND the scroll hint', () => {
    const typing = page({ inputFocused: true });
    expect(typing.hideHero).toBe(true);
    expect(typing.marketingSlot).toBe(false);
    // The hint rides landingHero: leaving it up over a form being typed into
    // was the specific complaint.
    expect(typing.landingHero).toBe(false);
  });

  // Typing leaves the form alone on the page: the resting below-fold goes too,
  // so nothing reflows under the field while someone is entering an amount.
  test('and takes the activity, crowd numbers and pool list with it', () => {
    expect(page({ inputFocused: true }).showPoolSummaries).toBe(false);
  });

  test('a resting signed-out visitor keeps the story, and only the story', () => {
    const resting = page();
    expect(resting.marketingSlot).toBe(true);
    expect(resting.showPoolSummaries).toBe(false);
  });

  // Native has no story to swap in, so hiding its cards would leave the widget
  // on bare canvas mid-keystroke. The rule is deliberately web-only, and this is
  // what says so: drop the Platform term and native loses them too.
  test('native keeps its cards while typing, because it has nothing to swap in', () => {
    expect(page({ os: 'ios' }).showPoolSummaries).toBe(true);
    expect(page({ os: 'ios', inputFocused: true }).showPoolSummaries).toBe(true);
  });

  // The page's only remaining height while typing. Without it the content falls
  // under the viewport, the browser clamps scrollTop with anchoring disabled,
  // and the FLIP animation replays that clamp as a slide of the live field.
  // A viewport's worth is not enough either: the floor has to reach wherever
  // the visitor had already scrolled to, so it is measured, in px, on focus.
  test('the typing floor is measured from the scroll position, not a viewport', () => {
    const src = readFileSync('components/home/home-screen.tsx', 'utf8');
    expect(src).toMatch(/setFocusFloorPx\(scroller\.clientHeight \+ scroller\.scrollTop\)/);
    // On the scroll container, so the footer's grow can take the slack.
    expect(src).toMatch(/contentContainerStyle=\{\{[\s\S]{0,400}focusFloorPx/);
    // And released again, or the page would stay tall for the whole visit.
    expect(src).toMatch(/setInputFocused\(false\);\s*\n\s*setFocusFloorPx\(0\);/);
  });

  // The floor belongs to ONE state. `inputFocused` alone also covers a signed-in
  // page, an open split panel and every native screen — none of which hide
  // anything on focus, so none of them may have their height changed.
  test('only the web signed-out landing gets the typing floor', () => {
    const floor = (ctx: Record<string, unknown>) => evaluate(home, 'focusedLanding', ctx) as boolean;
    const web = { OS: 'web' };
    expect(floor({ Platform: web, hasAccount: false, splitMounted: false, inputFocused: true })).toBe(true);
    expect(floor({ Platform: web, hasAccount: false, splitMounted: false, inputFocused: false })).toBe(false);
    expect(floor({ Platform: web, hasAccount: true, splitMounted: false, inputFocused: true })).toBe(false);
    expect(floor({ Platform: web, hasAccount: false, splitMounted: true, inputFocused: true })).toBe(false);
    expect(floor({ Platform: { OS: 'ios' }, hasAccount: false, splitMounted: false, inputFocused: true })).toBe(false);
  });

  // The row keeps the landing-only floor it always had: a dvh/calc string is a
  // CSS value React Native cannot represent, so it must not ride a flag that is
  // true on native.
  test('the row floor stays landing-only', () => {
    const src = readFileSync('components/home/home-screen.tsx', 'utf8');
    expect(src).toMatch(/minHeight: landingHero \? 'calc\(100dvh - 95px\)'/);
  });

  test('blurring restores every part of it', () => {
    expect(page({ inputFocused: false })).toEqual(page());
  });

  // An account or an open panel already owns the page; typing must not be the
  // thing that decides those, or a signed-in user would see the story return.
  test('typing changes nothing for an account holder or a split panel', () => {
    expect(page({ hasAccount: true, inputFocused: true })).toEqual(page({ hasAccount: true }));
    expect(page({ splitMounted: true, inputFocused: true })).toEqual(page({ splitMounted: true }));
  });
});

/** Run one of the page's own handlers against recording fakes. */
function runHandler(name: string, context: Record<string, unknown>) {
  const declaration = find(home, (node) => ts.isVariableDeclaration(node) && node.name.getText(home) === name) as ts.VariableDeclaration;
  const js = ts.transpileModule(`const handler = ${declaration.initializer!.getText(home)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  // useCallback is the wrapper, not the behaviour: unwrap to the function.
  const useCallback = (fn: unknown) => fn;
  const fn = new Function('useCallback', ...Object.keys(context), `${js}\nreturn handler;`)(useCallback, ...Object.values(context)) as () => void;
  fn();
}

describe('the wiring that drives it', () => {
  test('the page hands the hub the input focus pair, not just onEngage', () => {
    const names = element(home, 'ActionHub').map((a) => a.name);
    expect(names).toContain('onInputFocus');
    expect(names).toContain('onInputBlur');
  });

  test('the hub reports the amount field focus and blur', () => {
    const input = element(hub, 'TextInput', (attrs) => attrs.some((a) => a.name === 'testID' && a.value.includes('hub-amount-input')));
    const onFocus = input.find((a) => a.name === 'onFocus')?.value ?? '';
    expect(onFocus).toContain('onInputFocus');
    // onEngage still fires: it is what clears a forced intro.
    expect(onFocus).toContain('onEngage');
    expect(input.find((a) => a.name === 'onBlur')?.value ?? '').toContain('onInputBlur');
  });

  // React does not deliver onBlur when reconciliation removes a focused input
  // (a deposit-success swap, a resize that drops a page). Without a lifecycle
  // reporter the page stays in typing mode for the rest of the visit.
  test('an amount field that dies focused still reports its blur', () => {
    const input = element(hub, 'TextInput', (attrs) => attrs.some((a) => a.name === 'testID' && a.value.includes('hub-amount-input')));
    expect(input.find((a) => a.name === 'ref')?.value ?? '').toContain('amountFieldRef');
    const reporter = find(hub, (node) => ts.isVariableDeclaration(node) && node.name.getText(hub) === 'amountFieldRef') as ts.VariableDeclaration;
    const body = reporter.initializer!.getText(hub);
    // Stable identity, or React calls it with null on every keystroke render.
    expect(body).toContain('useCallback');
    expect(body).toMatch(/\[\s*\]\s*\)$/);
    // Only a focused field reports, and only on removal (node === null).
    expect(body).toContain('amountFieldFocused.current');
    expect(body).toContain('onInputBlurRef.current');
  });

  test('focusing sets the flag, cancels a pending blur and measures the floor', () => {
    const calls: string[] = [];
    runHandler('onHubInputFocus', {
      blurTimerRef: { current: 7 },
      clearTimeout: () => calls.push('clear'),
      setInputFocused: (v: boolean) => calls.push(`set:${v}`),
      Platform: { OS: 'web' },
      // 900px of viewport, scrolled 240px down: the floor has to reach 1140,
      // not merely one viewport, or focus still shortens the page under them.
      scrollViewRef: { current: { getScrollableNode: () => ({ clientHeight: 900, scrollTop: 240 }) } },
      setFocusFloorPx: (px: number) => calls.push(`floor:${px}`),
    });
    expect(calls).toEqual(['clear', 'floor:1140', 'set:true']);
  });

  test('native measures no floor, because nothing shortens there', () => {
    const calls: string[] = [];
    runHandler('onHubInputFocus', {
      blurTimerRef: { current: 7 },
      clearTimeout: () => calls.push('clear'),
      setInputFocused: (v: boolean) => calls.push(`set:${v}`),
      Platform: { OS: 'ios' },
      scrollViewRef: { current: { getScrollableNode: () => ({ clientHeight: 900, scrollTop: 240 }) } },
      setFocusFloorPx: (px: number) => calls.push(`floor:${px}`),
    });
    expect(calls).toEqual(['clear', 'set:true']);
  });

  test('blurring clears the flag only after the debounce, never synchronously', () => {
    const calls: string[] = [];
    let delay: number | undefined;
    let queued: (() => void) | undefined;
    runHandler('onHubInputBlur', {
      blurTimerRef: { current: null },
      clearTimeout: () => calls.push('clear'),
      setTimeout: (fn: () => void, ms: number) => { queued = fn; delay = ms; return 1; },
      setInputFocused: (v: boolean) => calls.push(`set:${v}`),
      setFocusFloorPx: (px: number) => calls.push(`floor:${px}`),
    });
    expect(calls).toEqual([]);
    expect(delay).toBe(160);
    queued!();
    // The floor is released with the flag: a page left tall for the visit is
    // its own bug.
    expect(calls).toEqual(['set:false', 'floor:0']);
  });

  test('leaving the route drops typing mode instead of stranding the page', () => {
    const effect = find(home, (node) => ts.isIdentifier(node) && node.getText(home) === 'focused'
      && ts.isVariableDeclaration(node.parent) === false);
    expect(effect).toBeDefined();
    const src = readFileSync('components/home/home-screen.tsx', 'utf8');
    expect(src).toMatch(/if \(focused\) return;[\s\S]{0,160}setInputFocused\(false\)/);
  });

  // The story's own preview widgets are a demo. Wiring them to the page's focus
  // state would let a click inside the story tear the story out from under it.
  test('the story previews stay unwired', () => {
    expect(element(home, 'FrontPage').map((a) => a.name)).not.toContain('onInputFocus');
  });
});

// The booleans above decide nothing on their own: these pin the JSX that reads
// them, so deleting a card or a conditional cannot pass as "behaviour kept".
describe('the components those booleans actually own', () => {
  const src = readFileSync('components/home/home-screen.tsx', 'utf8');

  test('the classic below-fold is gated on showPoolSummaries', () => {
    for (const tag of ['LatestActivity', 'StatBand', 'HomePools']) {
      expect(src).toContain(`<${tag}`);
    }
    const gated = src.split('showPoolSummaries && (').slice(1).join('');
    for (const tag of ['LatestActivity', 'StatBand', 'HomePools']) {
      expect(gated).toContain(`<${tag}`);
    }
  });

  test('the story and the scroll hint are gated on the marketing slot', () => {
    expect(src).toMatch(/marketingSlot && \([\s\S]{0,400}<FrontPage/);
    expect(src).toMatch(/landingHero && \([\s\S]{0,300}front-scroll-hint/);
  });

  test('the hero heading and copy ride the same visibility decision', () => {
    expect(src).toMatch(/<HeroHeading[^>]*hideHero/);
  });
});
