# Circuit artifact hosting and build modes

`public/artifacts` (the `.wasm` and `.zkey` files, about 1.2 GB, git lfs) is not deployed with the app.
It lives in its own Vercel project, `privacy-pools-artifacts`, under `/artifacts/<version>/`.

- **Version** is 12 hex chars of a sha256 over every file's path and content hash
  (`scripts/artifacts-version.mjs`). It works on an lfs pointer checkout too, so a build never needs the 1.2 GB.
- **Origin** is `EXPO_PUBLIC_ARTIFACTS_ORIGIN`, default `config/artifacts-origin.json`
  (https only, anything else falls back to the default). It is `https://artifacts.privacypools.com`, a first-party subdomain attached to the `privacy-pools-artifacts` Vercel project.
- **App build on Vercel** sets `EXPO_PUBLIC_ARTIFACTS_VERSION`, the app reads
  `<origin>/artifacts/<version>/...` directly (`config/artifacts.ts`), and `scripts/artifacts-offload.mjs`
  checks the artifacts project serves that version, then removes `dist/artifacts`. If the version is not
  published the build fails, so nothing can go live pointing at missing files.
  The browser therefore contacts the artifacts origin, a first-party subdomain served by the same operator as the app.
  Responses are `immutable, max-age=1 year` with `Access-Control-Allow-Origin: *`.
- **Local dev and e2e** leave the version empty and read the flat `/artifacts/...` that `public/` serves.
- **A 404 on a versioned file** means the tab is older than the deployed circuits: the loader reports it
  (`services/stale-assets.ts`), a toast says "The app was updated. Reload the page to continue." and the failed
  proof says the same.

## Publishing is additive

`node scripts/deploy-artifacts.mjs` (node, not safewrap bun: it needs the network) publishes the version of the
checked-out files. A deploy of the artifacts project replaces its whole production deployment, so the script
stages every version still in use: it reads `/artifacts/manifests.json` (version to path to sha256) from the live
project, adds the new version, keeps the newest 8, stores each distinct file once as `/blobs/<sha256>` and
rewrites `/artifacts/<version>/<path>` onto it. A circuit change only uploads the files that changed. Older
blobs the checkout no longer has are downloaded from the live project and verified against their hash.

## When a circuit changes

1. Commit the new files (lfs).
2. `node scripts/deploy-artifacts.mjs`. The live app, a rollback and open PRs keep their version.
3. Merge the app change. A tab left open across the change gets the reload toast on its next proof.

## Build modes (`scripts/build-web.mjs`, `scripts/build-mode.mjs`)

- **fast**: Vercel `preview` and `development` deployments (every PR, the dev branch). No graph optimization,
  tree shaking, minification or source maps: the bundle is bigger and slower to load, the build about 4 minutes shorter.
- **full**: production on Vercel, and every local or CI build. An unknown or missing `VERCEL_ENV` is full.
- **both modes** also skip the 1.2 GB of artifacts and reuse Metro's transform cache (`metro.config.js`, folder
  named after a hash of the inlined `EXPO_PUBLIC_*` values so an env edit starts a cold cache), neither of which
  changes the output.
