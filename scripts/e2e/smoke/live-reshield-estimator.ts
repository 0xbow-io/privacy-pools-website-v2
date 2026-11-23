// @ts-nocheck -- read-only live SDK adapter for the browser simulation.
// No account keys, note secrets, proofs, signing or submission methods exist here.
import { createPublicClient, http, parseAbi, zeroAddress, formatUnits } from 'viem';
import {
  PoolSessionReshield, PoolSessionReshieldCrosschain, PoolSessionYieldDeposit,
  LiFiSwapQuoteProvider, EvmSwapChainAdapter, EvmAddressEqualityComparator, ViemRPCInteractor,
} from '@privacy-pools-v2/sdk';
import { installNativeDeliveryBridgeDeny } from '../../../services/lifi-native-delivery';
import { ENTRYPOINT_ASSETS_ABI } from '../../../services/entrypoint-assets';

// Mainnet executor from the installed SDK factory; this probe uses mainnet inputs.
const LIFI_SWAP_EXECUTORS={1:{executor:'0xd9B2Da9C45b118e4e93A004FB1452bCDB6cC0E88',erc20Proxy:'0x68E1Acfa805dcA813116Ed6507E01c38D44318f0'}};
const RPC = { 1: 'https://ethereum-rpc.publicnode.com', 10: 'https://optimism-rpc.publicnode.com', 56: 'https://bsc-rpc.publicnode.com', 8453: 'https://base-rpc.publicnode.com', 42161: 'https://arbitrum-one-rpc.publicnode.com' };
const NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const VAULT = parseAbi(['function previewRedeem(uint256) view returns (uint256)', 'function previewDeposit(uint256) view returns (uint256)']);
const ROUTER = parseAbi(['function quote(uint256) view returns (uint256 underlyingNeeded,uint256 total)', 'function NATIVE_MODE() view returns (bool)']);
const detailsByChain = new Map();
export function seedLiveDetails(body){for(const chain of body.chains??[])detailsByChain.set(chain.id,Promise.resolve(chain));}
const liveFetch=globalThis.fetch;
export const liveRequests=[];
globalThis.fetch=async (...args)=>{
 const url=String(args[0]); const body=String(args[1]?.body??'');
 if(/\/relay\//.test(url)||/eth_send|wallet_send|eth_signTransaction/.test(body))throw new Error('Submission prohibited in simulation');
 const response=await liveFetch(...args);liveRequests.push({url:url.split('?')[0],status:response.status});
 console.log('live-http',response.status,url.split('?')[0]);return response;
};
const clients = new Map();
const clientFor = (chain) => {
  if (!RPC[chain]) throw new Error(`No test RPC for ${chain}`);
  if (!clients.has(chain)) clients.set(chain, createPublicClient({ transport: http(RPC[chain], { timeout: 20_000, retryCount: 1 }) }));
  return clients.get(chain);
};
async function detailsFor(chain) {
  if (!detailsByChain.has(chain)) detailsByChain.set(chain, (async () => {
    let res;
    for(let attempt=0;attempt<16;attempt++){
      res=await fetch(`https://v2.fastrelay.xyz/v1/details/evm/${chain}`,{signal:AbortSignal.timeout(15000)});
      if(res.status!==429)break;
      await new Promise(resolve=>setTimeout(resolve,5000));
    }
    if (!res.ok) throw new Error(`Live relayer details ${chain}: ${res.status}`);
    return res.json();
  })());
  return detailsByChain.get(chain);
}
function entrypoint(chain, address) {
  return {
    getAddress: () => address,
    getAssetConfig: async (asset) => clientFor(chain).readContract({ address, abi: ENTRYPOINT_ASSETS_ABI, functionName: 'assets', args: [asset] }),
  };
}
async function yieldsFor(chain, details) {
  const client = clientFor(chain);
  const targets = [];
  const wrappers = [];
  for (const deployment of details.yield ?? []) {
    // Same deployment metadata as the app: WETH-backed ppETH uses native deposits.
    const native = deployment.underlyingSymbol === 'WETH';
    const fundingToken = native ? NATIVE : deployment.underlying;
    const router = {
      // The actual SDK PPRouterInteractor supplies this protocol constant.
      supplyBufferUnits: async () => 2n,
      quote: async (shares) => {
        const [underlyingNeeded, total] = await client.readContract({ address: deployment.router, abi: ROUTER, functionName: 'quote', args: [shares] });
        return { underlyingNeeded, total };
      },
    };
    const yieldToken = { previewDeposit: (assets) => client.readContract({ address: deployment.ppToken, abi: VAULT, functionName: 'previewDeposit', args: [assets] }) };
    const sizer = new PoolSessionYieldDeposit({ deployment: {}, deposit: {}, router, yieldToken, codec: {} });
    targets.push({ chainId: chain, shareToken: deployment.ppToken, fundingToken, router: deployment.router,
      sizeSharesForBudget: sizer.sizeSharesForBudget.bind(sizer),
      prepareSwapDeposit: () => { throw new Error('Simulation stops before proofs'); },
      assertDepositMatches: () => { throw new Error('Simulation stops before proofs'); },
    });
    wrappers.push({ shareToken: deployment.ppToken, underlying: deployment.underlying, zap: deployment.zap,
      previewRedeem: (shares) => client.readContract({ address: deployment.ppToken, abi: VAULT, functionName: 'previewRedeem', args: [shares] }),
    });
  }
  return { targets, wrappers };
}
export async function liveReshieldEstimate(chainId, destinationChainId, params) {
  const [sourceDetails, destDetails] = await Promise.all([detailsFor(chainId), detailsFor(destinationChainId)]);
  const [sourceYield, destYield] = await Promise.all([yieldsFor(chainId, sourceDetails), yieldsFor(destinationChainId, destDetails)]);
  const sourceRpc = new ViemRPCInteractor({ publicClient: clientFor(chainId) });
  const relayer = {
    getChainDetails: (request) => detailsFor(request?.chainId ?? chainId),
    getSwapQuote: async (info, body) => {
      if (body.commit !== false) throw new Error('Only noncommitting estimate quotes are allowed');
      const res = await fetch(`${info.url.replace(/\/$/, '')}/v1/quote/evm/${chainId}/swap`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(`Live relayer quote ${res.status}: ${JSON.stringify(data)}`);
      return data;
    },
  };
  const lifi = new LiFiSwapQuoteProvider({ integrator: 'privacy-pools-v2' });
  const realContractQuote=lifi.getSwapAndDepositQuote.bind(lifi);
  lifi.getSwapAndDepositQuote=p=>realContractQuote({slippage:p.fromChainId===(p.toChainId??p.fromChainId)?0.01:0.03,...p});
  installNativeDeliveryBridgeDeny(lifi);
  const common = { chainId, core: {}, rpcInteractor: sourceRpc, relayerInteractor: relayer,
    entrypointInteractor: entrypoint(chainId, sourceDetails.contracts.entrypoint),
    addressEqualityComparator: new EvmAddressEqualityComparator(), emptyAddress: zeroAddress,
    swapQuoteProvider: lifi, swapAndDepositQuoteProvider: lifi,
    swapChainAdapter: new EvmSwapChainAdapter({ rpcInteractor: sourceRpc }),
    relaySwapsAddress: sourceDetails.contracts.relaySwaps, swapExecutor: LIFI_SWAP_EXECUTORS[chainId],
    nativeAssetAddress: NATIVE, yieldWrappers: sourceYield.wrappers,
  };
  const estimator = chainId === destinationChainId
    ? new PoolSessionReshield({ ...common, yieldDepositTargets: sourceYield.targets })
    : new PoolSessionReshieldCrosschain({ ...common, destinationChainId, destinationChainType: 'evm',
      destinationEntrypointInteractor: entrypoint(destinationChainId, destDetails.contracts.entrypoint),
      destinationYieldDepositTargets: destYield.targets, relayerChainDetails: [sourceDetails, destDetails],
    });
  const result = chainId === destinationChainId
    ? await estimator.estimateReshieldAmount(params)
    : await estimator.estimateReshieldCrosschainAmount(params);
  return JSON.parse(JSON.stringify(result, (_key, value) => typeof value === 'bigint' ? value.toString() : value));
}

export async function liveNoteRedemption(chain, token, noteValue) {
  const details = await detailsFor(chain);
  const target = details.yield.find(item => item.ppToken.toLowerCase() === token.toLowerCase());
  if (!target) throw new Error('This smoke checks configured ppAsset destinations');
  const underlying = await clientFor(chain).readContract({ address: token, abi: VAULT, functionName: 'previewRedeem', args: [BigInt(noteValue)] });
  return { exact: formatUnits(underlying, target.underlyingDecimals), symbol: target.underlyingSymbol };
}
