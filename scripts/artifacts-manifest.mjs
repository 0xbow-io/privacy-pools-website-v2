// Pure helpers for scripts/deploy-artifacts.mjs: which versions the artifacts
// project serves, and how each versioned path maps to a stored file.
//
// Publishing is ADDITIVE. A deploy of the artifacts project replaces its whole
// production deployment, so every version still in use has to be in the new one:
// the live app, a rollback target and any open PR keep asking for their old
// version while a new one goes out. Files are stored once by content hash
// (/blobs/<sha256>), a circuit change only adds the files that changed, and
// /artifacts/<version>/<path> is a rewrite onto the blob.

/** How many versions stay served. 93 rewrites each, far under Vercel's 2048 routes. */
export const KEEP_VERSIONS = 8;

/** Pure: existing is { version: { path: sha } }; the new version goes last, the oldest fall off. */
export function mergeManifests(existing, version, files, keep = KEEP_VERSIONS) {
  const next = { ...existing };
  delete next[version];
  next[version] = files;
  const versions = Object.keys(next);
  for (const old of versions.slice(0, Math.max(0, versions.length - keep))) delete next[old];
  return next;
}

/** Pure: every blob some kept version points at. */
export function blobShas(manifests) {
  const shas = new Set();
  for (const files of Object.values(manifests)) for (const sha of Object.values(files)) shas.add(sha);
  return shas;
}

/** Pure: one rewrite per versioned path, onto the stored blob. */
export function rewritesFor(manifests) {
  const rules = [];
  for (const [version, files] of Object.entries(manifests)) {
    for (const [path, sha] of Object.entries(files)) {
      rules.push({ source: `/artifacts/${version}/${path}`, destination: `/blobs/${sha}` });
    }
  }
  return rules;
}

const IMMUTABLE = [
  { key: 'Cache-Control', value: 'public, max-age=31536000, immutable' },
  { key: 'Access-Control-Allow-Origin', value: '*' },
];

/** Pure: the artifacts project's vercel.json for these manifests. */
export function artifactsVercelConfig(manifests) {
  return {
    cleanUrls: false,
    rewrites: rewritesFor(manifests),
    headers: [
      { source: '/blobs/:sha', headers: IMMUTABLE },
      { source: '/artifacts/:version([0-9a-f]{12})/:path*', headers: IMMUTABLE },
      // The list of versions is the one mutable file: never cached.
      {
        source: '/artifacts/manifests.json',
        headers: [
          { key: 'Cache-Control', value: 'public, max-age=0, must-revalidate' },
          { key: 'Access-Control-Allow-Origin', value: '*' },
        ],
      },
    ],
  };
}
