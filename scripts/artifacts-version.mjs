// Content version of public/artifacts: 12 hex chars of a sha256 over every
// file's relative path and content hash, sorted.
//
// The version is part of the served URL (/artifacts/<version>/...) so the files
// can be cached forever: a changed circuit changes the version, so a URL never
// points at two different files.
//
// The artifacts are git-lfs objects. A checkout that skipped lfs holds small
// pointer files whose `oid sha256:` line IS the sha256 of the real content, so
// both checkouts produce the same version without needing the 1.2 GB.
//
//   bun scripts/artifacts-version.mjs          prints the version
//   bun scripts/artifacts-version.mjs --vercel prints it only when VERCEL is set
//                                              (local dev stays on flat /artifacts)
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const POINTER_HEAD = 'version https://git-lfs.github.com/spec/v1';

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
  });
}

/** sha256 of a file's real content, read from the lfs pointer when that is all there is. */
export async function contentSha256(path) {
  if (statSync(path).size < 200) {
    const text = readFileSync(path, 'utf8');
    if (text.startsWith(POINTER_HEAD)) {
      const match = text.match(/^oid sha256:([0-9a-f]{64})$/m);
      if (match) return match[1];
    }
  }
  return sha256File(path);
}

/** Pure: the version for a list of [relativePath, sha256] pairs. */
export function versionFromEntries(entries) {
  const lines = [...entries].map(([path, sha]) => `${path}:${sha}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 12);
}

/** Every file under dir as [relativePath, sha256], sorted by path. Empty when dir is missing. */
export async function collectArtifactEntries(dir) {
  if (!existsSync(dir)) return [];
  const entries = [];
  for (const file of walk(dir).sort()) {
    entries.push([relative(dir, file).split(sep).join('/'), await contentSha256(file)]);
  }
  return entries;
}

export async function computeArtifactsVersion(dir) {
  const entries = await collectArtifactEntries(dir);
  return entries.length > 0 ? versionFromEntries(entries) : '';
}

if (import.meta.main) {
  const dir = new URL('../public/artifacts', import.meta.url).pathname;
  if (process.argv.includes('--vercel') && !process.env.VERCEL) {
    process.stdout.write('');
  } else {
    process.stdout.write(await computeArtifactsVersion(dir));
  }
}
