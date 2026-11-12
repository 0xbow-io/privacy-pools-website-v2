// Offline Safe Transaction Builder data. Never broadcasts or signs a transaction.
import { encodeFunctionData, isAddress } from 'viem';
import { readFileSync, writeFileSync } from 'node:fs';
import { sha256 } from './static-files.mjs';
const [manifestPath, registry, chainId, output] = process.argv.slice(2);
if (!manifestPath || !isAddress(registry ?? '') || !/^[1-9]\d*$/.test(chainId ?? '') || !output) throw new Error('Usage: node anchor-data.mjs <release-manifest.json> <registry-address> <chain-id> <output.json>');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (!/^[0-9a-f]{40}$/.test(manifest.commit) || !/^b[a-z2-7]+$/.test(manifest.siteCid ?? '') || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid release manifest');
const hash = await sha256(manifestPath);
const data = encodeFunctionData({ abi: [{ type: 'function', name: 'publishRelease', stateMutability: 'nonpayable', inputs: [{ name: 'version', type: 'string' }, { name: 'sourceCommit', type: 'bytes20' }, { name: 'manifestSha256', type: 'bytes32' }, { name: 'siteCid', type: 'string' }], outputs: [] }], functionName: 'publishRelease', args: [`v${manifest.version}`, `0x${manifest.commit}`, `0x${hash}`, manifest.siteCid] });
writeFileSync(output, JSON.stringify({ version: '1.0', chainId, createdAt: manifest.sourceDateEpoch * 1000, meta: { name: `Privacy Pools v${manifest.version} release attestation` }, transactions: [{ to: registry, value: '0', data }] }, null, 2) + '\n');
