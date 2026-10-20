// The Entrypoint's per-asset configuration: the ABI fragment for reading it, and
// the two accessors that cope with viem returning either a tuple or an object.
//
// This lived in the deposit modal and was exported from there, so the action hub
// imported contract-read plumbing from a modal provider, and the payment-request
// modal kept its own byte-identical copy of the ABI and the fee accessor. Moved
// verbatim: the bodies and comments are the originals.

// Exported for the inline hub form (action-hub), which shows the same
// vetting-fee/total picture the modal does.
export const ENTRYPOINT_ASSETS_ABI = [
  {
    type: 'function',
    name: 'assets',
    inputs: [{ name: '_asset', type: 'address' }],
    outputs: [
      {
        name: 'config_',
        type: 'tuple',
        components: [
          { name: 'enabled', type: 'bool' },
          { name: 'minAmount', type: 'uint256' },
          { name: 'vettingFeeBPS', type: 'uint256' },
          { name: 'maxRelayFee', type: 'uint256' },
        ],
      },
    ],
    stateMutability: 'view',
  },
] as const;

export type EntrypointAssetConfig =
  | readonly [enabled: boolean, minAmount: bigint, vettingFeeBPS: bigint, maxRelayFee: bigint]
  | { enabled: boolean; minAmount: bigint; vettingFeeBPS: bigint; maxRelayFee: bigint };

export function getVettingFeeBPS(config: EntrypointAssetConfig): bigint {
  return 'vettingFeeBPS' in config ? config.vettingFeeBPS : config[2];
}

export function getMinimumDepositAmount(config: EntrypointAssetConfig): bigint {
  return 'minAmount' in config ? config.minAmount : config[1];
}
