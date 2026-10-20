// Pixel-diff compare: candidate directory vs baseline directory, using the
// calibrated per-shot budgets in thresholds.json. On failure writes
// <out>/<name>.baseline.png / .candidate.png / .diff.png artifacts.
//
//   safewrap bun scripts/visual/compare.ts --candidate <dir> [--baseline <dir>]
//       [--artifacts <dir>] [--json <report.json>] [--commit <id>]
//
// Integrity gates (GATES-01/02):
//  - FAILS when the current fixture-set digest does not match the digest the
//    baselines were captured against (baselines/manifest.json).
//  - Per-shot changed-pixel budgets (thresholds.perShot); shots without a
//    calibrated budget use policy.defaultBudget (strict floor), NOT a global
//    worst-case budget.
//  - --json writes a machine-readable report per shot: raw byte equality
//    (sha256), thresholded changed pixels, max channel delta, bounding box,
//    the budget applied, and the verdict — so any claimed distribution can be
//    re-audited without rerunning the capture.

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { BASELINE_DIR, THRESHOLDS_PATH, SCREENSHOT_VARIANTS, surfaceShotInScope } from './config';
import { assertBaselineFixtureConsistency } from './baseline-manifest';
import { diffPng, readPng } from './png';

interface Thresholds {
  policy: { perChannelTolerance: number; changedPixelBudget?: number; defaultBudget?: number };
  perShot?: Record<string, number>;
}

interface ShotReport {
  name: string;
  byteIdentical: boolean;
  baselineSha256: string;
  candidateSha256: string;
  changedPixels: number;
  maxChannelDelta: number;
  changedBBox?: { x0: number; y0: number; x1: number; y1: number };
  budget: number;
  budgetSource: 'perShot' | 'default';
  verdict: 'ok' | 'fail' | 'missing' | 'dimension-mismatch';
}

const sha256File = (p: string) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

