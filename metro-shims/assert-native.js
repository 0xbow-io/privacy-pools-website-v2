// Minimal `assert` for native bundles (circomlibjs reference code).
function assert(cond, msg) { if (!cond) throw new Error(msg || 'Assertion failed'); }
assert.ok = assert;
assert.equal = (a, b, m) => assert(a == b, m);
assert.strictEqual = (a, b, m) => assert(a === b, m);
assert.deepEqual = (a, b, m) => assert(JSON.stringify(a) === JSON.stringify(b), m);
module.exports = assert;
module.exports.default = assert;
