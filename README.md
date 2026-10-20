# Privacy Pools V2 Website

Expo / React Native Web app for Privacy Pools V2, exported as a static SPA
for Vercel.

## Prerequisites

- Bun
- A Sepolia wallet for testnet flows

## Setup

Copy the environment template and fill in the required ASP URL:

```bash
cp .env.example .env
bun install
```

`EXPO_PUBLIC_ASP_URL` is required; the app throws at startup without it.
`EXPO_PUBLIC_ALCHEMY_KEY` is optional, otherwise public RPC URLs are used.
Advanced Sepolia contract overrides are available through the
`EXPO_PUBLIC_SEPOLIA_*` variables documented in `.env.example`.

## Develop

Start Expo web:

```bash
bun run web
```

The `preweb` hook builds the proving workers before Expo starts. Use
`bun run start` if you want the generic Expo dev menu instead.

## Quality Gates

```bash
bun run lint
bun run typecheck
bun run test
bun run test:sui
```

## Build And Deploy

Production export matches the Vercel build command:

```bash
bun run build:web
```

The static output is written to `dist/`. Vercel deploys pushes to `main` to
production.

## Architecture Pointers

- `app/` contains expo-router routes.
- `components/` contains the modal providers and main money-flow UI.
- `services/` contains SDK orchestration, local stores, codecs, and API clients.
- `config/` contains chain, token, relayer, and environment configuration.
- `public/artifacts/` serves Groth16 circuit artifacts same-origin for proving.
- `vendor/` contains the vendored Privacy Pools V2 SDK tarball used by Vercel.

For deployment source-of-truth and local SDK divergence, read `CLAUDE.md`,
`SDK_PATCHES.md`, and `SDK_CUSTOM_CHANGES.md`.

## Docs

- `CLAUDE.md` has the current repo-specific operating notes.
- `AGENTS.md` has agent hygiene rules for this repo.
- `docs/` contains supporting design and integration notes.
