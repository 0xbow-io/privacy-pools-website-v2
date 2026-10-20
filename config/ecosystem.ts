export type PartnerStatus = 'live' | 'building' | 'announced';
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
  logoColor: string;
  categories: PartnerCategory[];
  chains: string[];
  status: PartnerStatus;
  // Optional ecosystem-integration metadata (from the integrations sheet).
  assets?: string;
  launchDate?: string;
  integration?: string;
  // Highlight as a featured partnership (rendered prominently, first).
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
    logoColor: '#5C6BC0',
    categories: ['sdk', 'privacy'],
    chains: ['Ethereum'],
    status: 'live',
    assets: 'All supported assets',
    launchDate: '2025–2026',
    integration: 'Official Ethereum Foundation SDK',
    featured: true,
  },
  {
    name: 'Brevis ZK',
    slug: 'brevis',
    url: 'https://brevis.network',
    description:
      'ZK proving partner behind the Privacy Pools deployment on BNB Chain. Supplies the zero-knowledge proof infrastructure for the BNB pools.',
    logoText: 'B',
    logoColor: '#2E6DB4',
    categories: ['infrastructure', 'privacy'],
    chains: ['BNB Chain'],
    status: 'live',
    assets: 'USDT on BNB',
    launchDate: 'Early 2025',
    integration: 'BNB Chain ZK deployment',
  },
  {
    name: 'Ambire Wallet',
    slug: 'ambire',
    url: 'https://ambire.com',
    description:
      'Native private transfers powered by the Kohaku SDK. Send through Privacy Pools directly from the Ambire smart-account wallet, no separate app required.',
    logoText: 'A',
    logoColor: '#6246EA',
    categories: ['wallet'],
    chains: ['Ethereum'],
    status: 'building',
    assets: 'All supported assets',
    launchDate: 'June 2026',
    integration: 'Via Kohaku SDK',
  },
  {
    name: 'Cloaked',
    slug: 'cloaked',
    url: 'https://app.clkd.xyz',
    description:
      'Self-custodial wallet with stealth addresses, compliant Privacy Pools integration, and one-click private transfers via "Incognito mode".',
    logoText: 'C',
    logoColor: '#1a1a2e',
    categories: ['wallet', 'privacy'],
    chains: ['Ethereum'],
    status: 'live',
    assets: 'All supported assets',
    launchDate: 'May 2026',
    integration: 'Direct Privacy Pools integration',
  },
  {
    name: 'Veil Cash',
    slug: 'veil-cash',
    url: 'https://www.veil.cash/',
    description:
      'Shielded ETH and USDC pools on Base with compliant deposit screening, gasless relayed transfers, and staking.',
    logoText: 'V',
    logoColor: '#1F6F5C',
    categories: ['privacy'],
    chains: ['Base'],
    status: 'live',
  },
  {
    name: 'zFi',
    slug: 'zfi',
    url: 'https://zfi.wei.is/',
    description: 'Swap tokens on zFi. The most secure-by-default exchange.',
    logoText: 'Z',
    logoColor: '#0891B2',
    categories: ['defi'],
    chains: ['Ethereum'],
    status: 'live',
  },
  {
    name: 'Shielded ETH',
    slug: 'shielded-eth',
    url: 'https://shieldedeth.com',
    description:
      'TVL tracker for Ethereum privacy protocols including Privacy Pools, Railgun, Aztec, and Tornado Cash. Hourly updates in ETH and USD.',
    logoText: 'S',
    logoColor: '#4D4D4D',
    categories: ['analytics', 'privacy'],
    chains: ['Ethereum'],
    status: 'live',
  },
  {
    name: 'WenWithdraw',
    slug: 'wenwithdraw',
    url: 'https://wenwithdraw.xyz',
    description:
      'Withdrawal-timing tool for Privacy Pools. Analyzes deposit patterns and pool activity to surface optimal anonymity-set windows before you withdraw.',
    logoText: 'W',
    logoColor: '#006877',
    categories: ['tools', 'privacy'],
    chains: ['Ethereum'],
    status: 'live',
  },
  {
    name: 'DefiLlama: Privacy',
    slug: 'defillama-privacy',
    url: 'https://defillama.com/protocols/privacy',
    description:
      'Privacy Pools tracked in the DefiLlama privacy category alongside Railgun, Aztec, and Tornado Cash. TVL, chain breakdown, and historical charts.',
    logoText: 'L',
    logoColor: '#9B59B6',
    categories: ['analytics', 'defi'],
    chains: ['Ethereum'],
    status: 'live',
  },
];

/**
 * Display order and labels for every category the directory KNOWS about. This
 * is not the chip list: see PARTNER_CATEGORIES below.
 */
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

/**
 * The chips the Ecosystem page offers, derived from the categories partners
 * ACTUALLY carry.
 *
 * QA N-f: selecting "Payments" showed no projects. Nothing was broken about the
 * filter, and no partner was miscategorised: the chip was simply offered for a
 * category no partner has, so it could only ever return nothing. Deriving the
 * list rather than hand-maintaining it means adding a category to CATEGORY_LABELS
 * ahead of its first partner, or removing the last partner in a category, can no
 * longer strand a dead-end chip.
 */
export const PARTNER_CATEGORIES: { value: PartnerCategory | 'all'; label: string }[] = [
  { value: 'all', label: 'All' },
  ...CATEGORY_LABELS.filter((c) => ECOSYSTEM_PARTNERS.some((p) => p.categories.includes(c.value))),
];
