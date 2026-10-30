# Circuit artifact hosting

`public/artifacts` (the `.wasm` and `.zkey` files, about 1.2 GB, git lfs) is not deployed with the app.
It lives in its own Vercel project, `privacy-pools-artifacts`, under `/artifacts/<version>/`.

- **Version** is 12 hex chars of a sha256 over every file's path and content hash
  (`scripts/artifacts-version.mjs`). It works on an lfs pointer checkout too, so a build never needs the 1.2 GB.
- **App build on Vercel** sets `EXPO_PUBLIC_ARTIFACTS_VERSION`, the app reads
  `/artifacts/<version>/...` (`config/artifacts.ts`), and `scripts/artifacts-offload.mjs` checks the
  artifacts project serves that version, then removes `dist/artifacts`. If the version is not
  published the build fails, so nothing can go live pointing at missing files.
- **Main project** rewrites `/artifacts/:version/:path*` to the artifacts project (`vercel.json`), so the
  browser stays on the app's own origin: no new third party sees the user's IP, CSP and egress policy are unchanged.
  The URL carries the version, so the response is `immutable, max-age=1 year`.
- **Local dev and e2e** leave the version empty and read the flat `/artifacts/...` that `public/` serves.

## When a circuit changes

1. Commit the new files (lfs).
2. `bun scripts/deploy-artifacts.mjs` publishes the new version to the artifacts project. Do this BEFORE the app build.
3. Merge the app change. A tab still open on the old version gets a 404 on its next proof until it reloads.

Nothing else is needed: the version is derived, never edited by hand.
