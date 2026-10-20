// Registry half of services/receipt-chain.ts: reads the environment tables and
// the static chain registry, which bun tests cannot import (config/chains pulls
// in react-native).
import { ACTIVE_APP_ENVIRONMENT } from '@/config/app-environment';
import { chainDisplayNameAnyEnvironment, getChainConfig } from '@/config/chains';
import { ENVIRONMENTS } from '@/config/environments';
import { STAGING_CHAINS, STAGING_MAINNET_ONLY_CHAIN_IDS } from '@/config/staging-deployments';
import { STAGING_MAINNET_ENV_VALUE } from '@/config/staging-mainnet';
import { buildEnvironmentChains, resolveReceiptChain, type ReceiptChain } from '@/services/receipt-chain';

const ENVIRONMENT_CHAINS = buildEnvironmentChains(
  Object.values(ENVIRONMENTS),
  { chains: STAGING_CHAINS, mainnetOnlyChainIds: STAGING_MAINNET_ONLY_CHAIN_IDS, mainnetQuery: STAGING_MAINNET_ENV_VALUE },
  chainDisplayNameAnyEnvironment,
);

export function receiptChain(chainId: number): ReceiptChain {
  return resolveReceiptChain(chainId, getChainConfig(chainId)?.displayName, ACTIVE_APP_ENVIRONMENT, ENVIRONMENT_CHAINS);
}
