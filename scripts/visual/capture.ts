// Baseline/candidate capture CLI.
//
//   safewrap bun scripts/visual/capture.ts --mode replay --out scripts/visual/baselines
//   safewrap bun scripts/visual/capture.ts --mode record            # (re)record fixtures while capturing
//   safewrap bun scripts/visual/capture.ts --only home --only v3    # substring filters on shot names
//
// Requires the dev server on BASE_URL (default localhost:8081).

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BASELINE_DIR,
  FIXTURE_DIR,
  enumerateShots,
  shotName,
  surfaceUrl,
} from './config';
import { openFixtureStore, type FixtureMode } from './fixtures';
import { assertOrUpdateBaselineManifest } from './baseline-manifest';
import { launchBrowser, newDeterministicContext, openSurface, stableScreenshot } from './harness';

export interface CaptureOptions {
  mode: FixtureMode;
  outDir: string;
  only?: string[];
  log?: (msg: string) => void;
}

export interface CaptureResult {
  captured: string[];
  failed: { name: string; error: string }[];
  fixtureMisses: { method: string; url: string }[];
}

export async function captureAll(opts: CaptureOptions): Promise<CaptureResult> {
  const log = opts.log ?? ((m: string) => console.log(m));
  fs.mkdirSync(opts.outDir, { recursive: true });
  const store = openFixtureStore(FIXTURE_DIR, opts.mode);
  const browser = await launchBrowser();
  const captured: string[] = [];
  const failed: { name: string; error: string }[] = [];

  const shots = enumerateShots().filter((s) => {
    if (!opts.only || opts.only.length === 0) return true;
    const name = shotName(s.surface.name, s.variant, s.color, s.viewport);
    return opts.only.every((f) => name.includes(f));
  });

  log(`capturing ${shots.length} shots (mode=${opts.mode}) → ${opts.outDir}`);
  const ATTEMPTS = 2; // one retry absorbs transient load-induced timeouts
  for (const shot of shots) {
    const name = shotName(shot.surface.name, shot.variant, shot.color, shot.viewport);
    const url = surfaceUrl(shot.surface, shot.variant, shot.color);
    let lastError = '';
    let ok = false;
    for (let attempt = 1; attempt <= ATTEMPTS && !ok; attempt++) {
      const context = await newDeterministicContext(browser, {
        viewport: shot.viewport,
        color: shot.color,
        fixtures: { store, mode: opts.mode },
        log,
      });
      try {
        const page = await openSurface(context, {
          url,
          marker: shot.surface.marker,
          settleMs: shot.surface.settleMs,
          scrollY: shot.surface.scrollY,
        });
        const buf = await stableScreenshot(page);
        fs.writeFileSync(path.join(opts.outDir, name), buf);
        captured.push(name);
        log(`  ok ${name}${attempt > 1 ? ` (attempt ${attempt})` : ''}`);
        ok = true;
      } catch (e) {
        lastError = (e as Error).message;
        log(`  ${attempt < ATTEMPTS ? 'retry' : 'FAIL'} ${name}: ${lastError.slice(0, 200)}`);
      } finally {
        await context.close();
      }
    }
    if (!ok) failed.push({ name, error: lastError });
  }

  await browser.close();
  store.writeIndex();
  return { captured, failed, fixtureMisses: store.misses };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let mode: FixtureMode = 'replay';
  let outDir = BASELINE_DIR;
  let commit = '';
  let refreshBaselines = false;
  const only: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--mode') mode = args[++i] as FixtureMode;
    else if (args[i] === '--out') outDir = path.resolve(args[++i]);
    else if (args[i] === '--only') only.push(args[++i]);
    else if (args[i] === '--commit') commit = args[++i];
    else if (args[i] === '--refresh-baselines') refreshBaselines = true;
  }
  // Ground-truth writes must match (or deliberately refresh) the recorded
  // fixture digest — see baseline-manifest.ts (GATES-01).
  if (outDir === BASELINE_DIR) {
    assertOrUpdateBaselineManifest({ allowRefresh: refreshBaselines, ...(commit ? { commit } : {}) });
  }
  const result = await captureAll({ mode, outDir, only });
  console.log(`\ncaptured ${result.captured.length}, failed ${result.failed.length}, fixture misses ${result.fixtureMisses.length}`);
  // Replay misses mean the app asked for data the fixtures don't cover; the
  // aborted request degrades the UI (error/empty states) yet stable-screenshot
  // can still succeed — writing a poisoned baseline/candidate with exit 0.
  // Refuse that: misses fail the run so the fixtures get re-recorded instead.
  if (result.fixtureMisses.length > 0) {
    for (const m of result.fixtureMisses) console.error(`  fixture MISS: ${m.method} ${m.url}`);
    console.error('replay fixtures incomplete — re-record (capture.ts --mode record) before capturing');
    process.exit(1);
  }
  if (result.failed.length > 0) process.exit(1);
}

if ((import.meta as ImportMeta & { main?: boolean }).main) main();
