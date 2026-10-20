// Local fix (NOT committed) for a metro-web bundling crash:
// "Cannot destructure property '__extends' of 'tslib.default' as it is undefined".
// Some TypeScript-compiled deps read `tslib.default.__extends`, but under metro's
// package-exports resolution the tslib namespace bundled for web has no `default`.
// Force the CJS build and attach a self-referential `default` so BOTH
//   import { __extends } from 'tslib'   and   tslib.default.__extends
// resolve. tslib.js exports all helpers directly on module.exports.
const tslib = require('tslib/tslib.js');
if (!tslib.default) {
  tslib.default = tslib;
}
module.exports = tslib;
