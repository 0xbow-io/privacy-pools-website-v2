// Polyfill for import.meta for Metro bundler
if (typeof globalThis.importMeta === 'undefined') {
  globalThis.importMeta = { url: 'file://' };
}
