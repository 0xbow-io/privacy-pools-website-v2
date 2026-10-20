import Ionicons from '@expo/vector-icons/Ionicons';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, View } from 'react-native';

import { useTheme } from '@/components/theme-provider';
import { TooltipPortal } from '@/components/ui/tooltip-portal';
import { getChainConfig } from '@/config/chains';
import { Colors } from '@/constants/theme';
import { formatFeePercent, type FeeBreakdown, type FeeComponent } from '@/services/fee-warning';
import { formatUsdPrecise } from '@/services/format-fiat';

export const WAIT_FOR_LOWER_GAS = 'Gas costs are high! Consider waiting to lower your transaction fee.';

const NETWORK_DOMINANT_SHARE = 0.5;

const usd = (n: number) => (n > 0 && n < 0.01 ? '<$0.01' : formatUsdPrecise(n));

const partial = (b: FeeBreakdown) => b.unpriced.length > 0;

const feeFigure = (b: FeeBreakdown) => (b.showPercent ? `${formatFeePercent(b.pct)} of the amount` : usd(b.totalUsd));

export function feeWarningTitle(b: FeeBreakdown): string {
  if (partial(b)) return `High fee: at least ${feeFigure(b)}`;
  const what = b.networkShare >= NETWORK_DOMINANT_SHARE ? 'High network fee' : 'High fee';
  return `${what}: ${feeFigure(b)}`;
}

const LABELS: Record<FeeComponent, string> = {
  network: 'Network cost',
  swap: 'Swap, bridge & protocol',
  service: 'Relayer fee',
};

function totalLine(b: FeeBreakdown): { label: string; value: string } {
  return {
    label: partial(b) ? 'Fees priced so far' : 'Total fee',
    value: b.showPercent ? `${usd(b.totalUsd)} · ${formatFeePercent(b.pct)} of ${usd(b.amountUsd)}` : usd(b.totalUsd),
  };
}

function gasDetail(b: FeeBreakdown): string | null {
  const parts = b.gas
    .filter((g) => g.gwei !== null)
    .map((g) => `${getChainConfig(g.chainId)?.displayName ?? `Chain ${g.chainId}`} ${g.gwei} gwei`);
  return parts.length ? parts.join(' · ') : null;
}

type Line = { label: string; value: string; detail?: string | null; emphasis?: boolean };

export function feeBreakdownLines(b: FeeBreakdown): Line[] {
  const lines: Line[] = [];
  if (b.networkUsd !== null) {
    const share = b.totalUsd > 0 && !partial(b) ? ` (${Math.round(b.networkShare * 100)}% of fee)` : '';
    lines.push({ label: LABELS.network, value: `${usd(b.networkUsd)}${share}`, detail: gasDetail(b), emphasis: true });
  }
  if (b.swapUsd !== null && b.swapUsd >= 0.005) lines.push({ label: LABELS.swap, value: usd(b.swapUsd) });
  if (b.serviceUsd !== null && b.serviceUsd >= 0.005) lines.push({ label: LABELS.service, value: usd(b.serviceUsd) });
  for (const name of b.unpriced) lines.push({ label: LABELS[name], value: 'Not priced' });
  return lines;
}

function BreakdownBody({ b, onDark }: { b: FeeBreakdown; onDark: boolean }) {
  const strong = onDark ? 'text-white' : 'text-text';
  const muted = onDark ? 'text-[#B9B4AA]' : 'text-text-muted';
  const accent = b.level === 'second' ? (onDark ? 'text-[#F2A18F]' : 'text-danger') : (onDark ? 'text-[#F4C46B]' : 'text-warning');
  return (
    <View className="gap-[6px]">
      {feeBreakdownLines(b).map((line) => (
        <View key={line.label} className="gap-[2px]">
          <View className="flex-row justify-between gap-[12px]">
            <Text className={`text-[12px] leading-[16px] font-pp-medium ${line.emphasis ? accent : strong}`}>{line.label}</Text>
            <Text className={`text-[12px] leading-[16px] font-pp-medium ${line.emphasis ? accent : strong}`}>{line.value}</Text>
          </View>
          {line.detail ? <Text className={`text-[11px] leading-[14px] font-pp-regular ${muted}`}>{line.detail}</Text> : null}
        </View>
      ))}
      <View className={`h-px ${onDark ? 'bg-[#3A3B3E]' : 'bg-border'}`} />
      <View className="flex-row justify-between gap-[12px]">
        <Text className={`text-[12px] leading-[16px] font-pp-semi-bold ${strong}`}>{totalLine(b).label}</Text>
        <Text className={`text-[12px] leading-[16px] font-pp-semi-bold ${strong}`}>{totalLine(b).value}</Text>
      </View>
      {b.suggestWaiting ? (
        <Text className={`text-[12px] leading-[16px] font-pp-regular ${accent}`}>{WAIT_FOR_LOWER_GAS}</Text>
      ) : null}
    </View>
  );
}

