import { createPublicClient, getAddress, http } from 'viem';
import { getChainConfig } from '../config/chains';

type SearchResult = {
  chainId: number;
  contractAddress: `0x${string}`;
  deployBlock: string;
  deployDate: string;
};

async function findDeploymentBlock(
  chainId: number,
  contractAddress: `0x${string}`,
): Promise<SearchResult> {
  const chain = getChainConfig(chainId);
  if (!chain) {
    throw new Error(`Unsupported chain: ${chainId}`);
  }

  const client = createPublicClient({
    transport: http(chain.rpcUrl),
  });

  const latestBlock = await client.getBlockNumber();
  const latestCode = await client.getCode({ address: contractAddress, blockNumber: latestBlock });
  if (!latestCode || latestCode === '0x') {
    throw new Error(`No contract code found at ${contractAddress} on chain ${chainId}.`);
  }

  let low = 0n;
  let high = latestBlock;

  while (low < high) {
    const mid = (low + high) / 2n;
    const code = await client.getCode({ address: contractAddress, blockNumber: mid });
    if (code && code !== '0x') {
      high = mid;
    } else {
      low = mid + 1n;
    }
  }

  const block = await client.getBlock({ blockNumber: low });

  return {
    chainId,
    contractAddress,
    deployBlock: low.toString(),
    deployDate: new Date(Number(block.timestamp) * 1000).toISOString(),
  };
}

async function main() {
  const [, , chainIdArg, addressArg] = process.argv;

  if (!chainIdArg || !addressArg) {
    throw new Error('Usage: bun run scripts/get-contract-deploy-block.ts <chainId> <contractAddress>');
  }

  const chainId = Number(chainIdArg);
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw new Error(`Invalid chainId: ${chainIdArg}`);
  }

  const contractAddress = getAddress(addressArg);
  const result = await findDeploymentBlock(chainId, contractAddress);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : 'Failed to determine contract deployment block',
  );
  process.exit(1);
});
