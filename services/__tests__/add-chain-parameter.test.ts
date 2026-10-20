import { describe, expect, test } from 'bun:test';
import { buildAddChainParameter, PRIVATE_RPC, type ViemChainLike } from '../../config/add-chain-parameter';

const bsc: ViemChainLike = {
  name: 'BNB Smart Chain',
  nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
  rpcUrls: { default: { http: ['https://bsc-dataseed.bnbchain.org'] } },
  blockExplorers: { default: { url: 'https://bscscan.com' } },
};

describe('buildAddChainParameter', () => {
  test('describes the chain from the viem entry', () => {
    const p = buildAddChainParameter({ viemChain: bsc })!;
    expect(p.chainName).toBe('BNB Smart Chain');
    expect(p.nativeCurrency.symbol).toBe('BNB');
    expect(p.rpcUrls).toEqual(['https://bsc-dataseed.bnbchain.org']);
    expect(p.blockExplorerUrls).toEqual(['https://bscscan.com']);
  });

  test('the product display name wins over viem name', () => {
    const p = buildAddChainParameter({ viemChain: bsc, displayName: 'BNB Chain' })!;
    expect(p.chainName).toBe('BNB Chain');
  });

  test('NEVER writes our keyed endpoints into a wallet', () => {
    // The whole reason this module exists. A key handed to wallet_addEthereumChain
    // persists in the user's wallet and bills us for every later call, from any dapp.
    const p = buildAddChainParameter({
      viemChain: bsc,
      configuredRpcUrls: [
        'https://bnb-mainnet.g.alchemy.com/v2/SECRETKEY0123456789abcdef',
        'https://dry-ultra-sound.ethereum-sepolia.quiknode.pro/abc123def456/',
        'https://mainnet.infura.io/v3/deadbeefdeadbeefdeadbeef',
        'https://public.example.org/rpc',
      ],
    })!;
    expect(p.rpcUrls).toEqual(['https://bsc-dataseed.bnbchain.org', 'https://public.example.org/rpc']);
    for (const url of p.rpcUrls) expect(PRIVATE_RPC.test(url)).toBe(false);
    expect(JSON.stringify(p)).not.toContain('SECRETKEY');
  });

  test('de-duplicates when a configured endpoint repeats the viem default', () => {
    const p = buildAddChainParameter({
      viemChain: bsc,
      configuredRpcUrls: ['https://bsc-dataseed.bnbchain.org'],
    })!;
    expect(p.rpcUrls).toEqual(['https://bsc-dataseed.bnbchain.org']);
  });

  test('undefined when there is no viem chain to describe', () => {
    expect(buildAddChainParameter({ viemChain: undefined })).toBeUndefined();
  });

  test('undefined when every endpoint we have is private', () => {
    // Better to let the connector derive than to add an entry the user cannot use.
    const noPublic: ViemChainLike = { ...bsc, rpcUrls: { default: { http: [] } } };
    expect(buildAddChainParameter({
      viemChain: noPublic,
      configuredRpcUrls: ['https://x.g.alchemy.com/v2/AAAAAAAAAAAAAAAAAAAAAAAA'],
    })).toBeUndefined();
  });

  test('omits blockExplorerUrls when the chain has no explorer', () => {
    const noExplorer: ViemChainLike = { ...bsc, blockExplorers: undefined };
    const p = buildAddChainParameter({ viemChain: noExplorer })!;
    expect(p.blockExplorerUrls).toBeUndefined();
    expect('blockExplorerUrls' in p).toBe(false);
  });
});