function accessibleSummary(b: FeeBreakdown): string {
  const lines = feeBreakdownLines(b).map((l) => `${l.label} ${l.value}${l.detail ? `, ${l.detail}` : ''}`);
  const total = totalLine(b);
  lines.push(`${total.label} ${total.value}`);
  if (b.suggestWaiting) lines.push(WAIT_FOR_LOWER_GAS);
  return lines.join('. ');
}

/**
 * The fee-share warning beside an action's fee line. Advisory only: it never
 * blocks confirm. The breakdown opens on hover, or on tap where there is no
 * hover; on native it expands in place.
 */
export function FeeWarning({ breakdown, testID = 'fee-warning' }: { breakdown: FeeBreakdown | null | undefined; testID?: string }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const [anchor, setAnchor] = useState<{ x: number; top: number; bottom: number } | null>(null);
  const [shown, setShown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const nodeRef = useRef<View | null>(null);
  const web = Platform.OS === 'web';

  const open = useCallback(() => {
    const el = nodeRef.current as unknown as { getBoundingClientRect?: () => DOMRect } | null;
    if (!el?.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    setAnchor({ x: r.left + Math.min(r.width / 2, 140), top: r.top, bottom: r.bottom });
  }, []);
  const close = useCallback(() => {
    setAnchor(null);
    setShown(false);
  }, []);

  const hovering = anchor !== null;
  useEffect(() => {
    if (!hovering || !web || typeof window === 'undefined') return;
    const raf = requestAnimationFrame(() => setShown(true));
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [hovering, web, close]);

  if (!breakdown || breakdown.level === 'none') return null;

  const severe = breakdown.level === 'second';
  const tone = severe ? 'text-danger' : 'text-warning';
  const openAbove = anchor === null || anchor.top > 220;
  const left = typeof window === 'undefined' ? anchor?.x ?? 0 : Math.max(148, Math.min(anchor?.x ?? 0, window.innerWidth - 148));
  // nw-keep(platform-css): web-only breakdown bubble, viewport-fixed off the measured anchor rect; it lives in <body> where no className path positions it.
  const bubble: React.CSSProperties = {
    position: 'fixed',
    left,
    top: openAbove ? (anchor?.top ?? 0) - 6 : (anchor?.bottom ?? 0) + 6,
    transform: openAbove ? 'translate(-50%, -100%)' : 'translate(-50%, 0)',
    width: 280,
    background: '#1A1B1D',
    padding: '10px 12px',
    borderRadius: 6,
    pointerEvents: 'none',
    opacity: shown ? 1 : 0,
    transition: 'opacity 120ms ease',
    zIndex: 100000,
    boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
  };

  return (
    <View className="w-full">
      <Pressable
        ref={nodeRef}
        onHoverIn={web ? open : undefined}
        onHoverOut={web ? close : undefined}
        onPress={() => {
          if (web) {
            if (anchor) close();
            else open();
          } else {
            setExpanded((e) => !e);
          }
        }}
        accessibilityRole="button"
        accessibilityLabel={feeWarningTitle(breakdown)}
        accessibilityHint={accessibleSummary(breakdown)}
        accessibilityState={web ? undefined : { expanded }}
        testID={testID}
        className="flex-row items-center gap-[6px] self-start"
      >
        {/* nw-keep(data-color): glyph color is a runtime theme token (vector-icon sink) */}
        <Ionicons name="warning-outline" size={14} color={severe ? colors.danger : colors.warning} />
        <Text className={`text-[12px] leading-[17px] font-pp-medium ${tone}`}>{feeWarningTitle(breakdown)}</Text>
        {/* nw-keep(data-color): glyph color is a runtime theme token (vector-icon sink) */}
        <Ionicons name="information-circle-outline" size={13} color={severe ? colors.danger : colors.warning} />
      </Pressable>
      {!web && expanded ? (
        <View className={`mt-[8px] rounded-inner border px-[12px] py-[10px] ${severe ? 'border-danger bg-danger-bg' : 'border-warning bg-warning-bg'}`}>
          <BreakdownBody b={breakdown} onDark={false} />
        </View>
      ) : null}
      {web && anchor ? (
        <TooltipPortal>
          {React.createElement('div', { style: bubble, role: 'tooltip', 'data-testid': `${testID}-breakdown` }, <BreakdownBody b={breakdown} onDark />)}
        </TooltipPortal>
      ) : null}
    </View>
  );
}
