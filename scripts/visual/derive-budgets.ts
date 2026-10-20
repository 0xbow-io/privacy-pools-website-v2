// Per-shot changed-pixel budgets (GATES-02): every baseline namespace gets a
// calibrated budget instead of one global worst-case number (the old global
// budget let drawer noise grant modal/gallery shots ~4k pixels).
//
//   bun scripts/visual/derive-budgets.ts \
//     --from-measured                 # seed surface budgets from the F-A calibration data
//     --pair <dirA> <dirB>            # measure a repeat-capture pair (repeatable; any namespace)
//     [--floor 50] [--factor 3]
//
// Budget per shot = max(observed repeat-capture noise) × factor, floor
// `floor`. Shots never observed noisy get the floor. compare.ts falls back
// to policy.defaultBudget (= floor) for shots without an entry, so brand-new
// uncalibrated shots are held to the strict floor rather than a loose global.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { THRESHOLDS_PATH } from './config';
import { diffPng, readPng } from './png';

interface Thresholds {
  [k: string]: unknown;
  policy: { perChannelTolerance: number; changedPixelBudget?: number; defaultBudget?: number; note?: string };
  measured?: { noisyShotsAtChosenTolerance?: { name: string; changed: number }[] };
  perShot?: Record<string, number>;
  perShotSources?: Record<string, string>;
}

function main(): void {
  const args = process.argv.slice(2);
  let floor = 50;
  let factor = 3;
  let fromMeasured = false;
  const pairs: [string, string][] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--floor') floor = Number(args[++i]);
    else if (args[i] === '--factor') factor = Number(args[++i]);
    else if (args[i] === '--from-measured') fromMeasured = true;
    else if (args[i] === '--pair') {
      pairs.push([path.resolve(args[++i]), path.resolve(args[++i])]);
    }
  }

  const thresholds = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, 'utf8')) as Thresholds;
  const tolerance = thresholds.policy.perChannelTolerance;
  const noise = new Map<string, number>(); // shot -> max observed noise
  const source = new Map<string, string>();

  if (fromMeasured) {
    for (const s of thresholds.measured?.noisyShotsAtChosenTolerance ?? []) {
      noise.set(s.name, Math.max(noise.get(s.name) ?? 0, s.changed));
      source.set(s.name, 'F-A surface calibration (3 runs)');
    }
  }

  for (const [a, b] of pairs) {
    const names = fs.readdirSync(a).filter((f) => f.endsWith('.png'));
    for (const name of names) {
      const bPath = path.join(b, name);
      if (!fs.existsSync(bPath)) continue;
      const d = diffPng(readPng(path.join(a, name)), readPng(bPath), tolerance);
      if (d.changedPixels > (noise.get(name) ?? 0)) {
        noise.set(name, d.changedPixels);
        source.set(name, `repeat pair ${path.basename(a)} vs ${path.basename(b)}`);
      }
      console.log(`  ${name}: ${d.changedPixels} px noise`);
    }
  }

  const perShot: Record<string, number> = { ...(thresholds.perShot ?? {}) };
  const perShotSources: Record<string, string> = { ...(thresholds.perShotSources ?? {}) };
  for (const [name, n] of [...noise.entries()].sort()) {
    const budget = Math.max(floor, n * factor);
    if (budget > (perShot[name] ?? 0)) {
      perShot[name] = budget;
      perShotSources[name] = source.get(name) ?? 'unknown';
    }
  }

  thresholds.perShot = perShot;
  thresholds.perShotSources = perShotSources;
  thresholds.policy = {
    perChannelTolerance: tolerance,
    defaultBudget: floor,
    note:
      `A pixel differs when any RGBA channel deviates by more than perChannelTolerance; a shot fails when more than its ` +
      `perShot budget (fallback defaultBudget=${floor}) pixels differ. Budgets = measured repeat-capture noise × ${factor}, floor ${floor} — ` +
      `per shot, never a global worst case.`,
  };
  fs.writeFileSync(THRESHOLDS_PATH, JSON.stringify(thresholds, null, 2) + '\n');
  console.log(`wrote ${THRESHOLDS_PATH}: ${Object.keys(perShot).length} per-shot budgets, defaultBudget ${floor}`);
}

main();