function main(): void {
  const args = process.argv.slice(2);
  let baselineDir = BASELINE_DIR;
  let candidateDir = '';
  let artifactsDir = '';
  let jsonOut = '';
  let commit = '';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--baseline') baselineDir = path.resolve(args[++i]);
    else if (args[i] === '--candidate') candidateDir = path.resolve(args[++i]);
    else if (args[i] === '--artifacts') artifactsDir = path.resolve(args[++i]);
    else if (args[i] === '--json') jsonOut = path.resolve(args[++i]);
    else if (args[i] === '--commit') commit = args[++i];
  }
  if (!candidateDir) {
    console.error('usage: compare.ts --candidate <dir> [--baseline <dir>] [--artifacts <dir>] [--json <report.json>]');
    process.exit(2);
  }
  if (!artifactsDir) artifactsDir = path.join(candidateDir, 'diff-artifacts');

  // GATES-01: baseline/fixture consistency, fail closed.
  const baselineManifest = assertBaselineFixtureConsistency();

  const thresholds = JSON.parse(fs.readFileSync(THRESHOLDS_PATH, 'utf8')) as Thresholds;
  const { perChannelTolerance } = thresholds.policy;
  const defaultBudget = thresholds.policy.defaultBudget ?? 50;
  const perShot = thresholds.perShot ?? {};

  // Screenshot-scope allowlist (see config.SCREENSHOT_VARIANTS): out-of-scope
  // per-variant SURFACE baselines stay on disk and valid but are NOT required
  // of the candidate, so a scoped capture (Classic + Mono only) does not fail
  // 'missing' for v1/v2/v3. Modal + gallery baselines are always required.
  const skipped = fs.readdirSync(baselineDir).filter((f) => f.endsWith('.png') && !surfaceShotInScope(f));
  const baselineNames = fs.readdirSync(baselineDir).filter((f) => f.endsWith('.png') && surfaceShotInScope(f)).sort();
  const candidateNames = new Set(fs.readdirSync(candidateDir).filter((f) => f.endsWith('.png')));

  const shots: ShotReport[] = [];
  let failures = 0;
  const missing: string[] = [];
  for (const name of baselineNames) {
    const budget = perShot[name] ?? defaultBudget;
    const budgetSource: ShotReport['budgetSource'] = name in perShot ? 'perShot' : 'default';
    if (!candidateNames.has(name)) {
      missing.push(name);
      shots.push({
        name, byteIdentical: false, baselineSha256: sha256File(path.join(baselineDir, name)),
        candidateSha256: '', changedPixels: -1, maxChannelDelta: -1, budget, budgetSource, verdict: 'missing',
      });
      continue;
    }
    candidateNames.delete(name);
    const baselinePath = path.join(baselineDir, name);
    const candidatePath = path.join(candidateDir, name);
    const baselineSha = sha256File(baselinePath);
    const candidateSha = sha256File(candidatePath);
    const a = readPng(baselinePath);
    const b = readPng(candidatePath);
    fs.mkdirSync(artifactsDir, { recursive: true });
    const result = diffPng(a, b, perChannelTolerance, path.join(artifactsDir, `${name.replace(/\.png$/, '')}.diff.png`));
    const ok = !result.dimensionMismatch && result.changedPixels <= budget;
    shots.push({
      name,
      byteIdentical: baselineSha === candidateSha,
      baselineSha256: baselineSha,
      candidateSha256: candidateSha,
      changedPixels: result.changedPixels,
      maxChannelDelta: result.maxChannelDelta,
      ...(result.changedBBox ? { changedBBox: result.changedBBox } : {}),
      budget,
      budgetSource,
      verdict: result.dimensionMismatch ? 'dimension-mismatch' : ok ? 'ok' : 'fail',
    });
    if (ok) {
      fs.rmSync(path.join(artifactsDir, `${name.replace(/\.png$/, '')}.diff.png`), { force: true });
      console.log(`  ok   ${name} (${result.changedPixels} px within budget ${budget}${baselineSha === candidateSha ? ', byte-identical' : ''})`);
    } else {
      failures++;
      fs.copyFileSync(baselinePath, path.join(artifactsDir, `${name.replace(/\.png$/, '')}.baseline.png`));
      fs.copyFileSync(candidatePath, path.join(artifactsDir, `${name.replace(/\.png$/, '')}.candidate.png`));
      const why = result.dimensionMismatch
        ? `dimensions ${result.dimensionMismatch.a} vs ${result.dimensionMismatch.b}`
        : `${result.changedPixels} changed px > budget ${budget} (${budgetSource})`;
      console.log(`  FAIL ${name}: ${why}`);
    }
  }

  const extras = [...candidateNames].sort();
  if (skipped.length) console.log(`screenshot scope: variants [${SCREENSHOT_VARIANTS.join(',')}] — ${skipped.length} out-of-scope surface baselines on disk not required`);
  if (missing.length) console.log(`missing from candidate: ${missing.join(', ')}`);
  if (extras.length) console.log(`extra in candidate (no baseline): ${extras.join(', ')}`);

  if (jsonOut) {
    const okShots = shots.filter((s) => s.verdict === 'ok');
    const report = {
      generatedBy: 'scripts/visual/compare.ts',
      date: new Date().toISOString(),
      ...(commit ? { commit } : {}),
      baselineDir,
      candidateDir,
      fixtureDigest: baselineManifest.fixtureDigest,
      browser: baselineManifest.browser,
      policy: { perChannelTolerance, defaultBudget },
      screenshotScope: { variants: SCREENSHOT_VARIANTS, outOfScopeSurfaceBaselines: skipped.length },
      summary: {
        baselines: baselineNames.length,
        ok: okShots.length,
        failed: failures,
        missing: missing.length,
        extras: extras.length,
        byteIdentical: shots.filter((s) => s.byteIdentical).length,
        zeroThresholdedPixels: shots.filter((s) => s.verdict === 'ok' && s.changedPixels === 0).length,
        worstChangedPixels: Math.max(0, ...okShots.map((s) => s.changedPixels)),
      },
      shots,
      extrasInCandidate: extras,
    };
    fs.mkdirSync(path.dirname(jsonOut), { recursive: true });
    fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n');
    console.log(`report → ${jsonOut}`);
  }

  if (failures > 0 || missing.length > 0) {
    console.log(`\nCOMPARE FAILED — ${failures} diffs, ${missing.length} missing; artifacts in ${artifactsDir}`);
    process.exit(1);
  }
  console.log('\nCOMPARE OK');
}

main();
