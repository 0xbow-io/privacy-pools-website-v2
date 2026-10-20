// The prod web build tree shakes ESM. @walletconnect/jsonrpc-utils' ESM env.js
// re-exports isReactNative with `export * from "@walletconnect/environment"`,
// and its only reader (jsonrpc-ws-connection) uses a CommonJS require, so the
// re-export was dropped and every WalletConnect connect hung. metro.config.js
// resolves these packages to their CommonJS builds on web. This pins that.
import { describe, expect, test } from 'bun:test';
import fs from 'fs';
import path from 'path';

const root = path.resolve(__dirname, '..', '..');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const config = require(path.join(root, 'metro.config.js'));

type Ctx = { mainFields?: string[]; unstable_conditionNames?: string[] };

function resolveWith(moduleName: string, platform: string): Ctx | null {
  let seen: Ctx | null = null;
  const context = {
    originModulePath: path.join(root, 'node_modules/@walletconnect/jsonrpc-ws-connection/dist/index.es.js'),
    mainFields: ['browser', 'module', 'main'],
    unstable_conditionNames: ['import', 'default'],
    unstable_conditionsByPlatform: { web: ['browser'] },
    resolveRequest: (ctx: Ctx) => {
      seen = ctx;
      return { type: 'empty' };
    },
  };
  config.resolver.resolveRequest(context, moduleName, platform);
  return seen;
}

describe('metro resolves WalletConnect env packages to CommonJS on web', () => {
  for (const pkg of ['@walletconnect/jsonrpc-utils', '@walletconnect/environment']) {
    test(pkg, () => {
      const ctx = resolveWith(pkg, 'web');
      expect(ctx?.mainFields).toEqual(['main']);
      expect(ctx?.unstable_conditionNames).not.toContain('import');

      // What "main" points at must be the CommonJS build.
      const pkgDir = path.join(root, 'node_modules', pkg);
      const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
      expect(manifest.exports).toBeUndefined();
      const entry = fs.readFileSync(path.join(pkgDir, manifest.main), 'utf8');
      expect(entry).toMatch(/exports|require\(/);
      expect(entry).not.toMatch(/^\s*export\s/m);
    });
  }

  test('the CommonJS env module still re-exports isReactNative', () => {
    const env = fs.readFileSync(
      path.join(root, 'node_modules/@walletconnect/jsonrpc-utils/dist/cjs/env.js'),
      'utf8',
    );
    expect(env).toContain('__exportStar(require("@walletconnect/environment")');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const utils = require(path.join(root, 'node_modules/@walletconnect/jsonrpc-utils/dist/cjs/index.js'));
    expect(typeof utils.isReactNative).toBe('function');
  });
});
