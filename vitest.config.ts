import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest config for the Sui web-app integration tests.
 *
 * These are LOGIC / INTEGRATION tests over the ported Sui witness + chain-reader
 * + relay layers. They run in the `node` environment (no DOM needed): every test
 * imports the REAL ported module and mocks only the chain/wallet/network boundary
 * (a fake `SuiClient`, a fake `fetch`, an in-memory `localStorage`).
 *
 * Aliases:
 *  - `@/...`        -> repo root (mirrors tsconfig `paths`), so the production
 *                      import specifiers resolve unchanged.
 *  - `react-native` -> a tiny stub exposing `Platform` (note-store uses
 *                      `Platform.OS` to gate web localStorage; the real RN
 *                      package is a native module that cannot load under node).
 */
export default defineConfig({
  resolve: {
    alias: {
      'react-native': path.resolve(__dirname, 'tests/sui/__mocks__/react-native.ts'),
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/sui/**/*.test.ts'],
    setupFiles: ['tests/sui/setup.ts'],
    // circomlibjs/snarkjs Poseidon init + LeanIMT builds are not slow, but the
    // first WASM build can take a moment; give headroom.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
