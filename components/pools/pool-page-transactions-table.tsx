import { useCallback, useRef, useState } from 'react';
import { ExplorerPrivacyHint } from '@/components/ui/explorer-privacy-hint';
import { View, Text, Pressable, Platform, Linking, useWindowDimensions } from 'react-native';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { TransactionDetailModal } from '@/components/pools/transactions';
import type { Transaction } from '@/components/pools-provider';
import { getExplorerName, getExplorerTxUrl } from '@/config/chains';
import { useWithdrawModal } from '@/components/withdraw-modal-provider';
import { useRagequitModal } from '@/components/ragequit-modal-provider';
import {
  OverflowMenuIcon,
  FilterChevronIcon,
  CheckmarkIcon,
  PendingIcon,
  FailedIcon,
  ExitIcon,
  WEB_FIXED_POSITION,
  useEscapeToClose,
  type TxRow,
} from './pool-page-shared';
import { displayTokenSymbol } from '@/services/share-display';

const MOBILE_TABLE_BREAKPOINT = 600;

const DATE_FILTER_OPTIONS = ['All', 'Today', 'This Week', 'This Month', 'This Year'];
const AMOUNT_FILTER_OPTIONS = ['All', '< $100', '$100 - $1K', '$1K - $10K', '> $10K'];
const STATUS_FILTER_OPTIONS = ['All', 'Completed', 'Pending', 'Failed', 'Exit'];

type Props = {
  isConnected: boolean;
  rows: TxRow[];
  dateFilter: string;
  amountFilter: string;
  statusFilter: string;
  onDateFilterChange: (v: string) => void;
  onAmountFilterChange: (v: string) => void;
  onStatusFilterChange: (v: string) => void;
};

// Per-row overflow button. Owns its own ref so we can read the button's
// viewport rect at click time — used ONLY to decide whether the dropdown
// should flip upward. The dropdown's actual placement is still handled by
// absolute styles inside the cell, so anchoring is unaffected if the rect
// can't be measured.
function OverflowButton({
  onPress,
  backgroundColor,
  iconColor,
}: {
  onPress: (rect: DOMRect | null) => void;
  backgroundColor: string;
  iconColor: string;
}) {
  const ref = useRef<View>(null);
  return (
    <Pressable
      ref={ref}
      className="h-[24px] w-[24px] items-center justify-center rounded-card"
      // nw-keep(data-color): caller-provided scheme-resolved button background (runtime prop, non-token)
      style={{ backgroundColor }}
      onPress={() => {
        let rect: DOMRect | null = null;
        if (Platform.OS === 'web' && ref.current) {
          const node = ref.current as unknown as Element;
          if (typeof node.getBoundingClientRect === 'function') {
            rect = node.getBoundingClientRect();
          }
        }
        onPress(rect);
      }}
    >
      <OverflowMenuIcon color={iconColor} />
    </Pressable>
  );
}

