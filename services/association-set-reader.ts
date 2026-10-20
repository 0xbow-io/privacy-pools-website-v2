import type { Hash, IHTTPClient } from '@privacy-pools-v2/sdk';

// The public leaf query uses the same wire format as HttpASPDataProvider.
// Parity tests execute both against identical network responses.
export async function readAssociationSetLeaves(http: IHTTPClient, url: string): Promise<Hash[]> {
  try {
    const data = await http.get<{ leaves: string[] }>(url, { cache: 'no-store' });
    return data.leaves.map(leaf => `0x${BigInt(leaf).toString(16).padStart(64, '0')}` as Hash);
  } catch (error) {
    throw new Error(`ASP unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const ASP_ROOT_ABI = [{
  type: 'function', name: 'latestASPRoot', stateMutability: 'view',
  inputs: [], outputs: [{ name: '', type: 'uint256' }],
}] as const;

export function validateAssociationSetRegistry(address: string): void {
  if (!/^0x[0-9a-fA-F]+$/.test(address)) {
    throw new Error('Invalid contract address: Must represent a valid hexadecimal integer value with 0x prefix');
  }
  if (address.length !== 42) {
    throw new Error('Invalid contract address: Must be a 20-byte Ethereum address (40 hex chars)');
  }
}

export async function readAssociationSetRoot(read: () => Promise<unknown>): Promise<Hash> {
  try {
    let root: unknown;
    try {
      root = await read();
    } catch (error) {
      throw new Error(`Contract read failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof root !== 'bigint') throw new Error(`latestASPRoot returned ${typeof root}, expected bigint`);
    return `0x${root.toString(16).padStart(64, '0')}` as Hash;
  } catch (error) {
    throw new Error(`Contract call failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
