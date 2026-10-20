// NativeWind compatibility-gallery capture + PER-CELL equivalence assertions
// (F-B, revised per GALLERY-01/02/03).
//
// Targets the HARNESS gallery server — a separate dev server whose router
// root is scripts/visual/gallery-app (never a production route):
//
//   PPV2_NW_GALLERY=1 SAFEWRAP_WHITELIST_PORTS=8082 safewrap bun run web -- --port 8082
//   SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/visual/capture-gallery.ts \
//       --mode replay [--out <dir>] [--report <json>] [--commit <id>]
//
// What it does beyond screenshots:
//  - crops every equivalence pair (nwg-*-ss vs nwg-*-nw) out of the page shot
//    and pixel-diffs left vs right — the page-level shot alone cannot prove
//    per-cell equivalence;
//  - asserts computed styles/geometry for the probes: Animated direct
//    className in BOTH isolated load states (no registration vs ?animReg=1
//    startup registration), dropdown click-away + stacking, raw-DOM border
//    rendering with preflight OFF (CONFIG-02 web proof), modal-portal swatch
//    parity;
//  - writes a machine-readable report (--report) so the gate document's
//    claims are re-auditable.
//
// Output defaults to baselines/ under the nw-gallery-* namespace. Shots:
//   nw-gallery-main-desktop.png     — default load (NO Animated registration)
//   nw-gallery-modal-desktop.png    — RN Modal open (body portal)
//   nw-gallery-animreg-desktop.png  — ?animReg=1 load (startup registration)
// F-C probes (route /fc — theme vars, portals, the app-side registration
// module; see gallery-app/fc.tsx):
//   nw-gallery-fc-desktop.png         — default load (registration OFF)
//   nw-gallery-fc-modal-desktop.png   — RN Modal open, portal var swatch
//   nw-gallery-fc-animreg-desktop.png — ?animReg=1 (components/
//                                       nativewind-interop.ts, the real app
//                                       startup module, runs at gallery root)

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Page } from 'playwright';
import { BASELINE_DIR, FIXTURE_DIR } from './config';
import { openFixtureStore, type FixtureMode } from './fixtures';
import { assertOrUpdateBaselineManifest } from './baseline-manifest';
import { launchBrowser, newDeterministicContext, openSurface, stableScreenshot } from './harness';
import { decodePng, diffPng, type DecodedPng } from './png';

const GALLERY_BASE_URL = process.env.PPV2_GALLERY_BASE_URL ?? 'http://127.0.0.1:8082';
const GALLERY_VIEWPORT = { width: 1440, height: 2800 };
const MARKER = 'NativeWind compatibility gallery';
// Per-pair pixel budget: pairs render at different x positions, so identical
// content can still rasterize with sub-threshold antialiasing wobble; the
// per-channel tolerance (10) absorbs that, the budget stays deliberately low.
const PAIR_TOLERANCE = 10;
const PAIR_BUDGET = 40;

const EQUIVALENCE_PAIRS = [
  'probe', 'var', 'anim', 'scroll', 'overlay', 'dd', 'svg', 'icon',
  'fixed', 'float-anchor', 'float-panel',
] as const;

interface PairResult {
  pair: string;
  ssRect: { w: number; h: number };
  nwRect: { w: number; h: number };
  sizeMatch: boolean;
  changedPixels: number;
  maxChannelDelta: number;
  budget: number;
  verdict: 'ok' | 'fail';
}

function cropFromShot(img: DecodedPng, box: { x: number; y: number; width: number; height: number }): DecodedPng {
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const w = Math.round(box.width);
  const h = Math.round(box.height);
  const data = Buffer.alloc(w * h * 4);
  for (let row = 0; row < h; row++) {
    const src = ((y + row) * img.width + x) * 4;
    img.data.copy(data, row * w * 4, src, src + w * 4);
  }
  return { width: w, height: h, data };
}

async function boxOf(page: Page, testId: string) {
  const el = page.getByTestId(testId).first();
  const box = await el.boundingBox();
  if (!box) throw new Error(`no bounding box for ${testId}`);
  return box;
}

