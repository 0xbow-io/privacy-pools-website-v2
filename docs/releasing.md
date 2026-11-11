# Releasing

Work lands on `dev`. `main` only moves through a release PR, and every merge of one
is tagged and published automatically.

## Cut a release

1. Branch `release/vX.Y.Z` from `dev`.
2. Bump `version` in `package.json` to `X.Y.Z`.
3. Add a `## [X.Y.Z] - YYYY-MM-DD` section at the top of `CHANGELOG.md` with the
   user-facing changes since the last release (`### Added`, `### Changed`, `### Fixed`).
4. Open the PR titled `Release vX.Y.Z` into `main` and get it reviewed.
5. Merge it. `.github/workflows/tag-release.yml` then creates tag `vX.Y.Z` on the merge
   commit and a GitHub release marked latest, with the CHANGELOG section as its notes.
6. Merge `main` back into `dev`, so `dev` carries the new version and changelog.

## Which version

Semver, from the PR titles since the last release:

- any breaking change (`feat!:`, `fix!:` or a `BREAKING CHANGE` note): major, `X+1.0.0`
- otherwise any `feat:`: minor, `X.Y+1.0`
- otherwise (`fix:`, `chore:`, `docs:`, ...): patch, `X.Y.Z+1`

## The tag workflow

- It runs on every push to `main` and by hand (`workflow_dispatch`).
- If `vX.Y.Z` for the `package.json` version already exists it does nothing, so a
  re-run or a push that did not bump the version is harmless.
- If the CHANGELOG has no notes for that version the run fails and nothing is
  published. Add the section and re-run it.
- Logic: `scripts/release/tag-release.sh`. Try it without creating anything:

  ```bash
  TAG_RELEASE_DRY_RUN=1 bash scripts/release/tag-release.sh
  ```
