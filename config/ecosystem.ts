export type PartnerCategory =
  | 'wallet'
  | 'defi'
  | 'privacy'
  | 'sdk'
  | 'analytics'
  | 'payments'
  | 'tools'
  | 'infrastructure';

export interface EcosystemPartner {
  name: string;
  slug: string;
  url: string;
  description: string;
  logoText: string;
  categories: PartnerCategory[];
  // Use the featured layout in the unfiltered directory.
  featured?: boolean;
}

export const ECOSYSTEM_PARTNERS: EcosystemPartner[] = [
  {
    name: 'Kohaku SDK',
    slug: 'kohaku-sdk',
    url: 'https://github.com/ethereum/kohaku',
    description:
      "The Ethereum Foundation's open-source privacy toolkit. Lets any wallet add native Privacy Pools support without rebuilding its stack. The SDK embeds shielded-pool protocols directly into wallet flows.",
    logoText: 'K',
    categories: ['sdk', 'privacy'],
    featured: true,
  },
  {
    name: 'Casberi',
    slug: 'casberi',
    url: 'https://casberi.app',
    description:
      'An inbox and wallet for your accounts on iPhone, iPad, and Mac, with support for Privacy Pools v2.',
    logoText: 'C',
    categories: ['wallet', 'privacy'],
  },
  {
    name: 'Nymis',
    slug: 'nymis',
    url: 'https://nymis.io',
    description:
      'Scan an address to understand its onchain privacy exposure, or explore how two wallet addresses are linked.',
    logoText: 'N',
    categories: ['tools', 'analytics'],
  },
  {
    name: 'Brevis ZK',
    slug: 'brevis',
    url: 'https://brevis.network',
    description:
      'ZK proving partner behind the Privacy Pools deployment on BNB Chain. Supplies the zero-knowledge proof infrastructure for the BNB pools.',
    logoText: 'B',
    categories: ['infrastructure', 'privacy'],
  },
  {
    name: 'Ambire Wallet',
    slug: 'ambire',
    url: 'https://ambire.com',
    description:
      'Native private transfers powered by the Kohaku SDK. Send through Privacy Pools directly from the Ambire smart-account wallet, no separate app required.',
    logoText: 'A',
    categories: ['wallet'],
  },
  {
    name: 'Cloaked',
    slug: 'cloaked',
    url: 'https://app.clkd.xyz',
    description:
      'Self-custodial wallet with stealth addresses, compliant Privacy Pools integration, and one-click private transfers via "Incognito mode".',
    logoText: 'C',
    categories: ['wallet', 'privacy'],
  },
  {
    name: 'Veil Cash',
    slug: 'veil-cash',
    url: 'https://www.veil.cash/',
    description:
      'Shielded ETH and USDC pools on Base with compliant deposit screening, gasless relayed transfers, and staking.',
    logoText: 'V',
    categories: ['privacy'],
  },
  {
    name: 'zFi',
    slug: 'zfi',
    url: 'https://zfi.wei.is/',
    description: 'Swap tokens on zFi. The most secure-by-default exchange.',
    logoText: 'Z',
    categories: ['defi'],
  },
  {
    name: 'Shielded ETH',
    slug: 'shielded-eth',
    url: 'https://shieldedeth.com',
    description:
      'TVL tracker for Ethereum privacy protocols including Privacy Pools, Railgun, Aztec, and Tornado Cash. Hourly updates in ETH and USD.',
    logoText: 'S',
    categories: ['analytics', 'privacy'],
  },
  {
    name: 'WenWithdraw',
    slug: 'wenwithdraw',
    url: 'https://wenwithdraw.xyz',
    description:
      'Withdrawal-timing tool for Privacy Pools. Analyzes deposit patterns and pool activity to surface optimal anonymity-set windows before you withdraw.',
    logoText: 'W',
    categories: ['tools', 'privacy'],
  },
  {
    name: 'DefiLlama: Privacy',
    slug: 'defillama-privacy',
    url: 'https://defillama.com/protocols/privacy',
    description:
      'Privacy Pools tracked in the DefiLlama privacy category alongside Railgun, Aztec, and Tornado Cash. TVL, chain breakdown, and historical charts.',
    logoText: 'L',
    categories: ['analytics', 'defi'],
  },
];

// Category display order and labels.
const CATEGORY_LABELS: { value: PartnerCategory; label: string }[] = [
  { value: 'wallet', label: 'Wallet' },
  { value: 'defi', label: 'DeFi' },
  { value: 'privacy', label: 'Privacy' },
  { value: 'sdk', label: 'SDK' },
  { value: 'analytics', label: 'Analytics' },
  { value: 'payments', label: 'Payments' },
  { value: 'tools', label: 'Tools' },
  { value: 'infrastructure', label: 'Infra' },
];

// Only offer categories with projects, so every filter has results.
export const PARTNER_CATEGORIES: { value: PartnerCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  ...CATEGORY_LABELS.filter((c) => ECOSYSTEM_PARTNERS.some((p) => p.categories.includes(c.value))),
];
