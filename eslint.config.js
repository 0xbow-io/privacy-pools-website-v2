// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    // Generated from the pinned SDK; checked by build-fee-module.mjs --check.
    ignores: ['dist/*', 'vendor/stellar-fees/index.js'],
  },
]);