async function computed(page: Page, testId: string, props: string[]): Promise<Record<string, string>> {
  return page.evaluate(
    ({ id, props }: { id: string; props: string[] }) => {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      if (!el) return { __missing: 'true' };
      const cs = getComputedStyle(el);
      const out: Record<string, string> = {};
      for (const p of props) out[p] = (cs as unknown as Record<string, string>)[p];
      const r = el.getBoundingClientRect();
      out.__rect = `${Math.round(r.width)}x${Math.round(r.height)}`;
      return out;
    },
    { id: testId, props },
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let mode: FixtureMode = 'replay';
  let outDir = BASELINE_DIR;
  let reportOut = '';
  let commit = '';
  let refreshBaselines = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') mode = args[++i] as FixtureMode;
    else if (args[i] === '--out') outDir = path.resolve(args[++i]);
    else if (args[i] === '--report') reportOut = path.resolve(args[++i]);
    else if (args[i] === '--commit') commit = args[++i];
    else if (args[i] === '--refresh-baselines') refreshBaselines = true;
  }
  fs.mkdirSync(outDir, { recursive: true });
  if (outDir === BASELINE_DIR) {
    assertOrUpdateBaselineManifest({ allowRefresh: refreshBaselines, ...(commit ? { commit } : {}) });
  }

  const store = openFixtureStore(FIXTURE_DIR, mode);
  const browser = await launchBrowser();
  const report: Record<string, unknown> = {
    generatedBy: 'scripts/visual/capture-gallery.ts',
    date: new Date().toISOString(),
    ...(commit ? { commit } : {}),
    baseUrl: GALLERY_BASE_URL,
    scope: 'web verified; native unverified (SDK fs/promises native-export blocker)',
  };
  let failures = 0;

  // ---------- load 1: default (NO Animated registration anywhere) ----------
  {
    const context = await newDeterministicContext(browser, {
      viewport: 'desktop',
      viewportSize: GALLERY_VIEWPORT,
      color: 'light',
      fixtures: { store, mode },
    });
    const page = await openSurface(context, { url: `${GALLERY_BASE_URL}/?theme=4&color=light`, marker: MARKER });

    const mainShot = await stableScreenshot(page);
    fs.writeFileSync(path.join(outDir, 'nw-gallery-main-desktop.png'), mainShot);
    console.log('  ok nw-gallery-main-desktop.png');
    const mainImg = decodePng(mainShot);

    // Per-cell equivalence: crop + diff each ss/nw pair.
    const pairs: PairResult[] = [];
    for (const pair of EQUIVALENCE_PAIRS) {
      const ssBox = await boxOf(page, `nwg-${pair}-ss`);
      const nwBox = await boxOf(page, `nwg-${pair}-nw`);
      const sizeMatch = Math.abs(ssBox.width - nwBox.width) <= 1 && Math.abs(ssBox.height - nwBox.height) <= 1;
      let changedPixels = -1;
      let maxChannelDelta = -1;
      if (sizeMatch) {
        const w = Math.min(Math.round(ssBox.width), Math.round(nwBox.width));
        const h = Math.min(Math.round(ssBox.height), Math.round(nwBox.height));
        const a = cropFromShot(mainImg, { ...ssBox, width: w, height: h });
        const b = cropFromShot(mainImg, { ...nwBox, width: w, height: h });
        const d = diffPng(a, b, PAIR_TOLERANCE);
        changedPixels = d.changedPixels;
        maxChannelDelta = d.maxChannelDelta;
      }
      const verdict: PairResult['verdict'] = sizeMatch && changedPixels >= 0 && changedPixels <= PAIR_BUDGET ? 'ok' : 'fail';
      if (verdict === 'fail') failures++;
      pairs.push({
        pair,
        ssRect: { w: Math.round(ssBox.width), h: Math.round(ssBox.height) },
        nwRect: { w: Math.round(nwBox.width), h: Math.round(nwBox.height) },
        sizeMatch,
        changedPixels,
        maxChannelDelta,
        budget: PAIR_BUDGET,
        verdict,
      });
      console.log(`  ${verdict === 'ok' ? 'ok  ' : 'FAIL'} pair ${pair}: ${changedPixels} px (sizes ${Math.round(ssBox.width)}x${Math.round(ssBox.height)} vs ${Math.round(nwBox.width)}x${Math.round(nwBox.height)})`);
    }
    report.pairs = pairs;

    // GALLERY-02 (state A): direct className on UNREGISTERED Animated.View is dropped.
    const directUnreg = await computed(page, 'nwg-anim-direct', ['backgroundColor', 'height', 'width', 'borderRadius', 'transform']);
    const unregDropped =
      directUnreg.backgroundColor === 'rgba(0, 0, 0, 0)' && directUnreg.height === '0px' && directUnreg.transform.includes('24');
    if (!unregDropped) failures++;
    report.animDirectUnregistered = { ...directUnreg, expected: 'className DROPPED (transparent, 0-height), residual transform survives', verdict: unregDropped ? 'ok' : 'fail' };
    console.log(`  ${unregDropped ? 'ok  ' : 'FAIL'} anim-direct unregistered: dropped=${unregDropped}`);

    // CONFIG-02 web proof: raw-DOM border with explicit border-solid RENDERS with preflight OFF.
    const panel = await computed(page, 'nwg-float-panel-nw', ['borderTopWidth', 'borderTopStyle', 'borderTopColor']);
    const borderRenders = panel.borderTopWidth === '1px' && panel.borderTopStyle === 'solid';
    if (!borderRenders) failures++;
    report.rawDomBorderProof = { ...panel, expected: '1px solid (preflight OFF, explicit border-solid)', verdict: borderRenders ? 'ok' : 'fail' };
    console.log(`  ${borderRenders ? 'ok  ' : 'FAIL'} raw-DOM border proof: ${panel.borderTopWidth} ${panel.borderTopStyle}`);

    // Dropdown stacking: the open className dropdown must paint ABOVE the sibling row.
    const stacking = await page.evaluate(() => {
      const menu = document.querySelector('[data-testid="nwg-dd-nw-menu"]') as HTMLElement | null;
      if (!menu) return { ok: false, topElement: 'menu missing' };
      const r = menu.getBoundingClientRect();
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { ok: !!el && menu.contains(el), topElement: el?.tagName ?? 'none' };
    });
    if (!stacking.ok) failures++;
    report.dropdownStacking = { ...stacking, verdict: stacking.ok ? 'ok' : 'fail' };
    console.log(`  ${stacking.ok ? 'ok  ' : 'FAIL'} dropdown paints above siblings`);

    // Dropdown click-away (both idioms): clicking the overlay closes the menu.
    // Both menus default open, so both fixed overlays cover the viewport —
    // dismiss the top-most (nw) first, then ss; the state restoration at the
    // end uses force clicks (it is not the behavior under test).
    const clickAway: Record<string, boolean> = {};
    for (const side of ['nw', 'ss'] as const) {
      await page.getByTestId(`nwg-dd-${side}-overlay`).click({ position: { x: 5, y: 5 }, timeout: 5000 });
      clickAway[side] = (await page.getByTestId(`nwg-dd-${side}-menu`).count()) === 0;
      if (!clickAway[side]) failures++;
    }
    await page.getByTestId('nwg-dd-ss-trigger-a').click({ timeout: 5000, force: true });
    await page.getByTestId('nwg-dd-nw-trigger-a').click({ timeout: 5000, force: true });
    await page.getByTestId('nwg-dd-ss-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByTestId('nwg-dd-nw-menu').waitFor({ state: 'visible', timeout: 5000 });
    report.dropdownClickAway = { ...clickAway, verdict: clickAway.nw && clickAway.ss ? 'ok' : 'fail' };
    console.log(`  ${clickAway.nw && clickAway.ss ? 'ok  ' : 'FAIL'} dropdown click-away (ss=${clickAway.ss}, nw=${clickAway.nw})`);

    // Modal portal: open, shoot, assert the in-portal swatch pair.
    await page.getByTestId('nwg-open-modal').click({ timeout: 10_000 });
    await page.getByTestId('nwg-modal-content').waitFor({ state: 'visible', timeout: 10_000 });
    const modalShot = await stableScreenshot(page);
    fs.writeFileSync(path.join(outDir, 'nw-gallery-modal-desktop.png'), modalShot);
    console.log('  ok nw-gallery-modal-desktop.png');
    const modalImg = decodePng(modalShot);
    const ssSwatch = await boxOf(page, 'nwg-modal-ss-swatch');
    const nwSwatch = await boxOf(page, 'nwg-modal-nw-swatch');
    const swatchDiff = diffPng(cropFromShot(modalImg, ssSwatch), cropFromShot(modalImg, nwSwatch), PAIR_TOLERANCE);
    const swatchOk =
      Math.round(ssSwatch.width) === Math.round(nwSwatch.width) &&
      Math.round(ssSwatch.height) === Math.round(nwSwatch.height) &&
      swatchDiff.changedPixels <= PAIR_BUDGET;
    if (!swatchOk) failures++;
    report.modalPortalSwatches = { changedPixels: swatchDiff.changedPixels, verdict: swatchOk ? 'ok' : 'fail' };
    console.log(`  ${swatchOk ? 'ok  ' : 'FAIL'} modal-portal swatch pair: ${swatchDiff.changedPixels} px`);

    await context.close();
  }

  // ---------- load 2: ?animReg=1 (startup registration, isolated load) ----------
  {
    const context = await newDeterministicContext(browser, {
      viewport: 'desktop',
      viewportSize: GALLERY_VIEWPORT,
      color: 'light',
      fixtures: { store, mode },
    });
    const page = await openSurface(context, { url: `${GALLERY_BASE_URL}/?theme=4&color=light&animReg=1`, marker: MARKER });
    fs.writeFileSync(path.join(outDir, 'nw-gallery-animreg-desktop.png'), await stableScreenshot(page));
    console.log('  ok nw-gallery-animreg-desktop.png');

    const direct = await computed(page, 'nwg-anim-direct', ['backgroundColor', 'height', 'width', 'borderRadius', 'transform']);
    const applied =
      direct.backgroundColor === 'rgb(79, 70, 229)' &&
      direct.height === '24px' &&
      direct.width === '24px' &&
      direct.transform.includes('24');
    if (!applied) failures++;
    report.animDirectRegistered = { ...direct, expected: 'className APPLIES (24x24 indigo puck) after startup cssInterop(Animated.View)', verdict: applied ? 'ok' : 'fail' };
    console.log(`  ${applied ? 'ok  ' : 'FAIL'} anim-direct with startup registration: applied=${applied}`);

    await context.close();
  }

  // ---------- F-C loads: /fc theme-foundation probes ----------
  const FC_MARKER = 'NativeWind F-C theme gallery';
  // v3 anchors (constants/theme-data.ts): buttonPrimary #D2F4FB both schemes;
  // background #F2F8FA light / #131313 dark.
  const V3_BUTTON_PRIMARY = 'rgb(210, 244, 251)';
  const V3_BG_LIGHT = 'rgb(242, 248, 250)';
  const V3_BG_DARK = 'rgb(19, 19, 19)';

  const rootClasses = (page: Page) =>
    page.evaluate(() => document.documentElement.className.split(/\s+/).filter(Boolean).sort().join(' '));

  // load 3: default (registration OFF) — light scheme.
  {
    const context = await newDeterministicContext(browser, {
      viewport: 'desktop',
      viewportSize: GALLERY_VIEWPORT,
      color: 'light',
      fixtures: { store, mode },
    });
    // theme=3 keeps ActiveDesignVariant (used by the REAL ThemeProvider in
    // the FC4 probe) consistent with the pp-v3 classes the route seeds.
    const page = await openSurface(context, { url: `${GALLERY_BASE_URL}/fc?theme=3&color=light`, marker: FC_MARKER });

    const fcShot = await stableScreenshot(page);
    fs.writeFileSync(path.join(outDir, 'nw-gallery-fc-desktop.png'), fcShot);
    console.log('  ok nw-gallery-fc-desktop.png');
    const fcImg = decodePng(fcShot);

    // FC1a — root classes + in-page var swatch resolves the exact legacy hex.
    const classes = await rootClasses(page);
    const classesOk = classes.includes('pp-v3') && !classes.split(' ').includes('dark');
    if (!classesOk) failures++;
    report.fcRootClasses = { classes, verdict: classesOk ? 'ok' : 'fail' };
    console.log(`  ${classesOk ? 'ok  ' : 'FAIL'} fc root classes: "${classes}"`);

    const pageSwatch = await computed(page, 'nwg-fc-var-page', ['backgroundColor']);
    const bgSwatch = await computed(page, 'nwg-fc-var-bg', ['backgroundColor']);
    const pageVarsOk = pageSwatch.backgroundColor === V3_BUTTON_PRIMARY && bgSwatch.backgroundColor === V3_BG_LIGHT;
    if (!pageVarsOk) failures++;
    report.fcPageVarSwatches = {
      buttonPrimary: pageSwatch.backgroundColor,
      background: bgSwatch.backgroundColor,
      expected: { buttonPrimary: V3_BUTTON_PRIMARY, background: V3_BG_LIGHT },
      verdict: pageVarsOk ? 'ok' : 'fail',
    };
    console.log(`  ${pageVarsOk ? 'ok  ' : 'FAIL'} fc page var swatches: ${pageSwatch.backgroundColor} / ${bgSwatch.backgroundColor}`);
    const pageSwatchBox = await boxOf(page, 'nwg-fc-var-page');

    // FC2 (state A) — direct className on UNREGISTERED RN Animated.View is dropped.
    const animUnreg = await computed(page, 'nwg-fc-anim-direct', ['backgroundColor', 'height', 'width', 'transform']);
    const animDropped =
      animUnreg.backgroundColor === 'rgba(0, 0, 0, 0)' && animUnreg.height === '0px' && animUnreg.transform.includes('24');
    if (!animDropped) failures++;
    report.fcAnimDirectUnregistered = { ...animUnreg, expected: 'DROPPED (transparent, 0-height), residual transform survives', verdict: animDropped ? 'ok' : 'fail' };
    console.log(`  ${animDropped ? 'ok  ' : 'FAIL'} fc anim-direct unregistered: dropped=${animDropped}`);

    // FC3 (state A) — Reanimated View/Text/ScrollView without registration:
    // CONTRACTUAL negative controls (a change here means the interop/
    // Reanimated behavior shifted and the registration decision must be
    // re-examined — fail loudly, don't just record).
    const reUnreg = await computed(page, 'nwg-fc-reanimated', ['backgroundColor', 'height', 'width', 'transform']);
    const reViewDropped = reUnreg.backgroundColor === 'rgba(0, 0, 0, 0)' && reUnreg.height === '0px';
    if (!reViewDropped) failures++;
    report.fcReanimatedUnregistered = { ...reUnreg, expected: 'className DROPPED (transparent, 0-height)', verdict: reViewDropped ? 'ok' : 'fail' };
    console.log(`  ${reViewDropped ? 'ok  ' : 'FAIL'} fc reanimated-view unregistered: dropped=${reViewDropped}`);

    const reTextUnreg = await computed(page, 'nwg-fc-reanimated-text', ['color', 'fontSize']);
    const reTextDropped = reTextUnreg.color !== 'rgb(5, 150, 105)' && reTextUnreg.fontSize !== '16px';
    if (!reTextDropped) failures++;
    report.fcReanimatedTextUnregistered = { ...reTextUnreg, expected: 'className DROPPED (no emerald color, no 16px size)', verdict: reTextDropped ? 'ok' : 'fail' };
    console.log(`  ${reTextDropped ? 'ok  ' : 'FAIL'} fc reanimated-text unregistered: dropped=${reTextDropped}`);

    const reScrollUnreg = await computed(page, 'nwg-fc-reanimated-scroll', ['backgroundColor']);
    const reScrollPad = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="nwg-fc-reanimated-scroll"]');
      const content = host?.firstElementChild;
      return content ? getComputedStyle(content as Element).paddingTop : 'missing';
    });
    const reScrollDropped = reScrollUnreg.backgroundColor === 'rgba(0, 0, 0, 0)' && reScrollPad === '0px';
    if (!reScrollDropped) failures++;
    report.fcReanimatedScrollUnregistered = { ...reScrollUnreg, contentPaddingTop: reScrollPad, expected: 'className + contentContainerClassName DROPPED', verdict: reScrollDropped ? 'ok' : 'fail' };
    console.log(`  ${reScrollDropped ? 'ok  ' : 'FAIL'} fc reanimated-scroll unregistered: dropped=${reScrollDropped}`);

    // FC1b — RN Modal body portal: same var swatch inside the portal.
    await page.getByTestId('nwg-fc-open-modal').click({ timeout: 10_000 });
    await page.getByTestId('nwg-fc-modal-content').waitFor({ state: 'visible', timeout: 10_000 });
    const fcModalShot = await stableScreenshot(page);
    fs.writeFileSync(path.join(outDir, 'nw-gallery-fc-modal-desktop.png'), fcModalShot);
    console.log('  ok nw-gallery-fc-modal-desktop.png');
    const fcModalImg = decodePng(fcModalShot);

    const portalSwatch = await computed(page, 'nwg-fc-var-portal', ['backgroundColor']);
    const inPortal = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="nwg-fc-var-portal"]');
      const appRoot = document.getElementById('root');
      return !!el && !!appRoot && !appRoot.contains(el) && document.body.contains(el);
    });
    const portalBox = await boxOf(page, 'nwg-fc-var-portal');
    const portalCrop = cropFromShot(fcModalImg, portalBox);
    const pageCrop = cropFromShot(fcImg, pageSwatchBox); // pre-modal shot: no backdrop dimming
    const swatchDiff = diffPng(pageCrop, portalCrop, PAIR_TOLERANCE);
    const portalOk = portalSwatch.backgroundColor === V3_BUTTON_PRIMARY && inPortal && swatchDiff.changedPixels <= PAIR_BUDGET;
    if (!portalOk) failures++;
    report.fcPortalVarSwatch = {
      backgroundColor: portalSwatch.backgroundColor,
      expected: V3_BUTTON_PRIMARY,
      renderedInBodyPortalOutsideAppRoot: inPortal,
      cropDiffVsPageSwatch: swatchDiff.changedPixels,
      budget: PAIR_BUDGET,
      verdict: portalOk ? 'ok' : 'fail',
    };
    console.log(`  ${portalOk ? 'ok  ' : 'FAIL'} fc portal var swatch: ${portalSwatch.backgroundColor}, portal=${inPortal}, diff=${swatchDiff.changedPixels}px`);

    // FC4 — toggle timing (finding 5): a rAF watcher samples the
    // context-rendered label, the root `dark` class, and the resolved
    // --pp-background var on EVERY frame (rAF runs before each paint) while
    // a REAL click toggles the provider. With the layout-effect reconcile,
    // no sampled frame may ever be MIXED (context says dark while the CSS
    // sinks still say light, or vice versa) — the passive-effect defect
    // would surface as exactly such a frame between commit and effect.
    // Runs LAST: it flips the whole page to dark. Modal is closed first.
    await page.getByTestId('nwg-fc-close-modal').click({ timeout: 10_000 });
    await page.getByTestId('nwg-fc-modal-content').waitFor({ state: 'hidden', timeout: 10_000 });
    interface ToggleFrame { label: string; dark: boolean; background: string }
    await page.evaluate(() => {
      const w = window as unknown as { __nwgToggleSamples: ToggleFrame[] };
      w.__nwgToggleSamples = [];
      const record = () => {
        w.__nwgToggleSamples.push({
          label: document.querySelector('[data-testid="nwg-fc-toggle-label"]')?.textContent ?? '',
          dark: document.documentElement.classList.contains('dark'),
          background: getComputedStyle(document.documentElement).getPropertyValue('--pp-background').trim().toLowerCase(),
        });
        if (w.__nwgToggleSamples.length < 40) requestAnimationFrame(record);
      };
      requestAnimationFrame(record);
    });
    await page.getByTestId('nwg-fc-toggle').click({ timeout: 10_000 });
    await page.waitForTimeout(900); // let the 40 sampled frames elapse
    const toggleFrames: ToggleFrame[] = await page.evaluate(
      () => (window as unknown as { __nwgToggleSamples: ToggleFrame[] }).__nwgToggleSamples,
    );
    const frameConsistent = (f: ToggleFrame) =>
      f.dark ? f.label === 'scheme:dark' && f.background === '#131313' : f.label === 'scheme:light' && f.background === '#f2f8fa';
    const mixedFrames = toggleFrames.filter((f) => !frameConsistent(f));
    const last = toggleFrames[toggleFrames.length - 1];
    const toggleOk =
      toggleFrames.length >= 10 &&
      mixedFrames.length === 0 &&
      last !== undefined &&
      last.dark &&
      last.label === 'scheme:dark' &&
      last.background === '#131313';
    if (!toggleOk) failures++;
    report.fcToggleTiming = {
      framesSampled: toggleFrames.length,
      mixedFrames,
      finalFrame: last,
      expected: 'zero mixed frames (context label / dark class / --pp-background always agree per frame); final = dark',
      note: 'rAF-per-frame watcher around a real click — a passive-effect reconcile paints a mixed frame here',
      verdict: toggleOk ? 'ok' : 'fail',
    };
    console.log(
      `  ${toggleOk ? 'ok  ' : 'FAIL'} fc toggle timing: ${toggleFrames.length} frames sampled, ${mixedFrames.length} mixed, final=${JSON.stringify(last)}`,
    );

    await context.close();
  }

  // load 4: ?animReg=1 — the REAL app startup module (components/
  // nativewind-interop.ts) runs at gallery-root module evaluation.
  {
    const context = await newDeterministicContext(browser, {
      viewport: 'desktop',
      viewportSize: GALLERY_VIEWPORT,
      color: 'light',
      fixtures: { store, mode },
    });
    const page = await openSurface(context, { url: `${GALLERY_BASE_URL}/fc?theme=3&color=light&animReg=1`, marker: FC_MARKER });
    fs.writeFileSync(path.join(outDir, 'nw-gallery-fc-animreg-desktop.png'), await stableScreenshot(page));
    console.log('  ok nw-gallery-fc-animreg-desktop.png');

    const anim = await computed(page, 'nwg-fc-anim-direct', ['backgroundColor', 'height', 'width', 'transform']);
    const animApplied =
      anim.backgroundColor === 'rgb(79, 70, 229)' && anim.height === '24px' && anim.width === '24px' && anim.transform.includes('24');
    if (!animApplied) failures++;
    report.fcAnimDirectRegistered = { ...anim, expected: 'APPLIES (24x24 indigo puck) via the app startup module', verdict: animApplied ? 'ok' : 'fail' };
    console.log(`  ${animApplied ? 'ok  ' : 'FAIL'} fc anim-direct with app-module registration: applied=${animApplied}`);

    const re = await computed(page, 'nwg-fc-reanimated', ['backgroundColor', 'height', 'width', 'transform']);
    const reApplied = re.backgroundColor === 'rgb(5, 150, 105)' && re.height === '24px' && re.width === '24px' && re.transform.includes('24');
    if (!reApplied) failures++;
    report.fcReanimatedRegistered = { ...re, expected: 'APPLIES (24x24 emerald puck) — the app module registers Reanimated.View too', verdict: reApplied ? 'ok' : 'fail' };
    console.log(`  ${reApplied ? 'ok  ' : 'FAIL'} fc reanimated-view with app-module registration: applied=${reApplied}`);

    const reText = await computed(page, 'nwg-fc-reanimated-text', ['color', 'fontSize']);
    const reTextApplied = reText.color === 'rgb(5, 150, 105)' && reText.fontSize === '16px';
    if (!reTextApplied) failures++;
    report.fcReanimatedTextRegistered = { ...reText, expected: 'APPLIES (emerald, 16px) — Reanimated.Text registration (hello-wave.tsx is P1)', verdict: reTextApplied ? 'ok' : 'fail' };
    console.log(`  ${reTextApplied ? 'ok  ' : 'FAIL'} fc reanimated-text with app-module registration: applied=${reTextApplied}`);

    const reScroll = await computed(page, 'nwg-fc-reanimated-scroll', ['backgroundColor', 'height', 'width']);
    const reScrollPad = await page.evaluate(() => {
      const host = document.querySelector('[data-testid="nwg-fc-reanimated-scroll"]');
      const content = host?.firstElementChild;
      return content ? getComputedStyle(content as Element).paddingTop : 'missing';
    });
    const reScrollApplied =
      reScroll.backgroundColor === 'rgb(5, 150, 105)' && reScroll.height === '40px' && reScroll.width === '160px' && reScrollPad === '8px';
    if (!reScrollApplied) failures++;
    report.fcReanimatedScrollRegistered = {
      ...reScroll,
      contentPaddingTop: reScrollPad,
      expected: 'APPLIES (emerald 160x40, contentContainer p-2=8px) — Reanimated.ScrollView + contentContainerClassName remap (parallax-scroll-view.tsx is P1)',
      verdict: reScrollApplied ? 'ok' : 'fail',
    };
    console.log(`  ${reScrollApplied ? 'ok  ' : 'FAIL'} fc reanimated-scroll with app-module registration: applied=${reScrollApplied} (pad=${reScrollPad})`);

    await context.close();
  }

  // load 5: ?color=dark — scheme-sensitive var flips with the dark class.
  // Computed-style assertions only (no screenshot/baseline needed).
  {
    const context = await newDeterministicContext(browser, {
      viewport: 'desktop',
      viewportSize: GALLERY_VIEWPORT,
      color: 'dark',
      fixtures: { store, mode },
    });
    const page = await openSurface(context, { url: `${GALLERY_BASE_URL}/fc?theme=3&color=dark`, marker: FC_MARKER });
    const classes = await rootClasses(page);
    const bgSwatch = await computed(page, 'nwg-fc-var-bg', ['backgroundColor']);
    const ctaSwatch = await computed(page, 'nwg-fc-var-page', ['backgroundColor']);
    const darkOk =
      classes.split(' ').includes('dark') &&
      classes.includes('pp-v3') &&
      bgSwatch.backgroundColor === V3_BG_DARK &&
      ctaSwatch.backgroundColor === V3_BUTTON_PRIMARY;
    if (!darkOk) failures++;
    report.fcDarkScheme = {
      classes,
      background: bgSwatch.backgroundColor,
      buttonPrimary: ctaSwatch.backgroundColor,
      expected: { background: V3_BG_DARK, buttonPrimary: V3_BUTTON_PRIMARY },
      verdict: darkOk ? 'ok' : 'fail',
    };
    console.log(`  ${darkOk ? 'ok  ' : 'FAIL'} fc dark scheme: bg=${bgSwatch.backgroundColor}, classes="${classes}"`);
    await context.close();
  }

  await browser.close();
  store.writeIndex();
  report.failures = failures;
  if (reportOut) {
    fs.mkdirSync(path.dirname(reportOut), { recursive: true });
    fs.writeFileSync(reportOut, JSON.stringify(report, null, 2) + '\n');
    console.log(`report → ${reportOut}`);
  }
  if (store.misses.length > 0) {
    for (const m of store.misses) console.error(`  fixture MISS: ${m.method} ${m.url}`);
    process.exit(1);
  }
  if (failures > 0) {
    console.error(`\nGALLERY ASSERTIONS FAILED (${failures})`);
    process.exit(1);
  }
}

main();
