import React from 'react';
import { View, Text, TextInput, Pressable, ScrollView, ViewStyle } from 'react-native';
import { Modal } from '@/components/ui/modal';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Card } from '@/components/ui/card';
import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { formatToken } from '@/components/payroll/format';

// The payroll design kit: payroll-local primitives built on this branch's
// tokens (and the shared Card), mirroring the ui-overhaul payroll kit's API —
// PCard / PBadge / PButton carry payroll's padding, tone-per-variant, and
// variant naming so the ~40 call sites don't each re-derive them; CardTitle /
// CardEmptyState / PSegmented / PChip / PInput / FormField / PIconButton /
// PModal / PPagination stand in for the shared kit primitives that don't
// exist on this branch. Prefer these within payroll.

export function useC() {
  const { colorScheme } = useTheme();
  return Colors[colorScheme];
}

/** Minimal class joiner (the branch has no shared cn helper). */
export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

export function shortAddr(a?: string | null): string {
  if (!a) return '—';
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

// Payroll figures are exact (no k/M abbreviation). Decimals are token-aware
// inside formatToken (ETH 4, stablecoins 2).
export function fmtToken(n: number, currency: string): string {
  return formatToken(n, currency, { abbreviate: false });
}

export function PCard({ children, style, className }: { children: React.ReactNode; style?: ViewStyle; className?: string }) {
  return (
    // nw-keep(forwarded-style-contract): caller style applied LAST (caller-last precedence)
    <Card className={cx('gap-0', className)} style={style}>
      {children}
    </Card>
  );
}

/** Section heading inside a PCard — the payroll stand-in for the kit's CardTitle. */
export function CardTitle({ children }: { children: React.ReactNode }) {
  return <Text className="font-pp-sans-semi-bold text-[15px] text-text">{children}</Text>;
}

/**
 * The centered empty/placeholder state for a card body: an optional bare icon,
 * an optional title, a muted line, and optional action(s) as children.
 */
export function CardEmptyState({ icon, title, description, children }: {
  icon?: keyof typeof Ionicons.glyphMap;
  title?: string;
  description: string;
  children?: React.ReactNode;
}) {
  const c = useC();
  return (
    <View className="items-center gap-[8px] py-[24px]">
      {/* nw-keep(data-color): muted glyph color (theme token) into the vector-icon color prop */}
      {icon ? <Ionicons name={icon} size={20} color={c.textMuted} /> : null}
      {title ? <Text className="font-pp-sans-semi-bold text-[14px] text-text">{title}</Text> : null}
      <Text className="max-w-[300px] text-center font-pp-sans text-[13px] leading-[20px] text-text-secondary">{description}</Text>
      {children}
    </View>
  );
}

export function PBadge({ label, variant = 'default', className }: { label: string; variant?: 'default' | 'success' | 'warning' | 'danger' | 'accent'; className?: string }) {
  const map: Record<string, { bg: string; fg: string }> = {
    default: { bg: 'bg-background-secondary', fg: 'text-text-secondary' },
    success: { bg: 'bg-success-bg', fg: 'text-success' },
    warning: { bg: 'bg-warning-bg', fg: 'text-warning' },
    danger: { bg: 'bg-danger-bg', fg: 'text-danger' },
    accent: { bg: 'bg-accent-soft', fg: 'text-accent' },
  };
  const { bg, fg } = map[variant] ?? map.default;
  // Status/network values arrive as lowercase enums ('active', 'in progress');
  // render them sentence-cased so the pills match the app's copy instead of
  // shouting a raw enum.
  const display = label.charAt(0).toUpperCase() + label.slice(1);
  return (
    // `self-start` keeps the pill from stretching in a column; a row that
    // centres its children passes `self-center`, or the pill rides the top edge
    // next to the amount (Matthew, QA 2026-08-31: Run payroll "Paid").
    <View className={cx(`rounded-[4px] px-[9px] py-[3px] ${bg}`, className ?? 'self-start')}>
      <Text className={`font-pp-sans-medium text-[11px] ${fg}`}>{display}</Text>
    </View>
  );
}

// The single stat-card shape kept for payroll surfaces that want a compact
// figure. `hint` is a one-line caption under the value (muted, or accent for an
// active/link tone); `children` slot in richer footers in its place.
export function StatCard({ label, value, hint, icon, hintTone = 'muted', children }: {
  label: string;
  value: string;
  hint?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  hintTone?: 'muted' | 'primary';
  children?: React.ReactNode;
}) {
  const c = useC();
  return (
    <Card noPadding className="min-w-[150px] flex-1 gap-[6px] p-[20px]">
      <View className="flex-row items-center justify-between gap-[8px]">
        <Text numberOfLines={1} className="font-pp-sans-medium text-[12px] text-text-secondary">{label}</Text>
        {/* nw-keep(data-color): muted glyph color (theme token) into the vector-icon color prop */}
        {icon ? <Ionicons name={icon} size={15} color={c.textMuted} /> : null}
      </View>
      <Text numberOfLines={1} className="font-pp-sans-bold text-[22px] text-text">{value}</Text>
      {hint ? (
        <Text numberOfLines={1} className={cx('text-[11px] font-pp-sans', hintTone === 'primary' ? 'text-accent' : 'text-text-muted')}>
          {hint}
        </Text>
      ) : null}
      {children}
    </Card>
  );
}

// Lightweight bar chart (no chart lib) — values normalized to the max. Each
// column is a faint recessed track holding an accent-tinted fill, so the
// series reads as a chart rather than a wall of solid blocks. The current
// column (the caller marks it) is drawn brighter to anchor "now".
export function MiniBars({
  data,
  height = 152,
  currentIndex,
  formatValue,
}: {
  data: { label: string; value: number }[];
  height?: number;
  /** Index to highlight as the current period (brighter fill). */
  currentIndex?: number;
  /** Render the bar's value above it (e.g. the fiat format). Omit for no value row. */
  formatValue?: (value: number) => string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    // nw-keep(measured-or-inset): chart height is a caller-driven dimension (runtime value)
    <View className="flex-row items-end gap-[8px]" style={{ height }}>
      {data.map((d, i) => {
        const pct = d.value > 0 ? Math.max(4, (d.value / max) * 100) : 0;
        const current = i === currentIndex;
        return (
          <View key={`${d.label}-${i}`} className="h-full flex-1 items-center gap-[6px]">
            {formatValue ? (
              <Text numberOfLines={1} className={cx('text-[10px]', current ? 'font-pp-sans-medium text-text' : 'font-pp-sans text-text-muted')}>
                {d.value > 0 ? formatValue(d.value) : ' '}
              </Text>
            ) : null}
            <View className="w-full flex-1 justify-end overflow-hidden rounded-[6px] bg-background-secondary">
              {pct > 0 ? (
                <View
                  className={cx('w-full rounded-[6px] bg-accent', !current && 'opacity-[0.35]')}
                  // nw-keep(measured-or-inset): bar height is the value normalized to the series max (runtime %)
                  style={{ height: `${pct}%`, minHeight: 4 }}
                />
              ) : null}
            </View>
            <Text numberOfLines={1} className={cx('text-[10px]', current ? 'font-pp-sans-medium text-text' : 'font-pp-sans text-text-muted')}>{d.label}</Text>
          </View>
        );
      })}
    </View>
  );
}

export function PButton({ label, onPress, variant = 'primary', size = 'sm', icon, disabled, className, style }: {
  label: string; onPress: () => void; variant?: 'primary' | 'outline' | 'danger'; size?: 'sm' | 'default';
  icon?: keyof typeof Ionicons.glyphMap; disabled?: boolean; className?: string; style?: ViewStyle;
}) {
  const c = useC();
  // Match the icon to each variant's label color: white on the danger fill,
  // the primary-button foreground on the filled primary, plain text on outline.
  const fg = variant === 'outline' ? c.text : variant === 'danger' ? '#FFFFFF' : c.buttonPrimaryText;
  const bgClass = variant === 'primary' ? 'bg-button-primary' : variant === 'danger' ? 'bg-danger' : 'bg-transparent';
  const fgClass = variant === 'outline' ? 'text-text' : variant === 'danger' ? 'text-[#FFFFFF]' : 'text-button-primary-text';
  const sizeClass = size === 'default' ? 'px-[18px] py-[12px]' : 'px-[14px] py-[9px]';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      className={cx(
        'flex-row items-center justify-center gap-[7px] rounded-control',
        sizeClass,
        bgClass,
        variant === 'outline' && 'border border-border-light',
        disabled ? 'opacity-50' : 'opacity-100',
        className,
      )}
      // nw-keep(forwarded-style-contract): caller style applied LAST (caller-last precedence)
      style={style}
    >
      {/* nw-keep(data-color): variant fg (theme token / fixed danger white) into the vector-icon color prop */}
      {icon ? <Ionicons name={icon} size={15} color={fg} /> : null}
      <Text className={`font-pp-sans-semi-bold text-[13px] ${fgClass}`}>{label}</Text>
    </Pressable>
  );
}

