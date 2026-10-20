// Stability calibration: capture each surface N times unchanged (replay mode,
// fresh context each time), measure per-pixel noise between repeats, and emit
// the MEASURED threshold policy into scripts/visual/thresholds.json — the
// plan requires a measured policy, not a guess.
//
//   safewrap bun scripts/visual/calibrate.ts [--runs 3] [--only <substr>]...
//
// IMPORTANT operational note: one safewrap sandbox cannot survive 2+ full
// capture runs (the pasta netns wedges after ~150 page loads: screenshots
// hang at "waiting for fonts"). Run each capture in its OWN invocation and
// hand the directories to --from for the threshold computation:
//
//   for r in 1 2 3; do
//     SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/visual/capture.ts \
//       --mode replay --out scripts/visual/.calib-run-$r
//   done
//   safewrap bun scripts/visual/calibrate.ts \
//     --from scripts/visual/.calib-run-1 --from scripts/visual/.calib-run-2 \
//     --from scripts/visual/.calib-run-3

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { THRESHOLDS_PATH } from './config';
import { captureAll } from './capture';
import { diffPng, readPng } from './png';

interface PairStat {
  name: string;
  runA: number;
  runB: number;
  maxChannelDelta: number;
  changedAtZero: number;
  changedAtTolerance: number;
  totalPixels: number;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let runs = 3;
  const only: string[] = [];
  const fromDirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--runs') runs = Number(args[++i]);
    else if (args[i] === '--only') only.push(args[++i]);
    else if (args[i] === '--from') fromDirs.push(path.resolve(args[++i]));
  }

  let runDirs: string[];
  if (fromDirs.length >= 2) {
    // Compute-only mode: capture runs were done in separate invocations
    // (see the operational note in the header).
    runDirs = fromDirs;
    runs = fromDirs.length;
  } else {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ppv2-visual-calibration-'));
    runDirs = [];
    for (let r = 0; r < runs; r++) {
      const dir = path.join(tmpRoot, `run-${r}`);
      console.log(`\n=== calibration run ${r + 1}/${runs} ===`);
      const result = await captureAll({ mode: 'replay', outDir: dir, only });
      if (result.failed.length > 0 || result.fixtureMisses.length > 0) {
        console.error('calibration run had failures or fixture misses — fix those before calibrating');
        process.exit(1);
      }
      runDirs.push(dir);
    }
  }

  // Pairwise diffs between consecutive runs for every shot.
  const names = fs.readdirSync(runDirs[0]).filter((f) => f.endsWith('.png')).sort();
  const pairs: PairStat[] = [];
  let globalMaxDelta = 0;
  for (const name of names) {
    for (let r = 0; r + 1 < runDirs.length; r++) {
      const a = readPng(path.join(runDirs[r], name));
      const b = readPng(path.join(runDirs[r + 1], name));
      const zero = diffPng(a, b, 0);
      pairs.push({
        name,
        runA: r,
        runB: r + 1,
        maxChannelDelta: zero.maxChannelDelta,
        changedAtZero: zero.changedPixels,
        changedAtTolerance: 0, // filled below once the tolerance is chosen
        totalPixels: zero.totalPixels,
      });
      globalMaxDelta = Math.max(globalMaxDelta, zero.maxChannelDelta);
    }
  }

  // Choose the smallest per-channel tolerance that zeroes residual noise on
  // EVERY measured pair. If no candidate achieves that (residual noise above
  // the cap), the largest candidate stands — the cap exists so real
  // regressions can't hide behind an auto-grown tolerance.
  const CANDIDATES = [0, 1, 2, 3, 4, 5, 8, 10];
  let tolerance = CANDIDATES[CANDIDATES.length - 1];
  for (const t of CANDIDATES) {
    const noisy = pairs.filter((p) => p.maxChannelDelta > t).length;
    if (noisy === 0) {
      tolerance = t;
      break;
    }
  }

  // Recompute changed-pixel counts at the chosen tolerance.
  let maxChangedAtTolerance = 0;
  const perShotMax: Record<string, number> = {};
  for (const p of pairs) {
    const a = readPng(path.join(runDirs[p.runA], p.name));
    const b = readPng(path.join(runDirs[p.runB], p.name));
    const d = diffPng(a, b, tolerance);
    p.changedAtTolerance = d.changedPixels;
    maxChangedAtTolerance = Math.max(maxChangedAtTolerance, d.changedPixels);
    perShotMax[p.name] = Math.max(perShotMax[p.name] ?? 0, d.changedPixels);
  }

  // Budget: observed max at tolerance × 3, with a small floor so a future
  // single-pixel flake doesn't hard-fail, and expressed as an absolute count.
  const changedPixelBudget = Math.max(maxChangedAtTolerance * 3, 50);

  const noisyShots = Object.entries(perShotMax)
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, changed]) => ({ name, changed }));

  const thresholds = {
    generatedBy: 'scripts/visual/calibrate.ts',
    calibratedAt: new Date().toISOString().slice(0, 10),
    runs,
    shots: names.length,
    pairsMeasured: pairs.length,
    measured: {
      maxChannelDeltaObserved: globalMaxDelta,
      maxChangedPixelsAtZeroTolerance: Math.max(...pairs.map((p) => p.changedAtZero), 0),
      maxChangedPixelsAtChosenTolerance: maxChangedAtTolerance,
      noisyShotsAtChosenTolerance: noisyShots,
    },
    policy: {
      perChannelTolerance: tolerance,
      changedPixelBudget,
      note:
        'A pixel differs when any RGBA channel deviates by more than perChannelTolerance; a comparison fails when more than changedPixelBudget pixels differ. Values are measured from repeated identical captures (see `measured`), not guessed.',
    },
  };

  fs.writeFileSync(THRESHOLDS_PATH, JSON.stringify(thresholds, null, 2) + '\n');
  console.log(`\nwrote ${THRESHOLDS_PATH}`);
  console.log(JSON.stringify(thresholds.measured, null, 2));
  console.log(JSON.stringify(thresholds.policy, null, 2));
  console.log(`calibration artifacts kept at: ${runDirs.join(', ')}`);
}

main();
