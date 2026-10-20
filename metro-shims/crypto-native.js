// Minimal Node `crypto` for native bundles: randomBytes over the global
// crypto.getRandomValues that react-native-get-random-values installs.
const { Buffer } = require('buffer');
// getRandomValues throws QuotaExceededError above 65536 bytes per call.
const MAX_CHUNK = 65536;
function randomBytes(n, cb) {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i += MAX_CHUNK) {
    globalThis.crypto.getRandomValues(out.subarray(i, Math.min(i + MAX_CHUNK, n)));
  }
  if (typeof cb === 'function') { setTimeout(() => cb(null, out), 0); return undefined; }
  return out;
}
module.exports = {
  randomBytes,
  getRandomValues: (a) => globalThis.crypto.getRandomValues(a),
  webcrypto: globalThis.crypto,
};
module.exports.default = module.exports;
