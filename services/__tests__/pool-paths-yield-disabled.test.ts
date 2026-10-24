import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

test('pool directory stays unique and legacy routes stay accessible with yield disabled', () => {
  const result = spawnSync(process.execPath, ['-e', `
    import { mock } from 'bun:test';
    import { strict as assert } from 'node:assert';
    mock.module('react-native', () => ({ Platform: { OS: 'web', select: (o) => o.web ?? o.default } }));
    const { supportedEvmChainIds } = await import('./config/chains');
    const { getActionableTokens, getTokenMetadataBySymbol, getKnownTokenMetadata } = await import('./config/tokens');
    const { getPoolPath, poolSymbolFromRoute, isSupersededLegacyPool, poolDisplayLabel } = await import('./config/pool-paths');
    const { listShieldPools, defaultPoolFor, resolveDepositPayAsset } = await import('./services/shield-pools');
    const { getConfiguredYieldDeploymentForAsset } = await import('./config/yield');
    const { targetAcceptsConversion } = await import('./config/intent-targets');
    const shieldPools = listShieldPools();
    assert(shieldPools.every(pool => !isSupersededLegacyPool(pool.symbol, pool.chainId)));
    for (const chainId of supportedEvmChainIds) {
      const tokens = getActionableTokens(chainId);
      const directory = tokens.filter(token => !isSupersededLegacyPool(token.symbol, chainId));
      for (const token of tokens.filter(token => isSupersededLegacyPool(token.symbol, chainId))) {
        const destination = defaultPoolFor(token.symbol, chainId);
        const share = getKnownTokenMetadata(destination.address, chainId);
        assert.equal(destination.chainId, chainId);
        assert(share?.yieldShare, 'legacy default must name its share');
        assert.equal(poolDisplayLabel(share.symbol, chainId), poolDisplayLabel(token.symbol, chainId).replace(' (legacy)', ''));
        assert(shieldPools.some(pool => pool.chainId === chainId && pool.address === destination.address));
        assert.equal(targetAcceptsConversion(share, chainId, false, false), false);
        assert.equal(resolveDepositPayAsset(share, chainId, getConfiguredYieldDeploymentForAsset, getKnownTokenMetadata), null);
      }
      const labels = directory.map(token => poolDisplayLabel(token.symbol, chainId));
      assert.equal(new Set(labels).size, labels.length, 'duplicate asset on chain ' + chainId);
      if (tokens.some(token => token.symbol.toUpperCase() === 'PPETH')) {
        assert.equal(poolSymbolFromRoute('eth', chainId), 'PPETH');
        assert.equal(poolSymbolFromRoute('eth-legacy', chainId), 'ETH');
      }
      for (const token of tokens) {
        const path = getPoolPath(token.symbol, chainId);
        const symbol = poolSymbolFromRoute(path.split('/').pop(), chainId);
        assert.equal(getTokenMetadataBySymbol(symbol, chainId)?.address.toLowerCase(), token.address.toLowerCase(), path);
      }
    }
  `], {
    cwd: process.cwd(),
    env: { ...process.env, EXPO_PUBLIC_APP_ENV: 'prod', EXPO_PUBLIC_YIELD_ENABLED: 'false' },
    encoding: 'utf8',
  });
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
});
