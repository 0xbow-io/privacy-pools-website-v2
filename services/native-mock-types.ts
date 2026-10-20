import type { PoolsData } from '@/components/pools-provider';
import type { GlobalStatistics } from '@/services/api-types';
import type { YieldEarnedByShare } from '@/services/yield-earned';

export type NativeMockPoolsValue = {
  data: PoolsData;
  yieldEarned: YieldEarnedByShare;
  statistics: GlobalStatistics;
  isLoading: false;
  error: null;
};

export type NativeMockSession = {
  sessionAddress: string;
  identityMode: 'key';
  keysReady: true;
  isInitialized: true;
  isInitializing: false;
  isSyncing: false;
  error: null;
};

export type NativeMockWallet = {
  isConnected: true;
  address: string;
  chainType: 'evm';
  chainId: number;
  isSui: false;
  isStellar: false;
  isEvm: true;
  networkMismatch: false;
};
