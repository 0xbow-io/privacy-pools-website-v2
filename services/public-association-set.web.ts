import { createPublicClient, isAddress } from 'viem';
import type { Address, Hash } from '@privacy-pools-v2/sdk';
import { getChainConfig } from '@/config/chains';
import { ASP_URL, LEGACY_CONFIG } from '@/config/env';
import { VIEM_CHAIN_BY_ID } from '@/config/wagmi-chain-map';
import { policedHttp } from './egress-transport';
import { FetchHTTPClient } from './egress-http-client';
import { resolveConfiguredEntrypoint } from './pool-entrypoint';
import { approvedLabelCache, normalizeHashString } from './public-asp-cache';
import { ASP_ROOT_ABI, readAssociationSetLeaves, readAssociationSetRoot, validateAssociationSetRegistry } from './association-set-reader';
import { AssociationSetWorkerClient, AssociationSetWorkerUnavailable } from './association-set-worker-client';
import { getVerifiedPoolAssociationSetLeaves as fallback } from './public-association-set-fallback';

const worker = new AssociationSetWorkerClient();

export async function getVerifiedPoolAssociationSetLeaves(chainId: number): Promise<Hash[]> {
  try {
    // Use the pinned SDK's deployment fallback rather than maintaining a copy.
    const deployment = await worker.deployment(chainId);
    const configured = await resolveConfiguredEntrypoint(chainId).catch(() => undefined);
    const entrypoint = LEGACY_CONFIG?.entrypoint
      ?? (configured && isAddress(configured) ? configured : deployment?.entrypointAddress);
    if (!entrypoint) throw new Error(`Cannot resolve an entrypoint address for chain ${chainId}`);
    const chain = getChainConfig(chainId);
    const registry = chain?.contracts?.aspRegistryAddress ?? deployment?.aspRegistryAddress;
    if (!LEGACY_CONFIG) {
      if (!registry) throw new Error(`Missing ASP registry address for chain ${chainId}`);
      if (!chain) throw new Error(`Unsupported chain: ${chainId}`);
      if (!chain.contracts) throw new Error(`Missing contracts config for chain ${chainId}`);
      validateAssociationSetRegistry(registry);
    }
    const http = new FetchHTTPClient('asp', ASP_URL);
    const leavesUrl = `${ASP_URL.replace(/\/$/, '')}/association-set/leaves?chainId=${chainId}&entrypoint=${entrypoint.toLowerCase()}`;
    const client = !LEGACY_CONFIG && chain ? createPublicClient({
      chain: VIEM_CHAIN_BY_ID[chainId], transport: policedHttp(chain.rpcUrl),
    }) : undefined;
    const poolKey = `${chainId}:${(configured ?? '').toLowerCase()}`;
    return await approvedLabelCache.verify(chainId, poolKey, () => worker.verify({
      leaves: async () => {
        if (LEGACY_CONFIG) {
          const data = await http.get<{ leaves: string[] }>(`${ASP_URL}/association-set/${LEGACY_CONFIG.mtId}/leaves`);
          return data.leaves.map(normalizeHashString);
        }
        return await approvedLabelCache.leaves({ getLeaves: () => readAssociationSetLeaves(http, leavesUrl) }, chainId, poolKey) as Hash[];
      },
      root: () => readAssociationSetRoot(() => client!.readContract({
        address: registry as Address, abi: ASP_ROOT_ABI, functionName: 'latestASPRoot',
      })),
    }, Boolean(LEGACY_CONFIG)));
  } catch (error) {
    // Native/unsupported browsers and worker startup failures retain the
    // original verification path. Invalid leaves never trigger a retry here.
    if (error instanceof AssociationSetWorkerUnavailable) return fallback(chainId);
    throw error;
  }
}

declare const module: { hot?: { dispose?: (callback: () => void) => void } };
if (typeof module !== 'undefined') module.hot?.dispose?.(() => worker.dispose());
