const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');
const path = require('path');

const config = getDefaultConfig(__dirname);
const optimizeWeb = process.env.EXPO_UNSTABLE_METRO_OPTIMIZE_GRAPH === '1';
config.resolver.assetExts.push('woff2');
const navigationAliases = {
  '@react-navigation/native': path.resolve(__dirname, 'node_modules', '@react-navigation', 'native'),
  '@react-navigation/bottom-tabs': path.resolve(__dirname, 'node_modules', '@react-navigation', 'bottom-tabs'),
  '@react-navigation/elements': path.resolve(__dirname, 'node_modules', '@react-navigation', 'elements'),
  '@react-navigation/native-stack': path.resolve(__dirname, 'node_modules', '@react-navigation', 'native-stack'),
  '@react-navigation/core': path.resolve(__dirname, 'node_modules', '@react-navigation', 'core'),
  '@react-navigation/routers': path.resolve(__dirname, 'node_modules', '@react-navigation', 'routers'),
};

// Allow Metro to resolve node_modules from the app root first.
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
];
config.resolver.extraNodeModules = {
  ...(config.resolver.extraNodeModules || {}),
  ...navigationAliases,
};

// Enable package.json "exports" resolution so Metro can resolve
// subpath exports like @noble/ciphers/chacha.js
config.resolver.unstable_enablePackageExports = true;

// Prefer CJS builds to avoid import.meta issues in Metro.
// Order matters: 'require' first forces CJS resolution for zustand etc.
config.resolver.unstable_conditionNames = ['require', 'node', 'default'];

// The SDK's dist imports @noble subpath modules with .js extensions
// (e.g. @noble/ciphers/chacha.js), so redirect them to ppv2's own
// node_modules when Metro misses package exports.
const originalResolveRequest = config.resolver.resolveRequest;
const emptyShim = path.resolve(__dirname, 'metro-shims', 'empty.js');
const webFonts = new Set([
  'Geist_400Regular', 'Geist_500Medium', 'Geist_600SemiBold', 'Geist_700Bold',
  'Ionicons', 'MaterialIcons',
]);

// Node builtins the SDK imports for its Node-only paths (circuit artifact
// caching on disk). Web resolves them to empty browser stubs already; native
// has no such fallback and aborts the bundle.
const nodeBuiltins = new Set(require('module').builtinModules);
const nativeNodeBuiltins = new Set(['fs', 'fs/promises', 'node:fs', 'node:fs/promises']);

