// Bundle/perf baselines (F-A) → scripts/visual/perf-baseline.json
//
//   SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/visual/perf-baseline.ts [--skip-exports] [--out <file>]
//
// --out writes elsewhere (candidate measurements for phase gates, e.g. F-B)
// WITHOUT overwriting the committed F-A ground truth in perf-baseline.json.
//
// Records:
//  - prod web export JS/CSS asset sizes (raw + gzip) + env-inlining check
//  - iOS/Android export bundle sizes (Metro-only; recorded honestly if they
//    fail in this environment)
//  - startup latency (nav start → app-ready) and modal-open latency
//    (Connect-picker click → picker text visible), 5 runs, medians, against
//    the dev server with fixture replay + frozen clock (same protocol as the
//    screenshot baselines).

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { BASE_URL, FIXTURE_DIR, REPO_ROOT, VISUAL_DIR } from './config';
import { FixtureStore } from './fixtures';
import { launchBrowser, newDeterministicContext, waitForAppReady } from './harness';

interface AssetSize {
  file: string;
  bytes: number;
  gzipBytes: number;
}

function walkAssets(dir: string, exts: string[]): AssetSize[] {
  const out: AssetSize[] = [];
  const visit = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) visit(full);
      else if (exts.some((x) => e.name.endsWith(x))) {
        const buf = fs.readFileSync(full);
        out.push({
          file: path.relative(dir, full),
          bytes: buf.length,
          gzipBytes: zlib.gzipSync(buf, { level: 9 }).length,
        });
      }
    }
  };
  visit(dir);
  return out.sort((a, b) => b.bytes - a.bytes);
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function runExport(platform: 'web' | 'ios' | 'android', outDir: string): { ok: boolean; error?: string } {
  try {
    execFileSync(path.join(REPO_ROOT, 'node_modules', '.bin', 'expo'), ['export', '-p', platform, '--output-dir', outDir], {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15 * 60_000,
      env: { ...process.env, CI: '1' },
    });
    return { ok: true };
  } catch (e) {
    const err = e as { message: string; stderr?: Buffer };
    return { ok: false, error: `${err.message}\n${err.stderr?.toString().slice(-2000) ?? ''}`.trim() };
  }
}

