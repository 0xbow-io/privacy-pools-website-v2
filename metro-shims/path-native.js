// Minimal `path` for native bundles. The SDK imports join/dirname for its
// Node-only artifact cache, which never runs on device. Web gets its own stub.
function normalizeParts(parts) {
  const out = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return out;
}
function join(...segs) {
  const s = segs.filter(Boolean).join('/');
  const abs = s.startsWith('/');
  const joined = normalizeParts(s.split('/')).join('/');
  return (abs ? '/' : '') + joined || '.';
}
function dirname(p) {
  if (!p) return '.';
  const i = p.replace(/\/+$/, '').lastIndexOf('/');
  if (i < 0) return '.';
  return i === 0 ? '/' : p.slice(0, i);
}
function basename(p) {
  const s = (p || '').replace(/\/+$/, '');
  return s.slice(s.lastIndexOf('/') + 1);
}
const sep = '/';
module.exports = { join, dirname, basename, sep, resolve: join };
module.exports.default = module.exports;
