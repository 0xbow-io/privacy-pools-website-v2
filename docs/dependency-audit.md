# Dependency audit

CI runs `bun audit --prod --audit-level=high` (`.github/workflows/dependency-audit.yml`) on every pull
request, on pushes to `main` and `dev`, and weekly. It fails on any high or critical advisory in the
production dependency tree. It reads `bun.lock`, so no install is needed.

## Fixing a finding

1. `bun audit fix` bumps vulnerable packages to the lowest safe version that still satisfies every
   dependent's range. Use `bun audit fix --dry-run` first.
2. When a dependent pins the vulnerable version exactly (`@coinbase/cdp-sdk` pins axios), add an
   `overrides` entry in `package.json` pinned to the lowest patched version in the same major, and skip a
   version the registry marks as deprecated.
3. A package we declare ourselves is pinned in `package.json` (`check:pinned-deps` wants exact versions).

Do not use `bun audit fix --latest` or an override that crosses a major without checking the dependent
still works. In a 0.x package a minor is a breaking change, so `^0.2.2` does not allow 0.3. That is why
`decode-uri-component` is an exception below and not an override: 0.3 and later are ESM-only, and
`query-string` 7 loads it with `require`.

## Exceptions

An advisory can be ignored only if it cannot be fixed without a breaking bump and either is not
reachable from our code or the reachable exposure is stated here and accepted on purpose. Its GHSA id
goes in `.bun-audit-ignore`, one per line. The ignore is by advisory id, so it hides that advisory on
every path.

| Advisories | Package | Paths | Why it is accepted | Unblocked by |
| --- | --- | --- | --- | --- |
| GHSA-5p2g-fcmc-qvqq, GHSA-w3rx-r6r6-pgpr | image-size 1.2.1 | `expo > @expo/metro-config > @expo/metro > metro > image-size`, `react-native > @react-native/community-cli-plugin > metro > image-size`, `react-native-worklets > @react-native/metro-config > metro-config > metro > image-size` | metro is the bundler and runs at build time on our own assets. The advisories are denial of service when parsing a crafted image, and no user input reaches it. Fix needs image-size 2, a major bump that metro 0.84 does not accept. | metro moving to image-size 2 |
| GHSA-qr28-fpjm-wq7f | decode-uri-component 0.2.2 | `expo-router > query-string > decode-uri-component` | A crafted URL with long runs of percent-encoded characters makes the decoder slow (quadratic), so the worst case is a hung tab for the visitor who opens that link. There is no 0.2.x patch. The fixed 0.5.1 is ESM-only and `query-string` 7 is CommonJS, so forcing it would break query parsing in the router. | `expo-router` moving to a `query-string` that uses the ESM decoder |
| GHSA-mrhx-c7xc-m3w5 | zod 3.22.4 and 3.25.76 | `@walletconnect/ethereum-provider > @reown/appkit > @reown/appkit-wallet`, `wagmi > @wagmi/connectors > @base-org/account > @coinbase/cdp-sdk`, `expo > @expo/cli`, `viem > ox > abitype`, `eslint-config-expo > eslint-plugin-react-hooks`, `@ai-sdk/anthropic`, `ai > @ai-sdk/provider-utils`, `smithers-orchestrator > incur > @modelcontextprotocol/server` | Memory exhaustion when zod validates an oversized collection. Our own zod is 4.6.6 and fixed. The wallet paths run in the visitor's browser, so the worst case is a hung tab for the user who received the input. The Expo and ESLint paths are build and lint tooling. `ai`, `@ai-sdk/anthropic` and `smithers-orchestrator` are declared but nothing under `api`, `app`, `services`, `components`, `hooks` or `config` imports them. `api/` has no zod validation. The fix is zod >= 4.6.6, a major bump of a library each of these packages pins. | those packages resolving to zod >= 4.6.6 |