async function measureLatencies(runs: number): Promise<{
  startupMs: number[];
  modalOpenMs: number[];
}> {
  const store = new FixtureStore(FIXTURE_DIR);
  const browser = await launchBrowser();
  const startupMs: number[] = [];
  const modalOpenMs: number[] = [];
  for (let i = 0; i < runs; i++) {
    const context = await newDeterministicContext(browser, {
      viewport: 'desktop',
      color: 'light',
      fixtures: { store, mode: 'replay' },
    });
    const page = await context.newPage();
    const t0 = Date.now();
    await page.goto(`${BASE_URL}/?theme=4&color=light`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await waitForAppReady(page, 'Privacy Pools', 90_000);
    startupMs.push(Date.now() - t0);

    // Modal-open latency: Connect picker (deposit/withdraw need a connected
    // wallet; the picker is the modal every visitor can open).
    const t1 = Date.now();
    await page.getByText('Connect Wallet', { exact: true }).first().click({ timeout: 10_000 });
    await page.waitForFunction(
      () => /account key|WalletConnect|wallet/i.test(document.body?.innerText || ''),
      undefined,
      { timeout: 15_000 },
    );
    modalOpenMs.push(Date.now() - t1);
    await context.close();
  }
  await browser.close();
  return { startupMs, modalOpenMs };
}

/**
 * PERF-02: PRODUCT metrics come from serving the PRODUCTION export (the
 * css-interop wrapper/component-map lookup runs on every transformed JSX
 * creation in production — it is NOT a dev-only cost; only Tailwind
 * compilation is build/dev work). Cold = fresh context per run; warm =
 * second navigation in the same context (HTTP cache primed). Fixture replay
 * + frozen clock as everywhere else. Raw samples are retained.
 */
async function measureProdLatencies(webDir: string, runs: number): Promise<{
  coldMs: number[];
  warmMs: number[];
  modalOpenMs: number[];
}> {
  const BunRuntime = (globalThis as unknown as { Bun: { serve(o: unknown): { stop(force?: boolean): void } ; file(p: string): unknown } }).Bun;
  const server = BunRuntime.serve({
    port: 18084, // OUTSIDE pasta 3000-8085 splice range: in-ns only, exactly what a local static server needs
    hostname: '127.0.0.1',
    fetch(req: Request) {
      const url = new URL(req.url);
      let p = decodeURIComponent(url.pathname);
      if (p === '/' || p === '') p = '/index.html';
      let filePath = path.join(webDir, p);
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
        filePath = path.join(webDir, 'index.html'); // SPA fallback (single output)
      }
      return new Response(BunRuntime.file(filePath) as BodyInit);
    },
  });
  const PROD_URL = 'http://127.0.0.1:18084/?theme=4&color=light';
  try {
    const store = new FixtureStore(FIXTURE_DIR);
    const browser = await launchBrowser();
    const coldMs: number[] = [];
    const warmMs: number[] = [];
    const modalOpenMs: number[] = [];
    for (let i = 0; i < runs; i++) {
      const context = await newDeterministicContext(browser, {
        viewport: 'desktop',
        color: 'light',
        fixtures: { store, mode: 'replay' },
      });
      const page = await context.newPage();
      const t0 = Date.now();
      await page.goto(PROD_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await waitForAppReady(page, 'Privacy Pools', 90_000);
      coldMs.push(Date.now() - t0);

      const t1 = Date.now();
      await page.goto(`${PROD_URL}&warm=1`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      await waitForAppReady(page, 'Privacy Pools', 90_000);
      warmMs.push(Date.now() - t1);

      const t2 = Date.now();
      await page.getByText('Connect Wallet', { exact: true }).first().click({ timeout: 10_000 });
      await page.waitForFunction(
        () => /account key|WalletConnect|wallet/i.test(document.body?.innerText || ''),
        undefined,
        { timeout: 15_000 },
      );
      modalOpenMs.push(Date.now() - t2);
      await context.close();
    }
    await browser.close();
    return { coldMs, warmMs, modalOpenMs };
  } finally {
    server.stop(true);
  }
}

function resolveCommit(): string {
  const idx = process.argv.indexOf('--commit');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  try {
    // Fails in a git WORKTREE under safewrap (the .git pointer targets the
    // main checkout outside the sandbox) — pass --commit there.
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT }).toString().trim();
  } catch {
    return 'unknown (git unavailable in sandbox — pass --commit)';
  }
}

