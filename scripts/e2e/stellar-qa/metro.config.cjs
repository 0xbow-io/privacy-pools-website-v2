// Explicit local QA config; the normal build never resolves these fixtures.
const path = require('node:path');
const config = require('../../../metro.config.js');
const resolve = config.resolver.resolveRequest;
const mocks = new Set(['@/services/stellar/stellar-account', '@/components/stellar-wallet-provider', '@/hooks/use-stellar-balance', '@/hooks/use-stellar-fee-estimate']);
config.resolver.resolveRequest = (context, name, platform) => mocks.has(name)
  ? { type: 'sourceFile', filePath: path.resolve(__dirname, 'adapter.tsx') }
  : resolve(context, name, platform);
module.exports = config;
