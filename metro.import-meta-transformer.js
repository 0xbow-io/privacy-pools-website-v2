const upstreamTransformer = require('@expo/metro-config/babel-transformer');
const importMetaPlugin = require('babel-plugin-transform-import-meta');

module.exports.transform = async ({ src, filename, options }) => {
  // Apply import.meta transform to viem, wagmi, and .mjs files
  if (
    filename.includes('node_modules/viem') ||
    filename.includes('node_modules/wagmi') ||
    filename.includes('node_modules/@wagmi') ||
    filename.includes('node_modules/zustand') ||
    filename.includes('node_modules/abitype') ||
    filename.endsWith('.mjs')
  ) {
    options = {
      ...options,
      plugins: [importMetaPlugin, ...(options.plugins || [])],
    };
  }

  return upstreamTransformer.transform({ src, filename, options });
};
