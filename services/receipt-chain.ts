import type { AppEnvironment } from '@/config/app-environment';

/** One environment's chains, as far as naming a receipt's chain needs. */
export type EnvironmentChains = {
  id: AppEnvironment;
  label: string;
  chainNames: Readonly<Record<number, string>>;
  /** The `?env=` value that serves each chain (defaults to the environment id). */
  switchQuery?: Readonly<Record<number, string>>;
};

export type ReceiptChain = {
  name: string;
  /** False when no environment of this app serves the chain at all. */
  supported: boolean;
  /** Set when the chain is served by ANOTHER environment than this one. */
  otherEnvironment?: { id: AppEnvironment; label: string; query: string };
};

/**
 * Every EVM chain an environment serves: its deployments AND its base chain.
 * Sepolia is staging's base chain and never one of its deployments, so reading
 * deployments alone missed exactly the DEV-457 case (review).
 */
export function environmentChainIds(env: {
  deployments: readonly { chainId: number }[];
  includesBaseChain: boolean;
  baseEvmChainId?: number;
}): number[] {
  const ids = env.deployments.map((d) => d.chainId);
  if (env.includesBaseChain && env.baseEvmChainId !== undefined) ids.push(env.baseEvmChainId);
  return [...new Set(ids)];
}

type EnvironmentInput = {
  id: AppEnvironment;
  label: string;
  deployments: readonly { chainId: number; displayName: string }[];
  includesBaseChain: boolean;
  baseEvmChainId?: number;
};

/**
 * The name table for every environment, read from the shipped config.
 *
 * Staging is named from its FULL chain table, not only what this page load
 * enabled: on the production hosts staging's pools are dropped until a tester
 * asks, and a staging-mainnet-only chain (OP, Base) only exists under
 * `?env=staging-mainnet`, which a plain `?env=staging` reload forgets (review).
 */
export function buildEnvironmentChains(
  environments: readonly EnvironmentInput[],
  staging: {
    chains: readonly { chainId: number; displayName: string }[];
    mainnetOnlyChainIds: ReadonlySet<number>;
    mainnetQuery: string;
  },
  nameOf: (chainId: number) => string | undefined,
): EnvironmentChains[] {
  return environments.map((env) => {
    const names: Record<number, string> = {};
    const queries: Record<number, string> = {};
    const known = env.id === 'staging' ? [...env.deployments, ...staging.chains] : [...env.deployments];
    for (const d of known) names[d.chainId] = d.displayName;
    for (const id of environmentChainIds(env)) {
      const name = names[id] ?? nameOf(id);
      if (name) names[id] = name;
    }
    if (env.id === 'staging') {
      for (const id of Object.keys(names).map(Number)) {
        if (staging.mainnetOnlyChainIds.has(id)) queries[id] = staging.mainnetQuery;
      }
    }
    return { id: env.id, label: env.label, chainNames: names, switchQuery: queries };
  });
}

/**
 * Name a receipt's chain even when this environment does not serve it
 * (DEV-457). A Sepolia link opened on Prod read "This receipt is for Chain
 * 11155111. Switch the app to Chain 11155111", which no picker offers: the fix
 * for the user is the Environment switch, so say which one.
 */
export function resolveReceiptChain(
  chainId: number,
  activeName: string | undefined,
  activeEnvironment: AppEnvironment,
  environments: readonly EnvironmentChains[],
): ReceiptChain {
  if (activeName) return { name: activeName, supported: true };
  for (const env of environments) {
    if (env.id === activeEnvironment) continue;
    const name = env.chainNames[chainId];
    if (name) {
      return {
        name,
        supported: true,
        otherEnvironment: { id: env.id, label: env.label, query: env.switchQuery?.[chainId] ?? env.id },
      };
    }
  }
  return { name: `Chain ${chainId}`, supported: false };
}

/**
 * Why a payment request on a chain this environment does not serve cannot be
 * paid here, naming where it can (DEV-485). It replaced "Unsupported chain in
 * payment request (chainId 10)", which named neither the chain nor the fix.
 */
export function requestChainRefusal(chain: ReceiptChain): string {
  if (chain.otherEnvironment) {
    // OP and Base live in staging-mainnet, which plain Staging does not list.
    const where = chain.otherEnvironment.query !== chain.otherEnvironment.id
      ? `${chain.otherEnvironment.label} (${chain.otherEnvironment.query})`
      : chain.otherEnvironment.label;
    return `This request is for ${chain.name}, on ${chain.otherEnvironment.label}. Switch to ${where} to pay it.`;
  }
  return `This request is for ${chain.name}, which this app does not support. Ask the sender for a request on a supported chain.`;
}
