#!/usr/bin/env bash
# Builds @privacy-pools-v2/stellar-sdk from a v2-monorepo checkout and vendors it
# into ./vendor as a tarball, the same way the EVM SDK is vendored.
#
# Mirrors .github/workflows/stellar-sdk-pre-release.yml in v2-monorepo:
# tsup with core-sdk bundled (noExternal), then a prerelease version, then pack.
# The monorepo checkout is never modified: packaging happens in a temp dir.
#
#   scripts/stellar/build-stellar-sdk.sh [path-to-v2-monorepo]
set -euo pipefail

# Default: the branch with the Stellar SDK fixes (v2-monorepo mike/stellar-sdk-fixes, off v2.0).
MONO="${1:-$HOME/Claude/v2-monorepo-stellar-fixes}"
# Absolute, so node's require() below treats it as a path (a bare relative
# argument like ../v2-monorepo would otherwise resolve as a module name).
MONO="$(cd "$MONO" && pwd)"
WEB="$(cd "$(dirname "$0")/../.." && pwd)"
PKG="$MONO/packages/stellar-sdk"

SHA="$(git -C "$MONO" rev-parse --short=8 HEAD)"
echo "v2-monorepo @ $SHA ($(git -C "$MONO" log -1 --format=%s))"
# Every build input, not just src: the manifests and the tsup config shape the
# tarball too, and a dirty one would ship under a HEAD SHA it does not match.
BUILD_INPUTS=(
  packages/stellar-sdk/src packages/stellar-sdk/package.json packages/stellar-sdk/tsup.prerelease.config.ts
  packages/core-sdk/src packages/core-sdk/package.json
)
if ! git -C "$MONO" diff --quiet HEAD -- "${BUILD_INPUTS[@]}" \
  || [ -n "$(git -C "$MONO" ls-files --others --exclude-standard -- "${BUILD_INPUTS[@]}")" ]; then
  echo "refusing: uncommitted changes in the SDK build inputs (${BUILD_INPUTS[*]})" >&2
  exit 1
fi

# core-sdk's dist is what tsup inlines.
(cd "$MONO/packages/core-sdk" && pnpm build)

# core-sdk's OWN dependencies stay external (the CI prerelease config inlines
# them, which bakes the Node builds of snarkjs/circomlibjs/pino, with
# worker_threads/vm/fs, into the bundle). External, the app resolves their
# browser builds exactly as it does for the EVM SDK.
CORE_DEPS="$(node -e '
  const d = require(process.argv[1]).dependencies;
  console.log(Object.keys(d).filter((n) => !d[n].startsWith("workspace:")).join(" "));
' "$MONO/packages/core-sdk/package.json")"
EXTERNAL_FLAGS=()
for dep in $CORE_DEPS; do EXTERNAL_FLAGS+=(--external "$dep"); done
# --dts-resolve inlines core-sdk's types too: the tarball ships no core-sdk.
(cd "$PKG" && npx tsup --config tsup.prerelease.config.ts --dts-resolve "${EXTERNAL_FLAGS[@]}")

STAGE="$(mktemp -d)"
cp -R "$PKG/dist" "$STAGE/dist"
# The JS inlines core-sdk, but its .d.ts only re-exports from
# "@privacy-pools-v2/core-sdk", which the tarball does not ship. Ship
# core-sdk's own declarations beside it and point the re-export there.
mkdir -p "$STAGE/dist/core-sdk"
cp "$MONO"/packages/core-sdk/dist/*.d.ts "$MONO"/packages/core-sdk/dist/*.d.cts "$STAGE/dist/core-sdk/"
sed -i.bak "s#'@privacy-pools-v2/core-sdk'#'./core-sdk/index.js'#g" "$STAGE/dist/index.d.ts"
sed -i.bak "s#'@privacy-pools-v2/core-sdk'#'./core-sdk/index.cjs'#g" "$STAGE/dist/index.d.cts"
find "$STAGE/dist" -name '*.bak' -delete
cp "$PKG/package.json" "$STAGE/package.json"
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  p.version = `${p.version}-prerelease.${process.argv[2]}`;
  delete p.private;
  delete p.devDependencies;
  delete p.scripts;
  if (p.dependencies) delete p.dependencies["@privacy-pools-v2/core-sdk"];
  // The externalised core-sdk deps become dependencies of this package.
  const core = JSON.parse(fs.readFileSync(process.argv[3], "utf8")).dependencies;
  for (const [name, range] of Object.entries(core)) {
    if (!range.startsWith("workspace:")) p.dependencies[name] = range;
  }
  fs.writeFileSync(process.argv[1], JSON.stringify(p, null, 2) + "\n");
' "$STAGE/package.json" "$SHA" "$MONO/packages/core-sdk/package.json"

(cd "$STAGE" && pnpm pack --pack-destination "$WEB/vendor" >/dev/null)
echo "vendored: $(ls "$WEB"/vendor/privacy-pools-v2-stellar-sdk-*"$SHA"*.tgz)"
