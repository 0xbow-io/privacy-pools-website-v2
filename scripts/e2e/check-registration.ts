// One-off: is an address registered with the Keystore on Sepolia?
// Registration has TWO legs (auth policy, then viewing key); a gasless /
// cold-start registration lands the policy with NO viewing key by design.
//   SAFEWRAP_WHITELIST_PORTS=9999 safewrap bun scripts/e2e/check-registration.ts 0xaddr 0xaddr
import { createPublicClient, http } from 'viem';
import { sepolia } from 'viem/chains';
import { env } from './lib';

const e = env();
const url = e.EXPO_PUBLIC_ALCHEMY_KEY
  ? `https://eth-sepolia.g.alchemy.com/v2/${e.EXPO_PUBLIC_ALCHEMY_KEY}`
  : e.EXPO_PUBLIC_RPC_URL!;
const keystore = (e.EXPO_PUBLIC_SEPOLIA_KEYSTORE_ADDRESS || '0x6d264acb9c3a7a3105c29470afe2f5f1ec203c73') as `0x${string}`;
const c = createPublicClient({ chain: sepolia, transport: http(url) });

const ABI = [
  { type: 'function', name: 'viewingKeys', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'bytes32' }] },
  { type: 'function', name: 'authPolicies', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'address' }] },
] as const;

const ZERO32 = `0x${'00'.repeat(32)}`;
const targets = process.argv.slice(2).filter((a) => a.startsWith('0x'));
console.log('keystore:', keystore);
for (const addr of targets) {
  const out: string[] = [];
  for (const fn of ['authPolicies', 'viewingKeys'] as const) {
    try {
      const v = await c.readContract({ address: keystore, abi: ABI, functionName: fn, args: [addr as `0x${string}`] });
      const s = String(v);
      const set = s !== ZERO32 && s !== '0x0000000000000000000000000000000000000000';
      out.push(`${fn}=${set ? 'SET' : 'unset'}${set ? ` (${s.slice(0, 14)}…)` : ''}`);
    } catch (err) {
      out.push(`${fn}=ERR ${(err as Error).message.slice(0, 60)}`);
    }
  }
  console.log(`${addr}  ${out.join('  ')}`);
}
