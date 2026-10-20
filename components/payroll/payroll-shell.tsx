import React, { useState } from 'react';
import { View, Text, ScrollView, Pressable, Platform, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter, type Href } from 'expo-router';

import { Header } from '@/components/ui/header';
import { DROPDOWN_SHADOW } from '@/components/ui/web-style-shims';
import { Footer } from '@/components/ui/footer';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { cx } from '@/components/payroll/ui';

export type PayrollTab = 'dashboard' | 'employees' | 'run' | 'history' | 'settings';

const TABS: { key: PayrollTab; label: string; icon: keyof typeof Ionicons.glyphMap; href: Href }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'grid-outline', href: '/payroll' as Href },
  { key: 'employees', label: 'Team', icon: 'people-outline', href: '/payroll/employees' as Href },
  { key: 'run', label: 'Run payroll', icon: 'paper-plane-outline', href: '/payroll/run' as Href },
  { key: 'history', label: 'History', icon: 'time-outline', href: '/payroll/history' as Href },
  { key: 'settings', label: 'Settings', icon: 'settings-outline', href: '/payroll/settings' as Href },
];

export function PayrollShell({ active, title, subtitle, children }: {
  active: PayrollTab; title: string; subtitle?: string; children: React.ReactNode;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const router = useRouter();
  const { width } = useWindowDimensions();
  const [moreOpen, setMoreOpen] = useState(false);
  // Below this width the tabs don't fit, so Run Payroll / History / Settings
  // collapse into a "More" dropdown instead of being cut off the screen edge.
  const compactTabs = width < 820;
  const primaryKeys: PayrollTab[] = ['dashboard', 'employees'];
  const primaryTabs = compactTabs ? TABS.filter((t) => primaryKeys.includes(t.key)) : TABS;
  const overflowTabs = compactTabs ? TABS.filter((t) => !primaryKeys.includes(t.key)) : [];
  const overflowActive = overflowTabs.some((t) => t.key === active);

  // Raised-thumb segmented nav: a muted track with the active tab lifted onto
  // a card-background chip, not a solid-primary fill.
  const navItem = (isActive: boolean) => cx(
    'flex-row items-center gap-[7px] rounded-[6px] px-[12px] py-[7px]',
    isActive && 'bg-card-background',
  );
  const navText = (isActive: boolean) => cx(
    'text-[13px]',
    isActive ? 'font-pp-sans-semi-bold text-text' : 'font-pp-sans-medium text-text-secondary',
  );

  return (
    <View className="flex-1 bg-background">
      <Header />
      <ScrollView className="flex-1" contentContainerClassName="grow py-[28px]">
        {/* Padding sits inside the max-width frame so the header's lockup and
            wallet line up with the content edges, not 20px inside. */}
        <View className="mx-auto w-full max-w-[1080px] grow gap-[22px] px-[20px]">
          <View className="gap-[4px]">
            <Text className="font-pp-medium text-[11px] tracking-[2px] text-text-muted">PAYROLL</Text>
            <Text className="font-pp-bold text-[26px] text-text">{title}</Text>
            {subtitle ? <Text className="font-pp-regular text-[13px] text-text-secondary">{subtitle}</Text> : null}
          </View>

          <View className="z-[10] flex-row items-center gap-[8px]">
            <View className="shrink flex-row items-center rounded-[8px] bg-background-secondary p-[3px]">
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerClassName="flex-row gap-[2px]"
                className="shrink"
              >
                {primaryTabs.map((t) => {
                  const isActive = t.key === active;
                  return (
                    <Pressable
                      key={t.key}
                      onPress={() => { setMoreOpen(false); router.push(t.href); }}
                      className={navItem(isActive)}
                    >
                      {/* nw-keep(data-color): tab glyph color (theme token) into the vector-icon color prop */}
                      <Ionicons name={t.icon} size={15} color={isActive ? colors.text : colors.textSecondary} />
                      <Text className={navText(isActive)}>{t.label}</Text>
                    </Pressable>
                  );
                })}
              </ScrollView>
              {overflowTabs.length > 0 && (
                <View className="relative">
                  <Pressable
                    onPress={() => setMoreOpen((v) => !v)}
                    className={navItem(overflowActive)}
                  >
                    {/* nw-keep(data-color): More glyph colors (theme tokens) into the vector-icon color props */}
                    <Ionicons name="ellipsis-horizontal" size={15} color={overflowActive ? colors.text : colors.textSecondary} />
                    <Text className={navText(overflowActive)}>More</Text>
                    <Ionicons name={moreOpen ? 'chevron-up' : 'chevron-down'} size={13} color={overflowActive ? colors.text : colors.textMuted} />
                  </Pressable>
                  {moreOpen && (
                    <View
                      className="absolute right-0 top-[42px] z-[1000] min-w-[170px] rounded-card border border-border-light bg-menu-background p-[6px]"
                      // nw-keep(platform-css): the shared dropdown shadow (web box-shadow, native elevation)
                      style={DROPDOWN_SHADOW}
                    >
                      {overflowTabs.map((t) => {
                        const isActive = t.key === active;
                        return (
                          <Pressable
                            key={t.key}
                            onPress={() => { setMoreOpen(false); router.push(t.href); }}
                            className="flex-row items-center gap-[8px] rounded-pill px-[12px] py-[10px] hover:bg-background-secondary"
                          >
                            {/* nw-keep(data-color): menu-item glyph color (theme token) into the vector-icon color prop */}
                            <Ionicons name={t.icon} size={15} color={isActive ? colors.text : colors.textSecondary} />
                            <Text className={`text-[13px] ${isActive ? 'font-pp-sans-semi-bold text-text' : 'font-pp-sans-medium text-text-secondary'}`}>{t.label}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  )}
                </View>
              )}
            </View>
          </View>

          <View className="gap-[18px]">{children}</View>

          {Platform.OS === 'web' && <Footer />}
        </View>
      </ScrollView>
      {Platform.OS !== 'web' && (
        <View className="px-[20px] pb-[20px]"><Footer /></View>
      )}
    </View>
  );
}
