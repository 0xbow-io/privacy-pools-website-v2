/**
 * Native mock data: a believable account (vitalik.eth) with pool balances,
 * personal activity and a protocol feed, for showing the native app without a
 * funded wallet. Only read when NATIVE_MOCK_ACTIVE is on (constants/native-mock).
 * Everything is fixed data built once; nothing here touches the network.
 */
import type { MyPool, PoolEntry, PoolsData, Transaction } from '@/components/pools-provider';
import { formatUsd } from '@/services/format-fiat';
import type { NativeMockPoolsValue, NativeMockSession, NativeMockWallet } from './native-mock-types';

const ACCOUNT = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const CHAIN_ID = 1;
const CHAIN = 'Ethereum';

const TOKENS = {
  ETH: { address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', decimals: 18, price: 2650.4 },
  USDC: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6, price: 1 },
  USDT: { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7', decimals: 6, price: 1 },
  ppUSDC: { address: '0xC246aFb23482fF9596E9cee5f1f678eFe0EB1ad6', decimals: 18, price: 1.041 },
} as const;
type Sym = keyof typeof TOKENS;

const COLORS: Record<Sym, string> = { ETH: '#627EEA', USDC: '#2775CA', USDT: '#26A17B', ppUSDC: '#2775CA' };

const WALLET_BALANCES: Record<string, string> = { ETH: '1.2804', USDC: '4215.80', USDT: '980', ppUSDC: '0' };

function tokenText(amount: number, sym: string): string {
  const digits = amount >= 1000 ? 2 : amount >= 1 ? 4 : 6;
  // Raw data, parsed with parseFloat by the action hub: no grouping commas.
  return `${amount.toLocaleString('en-US', { maximumFractionDigits: digits, useGrouping: false })} ${sym}`;
}

function rawUnits(amount: number, decimals: number): string {
  const [whole, frac = ''] = amount.toFixed(Math.min(decimals, 8)).split('.');
  return (BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals))).toString();
}

function hash(seed: number): string {
  let h = '';
  let x = seed * 2654435761;
  for (let i = 0; i < 64; i++) {
    x = (x * 1103515245 + 12345) % 2147483648;
    h += (x % 16).toString(16);
  }
  return `0x${h}`;
}

