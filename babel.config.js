/**
 * The Stellar SDK loads Node built-ins for its file-backed store with
 * `import(/* webpackIgnore: true *\/ 'fs/promises')`. Metro leaves an import()
 * carrying that comment untouched, and Hermes cannot parse a bare import(), so
 * the Android release bundle failed to compile. Dropping the comment on native
 * lets Metro rewrite the call like any other, and metro.config.js already
 * resolves those built-ins to shims there. Web keeps the comment and its
 * current behaviour.
 */
function stripWebpackIgnoreOnNative() {
  return {
    visitor: {
      CallExpression(path, state) {
        if (path.node.callee.type !== 'Import') return;
        const caller = state.file.opts.caller;
        if (!caller || caller.platform === 'web') return;
        if (!/[\\/]@privacy-pools-v2[\\/]stellar-sdk[\\/]/.test(state.filename || '')) return;
        for (const arg of path.node.arguments) {
          if (arg.leadingComments) arg.leadingComments = arg.leadingComments.filter((c) => !/webpackIgnore/.test(c.value));
        }
      },
    },
  };
}

module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      // jsxImportSource routes JSX through NativeWind's interop wrapper so
      // className resolves on RN components (React Compiler output included).
      ['babel-preset-expo', { jsxImportSource: 'nativewind' }],
      // nativewind/babel is a PRESET, not a plugin.
      'nativewind/babel',
    ],
    plugins: [
      // Fixes "SyntaxError: Cannot use 'import.meta' outside a module"
      'babel-plugin-transform-import-meta',
      stripWebpackIgnoreOnNative,
    ],
  };
};
