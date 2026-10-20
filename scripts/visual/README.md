# Deterministic visual harness (NativeWind port — phase F-A)

Ground-truth screenshot baselines of the app AS IT IS at `a10dc08` (plus the
F-A evidence tooling itself), captured **before any NativeWind/Tailwind change**,
so phases F-B…P5 have something rigorous to diff against. Protocol per
`workflows/plans/nativewind-port.md` (rev. 2).

## Prerequisites

- **Playwright is a TEMPORARY dev dependency.** Sessions add it with
  `safewrap bun add --exact playwright@1.61.1` (cached, passes
  check-pinned-deps) and run `git checkout package.json bun.lock` before their
  final commits. It is deliberately NOT a permanent dependency; the pin matches
  every prior QA session in `.pwcheck/`.
- **Pinned browser:** chromium-1228 at `<repo>/.pw-browsers/…` (copy from
  `/home/pe/newnewrepos/w/0xbow/ppv2/.pw-browsers` — it must live inside the
  repo because the safewrap sandbox only exposes the cwd).
- **Dev server** on 8081: `safewrap bun run web` (background). The `.env`
  whitelist (`SAFEWRAP_WHITELIST_PORTS=8081,8082`) is what lets that sandbox
  hold the host port — which is also why capture commands must run with
  `SAFEWRAP_WHITELIST_PORTS=8085` (any harmless value): the whitelist entry
  EXCLUDES 8081 from pasta's ns→host loopback splice, so a capture sandbox
  inheriting it cannot reach the server. Target is `127.0.0.1`, never
  `localhost` (v6 loopback isn't spliced).
- `.env` carries the F-A baseline feature flags (yield/batch/intent-swaps
  ON with placeholder deployment addresses) so the flagged
  surfaces are part of the baseline. These placeholders are baseline-only —
  the features stay dark in prod.

## Commands

```sh
# record fixtures — goes to fixtures-staging/, NEVER the committed set
SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/visual/capture.ts --mode record --out scripts/visual/.record-run
safewrap bun scripts/visual/fixtures-promote.ts --replace   # (or --merge: new keys only)

# capture baselines from fixtures (deterministic; writes baselines/manifest.json)
SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/visual/capture.ts            # → baselines/

# per-shot budget derivation (repeat-capture noise ×3, floor 50) → thresholds.json
safewrap bun scripts/visual/derive-budgets.ts --from-measured --pair <runA> <runB>

# connected modal states (headless EIP-6963 wallet)
SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/visual/capture-modals.ts --mode replay

# NativeWind compatibility gallery: needs ITS OWN dev server (harness router
# root — never a production route) + per-cell equivalence assertions
SAFEWRAP_WHITELIST_PORTS=8082 safewrap bun run web:gallery                       # server on 8082
SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/visual/capture-gallery.ts --mode replay --report <json>

# compare a candidate run against the baselines — ALL capture CLIs must feed
# the candidate dir (surface + modal + gallery shots share the baseline
# namespace, and compare fails on any baseline missing from the candidate).
# --json retains the auditable per-shot report (byte equality, changed px,
# max delta, bbox, budget, verdict).
SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/visual/capture.ts --out <candidate>
SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/visual/capture-modals.ts --out <candidate>
SAFEWRAP_WHITELIST_PORTS=8085 safewrap bun scripts/visual/capture-gallery.ts --out <candidate>
safewrap bun scripts/visual/compare.ts --candidate <candidate> --json <report.json>
```

Replay-mode fixture misses fail the capture run (exit 1): a request the
fixtures don't cover would render degraded UI behind a stable-looking
screenshot. Re-record (`--mode record` → staging → promote) when the app's
request set changes.

## Fixture/baseline integrity (GATES-01)

The F-A corpus was poisoned by a silent overwrite: a later record session
replaced shared response keys (`/assets-stats` among them) under an unchanged
`meta.json`, so the committed fixtures and the committed PNGs described
different data snapshots (visible as TVL text drift). Three mechanisms
prevent recurrence:

1. **Recording is staged** (`fixtures-staging/` + `fixtures-promote.ts`);
   duplicate-key overwrites with different content THROW unless
   `PPV2_FIXTURES_ALLOW_OVERWRITE=1`.
2. **Baselines record their fixture digest** (`baselines/manifest.json`,
   written by the capture CLIs; a digest-mixing partial refresh is refused
   without `--refresh-baselines`).
3. **compare.ts fails closed on digest mismatch** — a comparison across
   different data snapshots can't silently pass again.

`capture-*.ts` without `--out` overwrite the ground-truth baselines — only do
that when intentionally regenerating them (and say so with
`--refresh-baselines` if fixtures changed).

## Determinism measures (each one exists for a reason)

| Measure | Why |
| --- | --- |
| Fixed viewports 1440×1400 + 390×844, DPR 1, locale en-US, TZ UTC, `--force-color-profile=srgb` | render geometry + color repeatability |
| Fresh context per shot | no storage/cache bleed between sets |
| `ppv2_smartwallet_skipped_v1=1` seed | no onboarding overlay |
| `ppv2_freeze_motion=1` seed | app-side hook in `components/home/liquid-light.tsx` — the ONLY app-code test hook: drift loops hold their start pose, the fade jumps to target. Everything else was verified loop-free on public surfaces |
| CSS `animation: none; transition: none; caret-color: transparent` injection | CSS-driven motion resets to its base state (`paused` would freeze at a random phase); no text caret in inputs |
| `document.fonts.ready` + surface marker + stable-screenshot loop (N identical consecutive frames) | no capture until fonts, data and entrance animations settle |
| **Network fixtures** (`fixtures/`): every non-localhost request recorded once, replayed forever; unknown requests during replay are ABORTED and counted | the public surfaces render from the live ASP feed — replay freezes that data. No masks needed anywhere (zero masked regions) |
| **Frozen wall clock in replay**: `Date.now`/`new Date()` pinned to the fixture recording moment (`fixtures/meta.json`); `performance.now()`/rAF untouched | relative-time labels ("2h ago") on home/activity are computed against frozen data and must not drift between runs |
| JSON-RPC `id` normalization in fixture keys + response-id realignment | viem's incrementing request ids would otherwise defeat fixture matching |

## Threshold policy (`thresholds.json`)

Measured, per shot. `calibrate.ts` captures each surface `--runs` times
unchanged (fresh context each run) and diffs consecutive runs per pixel;
`derive-budgets.ts` turns measured repeat-capture noise into PER-SHOT budgets
(`perShot`: observed max × 3, floor 50 — sources recorded in
`perShotSources`) for every namespace (surfaces from the F-A calibration,
modals/gallery from dedicated repeat runs). Shots without a calibrated entry
are held to `policy.defaultBudget` (the strict floor), never a global
worst-case number. A "0 changed px" result means zero pixels exceeded
`perChannelTolerance` (10) — compare.ts additionally records true byte
equality per shot (sha256) in its `--json` report.

## What is captured

- `baselines/v{0..4}-{light,dark}-<surface>-{desktop,narrow}.png` — the 10
  web sets × public surfaces: `home`, `pool-detail` (/chains/sepolia/eth),
  `portfolio`, `ecosystem`, `payroll`, and the three vault drawers
  (`/?panel=balances|pools|activity`, variants 1-4 only — the classic home has
  no drawers by design; its home IS the pools list, and the
  payment-requests widget area is part of the classic home/pool surfaces).
- `baselines/v{0,1}-{light,dark}-modal-*.png` — connect picker + money-modal
  states (input/filled/review where reachable) via the headless EIP-6963
  wallet, desktop only. Variants 2-4 share the vault modal structure with v1;
  they are deliberately not duplicated at the modal level.
  `baselines/modal-capture-log.json` records per-shot status including every
  honest `not-capturable` (e.g. states needing on-chain txs — the harness
  wallet hard-rejects `eth_sendTransaction`).
- `baselines/nw-gallery-{main,modal,animreg}-desktop.png` — the NativeWind
  compatibility gallery (F-B evidence fixture) from the harness gallery
  server: default load (no Animated registration), RN-Modal-open, and the
  `?animReg=1` startup-registration load. Web-verified only — native remains
  blocked by the vendored SDK's fs/promises native-export failure.

### Known not-capturable in F-A (documented, not hidden)

- Money-modal states beyond review (proving/relaying/success/error) — they
  require real on-chain transactions.
- Native (iOS/Android) screenshots — no simulator/emulator in this
  environment; F-A records native bundle sizes only (see perf-baseline.json).
- Below-the-fold content on long surfaces: RN-Web scroll containers scroll
  internally, so viewport captures show the initial fold only. The 1400px
  desktop viewport covers most surfaces fully.

## Perf baselines

`perf-baseline.ts` → `perf-baseline.json`: prod web export asset sizes
(raw+gzip), env-inlining check, iOS/Android export bundle sizes (when the
exports run in this environment), and Playwright-timed startup + modal-open
latency (5 runs, medians).