/** Soft square icon button (edit/delete row actions, pager chevrons). */
export function PIconButton({ name, onPress, tone = 'foreground', size = 16, disabled, accessibilityLabel }: {
  name: keyof typeof Ionicons.glyphMap;
  onPress: () => void;
  tone?: 'foreground' | 'muted' | 'danger';
  size?: number;
  disabled?: boolean;
  accessibilityLabel: string;
}) {
  const c = useC();
  const color = tone === 'danger' ? c.danger : tone === 'muted' ? c.textMuted : c.text;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      className={cx('h-[30px] w-[30px] items-center justify-center rounded-[6px] bg-background-secondary', disabled && 'opacity-40')}
    >
      {/* nw-keep(data-color): tone color (theme token) into the vector-icon color prop */}
      <Ionicons name={name} size={size} color={color} />
    </Pressable>
  );
}

/** Text input with the payroll field chrome. */
export function PInput({ value, onChangeText, placeholder, keyboardType, className }: {
  value: string;
  onChangeText: (s: string) => void;
  placeholder?: string;
  keyboardType?: 'default' | 'numeric';
  className?: string;
}) {
  const c = useC();
  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
      placeholderTextColor={c.textMuted}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType={keyboardType ?? 'default'}
      className={cx('rounded-control border border-border-light px-[14px] py-[11px] font-pp-regular text-[13px] text-text', className)}
    />
  );
}

