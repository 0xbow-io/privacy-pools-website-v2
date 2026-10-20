// Promote a recorded fixture STAGING set into the committed fixture set
// (GATES-01). Recording never touches the committed set directly; this step
// makes snapshot changes explicit and reviewable.
//
//   bun scripts/visual/fixtures-promote.ts --replace   # staging becomes THE set (full re-record)
//   bun scripts/visual/fixtures-promote.ts --merge     # add NEW keys only; any conflicting key aborts
//
// Any promotion changes the fixture digest, so every existing baseline is
// invalidated by design — the baseline manifest check forces a full
// recapture before the next compare.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { FIXTURE_DIR } from './config';
import { FIXTURE_STAGING_SUFFIX, fixtureSetDigest, FixtureStore } from './fixtures';

function main(): void {
  const stagingDir = FIXTURE_DIR + FIXTURE_STAGING_SUFFIX;
  const mode = process.argv.includes('--replace') ? 'replace' : process.argv.includes('--merge') ? 'merge' : null;
  if (!mode) {
    console.error('usage: fixtures-promote.ts --replace | --merge');
    process.exit(2);
  }
  if (!fs.existsSync(stagingDir)) {
    console.error(`no staging set at ${stagingDir} — record first (capture CLIs with --mode record write there)`);
    process.exit(2);
  }

  if (mode === 'replace') {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.renameSync(stagingDir, FIXTURE_DIR);
  } else {
    const live = new FixtureStore(FIXTURE_DIR);
    const staged = new FixtureStore(stagingDir);
    const conflicts: string[] = [];
    for (const key of staged.keys()) {
      const a = live.get(key);
      const b = staged.get(key)!;
      if (a && JSON.stringify(a) !== JSON.stringify(b)) conflicts.push(`${key} (${b.method} ${b.url})`);
    }
    if (conflicts.length > 0) {
      console.error('merge aborted — staged keys conflict with the committed set (different content):');
      for (const c of conflicts) console.error(`  ${c}`);
      console.error('A conflicting key means the upstream data changed: re-record the WHOLE set and promote with --replace.');
      process.exit(1);
    }
    for (const key of staged.keys()) {
      if (!live.get(key)) live.put(key, staged.get(key)!);
    }
    live.writeIndex();
    fs.rmSync(stagingDir, { recursive: true, force: true });
  }

  const digest = fixtureSetDigest(FIXTURE_DIR);
  console.log(`promoted (${mode}); fixture digest now ${digest}`);
  console.log('ALL baselines are invalidated by this change — recapture them (capture CLIs --refresh-baselines) before comparing.');
}

main();