function TxActionMenu({
  tx,
  flipUp,
  onClose,
  onViewDetails,
  onWithdraw,
  onExit,
}: {
  tx: TxRow;
  flipUp: boolean;
  onClose: () => void;
  onViewDetails: (tx: Transaction) => void;
  onWithdraw: (tx: Transaction) => void;
  onExit: (tx: Transaction) => void;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  return (
    <View
      className={`absolute right-0 z-[99999] min-w-[180px] rounded-card border border-border-light bg-menu-background p-[6px] ${flipUp ? 'bottom-[28px]' : 'top-[28px]'}`}
      // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
      style={DROPDOWN_SHADOW}
    >
        <Pressable className="flex-row items-center gap-[8px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={() => { onClose(); onViewDetails(tx.source); }}>
          {/* nw-keep(data-color): text-color token into the vector-icon color prop (non-class sink) */}
          <Ionicons name="eye-outline" size={16} color={colors.text} />
          <Text className="text-[14px] text-text font-pp-regular">View Details</Text>
        </Pressable>
        <Pressable className="flex-row items-center gap-[8px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={() => { onClose(); if (tx.txHash) Linking.openURL(getExplorerTxUrl(tx.chainId, tx.txHash)); }}>
          {/* DEV-573: red triangle, the privacy note shows on hover or tap. */}
          <ExplorerPrivacyHint explorerName={getExplorerName(tx.chainId)} size={16} />
          <Text className="text-[14px] text-text font-pp-regular">View on {getExplorerName(tx.chainId)}</Text>
        </Pressable>
        {tx.status === 'completed' && (
          <Pressable className="flex-row items-center gap-[8px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={() => { onClose(); onWithdraw(tx.source); }}>
            {/* nw-keep(data-color): text-color token into the vector-icon color prop (non-class sink) */}
            <Ionicons name="arrow-up-outline" size={16} color={colors.text} />
            <Text className="text-[14px] text-text font-pp-regular">Withdraw</Text>
          </Pressable>
        )}
        {(tx.status === 'completed' || tx.status === 'pending') && (
          <Pressable className="flex-row items-center gap-[8px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary" onPress={() => { onClose(); onExit(tx.source); }}>
            {/* nw-keep(svg-or-canvas): fixed exit-red into the SVG icon color prop */}
            <ExitIcon color="#BA6B5D" />
            <Text className="text-[14px] font-pp-regular text-[#BA6B5D]">Exit</Text>
          </Pressable>
        )}
    </View>
  );
}

// Per-scheme status tints (matches STATUS_CONFIG in transactions.tsx):
// translucent bg over the scheme's surfaces, pastel icon on dark glass,
// deep icon on the light canvas.
const STATUS_TINTS: Record<'light' | 'dark', Record<TxRow['status'], { bg: string; fg: string }>> = {
  dark: {
    completed: { bg: 'rgba(0,218,248,0.16)', fg: '#7BE8FA' },
    pending: { bg: 'rgba(232,163,61,0.16)', fg: '#E8A33D' },
    failed: { bg: 'rgba(255,180,171,0.16)', fg: '#FFB4AB' },
  },
  light: {
    completed: { bg: 'rgba(0,218,248,0.12)', fg: '#006877' },
    pending: { bg: 'rgba(245,172,55,0.16)', fg: '#9A6A0B' },
    failed: { bg: 'rgba(186,26,26,0.10)', fg: '#BA1A1A' },
  },
};

function StatusBadge({ status }: { status: TxRow['status'] }) {
  const { colorScheme } = useTheme();
  const tint = STATUS_TINTS[colorScheme][status];
  const Icon = status === 'completed' ? CheckmarkIcon : status === 'failed' ? FailedIcon : PendingIcon;
  return (
    // nw-keep(data-color): per-scheme/per-status tint bg (runtime STATUS_TINTS lookup, non-token literal)
    <View className="h-[24px] w-[24px] items-center justify-center rounded-full" style={{ backgroundColor: tint.bg }}>
      {/* nw-keep(data-color): matching status tint into the SVG icon color prop (non-class sink) */}
      <Icon color={tint.fg} />
    </View>
  );
}

export function PoolPageTransactionsTable({
  isConnected,
  rows,
  dateFilter,
  amountFilter,
  statusFilter,
  onDateFilterChange,
  onAmountFilterChange,
  onStatusFilterChange,
}: Props) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { width } = useWindowDimensions();
  const isCompact = width < MOBILE_TABLE_BREAKPOINT;
  const { openWithdrawModal } = useWithdrawModal();
  const { openRagequitModal } = useRagequitModal();

  const [openTxFilter, setOpenTxFilter] = useState<string | null>(null);
  const [openTxMenuId, setOpenTxMenuId] = useState<number | null>(null);
  const [openMenuFlipUp, setOpenMenuFlipUp] = useState(false);
  const [detailTx, setDetailTx] = useState<Transaction | null>(null);

  const closeTxMenu = useCallback(() => setOpenTxMenuId(null), []);

  useEscapeToClose(useCallback(() => {
    setOpenTxFilter(null);
    closeTxMenu();
  }, [closeTxMenu]), openTxFilter !== null || openTxMenuId !== null);

  // Default to opening downward; flip up only when the dropdown wouldn't fit
  // below the button in the current viewport. Anchor placement is unaffected
  // — that's still done by absolute styles inside the action cell.
  const toggleTxMenu = useCallback((menuId: number, buttonRect: DOMRect | null) => {
    if (openTxMenuId === menuId) {
      setOpenTxMenuId(null);
      return;
    }
    let flipUp = false;
    if (Platform.OS === 'web' && buttonRect && typeof window !== 'undefined') {
      const ESTIMATED_MENU_HEIGHT = 180;
      const VIEWPORT_MARGIN = 12;
      const spaceBelow = window.innerHeight - buttonRect.bottom;
      flipUp = spaceBelow < ESTIMATED_MENU_HEIGHT + VIEWPORT_MARGIN;
    }
    setOpenMenuFlipUp(flipUp);
    setOpenTxMenuId(menuId);
  }, [openTxMenuId]);

  const renderFilter = (key: string, label: string, value: string, options: string[], onChange: (v: string) => void) => (
    <View className="relative overflow-visible z-[99999]">
      <Pressable className="flex-row items-center gap-[4px]" onPress={() => setOpenTxFilter(openTxFilter === key ? null : key)}>
        <Text className="text-[12px] text-text-secondary font-pp-regular">
          {label}: {value}
        </Text>
        {/* nw-keep(data-color): secondary-text token into the SVG chevron color prop (non-class sink) */}
        <FilterChevronIcon color={colors.textSecondary} />
      </Pressable>
      {openTxFilter === key && (
        <>
          {/* nw-keep(platform-css): web-only position:fixed backdrop (WEB_FIXED_POSITION) — no className path */}
          <Pressable className="inset-0 z-[9998]" style={WEB_FIXED_POSITION} onPress={() => setOpenTxFilter(null)} />
          <View
            className="absolute top-[24px] left-0 z-[99999] min-w-[150px] rounded-card border border-border-light bg-menu-background p-[6px]"
            // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
            style={DROPDOWN_SHADOW}
          >
            {options.map((opt) => (
              <Pressable
                key={opt}
                className="rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                onPress={() => { onChange(opt); setOpenTxFilter(null); }}
              >
                <Text className="text-[14px] text-text font-pp-regular">
                  {opt}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      )}
    </View>
  );

  return (
    <>
      <View className="-mt-[1px]">
        <View className="border p-[16px] gap-[8px] overflow-visible z-[99999] border-border bg-card-background">
          <View className="flex-row items-center gap-[8px]">
            <Text className="text-[16px] text-text font-pp-bold">
              {isConnected ? 'My Transactions' : 'Pool Transactions History'}
            </Text>
            <Text className="text-[12px] mt-[2px] text-text font-pp-bold">
              ({rows.length})
            </Text>
          </View>
          <View className="flex-row items-center justify-between overflow-visible flex-wrap gap-[8px]">
            <View className="flex-row items-center gap-[16px] overflow-visible flex-wrap">
              {renderFilter('date', 'Date', dateFilter, DATE_FILTER_OPTIONS, onDateFilterChange)}
              {renderFilter('amount', 'Amount', amountFilter, AMOUNT_FILTER_OPTIONS, onAmountFilterChange)}
              {renderFilter('status', 'Status', statusFilter, STATUS_FILTER_OPTIONS, onStatusFilterChange)}
            </View>
            <Pressable
              onPress={() => {
                onDateFilterChange('All');
                onAmountFilterChange('All');
                onStatusFilterChange('All');
              }}
            >
              <Text className="text-[14px] underline font-pp-regular text-[rgba(32,34,36,0.5)] dark:text-[rgba(255,255,255,0.5)]">
                Reset Filters
              </Text>
            </Pressable>
          </View>
        </View>

        <View className={`border-l border-r border-b border-t-0 px-[16px] py-[8px] overflow-visible bg-card-background border-[#000000] dark:border-border${openTxMenuId !== null ? ' z-[100000]' : ''}`}>
          {isCompact ? (
            <View className="flex-row items-center gap-[8px] h-[29px]">
              <View className="flex-[1.4] px-[8px]">
                <Text className="text-[10px] uppercase text-[#999999] font-pp-semi-bold">ASSET</Text>
              </View>
              <View className="flex-1 flex-row items-center justify-end gap-[6px] px-[8px]">
                <Text className="text-[10px] uppercase text-[#999999] font-pp-semi-bold">VALUE</Text>
              </View>
              <View className="w-[40px] px-[8px]" />
            </View>
          ) : (
            <View className="flex-row items-center gap-[8px] h-[29px]">
              <View className="w-[80px] px-[8px]">
                <Text className="text-[10px] uppercase text-[#999999] font-pp-semi-bold">ASSET</Text>
              </View>
              <View className="flex-1 px-[8px]">
                <Text className="text-[10px] uppercase text-[#999999] font-pp-semi-bold">DATE-TIME</Text>
              </View>
              <View className="flex-1 px-[8px]">
                <Text className="text-[10px] uppercase text-[#999999] font-pp-semi-bold">TOTAL VALUE</Text>
              </View>
              <View className="w-[52px] px-[8px]">
                <Text className="text-[10px] uppercase text-[#999999] font-pp-semi-bold">STATUS</Text>
              </View>
              <View className="w-[40px] px-[8px]" />
            </View>
          )}

          {rows.map((tx, i) => (
            <View key={i} className={openTxMenuId === i ? 'relative overflow-visible z-[99999]' : 'relative overflow-visible z-[1]'}>
              {i > 0 && <View className="h-[1px] self-stretch bg-border-light" />}
              {isCompact ? (
                <View className="flex-row items-center gap-[8px] min-h-[48px] py-[6px] overflow-visible">
                  <View className="flex-[1.4] px-[8px]">
                    <View className="flex-row items-center gap-[8px]">
                      <tx.icon size={20} />
                      <View className="flex-1 gap-[2px]">
                        <Text className="text-[12px] text-text-secondary font-pp-regular">
                          {displayTokenSymbol(tx.asset)}
                        </Text>
                        <Text className="text-[10px] text-text-secondary font-pp-regular" numberOfLines={1}>
                          {tx.date}
                        </Text>
                      </View>
                    </View>
                  </View>
                  <View className="flex-1 flex-row items-center justify-end gap-[6px] px-[8px]">
                    <Text className="text-[12px] text-text-secondary font-pp-regular" numberOfLines={1}>
                      {tx.value}
                    </Text>
                    <View className="shrink-0">
                      <StatusBadge status={tx.status} />
                    </View>
                  </View>
                  <View className="w-[40px] items-center justify-center relative overflow-visible z-[99999] px-[8px]">
                    <OverflowButton
                      backgroundColor={colorScheme === 'dark' ? '#333333' : '#FAFAFA'}
                      iconColor={colorScheme === 'dark' ? colors.text : '#000000'}
                      onPress={(rect) => toggleTxMenu(i, rect)}
                    />
                    {openTxMenuId === i && (
                      <TxActionMenu
                        tx={tx}
                        flipUp={openMenuFlipUp}
                        onClose={closeTxMenu}
                        onViewDetails={setDetailTx}
                        onWithdraw={openWithdrawModal}
                        onExit={openRagequitModal}
                      />
                    )}
                  </View>
                </View>
              ) : (
                <View className="flex-row items-center gap-[8px] h-[40px] overflow-visible">
                  <View className="w-[80px] flex-row items-center gap-[4px] px-[8px] py-[4px]">
                    <tx.icon size={20} />
                    <Text className="text-[12px] text-text-secondary font-pp-regular">
                      {displayTokenSymbol(tx.asset)}
                    </Text>
                  </View>
                  <View className="flex-1 px-[8px] py-[10px]">
                    <Text className="text-[12px] text-text-secondary font-pp-regular">
                      {tx.date}
                    </Text>
                  </View>
                  <View className="flex-1 px-[8px] py-[10px]">
                    <Text className="text-[12px] text-text-secondary font-pp-regular">
                      {tx.value}
                    </Text>
                  </View>
                  <View className="w-[52px] items-center justify-center px-[8px]">
                    <StatusBadge status={tx.status} />
                  </View>
                  <View className="w-[40px] items-center justify-center relative overflow-visible z-[99999] px-[8px]">
                    <OverflowButton
                      backgroundColor={colorScheme === 'dark' ? '#333333' : '#FAFAFA'}
                      iconColor={colorScheme === 'dark' ? colors.text : '#000000'}
                      onPress={(rect) => toggleTxMenu(i, rect)}
                    />
                    {openTxMenuId === i && (
                      <TxActionMenu
                        tx={tx}
                        flipUp={openMenuFlipUp}
                        onClose={closeTxMenu}
                        onViewDetails={setDetailTx}
                        onWithdraw={openWithdrawModal}
                        onExit={openRagequitModal}
                      />
                    )}
                  </View>
                </View>
              )}
            </View>
          ))}
        </View>
      </View>

      {detailTx && <TransactionDetailModal tx={detailTx} onClose={() => setDetailTx(null)} />}
    </>
  );
}

