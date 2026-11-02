# Agent instructions

## Run the dependency audit before you commit

CI has a `Dependency audit` workflow that fails the pull request on a high or critical advisory in the
production dependency tree. Run the same check locally before every commit that touches
`package.json` or `bun.lock`, so CI does not block you. It reads `bun.lock`, so it takes seconds:

```bash
bun audit --prod --audit-level=high $(sed -E 's/#.*//; s/[[:space:]]+//g; /^$/d; s/^/--ignore=/' .bun-audit-ignore | tr '\n' ' ')
```

If it fails:

1. Run `bun audit fix --dry-run`, then `bun audit fix`. It moves a vulnerable package to the lowest safe
   version that still satisfies every dependent's range. Add an `overrides` entry in `package.json` only
   when a dependent pins the vulnerable version exactly.
2. Do not add an id to `.bun-audit-ignore` without a written reason in `docs/dependency-audit.md`.
3. Do not use `bun audit fix --latest` or an override that crosses a major without checking the
   dependent still works. In a 0.x package a minor is breaking, and a newer release can be ESM-only for a
   CommonJS consumer (`decode-uri-component` 0.3 and later under `query-string` 7).
4. Declared packages stay pinned to exact versions (`bun run check:pinned-deps`).

Run it again after you add or bump any dependency.
