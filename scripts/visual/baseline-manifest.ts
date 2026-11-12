// Baseline manifest (GATES-01): every baseline set records the fixture-set
// digest it was captured against. Capture CLIs writing into BASELINE_DIR
// refuse to mix digests; compare.ts fails when the current fixture set no
// longer matches the digest the baselines were captured from.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { BASELINE_DIR, FIXTURE_DIR } from './config';
import { fixtureSetDigest } from './fixtures';

export interface BaselineManifest {
  fixtureDigest: string;
  browser: string;
  updatedAt: string;
  commit?: string;
  note?: string;
}

const MANIFEST_PATH = path.join(BASELINE_DIR, 'manifest.json');

// Which browser a capture ran on. Pixels differ between Chrome majors, so a
// comparison across majors would read as diffs instead of a clear mismatch.
const CAPTURE_BROWSER_FILE = 'capture-browser.json';

/** The manifest label for a Chrome `browser.version()` string. */
export function chromeLabel(version: string): string {
  return `chrome-${version}`;
}

/** Pure: what has to match between baselines and a capture (Chrome major, or the whole legacy label). */
export function browserFamily(label: string): string {
  const m = /^chrome-(\d+)\./.exec(label);
  return m ? `chrome-${m[1]}` : label;
}

/** Record the browser a capture ran on, next to its screenshots. */
export function writeCaptureBrowser(outDir: string, label: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, CAPTURE_BROWSER_FILE), JSON.stringify({ browser: label }, null, 2) + '\n');
}

/** The browser a capture directory was captured on, or null when it does not say. */
export function readCaptureBrowser(dir: string): string | null {
  const file = path.join(dir, CAPTURE_BROWSER_FILE);
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { browser?: unknown };
  return typeof parsed.browser === 'string' ? parsed.browser : null;
}

export function readBaselineManifest(): BaselineManifest | null {
  if (!fs.existsSync(MANIFEST_PATH)) return null;
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as BaselineManifest;
}

export function currentFixtureDigest(): string {
  return fixtureSetDigest(FIXTURE_DIR);
}

/**
 * Called by every capture CLI that is about to write GROUND-TRUTH baselines
 * (outDir === BASELINE_DIR). Fails when a manifest exists for a DIFFERENT
 * fixture digest — a partial refresh against changed fixtures would produce
 * exactly the mixed-snapshot corpus this mechanism exists to prevent. Pass
 * `allowRefresh` (capture CLI flag --refresh-baselines) when deliberately
 * recapturing; the manifest is then updated to the current digest.
 */
export function assertOrUpdateBaselineManifest(opts: { browser: string; commit?: string; note?: string; allowRefresh?: boolean }): void {
  const digest = currentFixtureDigest();
  const existing = readBaselineManifest();
  if (existing && browserFamily(existing.browser) !== browserFamily(opts.browser) && !opts.allowRefresh) {
    throw new Error(
      `baseline manifest browser mismatch: baselines were captured on ${existing.browser}, this capture runs on ` +
        `${opts.browser}. Recapture ALL baselines with --refresh-baselines instead of mixing browsers.`,
    );
  }
  if (existing && existing.fixtureDigest !== digest && !opts.allowRefresh) {
    throw new Error(
      `baseline manifest digest mismatch: baselines were captured against fixture set ${existing.fixtureDigest.slice(0, 16)}…, ` +
        `current fixtures are ${digest.slice(0, 16)}…. Either restore the recorded fixture set or deliberately recapture ` +
        `ALL baselines with --refresh-baselines (partial refreshes against changed fixtures are exactly the mixed-snapshot ` +
        `corruption this check prevents).`,
    );
  }
  const manifest: BaselineManifest = {
    fixtureDigest: digest,
    browser: opts.browser,
    updatedAt: new Date().toISOString(),
    ...(opts.commit ? { commit: opts.commit } : existing?.commit ? { commit: existing.commit } : {}),
    ...(opts.note ? { note: opts.note } : existing?.note ? { note: existing.note } : {}),
  };
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
}

/** compare.ts: fail closed when fixtures or the browser no longer match the baselines. */
export function assertBaselineFixtureConsistency(candidateBrowser: string | null): BaselineManifest {
  const manifest = readBaselineManifest();
  if (!manifest) {
    throw new Error(
      'baselines/manifest.json missing — baselines have no recorded fixture digest. Recapture baselines (capture CLIs ' +
        'write the manifest) before comparing.',
    );
  }
  const digest = currentFixtureDigest();
  if (manifest.fixtureDigest !== digest) {
    throw new Error(
      `fixture set (${digest.slice(0, 16)}…) does not match the digest the baselines were captured against ` +
        `(${manifest.fixtureDigest.slice(0, 16)}…) — comparison would diff different data snapshots. Restore the fixture ` +
        `set or recapture all baselines.`,
    );
  }
  if (!candidateBrowser) {
    throw new Error(
      'the candidate capture does not record its browser (capture-browser.json missing). Recapture it with the current ' +
        'capture CLIs before comparing.',
    );
  }
  if (browserFamily(manifest.browser) !== browserFamily(candidateBrowser)) {
    throw new Error(
      `browser mismatch: baselines were captured on ${manifest.browser}, the candidate on ${candidateBrowser}. ` +
        'Pixels differ between browser versions, so recapture all baselines (--refresh-baselines) on the current Chrome.',
    );
  }
  return manifest;
}
