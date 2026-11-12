# Reproducible static releases

Each production release gets `bundle.tar`, `site.car`, `release-manifest.json`,
`SHA256SUMS`, and `reproducibility.json` as GitHub release assets. The tar contains
`site/` (the frontend and every circuit artifact) and `release.json`. The manifest
lists every file's SHA-256, all circuit input hashes, the source commit, public
build settings, pinned tool versions, the site directory CID and the archive CID.
Neither a Git LFS pointer nor a mismatched circuit is accepted as an artifact.

The workflow follows successful `tag-release` runs because releases created by
`GITHUB_TOKEN` do not trigger another release/tag workflow. A non-release main push
is skipped. Only an existing stable tag matching the checked-out package version
and an ancestor of main can receive release assets. Existing assets are never
replaced; a rerun requires their GitHub SHA-256 digests to match.

## Reproduce

Install Git, Node, Docker and Git LFS, check out the release tag, and hydrate LFS:

```sh
git lfs pull
node scripts/release/reproducible.mjs
```

The script requires committed, clean sources. It runs **two** clean exports in
separate containers with fresh dependency installations. Linux/amd64 Node, Bun and
Kubo images are pinned by digest in `scripts/release/Dockerfile`. Dependency input
is `bun.lock`. Both exports run under `/src` with an explicit environment,
`SOURCE_DATE_EPOCH` from the source commit, normalized tar metadata and fixed IPFS
import options. Both tar files, CAR files, manifests and checksum lists must match
byte for byte before `release-out/artifacts` is produced. A difference fails the
workflow rather than publishing a reproducibility claim.

`config/release-env.json` is the complete public deployment configuration for this
self-hostable build. It uses local `/artifacts`, never Vercel's circuit offload.
Host `.env` files, Vercel environment values and Sentry upload credentials do not
enter the container. The source archive contains tracked files only. No private
build secret is necessary to reproduce it. This bundle is its own public build
profile; it does not claim byte identity with an independently built Vercel deploy.

The script uses at most 8 GiB memory and 1.8 CPUs per container and serializes both
builds. `--sudo` is available locally if Docker requires it. `--host-network` is available for hosts whose Docker bridge cannot reach npm;
it changes container networking, not build inputs. Circuit inputs may be
recovered from the configured first-party artifact host only after checking their
hashes against the Git LFS pointers. A digest mismatch stops the build.

## Verify and serve

```sh
sha256sum --check SHA256SUMS
tar -xf bundle.tar
python3 -m http.server --directory site 8080
# With Kubo installed, import and pin the complete site DAG:
ipfs dag import --pin-roots=true site.car
ipfs pin verify
```

Compare the imported root with `siteCid` in `release-manifest.json`. The CAR makes
all blocks available for independent import and pinning. A CID alone is not a
claim that a third-party node retains the content: this workflow does not have an
IPFS pinning-service credential. Release assets preserve the CAR for rehosting.
Serve the extracted site at an origin root, or use a CID subdomain gateway. A
path-prefix gateway needs its own URL rewriting. The included `404.html` provides
an SPA fallback where the host supports it. Chain interactions still require the
configured RPC/ASP/relayer services; bundling circuits does not make those offline.

## Optional on-chain attestation

`scripts/release/anchor/src/ReleaseAnchor.sol` is an append-only registry whose
immutable owner should be the approved multisig. A version can be published once
and cannot be overwritten. Its record and event bind the source commit, manifest
SHA-256 and site CID. It verifies the publisher, not the correctness of the build.

After the chain, registry and owner are agreed, compile/test that target with
Solidity 0.8.24 (no via-IR), deploy through the approved multisig process and verify
the deployed code. With repository dependencies installed (`bun install --frozen-lockfile`),
prepare a Safe Transaction Builder file offline:

```sh
node scripts/release/anchor-data.mjs release-manifest.json REGISTRY_ADDRESS CHAIN_ID anchor.json
```

This script does not sign or broadcast. Import it into the owner Safe and verify
all fields against the published manifest. No release is described as anchored
until the transaction is confirmed. No registry deployment or on-chain publication
is performed by the frontend release workflow.
