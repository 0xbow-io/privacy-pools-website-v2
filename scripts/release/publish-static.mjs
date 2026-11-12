// Never replace an existing release asset. Re-runs require matching GitHub digests.
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { sha256, verifyReleaseOutputs } from './static-files.mjs';
const repo = process.env.GH_REPO, tag = process.env.RELEASE_TAG;
if (!/^0xbow-io\/[a-zA-Z0-9_.-]+$/.test(repo ?? '') || !/^v\d+\.\d+\.\d+$/.test(tag ?? '')) throw new Error('Expected 0xbow release repository and semver tag');
const gh = args => execFileSync('gh', args, { encoding: 'utf8' });
const release = JSON.parse(gh(['api', `repos/${repo}/releases/tags/${tag}`]));
if (release.draft || release.prerelease) throw new Error('Only published stable releases get production bundles');
const dir = 'release-out/artifacts';
const { proof, manifest } = await verifyReleaseOutputs(dir);
const tagged = gh(['api', `repos/${repo}/commits/${tag}`, '--jq', '.sha']).trim();
if (proof.independentBuilds !== 2 || proof.commit !== tagged || manifest.commit !== tagged || tag !== `v${manifest.version}` || proof.manifestSha256 !== await sha256(join(dir, 'release-manifest.json'))) throw new Error('Release tag and verified build do not match');
for (const name of ['bundle.tar', 'site.car', 'release-manifest.json', 'SHA256SUMS', 'reproducibility.json']) {
  const path = join(dir, name), digest = `sha256:${await sha256(path)}`;
  const existing = release.assets.find(a => a.name === name);
  if (existing) {
    if (existing.digest !== digest) throw new Error(`Refusing to replace release asset: ${name}`);
    continue;
  }
  gh(['release', 'upload', tag, path, '--repo', repo]);
}