const wcCjsPackages = new Set(['@walletconnect/jsonrpc-utils', '@walletconnect/environment']);

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Hermes has no WebAssembly: circomlibjs's WASM Poseidon cannot build on a
  // phone. The shim swaps in a pure-BigInt Poseidon and re-exports the rest
  // (the shim's own import of circomlibjs resolves to the real package).
  const circomShim = path.resolve(__dirname, 'metro-shims', 'circomlibjs-native.js');
  if (platform !== 'web' && moduleName === 'circomlibjs' && context.originModulePath !== circomShim) {
    return { type: 'sourceFile', filePath: circomShim };
  }
  if (platform !== 'web' && nativeNodeBuiltins.has(moduleName)) {
    return { type: 'sourceFile', filePath: emptyShim };
  }
  if (platform !== 'web') {
    const bare = moduleName.replace(/^node:/, '');
    const nativeShims = { path: 'path-native.js', assert: 'assert-native.js', crypto: 'crypto-native.js', os: 'os-native.js' };
    if (nativeShims[bare]) {
      return { type: 'sourceFile', filePath: path.resolve(__dirname, 'metro-shims', nativeShims[bare]) };
    }
    // Any other Node builtin (constants, readline, worker_threads, ...) is only
    // reached on the SDK / zk libraries' Node code paths, which never run on device.
    if (moduleName === 'ws') return { type: 'sourceFile', filePath: path.resolve(__dirname, 'metro-shims', 'ws-native.js') };
    if (bare === 'stream') return { type: 'sourceFile', filePath: path.resolve(__dirname, 'node_modules', 'readable-stream', 'readable.js') };
    if (moduleName === 'web-worker') return { type: 'sourceFile', filePath: emptyShim };
    if (nodeBuiltins.has(bare) && !['buffer', 'events', 'process', 'string_decoder', 'stream'].includes(bare)) {
      return { type: 'sourceFile', filePath: emptyShim };
    }
  }
  // Same complete fonts and metrics, compressed for browsers. Native keeps TTF.
  const font = path.basename(moduleName, '.ttf');
  if (platform === 'web' && moduleName.endsWith('.ttf') && webFonts.has(font)) {
    return context.resolveRequest(context, path.resolve(__dirname, 'assets/fonts', `${font}.woff2`), platform);
  }
  // tslib: force the CJS shim with a self-referential `default` so deps that
  // read `tslib.default.__extends` don't crash under metro web package-exports
  // (hit by the @mysten/* Sui packages).
  if (moduleName === 'tslib') {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'tslib-cjs-shim.js') };
  }
  // buffer: bare `require('buffer')` resolves to an empty web/builtin shim under
  // metro, so `require('buffer').Buffer` is undefined and the Buffer polyfill +
  // snarkjs fail. Force the installed `buffer` package (exports a real Buffer).
  if (moduleName === 'buffer') {
    return { type: 'sourceFile', filePath: path.resolve(__dirname, 'node_modules', 'buffer', 'index.js') };
  }
  if (navigationAliases[moduleName]) {
    return context.resolveRequest(
      {
        ...context,
        resolveRequest: originalResolveRequest,
      },
      navigationAliases[moduleName],
      platform
    );
  }
  // Zustand ESM uses import.meta.env — force CJS entry
  if (moduleName === 'zustand' || moduleName.startsWith('zustand/')) {
    const subpath = moduleName === 'zustand' ? 'index' : moduleName.replace('zustand/', '');
    const cjsPath = path.resolve(__dirname, 'node_modules', 'zustand', subpath + '.js');
    try {
      require.resolve(cjsPath);
      return { type: 'sourceFile', filePath: cjsPath };
    } catch {}
  }
  // The Stellar SDK tarball inlines core-sdk, whose file-backed services
  // (FileStorageService, LocalCircuitArtifacts) import Node built-ins at the
  // top level. The browser never constructs either (the app passes local
  // storage and a fetch-based artifact loader), so stub those built-ins for
  // imports coming FROM that package only; every other package keeps its
  // own resolution.
  if (
    platform === 'web'
    && /[\\/]@privacy-pools-v2[\\/]stellar-sdk[\\/]/.test(context.originModulePath ?? '')
    && /^(node:)?(fs|fs\/promises|path|os|crypto|constants)$/.test(moduleName)
  ) {
    return { type: 'sourceFile', filePath: emptyShim };
  }
  if (moduleName.startsWith('@noble/') && moduleName.endsWith('.js')) {
    const filePath = path.resolve(__dirname, 'node_modules', moduleName);
    return { type: 'sourceFile', filePath };
  }
  // @walletconnect/ethereum-provider has a dynamic
  //   import('@reown/appkit/core')
  // gated at runtime by showQrModal. We always pass showQrModal: false
  // and render our own QR with react-native-qrcode-svg, so that branch
  // never executes — but Metro statically discovers the import target
  // and bundles @reown/appkit anyway. That drags in valtio's ESM entry
  // (uses `import.meta.env`), which prod-loads as a classic script and
  // throws "Cannot use 'import.meta' outside a module" at page load.
  // Stub the package out so Metro skips the whole subtree.
  if (moduleName === '@reown/appkit' || moduleName.startsWith('@reown/appkit/') || moduleName.startsWith('@reown/appkit-')) {
    return { type: 'sourceFile', filePath: emptyShim };
  }
  // @wagmi/core's tempo wallet connector does
  //   const accounts = await import('accounts').catch(() => { throw … })
  // as an optional peer-dep guard, AND its tempo barrel reaches
  // into `viem/tempo/zones` etc. Metro statically discovers all of
  // it and aborts the bundle when any resolution fails, even though
  // the catches and lazy imports mean the code never runs at
  // runtime. We never use tempoWallet in config/wagmi.web.ts (only
  // injected + walletConnect), so empty stubs are functionally
  // invisible — the dereferences that would matter only fire from
  // the tempo connector's own callbacks, which we never invoke.
  if (
    moduleName === 'accounts' ||
    moduleName === '@wagmi/core/tempo' ||
    moduleName.startsWith('@wagmi/core/tempo/') ||
    moduleName === 'viem/tempo' ||
    moduleName.startsWith('viem/tempo/')
  ) {
    return { type: 'sourceFile', filePath: emptyShim };
  }
  // These packages put their Node export before the browser export. Do not
  // assert "node": field initialization needs the real Web Crypto build.
  if (platform === 'web' && optimizeWeb && (moduleName === 'ffjavascript' || moduleName === 'snarkjs')) {
    return context.resolveRequest({
      ...context,
      unstable_conditionNames: ['browser', 'import', 'default'],
      unstable_conditionsByPlatform: { web: ['browser'] },
    }, moduleName, platform);
  }
  // Graph optimization needs ESM exports. In particular, wallet-standard's
  // CommonJS export-star wrappers lose getWallets when re-exported by Sui.
  // Keep all existing aliases and optional-package exclusions above this rule.
  if (platform === 'web' && optimizeWeb && /^(viem(?:\/|$)|ox(?:\/|$)|wagmi(?:\/|$)|@wagmi\/|@wallet-standard\/)/.test(moduleName)) {
    return context.resolveRequest({
      ...context,
      unstable_conditionNames: ['import', 'default'],
      unstable_conditionsByPlatform: { web: ['browser'] },
    }, moduleName, platform);
  }
  // WalletConnect relay: jsonrpc-utils' ESM env.js re-exports isReactNative
  // with `export * from "@walletconnect/environment"`. Its only consumer
  // (jsonrpc-ws-connection) reads it through a CommonJS require, so web tree
  // shaking drops the re-export and opening the relay socket throws
  // "isReactNative is not a function". Every connect then hangs. Use the
  // CommonJS builds, which tree shaking leaves whole.
  if (platform === 'web' && wcCjsPackages.has(moduleName)) {
    return context.resolveRequest({
      ...context,
      mainFields: ['main'],
      unstable_conditionNames: ['require', 'default'],
      unstable_conditionsByPlatform: {},
    }, moduleName, platform);
  }
  if (originalResolveRequest) {
    return originalResolveRequest(context, moduleName, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

// Inject Buffer/process polyfills before any application code.
const defaultGetPolyfills = config.serializer?.getPolyfills || (() => []);
config.serializer = {
  ...config.serializer,
  getPolyfills: (options) => {
    return [
      path.resolve(__dirname, 'global-polyfills.js'),
      ...defaultGetPolyfills(options),
    ];
  },
};

// Leave development and native module evaluation unchanged. Bare side-effect
// imports (polyfills and NativeWind registration) still run in source order.
const getTransformOptions = config.transformer.getTransformOptions;
config.transformer.getTransformOptions = async (...args) => {
  const options = await getTransformOptions(...args);
  const { platform, dev } = args[1];
  return {
    ...options,
    transform: {
      ...options.transform,
      inlineRequires: optimizeWeb && platform === 'web' && !dev,
    },
  };
};

// NativeWind wraps the fully-customized config at the final export ONLY —
// resolver/serializer customizations above must stay untouched. inlineRem: 16
// is mandatory: the default (14) would shrink every rem-derived native value
// (p-6 = 24px on web but 21 on native otherwise).
module.exports = withNativeWind(config, { input: './global.css', inlineRem: 16 });