/** Labeled form row (field label over its control). */
export function FormField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View className="gap-[6px]">
      <Text className="font-pp-sans-medium text-[11px] tracking-[0.3px] text-text-muted">{label}</Text>
      {children}
    </View>
  );
}

/** Selectable filter/option chip. */
export function PChip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      className={cx('rounded-control border px-[12px] py-[6px]', selected ? 'border-button-primary bg-button-primary' : 'border-border-light bg-transparent')}
    >
      <Text className={cx('font-pp-sans-medium text-[12px]', selected ? 'text-button-primary-text' : 'text-text')}>{label}</Text>
    </Pressable>
  );
}

export type SegmentedOption<T extends string> = { value: T; label: string };

/**
 * Raised-thumb segmented value selector: a muted track with the active segment
 * lifted onto a card-background chip — the payroll stand-in for the kit's
 * SegmentedControl.
 */
export function PSegmented<T extends string>({ options, value, onChange }: {
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View className="flex-row items-center gap-[2px] self-start rounded-[8px] bg-background-secondary p-[3px]">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            onPress={() => onChange(opt.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            className={cx('rounded-[6px] px-[10px] py-[5px]', active && 'bg-card-background')}
          >
            <Text className={cx('text-[12px]', active ? 'font-pp-sans-semi-bold text-text' : 'font-pp-sans-medium text-text-secondary')}>{opt.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * Chevron pager for paged card lists: soft icon-button chevrons around a muted
 * "Page N of M" readout. `page` is 1-based. Renders nothing with a single
 * page, so consumers can mount it unconditionally.
 */
export function PPagination({ page, pageCount, onChange, className }: {
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  className?: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <View className={cx('flex-row items-center justify-between', className)}>
      <PIconButton name="chevron-back" tone="muted" accessibilityLabel="Previous page"
        onPress={() => onChange(Math.max(1, page - 1))} disabled={page <= 1} />
      <Text className="font-pp-sans text-[12px] text-text-secondary">Page {page} of {pageCount}</Text>
      <PIconButton name="chevron-forward" tone="muted" accessibilityLabel="Next page"
        onPress={() => onChange(Math.min(pageCount, page + 1))} disabled={page >= pageCount} />
    </View>
  );
}

/**
 * The payroll modal shell: scrim, centered card, title/description header with
 * the standard close control, scrolling body, fixed footer row. Stand-in for
 * the kit's Modal.
 */
export function PModal({ visible, onClose, title, description, footer, children }: {
  visible: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  footer?: React.ReactNode;
  children: React.ReactNode;
}) {
  const c = useC();
  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={onClose}>
      <View className="flex-1 items-center justify-center bg-overlay p-[20px]">
        <View className="w-full max-w-[480px] gap-[14px] rounded-card border border-border bg-card-background p-[22px]">
          <View className="flex-row items-start justify-between gap-[12px]">
            <View className="min-w-0 flex-1 gap-[3px]">
              <Text className="font-pp-bold text-[18px] text-text">{title}</Text>
              {description ? <Text className="font-pp-regular text-[12px] leading-[18px] text-text-secondary">{description}</Text> : null}
            </View>
            <Pressable className="h-[34px] w-[34px] shrink-0 items-center justify-center rounded-control border border-border-light" onPress={onClose} accessibilityRole="button" accessibilityLabel="Close">
              {/* nw-keep(data-color): close glyph color (theme token) into the vector-icon color prop */}
              <Ionicons name="close" size={18} color={c.text} />
            </Pressable>
          </View>

          <ScrollView className="max-h-[460px]" contentContainerClassName="gap-[12px]">
            {children}
          </ScrollView>

          {footer ? <View className="flex-row gap-[10px]">{footer}</View> : null}
        </View>
      </View>
    </Modal>
  );
}
