import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';

for (const [hostname, search] of [
  ['testnet.privacypools.com', ''],
  ['v2.privacypools.com', '?env=staging'],
]) {
  test(`${hostname}${search} selects the complete V8 deployment`, () => {
    const code = `
      import { mock } from 'bun:test';
      mock.module('react-native', () => ({ Platform: { OS: 'web', select: o => o.web ?? o.default } }));
      globalThis.window = { location: { hostname: ${JSON.stringify(hostname)}, search: ${JSON.stringify(search)}, origin: ${JSON.stringify('https://' + hostname)} }, localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } };
      const env = await import('./config/env');
      const relay = await import('./config/relayer');
      const { ACTIVE_ENVIRONMENT } = await import('./config/environments');
      console.log(JSON.stringify({ environment: ACTIVE_ENVIRONMENT.id, pool: env.SEPOLIA_POOL_ADDRESS, keystore: env.SEPOLIA_KEYSTORE_ADDRESS, registry: env.SEPOLIA_ASP_REGISTRY_ADDRESS, fromBlock: String(env.SEPOLIA_FROM_BLOCK), relay: relay.SEPOLIA_WITHDRAWAL_PROCESSOR_ADDRESS, url: relay.SEPOLIA_RELAYER_BASE_URL }));
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, EXPO_PUBLIC_APP_ENV: 'prod', EXPO_PUBLIC_STAGING_MAINNET: 'false', EXPO_PUBLIC_LOCAL_V8_PREVIEW: '' };
    for (const key of ['POOL_ADDRESS', 'KEYSTORE_ADDRESS', 'ASP_REGISTRY_ADDRESS', 'FROM_BLOCK', 'RELAYER_URL']) {
      env[`EXPO_PUBLIC_SEPOLIA_${key}`] = '';
    }
    const run = spawnSync(process.execPath, ['-e', code], { cwd: process.cwd(), env, encoding: 'utf8' });
    if (run.status !== 0) throw new Error(run.stderr);
    expect(JSON.parse(run.stdout.trim())).toEqual({
      environment: 'staging',
      pool: '0x4deceef285a24ca05999870887c895042731d7cb',
      keystore: '0x5b8883a2f8339560d8ebfeaabf93ce4e7056c4ca',
      registry: '0x836acbf56832fd11492e4a4ba1ba40f6e361df66',
      fromBlock: '10956341',
      relay: '0x87a5BFbAd7cA6B1FF3d9E631877B5930f17C24B0',
      url: 'https://relayer-v2-testing-149184580131.us-east1.run.app',
    });
  });
}
