// Pre-bundle the witness-preparation worker into public/witness-worker.js
// so the app can spawn it via `new Worker('/witness-worker.js')`. Same
// rationale as build-snarkjs-worker.mjs — Metro Web doesn't honor
// `new Worker(new URL(...))` the way Webpack does, so we shortcut the
// bundler and serve a self-contained classic worker out of public/.
//
// Run via `bun run build:witness-worker` (also wired into prestart /
// prebuild / preweb).

import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const root = resolve(dirname(__filename), "..");

// circomlibjs (transitive dep of the SDK's witness builder) imports
// `assert`, and a few transitive deps reach for `events`/`stream`/`util`.
// In a worker context those Node-only modules don't exist, so we map
// them to browser-friendly stubs via a virtual-module plugin. The
// shimmed surface is the small slice the SDK actually exercises:
// `assert(cond, msg)` calls and `EventEmitter` instances. Anything
// beyond that throws, which is fine — the witness path doesn't go there.
const nodeShimPlugin = {
  name: "node-shim",
  setup(buildCtx) {
    const stubs = {
      assert: `
        function assert(cond, msg) { if (!cond) throw new Error(msg || "Assertion failed"); }
        assert.equal = function(a, b, msg) { if (a !== b) throw new Error(msg || a + " !== " + b); };
        assert.notEqual = function(a, b, msg) { if (a === b) throw new Error(msg || a + " === " + b); };
        assert.deepEqual = assert.equal;
        assert.ok = function(v, msg) { if (!v) throw new Error(msg || "Assertion failed"); };
        export default assert;
        export { assert };
      `,
      events: `
        export class EventEmitter {
          constructor() { this._listeners = {}; }
          on(event, fn) { (this._listeners[event] ??= []).push(fn); return this; }
          off(event, fn) {
            this._listeners[event] = (this._listeners[event] || []).filter((f) => f !== fn);
            return this;
          }
          emit(event, ...args) {
            (this._listeners[event] || []).slice().forEach((fn) => fn(...args));
            return true;
          }
          removeListener(event, fn) { return this.off(event, fn); }
          removeAllListeners(event) {
            if (event) delete this._listeners[event]; else this._listeners = {};
            return this;
          }
          once(event, fn) {
            const wrap = (...args) => { this.off(event, wrap); fn(...args); };
            return this.on(event, wrap);
          }
          listenerCount(event) { return (this._listeners[event] || []).length; }
        }
        export default EventEmitter;
      `,
      stream: `
        export { EventEmitter as Readable } from 'events';
        export { EventEmitter as Writable } from 'events';
        export { EventEmitter as Stream } from 'events';
        export { EventEmitter as default } from 'events';
      `,
      util: `
        export function inherits(ctor, superCtor) {
          ctor.super_ = superCtor;
          Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
        }
        export function inspect(v) { try { return JSON.stringify(v); } catch { return String(v); } }
        export function format(...args) { return args.map(String).join(" "); }
        export default { inherits, inspect, format };
      `,
      // Pulled in transitively by SDK FileStorageService — never reached
      // from the witness path, so a throwing stub is safe.
      "fs/promises": `
        const noop = () => Promise.reject(new Error("fs/promises not available in worker"));
        export const readFile = noop;
        export const writeFile = noop;
        export const mkdir = noop;
        export const access = noop;
        export const stat = noop;
        export const unlink = noop;
        export const rm = noop;
        export const rename = noop;
        export const copyFile = noop;
        export const readdir = noop;
        export const rmdir = noop;
        export const open = noop;
        export const chmod = noop;
        export const chown = noop;
        export const lstat = noop;
        export const realpath = noop;
        export const symlink = noop;
        export const truncate = noop;
        export const utimes = noop;
        export default {
          readFile, writeFile, mkdir, access, stat, unlink, rm, rename,
          copyFile, readdir, rmdir, open, chmod, chown, lstat, realpath,
          symlink, truncate, utimes,
        };
      `,
      // Also from FileStorageService (temp file names) since the core-sdk
      // split; never reached from the witness path. Web Crypto has the same
      // function, so the stub is the real thing where it exists.
      crypto: `
        export const randomUUID = () => globalThis.crypto.randomUUID();
        export default { randomUUID };
      `,
      path: `
        export function join(...parts) { return parts.filter(Boolean).join("/"); }
        export function resolve(...parts) { return join(...parts); }
        export function dirname(p) { return p.split("/").slice(0, -1).join("/") || "/"; }
        export function basename(p) { return p.split("/").pop() || ""; }
        export function extname(p) {
          const b = basename(p);
          const i = b.lastIndexOf(".");
          return i > 0 ? b.slice(i) : "";
        }
        export const sep = "/";
        export default { join, resolve, dirname, basename, extname, sep };
      `,
    };
    for (const name of Object.keys(stubs)) {
      buildCtx.onResolve({ filter: new RegExp(`^${name}$`) }, () => ({
        path: name,
        namespace: "node-shim",
      }));
    }
    buildCtx.onLoad({ filter: /.*/, namespace: "node-shim" }, (args) => ({
      contents: stubs[args.path],
      loader: "js",
    }));
  },
};

// Pre-bundle the Buffer polyfill into an IIFE that assigns
// globalThis.Buffer at the top of the worker bundle, BEFORE any module
// init runs. circomlibjs (transitive dep) calls `Buffer.from(...)` at
// module-load time, so a normal `import { Buffer } from "buffer"` at
// the top of witness-worker.ts is too late — ESM hoists imports but
// runs CJS module bodies in dependency order, and circomlibjs's body
// runs before the entry's body. The banner trick is the only reliable
// way to get the polyfill in place first.
const bufferShim = await build({
  stdin: {
    contents: `import { Buffer } from "buffer";\nglobalThis.Buffer = globalThis.Buffer || Buffer;`,
    loader: "js",
    resolveDir: root,
  },
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  write: false,
});
const bannerJs = bufferShim.outputFiles[0].text;

await build({
  entryPoints: [resolve(root, "services/witness-worker.ts"), resolve(root, "services/association-set-worker.ts")],
  outdir: resolve(root, "public"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  sourcemap: false,
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".wasm": "binary" },
  plugins: [nodeShimPlugin],
  banner: { js: bannerJs },
  logLevel: "info",
});

console.log("Built public/witness-worker.js and public/association-set-worker.js");