async function main(): Promise<void> {
  const skipExports = process.argv.includes('--skip-exports');
  const result: Record<string, unknown> = {
    generatedBy: 'scripts/visual/perf-baseline.ts',
    commit: resolveCommit(),
    date: new Date().toISOString().slice(0, 10),
  };

  if (!skipExports) {
    // --- web export ---
    const webDir = path.join(REPO_ROOT, '.perf-export-web');
    fs.rmSync(webDir, { recursive: true, force: true });
    console.log('exporting web…');
    const web = runExport('web', webDir);
    if (web.ok) {
      const assets = walkAssets(webDir, ['.js', '.css']);
      const totalJs = assets.filter((a) => a.file.endsWith('.js'));
      const totalCss = assets.filter((a) => a.file.endsWith('.css'));
      // Established env-inlining check: the literal env-var NAME must not
      // survive into the bundle (values are inlined at build time; a
      // surviving name means a dynamic lookup that would be undefined in prod).
      const jsBlob = assets
        .filter((a) => a.file.endsWith('.js'))
        .map((a) => fs.readFileSync(path.join(webDir, a.file), 'utf8'))
        .join('\n');
      const cssBlob = totalCss
        .map((a) => fs.readFileSync(path.join(webDir, a.file), 'utf8'))
        .join('\n');
      // Distinct utility/rule counts: the shared-CSS growth budget metric
      // (distinct utilities grow shared data; JSX creation pays the
      // css-interop wrapper/map path — a PRODUCTION runtime cost, not dev-only).
      const cssRuleCount = (cssBlob.match(/{/g) ?? []).length;
      const cssClassSelectors = new Set(cssBlob.match(/\.[A-Za-z0-9_\\[\]():%.#-]+(?=[,{ >~+])/g) ?? []).size;
      result.web = {
        js: {
          files: totalJs.length,
          totalBytes: totalJs.reduce((s, a) => s + a.bytes, 0),
          totalGzipBytes: totalJs.reduce((s, a) => s + a.gzipBytes, 0),
        },
        css: {
          files: totalCss.length,
          totalBytes: totalCss.reduce((s, a) => s + a.bytes, 0),
          totalGzipBytes: totalCss.reduce((s, a) => s + a.gzipBytes, 0),
          ruleCount: cssRuleCount,
          distinctClassSelectors: cssClassSelectors,
        },
        largestAssets: assets.slice(0, 10),
        envInlining: {
          yieldEnabledNameAbsent: !jsBlob.includes('EXPO_PUBLIC_YIELD_ENABLED'),
          aspUrlNameAbsent: !jsBlob.includes('EXPO_PUBLIC_ASP_URL'),
        },
        // PERF-01 / GALLERY-01 assertions on the PRODUCTION artifacts:
        prodCssAssertions: {
          // Tailwind preflight fingerprint (html reset) must be absent —
          // corePlugins.preflight is OFF.
          preflightAbsent: !cssBlob.includes('-webkit-text-size-adjust'),
          // Gallery-only selectors must never reach production CSS (the
          // var() UTILITIES are gallery probes; the var DECLARATIONS in the
          // .pp-v{N} blocks are product code and MUST be present — see
          // prodThemeAssertions).
          // P1 NOTE: `z-[99999]` was DROPPED from this list — the header/
          // notification dropdown stacking (originally `zIndex: 99999` in
          // StyleSheet) is now class-authored, so it is legitimate PRODUCT CSS,
          // not a gallery-only probe.
          // P5 NOTE: `min-w-[160px]` DROPPED for the same reason — the ports
          // adopted it as real product CSS in the overflow-menu dropdowns
          // (all-pools / portfolio all-positions / pools transactions), the
          // swap-modal CTA buttons, and payroll cards (grep min-w-\[160px\] in
          // app+components). It was a gallery probe at F-B; it is product now.
          // The remaining four stay gallery-only.
          gallerySelectorsAbsent: [
            'backdrop-blur-\\[3px\\]', 'right-24',
            'bg-\\[var\\(--pp-button-primary\\)\\]', 'bg-\\[var\\(--pp-background\\)\\]',
          ].every((s) => !cssBlob.includes(s)),
        },
        prodGalleryAssertions: {
          galleryMarkerAbsent: !jsBlob.includes('NativeWind compatibility gallery'),
          fcGalleryMarkerAbsent: !jsBlob.includes('NativeWind F-C theme gallery'),
          galleryRouteAbsent: !jsBlob.includes('nw-gallery'),
        },
        // F-C: the generated theme foundation must be IN the product.
        prodThemeAssertions: (() => {
          const htmlPath = path.join(webDir, 'index.html');
          const html = fs.existsSync(htmlPath) ? fs.readFileSync(htmlPath, 'utf8') : '';
          // MEASURED F-C FINDING: with web.output "single", expo export does
          // NOT render app/+html.tsx into the shell at all (the exported —
          // and the LIVE — index.html carry the app-slug <title> and none of
          // the +html meta tags; pre-existing, not a NativeWind change). The
          // shell paints nothing before the bundle runs and the theme
          // provider applies root classes synchronously in its first render,
          // so no wrong-theme flash is possible in single output. The inline
          // bootstrap therefore only becomes load-bearing if web.output ever
          // switches to "static" — in which case it MUST be in the shell:
          const htmlShellFromPlusHtml = html.includes('Privacy Pools'); // +html.tsx title/meta
          const bootstrapInHtml = html.includes('ppv2_design_variant') && html.includes('ppv2_theme_preference');
          return {
            // All 10 theme blocks present in prod CSS (spot the bookends + dark).
            themeVarsPresent:
              cssBlob.includes('.pp-v0') && cssBlob.includes('.pp-v4.dark') && cssBlob.includes('--pp-button-primary'),
            // Enforced pair: +html emitted ⇒ bootstrap present. Both false is
            // the current single-output reality (recorded, not a failure).
            bootstrapPresentIfHtmlShellEmitted: !htmlShellFromPlusHtml || bootstrapInHtml,
            // Recorded (informational, keys prefixed info- are not enforced):
            'info-htmlShellFromPlusHtml': htmlShellFromPlusHtml,
            'info-bootstrapInHtml': bootstrapInHtml,
          };
        })(),
      };
      const web2 = result.web as {
        prodCssAssertions: Record<string, boolean>;
        prodGalleryAssertions: Record<string, boolean>;
        prodThemeAssertions: Record<string, boolean>;
      };
      const assertionFailures = [
        ...Object.entries(web2.prodCssAssertions),
        ...Object.entries(web2.prodGalleryAssertions),
        ...Object.entries(web2.prodThemeAssertions),
      ].filter(([key, ok]) => !key.startsWith('info-') && !ok);
      if (assertionFailures.length > 0) {
        console.error(`PROD EXPORT ASSERTIONS FAILED: ${assertionFailures.map(([k]) => k).join(', ')}`);
        process.exitCode = 1;
      }
    } else {
      result.web = { failed: web.error };
    }

    // --- native exports (Metro bundles; no Xcode/gradle needed for export) ---
    for (const platform of ['ios', 'android'] as const) {
      const dir = path.join(REPO_ROOT, `.perf-export-${platform}`);
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(`exporting ${platform}…`);
      const res = runExport(platform, dir);
      if (res.ok) {
        const bundles = walkAssets(dir, ['.hbc', '.js', '.bundle']);
        result[platform] = {
          bundles: bundles.slice(0, 5),
          totalBytes: bundles.reduce((s, a) => s + a.bytes, 0),
          totalGzipBytes: bundles.reduce((s, a) => s + a.gzipBytes, 0),
        };
      } else {
        result[platform] = { failed: res.error?.slice(0, 1200) };
      }
    }
  }

  // --- PRODUCT latency: serve the production export (PERF-02) ---
  const webDirForLatency = path.join(REPO_ROOT, '.perf-export-web');
  if (!skipExports && fs.existsSync(path.join(webDirForLatency, 'index.html'))) {
    console.log('measuring PRODUCTION latency (served export, 5 runs)…');
    const prod = await measureProdLatencies(webDirForLatency, 5);
    result.prodLatency = {
      protocol:
        'production export served statically on 127.0.0.1:18084; fixture replay + frozen clock; cold = fresh context nav→app-ready; warm = second nav same context; modal = Connect-Wallet click → picker text. PRODUCT metric (css-interop render work is production runtime).',
      coldMsRuns: prod.coldMs,
      coldMsMedian: median(prod.coldMs),
      warmMsRuns: prod.warmMs,
      warmMsMedian: median(prod.warmMs),
      modalOpenMsRuns: prod.modalOpenMs,
      modalOpenMsMedian: median(prod.modalOpenMs),
    };
  }

  // --- DEV latency (DX metric only — dev pipeline includes Tailwind compile) ---
  console.log('measuring dev-server startup/modal latency (5 runs)…');
  const lat = await measureLatencies(5);
  result.devLatency = {
    protocol:
      'dev server 8081, fixture replay, frozen clock; startup = nav→app-ready marker; modal = Connect-Wallet click → picker text. DX metric — do NOT compare against product budgets.',
    startupMsRuns: lat.startupMs,
    startupMsMedian: median(lat.startupMs),
    modalOpenMsRuns: lat.modalOpenMs,
    modalOpenMsMedian: median(lat.modalOpenMs),
  };

  const outIdx = process.argv.indexOf('--out');
  const outPath =
    outIdx >= 0 && process.argv[outIdx + 1]
      ? path.resolve(process.argv[outIdx + 1])
      : path.join(VISUAL_DIR, 'perf-baseline.json');
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n');
  console.log(`wrote ${outPath}`);
}

main();
