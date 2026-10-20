// What to call the block explorer we are about to send someone to.
//
// The UI hardcoded "View on Etherscan" for everything that was not Sui. That is
// wrong the moment the app serves more than one EVM chain: Pat withdrew on
// Citrea and the success screen offered "View on Etherscan" beside a link to
// explorer.mainnet.citrea.xyz (2026-09-01). Naming the wrong company reads as
// the app not knowing which chain it is on, at exactly the step where someone is
// trying to verify their money moved.
//
// viem already carries these names (Pat's suggestion), and it is the better
// source than anything we would hand-maintain: chain.blockExplorers.default.name
// gives "Etherscan", "BscScan", "Optimism Explorer", "Citrea Explorer". Note it
// disagrees with a naive domain reading on Optimism, whose explorer is hosted at
// optimistic.etherscan.io but is NOT called Etherscan. That disagreement is the
// reason to prefer viem over a hostname guess.
//
// Imported per chain rather than as `* as chains`: viem ships 675 chain objects
// and we need five strings, so a namespace import would drag the lot into the
// bundle. The URL heuristic below covers anything not listed here, including
// chains added to config later, so nothing breaks if this list falls behind.
import { arbitrum, base, bsc, citrea, mainnet, optimism, sepolia } from 'viem/chains';

/** Neutral, always-true fallback. Better than guessing a brand and being wrong. */
export const GENERIC_EXPLORER_LABEL = 'Explorer';

const VIEM_EXPLORER_NAME_BY_CHAIN: Record<number, string | undefined> = {
  [mainnet.id]: mainnet.blockExplorers?.default?.name,
  [sepolia.id]: sepolia.blockExplorers?.default?.name,
  [optimism.id]: optimism.blockExplorers?.default?.name,
  [bsc.id]: bsc.blockExplorers?.default?.name,
  [citrea.id]: citrea.blockExplorers?.default?.name,
  [base.id]: base.blockExplorers?.default?.name,
  [arbitrum.id]: arbitrum.blockExplorers?.default?.name,
};

/**
 * Hostname fallback for chains viem does not cover here, keyed on the
 * registrable domain so subdomains need no enumerating: sepolia.etherscan.io and
 * etherscan.io both collapse to "etherscan.io".
 *
 * Deliberately does NOT list optimistic.etherscan.io as Etherscan; a chain whose
 * explorer has its own brand should come from the viem table above.
 */
const EXPLORER_BRANDS_BY_DOMAIN: Record<string, string> = {
  'etherscan.io': 'Etherscan',
  'basescan.org': 'Basescan',
  'arbiscan.io': 'Arbiscan',
  'bscscan.com': 'BscScan',
  'snowtrace.io': 'Snowtrace',
  'polygonscan.com': 'PolygonScan',
  'citrea.xyz': 'Citrea Explorer',
  'blockscout.com': 'Blockscout',
  'suivision.xyz': 'SuiVision',
  'suiscan.xyz': 'Suiscan',
};

/** The registrable domain: the last two dot-separated labels of the host. */
function registrableDomain(host: string): string {
  const parts = host.toLowerCase().replace(/^www\./, '').split('.').filter(Boolean);
  return parts.length <= 2 ? parts.join('.') : parts.slice(-2).join('.');
}

function labelFromUrl(explorerUrl: string | null | undefined): string {
  if (!explorerUrl) return GENERIC_EXPLORER_LABEL;
  let host: string;
  try {
    host = new URL(explorerUrl).hostname;
  } catch {
    // Tolerate a bare host with no scheme, which is easy to write in config.
    const bare = String(explorerUrl).trim().replace(/^\/+/, '').split('/')[0];
    if (!bare || !bare.includes('.')) return GENERIC_EXPLORER_LABEL;
    host = bare;
  }
  return EXPLORER_BRANDS_BY_DOMAIN[registrableDomain(host)] ?? GENERIC_EXPLORER_LABEL;
}

/**
 * Brand name for a chain's explorer, e.g. "Etherscan" or "Citrea Explorer".
 *
 * viem first, then the URL's domain, then the generic label. Anything
 * unrecognised or unparseable degrades to "Explorer" rather than throwing inside
 * a render or, worse, naming another chain's explorer.
 */
export function explorerLabel(
  chainId: number | null | undefined,
  explorerUrl?: string | null,
): string {
  if (chainId != null) {
    const fromViem = VIEM_EXPLORER_NAME_BY_CHAIN[chainId];
    if (fromViem) return fromViem;
  }
  return labelFromUrl(explorerUrl);
}

/** Ready-made call to action, e.g. "View on Citrea Explorer". */
export function viewOnExplorerLabel(
  chainId: number | null | undefined,
  explorerUrl?: string | null,
): string {
  return `View on ${explorerLabel(chainId, explorerUrl)}`;
}
