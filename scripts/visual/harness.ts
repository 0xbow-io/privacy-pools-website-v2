// Deterministic capture harness: pinned browser, fixed viewport/DPR/locale/TZ,
// fresh context per set, seeded storage, frozen motion, fixture-driven data,
// app-ready + fonts.ready waits, and stable-screenshot capture.

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { BASE_URL, CHROMIUM_PATH, VIEWPORTS, type ColorName, type ViewportName } from './config';
import { FixtureStore, installFixtureRouting, type FixtureMode } from './fixtures';

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    headless: true,
    executablePath: CHROMIUM_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--force-color-profile=srgb', '--disable-lcd-text'],
  });
}

export interface ContextOptions {
  viewport: ViewportName;
  /**
   * Exact pixel override (e.g. the nw-gallery capture needs a taller-than-
   * desktop viewport because RN-Web pages scroll internally, so full-page
   * screenshots can't see below the fold). Standard captures use the named
   * viewports only.
   */
  viewportSize?: { width: number; height: number };
  color: ColorName;
  fixtures?: { store: FixtureStore; mode: FixtureMode };
  /** Extra localStorage seeds (beyond the standard determinism seeds). */
  localStorage?: Record<string, string>;
  log?: (msg: string) => void;
}

/**
 * Fresh context per capture set. Determinism measures:
 *  - locale/TZ pinned (en-US / UTC), DPR 1, colorScheme matches the set;
 *  - reducedMotion: 'reduce' for CSS/Reanimated consumers;
 *  - `ppv2_smartwallet_skipped_v1=1` (no smart-wallet onboarding overlay);
 *  - `ppv2_freeze_motion=1` (LiquidLight holds a fixed pose — app-side hook);
 *  - CSS kill-switch for any remaining CSS animation/transition/caret;
 *  - fixture record/replay for every non-localhost request.
 */
export async function newDeterministicContext(browser: Browser, opts: ContextOptions): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: opts.viewportSize ?? VIEWPORTS[opts.viewport],
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: opts.color,
    reducedMotion: 'reduce',
  });

  if (opts.fixtures) {
    if (opts.fixtures.mode === 'record') opts.fixtures.store.stampRecordingTime();
    await installFixtureRouting(context, opts.fixtures.store, opts.fixtures.mode, opts.log);

    // Replay: freeze wall-clock time to the fixture recording moment so
    // relative-time labels ("2h ago") computed against frozen data can never
    // drift between capture runs. Only Date is frozen — performance.now(),
    // rAF timestamps and timers keep running, so app scheduling is unaffected.
    if (opts.fixtures.mode === 'replay' && opts.fixtures.store.recordedAt !== null) {
      await context.addInitScript((frozenNow: number) => {
        const RealDate = Date;
        const FrozenDate = function (this: Date, ...args: unknown[]) {
          if (!(this instanceof FrozenDate)) return new RealDate(frozenNow).toString();
          if (args.length === 0) return new RealDate(frozenNow);
          return new (RealDate as unknown as new (...a: unknown[]) => Date)(...args);
        } as unknown as DateConstructor;
        FrozenDate.now = () => frozenNow;
        FrozenDate.parse = RealDate.parse.bind(RealDate);
        FrozenDate.UTC = RealDate.UTC.bind(RealDate);
        (FrozenDate as unknown as { prototype: unknown }).prototype = RealDate.prototype;
        (window as unknown as { Date: DateConstructor }).Date = FrozenDate;
      }, opts.fixtures.store.recordedAt);
    }
  }

  const seeds: Record<string, string> = {
    ppv2_smartwallet_skipped_v1: '1',
    ppv2_freeze_motion: '1',
    ...opts.localStorage,
  };
  await context.addInitScript((entries: [string, string][]) => {
    try {
      for (const [k, v] of entries) window.localStorage.setItem(k, v);
    } catch {
      // storage unavailable — captures will be less deterministic but not broken
    }
  }, Object.entries(seeds));

  // CSS motion kill-switch: `animation: none` (not `paused`, which would
  // freeze at a nondeterministic phase) + no transitions + no text caret.
  await context.addInitScript(() => {
    const install = () => {
      const style = document.createElement('style');
      style.id = '__ppv2_visual_freeze';
      style.textContent =
        '*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }';
      document.documentElement.appendChild(style);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', install);
    } else {
      install();
    }
  });

  return context;
}

export interface OpenOptions {
  url: string;
  /** Body text that must appear before the surface counts as ready. */
  marker: string;
  markerTimeoutMs?: number;
  settleMs?: number;
  /** Wheel-scroll over the page center (RN-Web containers scroll internally). */
  scrollY?: number;
}

export async function openSurface(context: BrowserContext, opts: OpenOptions): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`  [pageerror] ${e.message.slice(0, 160)}`));
  await page.goto(opts.url, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await waitForAppReady(page, opts.marker, opts.markerTimeoutMs ?? 60_000);
  if (opts.scrollY) {
    const viewport = page.viewportSize();
    await page.mouse.move((viewport?.width ?? 800) / 2, (viewport?.height ?? 600) / 2);
    await page.mouse.wheel(0, opts.scrollY);
    await page.waitForTimeout(600);
  }
  if (opts.settleMs) await page.waitForTimeout(opts.settleMs);
  return page;
}

export async function waitForAppReady(page: Page, marker: string, timeoutMs: number): Promise<void> {
  // 1. Web fonts settled (face swaps are the classic flaky-pixel source).
  await page.evaluate(() => (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready);
  // 2. Surface marker text present (case-insensitive: e.g. the vault hero
  //    eyebrow renders "PRIVACY POOLS" while the desktop header uses
  //    title case, and narrow viewports hide the header wordmark).
  await page.waitForFunction(
    (m: string) => (document.body?.innerText || '').toLowerCase().includes(m.toLowerCase()),
    marker,
    { timeout: timeoutMs },
  );
}

export interface StableShotOptions {
  intervalMs?: number;
  maxTries?: number;
  /** Require this many consecutive identical frames (default 2). */
  consecutive?: number;
}

/**
 * Screenshot until N consecutive frames are byte-identical — the honest
 * "everything settled" signal (entrance animations, late data paints).
 * Returns the stable buffer; throws if stability is never reached.
 */
export async function stableScreenshot(page: Page, opts: StableShotOptions = {}): Promise<Buffer> {
  const intervalMs = opts.intervalMs ?? 700;
  const maxTries = opts.maxTries ?? 25;
  const need = (opts.consecutive ?? 2) + 1; // N identical pairs = N+1 frames
  let prev: Buffer | null = null;
  let identical = 1;
  for (let i = 0; i < maxTries; i++) {
    const shot = await page.screenshot({ type: 'png', animations: 'disabled', caret: 'hide', timeout: 60_000 });
    if (prev && shot.equals(prev)) {
      identical++;
      if (identical >= need) return shot;
    } else {
      identical = 1;
    }
    prev = shot;
    await page.waitForTimeout(intervalMs);
  }
  throw new Error(`stableScreenshot: no ${need} identical consecutive frames within ${maxTries} tries on ${page.url()}`);
}
