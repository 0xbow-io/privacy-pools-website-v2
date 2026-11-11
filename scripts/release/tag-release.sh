#!/usr/bin/env bash
# Tag and publish the release a merge to main just shipped.
#
# Reads the version from package.json. If tag v$VERSION already exists on the
# remote it does nothing (re-runs and unrelated pushes to main are no-ops).
# Otherwise it creates the tag and the GitHub release on $GITHUB_SHA, with that
# version's CHANGELOG.md section as the notes, and marks it latest. An empty or
# missing section fails the run: a release without notes is a mistake in the
# release PR, not something to publish. See docs/releasing.md.
#
# Env:
#   GITHUB_SHA          commit to tag (required unless dry run)
#   GH_TOKEN            token for the gh CLI (required unless dry run)
#   TAG_RELEASE_DRY_RUN 1: print what would be created, create nothing
#   TAG_RELEASE_REMOTE  remote to look the tag up on (default: origin)
#   TAG_RELEASE_ROOT    directory holding package.json and CHANGELOG.md (default: .)
set -euo pipefail

root="${TAG_RELEASE_ROOT:-.}"
remote="${TAG_RELEASE_REMOTE:-origin}"
dry_run="${TAG_RELEASE_DRY_RUN:-0}"

version="$(jq -r '.version // empty' "$root/package.json")"
if ! [[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "::error::package.json version '$version' is not X.Y.Z" >&2
  exit 1
fi
tag="v$version"

# A lookup that fails is not "no such tag": stop rather than guess.
if ! existing="$(git ls-remote --tags "$remote" "refs/tags/$tag")"; then
  echo "::error::could not list tags on $remote" >&2
  exit 1
fi
if [ -n "$existing" ]; then
  echo "$tag already exists on $remote: nothing to do"
  exit 0
fi

# The lines after "## [X.Y.Z]" up to the next "## [" heading. index() matches
# the literal heading, so the dots in the version are not regex wildcards.
notes="$(awk -v head="## [$version]" '
  index($0, head) == 1 { inside = 1; next }
  inside && /^## \[/ { exit }
  inside { print }
' "$root/CHANGELOG.md")"
if [ -z "$(printf '%s' "$notes" | tr -d '[:space:]')" ]; then
  echo "::error::CHANGELOG.md has no notes under '## [$version]'. Add them in the release PR." >&2
  exit 1
fi

if [ "$dry_run" = "1" ]; then
  echo "DRY RUN: would create $tag at ${GITHUB_SHA:-<GITHUB_SHA>} as the latest release, with notes:"
  printf '%s\n' "$notes"
  exit 0
fi

: "${GITHUB_SHA:?GITHUB_SHA is required}"
printf '%s\n' "$notes" | gh release create "$tag" --target "$GITHUB_SHA" --title "$tag" --notes-file - --latest
echo "created $tag at $GITHUB_SHA"
