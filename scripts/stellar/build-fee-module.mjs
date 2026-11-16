// Isolate the pinned SDK's public fee helpers without its proving/wallet imports.
// Source contents are unchanged; only the SDK's broad internal barrel is narrowed.
import { build } from 'esbuild';
import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const sdk = path.join(root, 'node_modules/@privacy-pools-v2/stellar-sdk');
const map = JSON.parse(await readFile(path.join(sdk, 'dist/index.js.map'), 'utf8'));
const sources = new Map(map.sources.map((name, i) => [path.posix.normalize(name), map.sourcesContent[i]]));
const modules = [
  '../src/utils/StellarResourceFee.ts', '../src/utils/StellarRelayPricing.ts',
  '../src/constant/stellarRelayResources.ts', '../src/utils/StellarU32.ts',
  '../src/utils/StellarPreflightSnapshotGap.ts', '../src/utils/StellarErrorMessage.ts',
  '../src/errors/StellarRPCInteractor.ts', '../src/errors/StellarRelayPricing.ts', '../src/errors/StellarValue.ts',
  '../../core-sdk/src/utils/sleep.ts', '../../core-sdk/src/errors/Timer.ts', '../../core-sdk/src/schemas/HTTPClient.ts',
];
const names = 'readStellarFeeSettings, stellarRelayResourceFee, stellarRelayResources, STELLAR_RELAY_RESOURCE_TABLE';
const result = await build({
  stdin: { contents: `export { ${names} } from "internal";`, resolveDir: root },
  bundle: true, format: 'esm', platform: 'browser', write: false, metafile: true,
  // Keep generated code compact but readable; the table accounts for most bytes.
  minifySyntax: true,
  plugins: [{ name: 'pinned-sdk-sources', setup(b) {
    b.onResolve({ filter: /^(internal|.*\/internal\.js)$/ }, () => ({ path: 'internal', namespace: 'sdk' }));
    b.onResolve({ filter: /.*/ }, a => {
      if (a.path.startsWith('@') || a.path === 'zod') return { path: a.path, external: true };
      let p = a.importer === 'internal' ? a.path : path.posix.join(path.posix.dirname(a.importer), a.path);
      p = path.posix.normalize(p.replace(/\.js$/, '.ts'));
      if (!sources.has(p)) throw new Error(`Missing pinned SDK source: ${p}`);
      return { path: p, namespace: 'sdk' };
    });
    b.onLoad({ filter: /.*/, namespace: 'sdk' }, a => ({
      contents: a.path === 'internal' ? modules.map(p => `export * from ${JSON.stringify(p)};`).join('\n') : sources.get(a.path),
      loader: a.path.endsWith('.json') ? 'json' : 'ts',
    }));
  } }],
});
const imports = [...new Set(Object.values(result.metafile.outputs).flatMap(o => o.imports.map(i => i.path)))];
if (imports.some(p => !['@stellar/stellar-sdk', 'zod'].includes(p))) throw new Error(`Unexpected runtime imports: ${imports}`);
const version = JSON.parse(await readFile(path.join(sdk, 'package.json'), 'utf8')).version;
const output = `// GENERATED from @privacy-pools-v2/stellar-sdk ${version}.\n// Regenerate: bun scripts/stellar/build-fee-module.mjs. See README.md.\n${result.outputFiles[0].text}`;
const target = path.join(root, 'vendor/stellar-fees/index.js');
if (process.argv.includes('--check')) {
  if (await readFile(target, 'utf8') !== output) throw new Error('Stellar fee module differs from the pinned SDK; regenerate it.');
} else await writeFile(target, output);
console.log(`Stellar fee module: ${Buffer.byteLength(output)} bytes; runtime imports: ${imports.join(', ')}`);
