// Staging pool-menu options — PURE module (bun-testable), extracted from
// components/ui/header.tsx per codex review of 1454f30.
//
// On staging chains the header's Pool submenu must be built from the PINNED
// deployment, never the ASP feed: the chain-10 feed row is misregistered, and
// rendering it as a pickable non-default option let applyPoolSelection()
// persist a foreign vault that env.ts bakes into SEPOLIA_POOL_ADDRESS on
// reload. The invariant this module (and its test) guards: a staging chain
// yields exactly ONE option and it is isDefault:true — the pick handler maps
// default → applyPoolSelection(null), so picking can only ever CLEAR a stored
// selection, never write one.

import type { StagingDeployment } from '@/config/staging-deployments';

export type StagingPoolMenuOption = {
  poolVault: string;
  entrypoint: string;
  fromBlock: number;
  label: string;
  isDefault: boolean;
  isActive: boolean;
};

export function buildStagingPoolMenuOptions(pin: StagingDeployment): StagingPoolMenuOption[] {
  const entrypoint = pin.entrypoint;
  return [{
    poolVault: pin.pool.toLowerCase(),
    entrypoint,
    fromBlock: Number(pin.fromBlock),
    label: `Entrypoint ${entrypoint.slice(0, 6)}…${entrypoint.slice(-4)} (current)`,
    isDefault: true, // picking it applies null. Never persists a vault
    isActive: true,
  }];
}
