// Manifest-completeness gate (F-A): the ownership manifest must stay in
// lockstep with the live audit output — a styled file added/removed without a
// manifest update fails here, so drift can't accumulate silently.
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { auditRepo, AUDIT_DIRS, EVIDENCE_FIXTURES } from './audit-nativewind';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const MANIFEST_PATH = path.join(ROOT, 'workflows', 'plans', 'nativewind-manifest.json');

interface ManifestFile {
  path: string;
  phase: string;
  slice?: string;
  subwave?: number;
  money?: string;
  /**
   * Set when the file's port landed: zero StyleSheet refs and every remaining
   * style signal carries a categorized nw-keep annotation (enforced below).
   * A ported file MAY drop out of the audit's styled set entirely (all
   * signals became className) — it stays in the manifest as the record of
   * ownership until P4 retires the inventory.
   */
  ported?: boolean;
}

interface ManifestEvidenceFixture {
  path: string;
  owner: string;
  reason: string;
  lifecycle: string;
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as {
  version: number;
  groundTruth: {
    filesWithStyleSheetCreate: number;
    filesWithAnyStylingSignal: number;
    portedFiles: number;
    note: string;
  };
  counts: Record<string, number>;
  files: ManifestFile[];
  outOfScope: { path: string }[];
  evidenceFixtures: ManifestEvidenceFixture[];
};

describe('nativewind-manifest counts', () => {
  test('counts are the per-slice tally of the files list, derived, not restated', () => {
    const tally: Record<string, number> = {};
    for (const f of manifest.files) {
      const bucket = `${f.phase}/${f.slice ?? `subwave-${f.subwave}`}`;
      tally[bucket] = (tally[bucket] ?? 0) + 1;
    }
    expect(manifest.counts).toEqual(tally);
  });
});

const report = auditRepo(ROOT);
// Phase ownership (files[]) covers migration-scope files; evidence fixtures
// are owned separately via manifest.evidenceFixtures (asserted below).
const styledFiles = report.files
  .filter((f) => f.hasStyles && f.classification === 'app')
  .map((f) => f.file);

describe('nativewind-manifest completeness', () => {
  test('every audited styled file appears in the manifest exactly once', () => {
    const manifestPaths = manifest.files.map((f) => f.path);
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const p of manifestPaths) {
      if (seen.has(p)) duplicates.push(p);
      seen.add(p);
    }
    expect(duplicates).toEqual([]);

    const missing = styledFiles.filter((f) => !seen.has(f));
    expect(missing).toEqual([]); // styled file not owned by any phase — add it to the manifest

    // A non-ported entry must still be styled (else it was removed/renamed
    // and the manifest is stale). A PORTED entry may have gone fully
    // styleless — every signal became className — but must still exist.
    const ported = new Set(manifest.files.filter((f) => f.ported).map((f) => f.path));
    const stale = manifestPaths.filter((p) => !styledFiles.includes(p) && !ported.has(p));
    expect(stale).toEqual([]); // manifest entry no longer styled/existing — remove or reclassify
    const goneButPorted = manifestPaths.filter((p) => ported.has(p) && !fs.existsSync(path.join(ROOT, p)));
    expect(goneButPorted).toEqual([]); // ported entry's file vanished — remove from the manifest
  });

  test('every entry has a valid phase, P2 entries a slice, P3 entries a subwave', () => {
    const validPhases = new Set(['F-C', 'P1', 'P2', 'P3']);
    for (const f of manifest.files) {
      expect(validPhases.has(f.phase)).toBe(true);
      if (f.phase === 'P2') expect(typeof f.slice).toBe('string');
      if (f.phase === 'P3') {
        expect(typeof f.subwave).toBe('number');
        expect(f.subwave! >= 1 && f.subwave! <= 7).toBe(true);
        // Money providers (subwaves 2-7) carry the plan-ordered name.
        if (f.subwave! > 1) {
          expect(['deposit', 'transfer', 'withdraw', 'swap', 'ragequit', 'payment-request']).toContain(f.money);
        }
      }
    }
  });

  test('P3 money order matches the plan: deposit → transfer → withdraw → swap → ragequit → payment-request', () => {
    const money = manifest.files
      .filter((f) => f.phase === 'P3' && (f.subwave ?? 1) > 1)
      .sort((a, b) => a.subwave! - b.subwave!)
      .map((f) => f.money);
    expect(money).toEqual(['deposit', 'transfer', 'withdraw', 'swap', 'ragequit', 'payment-request']);
  });

  test('sdk-provider.tsx is styleless and stays out of scope', () => {
    expect(manifest.outOfScope.map((f) => f.path)).toContain('components/sdk-provider.tsx');
    const audited = report.files.find((f) => f.file === 'components/sdk-provider.tsx');
    expect(audited).toBeDefined();
    expect(audited!.hasStyles).toBe(false);
  });

  test('no manifest entry is also declared outOfScope', () => {
    const owned = new Set(manifest.files.map((f) => f.path));
    const overlap = manifest.outOfScope.filter((f) => owned.has(f.path)).map((f) => f.path);
    expect(overlap).toEqual([]);
  });

  test('audit coverage: every top-level source dir is audited or explicitly excluded', () => {
    // The audit only scans AUDIT_DIRS — a NEW app-code dir would make styled
    // files invisible to both the audit and this gate. Fail loudly instead.
    const EXCLUDED_TOP_LEVEL = new Set([
      'scripts', // tooling (this gate's own fixtures are .test.ts, skipped by the audit)
      'workflows', 'plans', 'docs', 'public', 'assets', 'types', 'tests',
      'vendor', 'metro-shims', '.expo', '.github', '.vscode', '.pw-browsers', '.pwcheck',
      'modules', // local Expo native modules (Kotlin/Swift/Rust), no styles
    ]);
    const SKIP_DESCEND = new Set(['node_modules', '__tests__', '__fixtures__', 'sui-witness']);
    const hasSourceFiles = (dir: string): boolean => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (SKIP_DESCEND.has(e.name) || e.name.startsWith('.')) continue;
          if (hasSourceFiles(full)) return true;
        } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts') && !/\.test\.(ts|tsx)$/.test(e.name)) {
          return true;
        }
      }
      return false;
    };
    const unaudited: string[] = [];
    for (const e of fs.readdirSync(ROOT, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
      if (AUDIT_DIRS.includes(e.name) || EXCLUDED_TOP_LEVEL.has(e.name)) continue;
      if (hasSourceFiles(path.join(ROOT, e.name))) unaudited.push(e.name);
    }
    expect(unaudited).toEqual([]); // new source dir — add it to AUDIT_DIRS (and re-run the manifest gate)
  });

  test('ground-truth counters track the port (manifest.groundTruth is the snapshot)', () => {
    // These counters CHANGE as phases port files; each porting commit updates
    // the manifest snapshot alongside the code, so drift between the audit
    // and the committed record fails here.
    expect(report.totals.filesWithStyleSheetCreate).toBe(manifest.groundTruth.filesWithStyleSheetCreate);
    expect(report.totals.filesWithStyles).toBe(manifest.groundTruth.filesWithAnyStylingSignal);
    expect(manifest.files.filter((f) => f.ported).length).toBe(manifest.groundTruth.portedFiles);
    // Ownership never shrinks below the audit's live styled set.
    expect(manifest.files.length).toBeGreaterThanOrEqual(report.totals.filesWithStyles);
  });

  // ---- ported-file debt gate (P1+): zero StyleSheet, categorized nw-keep ----

  test('ported files carry zero StyleSheet refs and only categorized, justified nw-keep', () => {
    const byFile = new Map(report.files.map((f) => [f.file, f]));
    for (const entry of manifest.files.filter((f) => f.ported)) {
      const audited = byFile.get(entry.path);
      if (!audited) continue; // fully styleless AND signal-free; existence asserted above
      expect({ file: entry.path, refs: audited.styleSheetRefs }).toEqual({ file: entry.path, refs: [] });
      // Every annotation present must be a valid category with a reason.
      const invalid = audited.nwKeep.filter((k) => !k.valid);
      expect({ file: entry.path, invalid }).toEqual({ file: entry.path, invalid: [] });
      // Remaining style signals (sinks or visual color props) need at least
      // one nw-keep classification decision recorded in the file.
      if (audited.sinks.length + audited.colorProps.length > 0) {
        expect({ file: entry.path, nwKeep: audited.nwKeep.length > 0 }).toEqual({ file: entry.path, nwKeep: true });
      }
    }
  });

  // ---- evidence fixtures (AUDIT-01): in the report, owned, not debt ----

  test('evidence fixtures: audit report, allowlist and manifest agree exactly', () => {
    const reported = report.files
      .filter((f) => f.classification === 'evidence-fixture')
      .map((f) => f.file)
      .sort();
    const allowlisted = [...EVIDENCE_FIXTURES].sort();
    const owned = manifest.evidenceFixtures.map((f) => f.path).sort();
    expect(reported).toEqual(allowlisted); // every allowlisted fixture is audited (exists) and nothing else is classified
    expect(owned).toEqual(allowlisted); // every fixture has a manifest owner entry, no strays
  });

  test('evidence fixtures: exist, carry owner + reason + lifecycle', () => {
    for (const f of manifest.evidenceFixtures) {
      expect(fs.existsSync(path.join(ROOT, f.path))).toBe(true);
      expect(f.owner.length).toBeGreaterThan(0);
      expect(f.reason.length).toBeGreaterThan(10);
      expect(f.lifecycle.length).toBeGreaterThan(10);
    }
  });

  test('evidence fixtures: excluded from the production route tree and production CSS content', () => {
    // Route exclusion: expo-router only routes the production `app/` tree
    // (the harness serves the gallery from its own router root — app.config.js
    // switches roots only when PPV2_NW_GALLERY=1).
    for (const f of manifest.evidenceFixtures) {
      expect(f.path.startsWith('app/')).toBe(false);
      expect(f.path.startsWith('components/')).toBe(false);
    }
    // CSS exclusion: without PPV2_NW_GALLERY, the tailwind content list must
    // not include any harness path (prod exports never set the variable).
    const hadVar = process.env.PPV2_NW_GALLERY;
    delete process.env.PPV2_NW_GALLERY;
    delete require.cache[require.resolve(path.join(ROOT, 'tailwind.config.js'))];
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const twConfig = require(path.join(ROOT, 'tailwind.config.js')) as { content: string[] };
    if (hadVar !== undefined) process.env.PPV2_NW_GALLERY = hadVar;
    for (const f of manifest.evidenceFixtures) {
      expect(twConfig.content.some((glob) => f.path.startsWith(glob.split('/**')[0] + '/'))).toBe(false);
    }
  });

  test('evidence fixtures are excluded from debt totals but present in the report', () => {
    expect(report.totals.evidenceFixtureFiles).toBe(EVIDENCE_FIXTURES.size);
    const debtStyled = report.files.filter((f) => f.hasStyles && f.classification === 'app').length;
    expect(report.totals.filesWithStyles).toBe(debtStyled);
    // The gallery itself has StyleSheet.create halves; ensure they are not
    // counted in the 90-file ground truth.
    const fixtureCreates = report.files
      .filter((f) => f.classification === 'evidence-fixture')
      .reduce((s, f) => s + f.styleSheetCreateCount, 0);
    expect(fixtureCreates).toBeGreaterThan(0);
  });
});
