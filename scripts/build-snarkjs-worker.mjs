// Pre-bundle the snarkjs worker into public/snarkjs-worker.js so the app
// can spawn it via `new Worker('/snarkjs-worker.js')`. Metro Web doesn't
// honor `new Worker(new URL(...))` the way Webpack does, so we shortcut
// the bundler and serve a self-contained worker file out of public/.
//
// Run via `bun run build:worker` (also wired into prestart / prebuild).

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const root = resolve(dirname(__filename), "..");

await build({
  entryPoints: [resolve(root, "services/snarkjs-worker.ts")],
  outfile: resolve(root, "public/snarkjs-worker.js"),
  bundle: true,
  format: "iife",            // classic worker — no ES module dance, snarkjs's
                             // own nested workers also use classic.
  platform: "browser",
  target: ["es2020"],
  minify: false,
  sourcemap: false,
  // snarkjs touches `process.browser` and `globalThis.crypto` etc.
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".wasm": "binary" },
  logLevel: "info",
});

console.log("Built public/snarkjs-worker.js");