function short(addr: string): string {
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

const HOLDINGS: Array<{ sym: Sym; balance: number; pending: number; accounts: number }> = [
  { sym: 'ETH', balance: 3.8421, pending: 0.25, accounts: 3 },
  { sym: 'USDC', balance: 12480.5, pending: 0, accounts: 2 },
  { sym: 'ppUSDC', balance: 8120.35, pending: 0, accounts: 1 },
  { sym: 'USDT', balance: 2350, pending: 500, accounts: 1 },
];

// Personal activity, newest first: [hours ago, type, symbol, amount, direction, status, review]
type Row = [number, 'Deposit' | 'Withdrawal' | 'Transfer', Sym, number, ('in' | 'out')?, string?, string?];
const MY_ROWS: Row[] = [
  [0.4, 'Deposit', 'ETH', 0.25, undefined, 'pending', 'pending'],
  [3, 'Transfer', 'USDC', 750, 'out'],
  [9, 'Transfer', 'ETH', 0.5, 'in'],
  [26, 'Withdrawal', 'USDC', 1200, 'out'],
  [30, 'Deposit', 'USDT', 500, undefined, 'pending', 'pending'],
  [52, 'Deposit', 'ppUSDC', 8120.35],
  [75, 'Transfer', 'USDC', 2400, 'in'],
  [120, 'Deposit', 'USDC', 11000],
  [168, 'Withdrawal', 'ETH', 1.1, 'out'],
  [210, 'Deposit', 'ETH', 2.5],
  [260, 'Deposit', 'USDT', 2350],
  [330, 'Deposit', 'ETH', 2.19],
];

// Other people's public feed rows.
const OTHERS = [
  '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
  '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF',
  '0x6813Eb9362372EEF6200f3b1dbC3f819671cBA69',
  '0x1efF47bc3a10a45D4B230B5d10E37751FE6AA718',
  '0xe1AB8145F7E55DC933d51a18c793F901A3A0b276',
];
const FEED_ROWS: Row[] = [
  [0.2, 'Deposit', 'USDC', 25000],
  [1.1, 'Withdrawal', 'ETH', 4.2, 'out'],
  [2.3, 'Deposit', 'ETH', 1.5],
  [4, 'Deposit', 'USDT', 8000],
  [6.5, 'Withdrawal', 'USDC', 3100, 'out'],
  [11, 'Deposit', 'ppUSDC', 15000],
  [15, 'Deposit', 'ETH', 10],
  [22, 'Withdrawal', 'USDT', 950, 'out'],
];

function buildRow(r: Row, i: number, owner: string, idPrefix: string, now: number): Transaction {
  const [hoursAgo, type, sym, amount, direction, status = 'completed', review = 'approved'] = r;
  const t = TOKENS[sym];
  const usd = amount * t.price;
  const ts = now - hoursAgo * 3600_000;
  return {
    id: `${idPrefix}-${i}`,
    address: short(owner),
    fullAddress: owner,
    type,
    chain: CHAIN,
    chainId: CHAIN_ID,
    asset: sym,
    tokenAddress: t.address,
    rawAmount: rawUnits(amount, t.decimals),
    tokenAmount: amount,
    usdValue: usd,
    value: formatUsd(usd),
    timestamp: ts,
    status,
    txHash: hash(i + (idPrefix === 'mock-feed' ? 500 : 1)),
    reviewStatus: review,
    aspRoot: null,
    label: null,
    ...(direction ? { direction } : {}),
    ...(type !== 'Deposit' && idPrefix === 'mock-mine' ? { isLineageSynthetic: true } : {}),
  };
}

let cached: NativeMockPoolsValue | null = null;

export function getNativeMockPoolsValue(): NativeMockPoolsValue {
  if (cached) return cached;
  const now = Date.now();

  const myPools: MyPool[] = HOLDINGS.map((h) => {
    const t = TOKENS[h.sym];
    return {
      id: `${h.sym.toLowerCase()}-${CHAIN_ID}`,
      name: h.sym,
      tokenAddress: t.address,
      chainId: CHAIN_ID,
      balance: formatUsd(h.balance * t.price),
      balanceToken: tokenText(h.balance, h.sym),
      balanceTokenExact: String(h.balance),
      pending: formatUsd(h.pending * t.price),
      pendingToken: tokenText(h.pending, h.sym),
      pendingTokenExact: String(h.pending),
      poolAccounts: h.accounts,
    };
  });

  const totalUsd = HOLDINGS.reduce((s, h) => s + h.balance * TOKENS[h.sym].price, 0);
  const pendingUsd = HOLDINGS.reduce((s, h) => s + h.pending * TOKENS[h.sym].price, 0);

  // Deposits are made by the account itself; transfers and withdrawals show
  // the other side.
  const mine = MY_ROWS.map((r, i) => buildRow(r, i, r[1] === 'Deposit' ? ACCOUNT : OTHERS[(i + 2) % OTHERS.length], 'mock-mine', now));
  const myDeposits = mine.filter((t) => t.type === 'Deposit');
  const lineageRows = mine.filter((t) => t.type !== 'Deposit');
  const feed = FEED_ROWS.map((r, i) => buildRow(r, i, OTHERS[i % OTHERS.length], 'mock-feed', now));
  const transactions = [...myDeposits, ...feed].sort((a, b) => b.timestamp - a.timestamp);

  const tvl: Record<Sym, number> = { ETH: 1842.6, USDC: 4_812_300, USDT: 1_935_400, ppUSDC: 2_480_150 };
  const allPools: PoolEntry[] = (Object.keys(TOKENS) as Sym[]).map((sym, i) => {
    const t = TOKENS[sym];
    const usd = tvl[sym] * t.price;
    return {
      id: sym.toLowerCase(),
      name: sym,
      tokenAddress: t.address,
      chainId: CHAIN_ID,
      poolValue: formatUsd(usd),
      poolValueUsd: usd,
      poolValueToken: tokenText(tvl[sym], sym),
      poolValueTokenAmount: tvl[sym],
      fundsAccepted: formatUsd(usd * 1.38),
      change24h: ['+2.4%', '+0.8%', '+1.3%', '+3.1%'][i],
      privacyScore: [92, 88, 81, 76][i],
    };
  });

  const priceMap: Record<string, number> = {};
  for (const [sym, t] of Object.entries(TOKENS)) {
    priceMap[sym.toUpperCase()] = t.price;
    priceMap[t.address.toLowerCase()] = t.price;
  }

  const data: PoolsData = {
    myPools,
    myPoolsStats: {
      acceptedFundsValue: formatUsd(totalUsd),
      acceptedFundsUsd: totalUsd,
      acceptedFundsChange: '+1.8%',
      acceptedFundsLabel: 'past 24h',
      pendingValue: formatUsd(pendingUsd),
      pendingChange: '0%',
      totalDeposits: myDeposits.length,
      totalSwaps: 0,
      totalTransfers: mine.filter((t) => t.type === 'Transfer').length,
      totalWithdrawals: mine.filter((t) => t.type === 'Withdrawal').length,
      assets: HOLDINGS.map((h) => ({
        name: h.sym,
        color: COLORS[h.sym],
        percent: Math.round(((h.balance * TOKENS[h.sym].price) / totalUsd) * 100),
      })),
    },
    availableAssets: [],
    allPools,
    transactions,
    lineageRows,
    priceMap,
    pricesLoading: false,
    transferTxHashes: new Set(),
    swapRouteKinds: new Map(),
    anchorTxHashes: new Set(),
    transferClassificationReady: true,
    spendClassificationPending: false,
    holdingsReady: true,
    historyPendingChainIds: [],
    ownTransfersPendingChainIds: [],
    myDeposits: [],
    myExits: [],
    defaultChainId: CHAIN_ID,
    internalTxHashes: new Set(),
    unmatchedApprovedDeposits: [],
    depositOwnership: { notMine: new Set(), pending: new Set() },
  };

  const allTvlUsd = allPools.reduce((s, p) => s + p.poolValueUsd, 0);
  const value: NativeMockPoolsValue = {
    data,
    yieldEarned: new Map(),
    statistics: {
      allTime: { tvl: '0', tvlUsd: String(allTvlUsd), avgDepositSize: '0', avgDepositSizeUsd: '4820', totalDepositsCount: 18240, totalDepositsValue: '0', totalDepositsValueUsd: String(allTvlUsd * 1.38), totalWithdrawalsCount: 6415, totalWithdrawalsValue: '0', totalWithdrawalsValueUsd: String(allTvlUsd * 0.38), totalTransfersCount: 9120 },
      last24h: { tvl: '0', tvlUsd: String(allTvlUsd * 0.018), avgDepositSize: '0', avgDepositSizeUsd: '6150', totalDepositsCount: 142, totalDepositsValue: '0', totalDepositsValueUsd: String(allTvlUsd * 0.022), totalWithdrawalsCount: 51, totalWithdrawalsValue: '0', totalWithdrawalsValueUsd: String(allTvlUsd * 0.004), totalTransfersCount: 88 },
      cacheTimestamp: new Date(now).toISOString(),
    },
    isLoading: false,
    error: null,
  };
  cached = value;
  return value;
}

export function getNativeMockSession(): NativeMockSession {
  return {
    sessionAddress: ACCOUNT,
    identityMode: 'key',
    keysReady: true,
    isInitialized: true,
    isInitializing: false,
    isSyncing: false,
    error: null,
  };
}

export function getNativeMockWallet(): NativeMockWallet {
  return { isConnected: true, address: ACCOUNT, chainType: 'evm', chainId: CHAIN_ID, isSui: false, isStellar: false, isEvm: true, networkMismatch: false };
}

/** Public wallet balance shown on the Shield card, by token symbol. */
export function getNativeMockWalletBalance(symbol: string): string | null {
  return WALLET_BALANCES[symbol] ?? '0';
}
