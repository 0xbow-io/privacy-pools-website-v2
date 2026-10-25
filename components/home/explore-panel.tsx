import { useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { Card } from '@/components/ui/card';
import { useCollapsed } from '@/hooks/use-collapsed';
import { Transactions } from '@/components/pools/transactions';
import { MyPrivacyPools } from '@/components/pools/my-privacy-pools';
import { PaymentRequestsCard } from '@/components/payment-requests-card';

/** Which exploratory surface the user asked for. */
/**
 * The panel's surfaces. 'pools' is gone: the pool directory it showed
 * (Available assets + All pools) duplicated the /explore page, which carries
 * the same list plus the protocol figures — so /explore is the one "explore"
 * surface now and the panel keeps only the two personal ones.
 */
export type DrawerSection = 'activity' | 'mine';

/**
 * The ONLY accepted `?panel=` values. Home and the mobile bar must agree on
 * this: Home validated the value before rendering a drawer while the bar
 * treated any non-empty string as "a sheet is open", so `/?panel=bogus` showed
 * no drawer AND hid the bottom bar, leaving no navigation at all.
 */
export const PANEL_PARAMS: Record<string, DrawerSection> = {
  balances: 'mine',
  activity: 'activity',
};

/** Parse a raw `?panel=` value, returning null for anything unrecognised. */
export function parsePanelParam(raw: string | null | undefined): DrawerSection | null {
  if (!raw) return null;
  return PANEL_PARAMS[raw] ?? null;
}

export const PANEL_TITLES: Record<DrawerSection, string> = {
  activity: 'Activity',
  mine: 'My balances',
};

/**
 * The data itself, with no shell around it.
 *
 * Exactly one copy of this feeds all three presentations — the desktop split
 * column, the mobile bottom sheet, and (via the same children) any future
 * surface. The shell owns geometry and animation; this owns content. That
 * split is what keeps "data fetching decoupled from the layout shell": every
 * component below fetches through its own provider/hook, so moving between
 * split screen and sheet re-parents them without touching a request.
 */
export function PanelSections({ section, onClose }: { section: DrawerSection; onClose: () => void }) {
  return (
    <>
      {section === 'activity' && <Transactions />}
      {section === 'mine' && (
        <View className="gap-[16px]">
          <MyPrivacyPools />
          {/* The Yield card is gone from My balances: the hero's green
              "yield earned while shielded" line now carries that story, and
              the card repeated it in a heavier, DEMO-figure form. It still
              lives on the Portfolio page. */}
          {/* Device-stored requests list — hidden while signed out AND hidden
              entirely with nothing to show, so My balances is not padded with an
              empty card. Same `hideWhenEmpty` the Classic pools page uses.
              Re-issue opens the create modal; close the panel first. */}
          <PaymentRequestsCard surface="page" hideWhenEmpty onNavigateAway={onClose} />
          {/* Mock's last row: a collapsed "My transactions (N)" that opens the
              activity feed IN PLACE, rather than sending the user to the
              activity tab and losing the balance context. */}
          <MyTransactionsSection />
        </View>
      )}
    </>
  );
}

/**
 * Collapsed-by-default activity, inside My balances (mock). The feed itself is
 * the same <Transactions /> the activity tab renders — one implementation, two
 * entry points, so the two can never disagree.
 */
export function MyTransactionsSection() {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  // DEV-369 ("transactions not shown by default"): the comment above claimed
  // collapsed-by-default but nothing implemented it — an unset key read as
  // expanded, so the feed was open on first visit. The default is explicit now.
  const [collapsed, toggleCollapsed] = useCollapsed('my-transactions-inline', true);
  // Reported by <Transactions>, which owns the ownership logic (note lineage,
  // internal-spend suppression). data.transactions.length would be the PUBLIC
  // feed — this header says "My transactions", so it has to count the user's.
  const [count, setCount] = useState(0);

  return (
    <Card noPadding className="overflow-hidden">
      <Pressable
        className={`flex-row items-center gap-[8px] p-[16px] ${collapsed ? '' : 'border-b border-b-border-light'}`}
        onPress={toggleCollapsed}
        accessibilityRole="button"
        accessibilityState={{ expanded: !collapsed }}
        testID="my-transactions-toggle"
      >
        <Text className="flex-1 font-pp-sans-semi-bold text-[15px] text-text">
          My transactions{count > 0 ? ` (${count})` : ''}
        </Text>
        {/* nw-keep(data-color): chevron color is a runtime theme token (vector-icon sink) */}
        <Ionicons name={collapsed ? 'chevron-down' : 'chevron-up'} size={22} color={colors.textSecondary} />
      </Pressable>
      {/* Always mounted: collapsed it renders null but keeps reporting the
          count, which is what the header above shows while collapsed. */}
      <View className={collapsed ? undefined : 'px-[16px] pt-[12px]'}>
        {/* hideScopeToggle: this card's title is "My transactions", so the
            table shows exactly that — a "Mine | All" toggle here let it show
            the protocol-wide feed under a heading that says otherwise. */}
        <Transactions embedded collapsed={collapsed} onMyCountChange={setCount} hideScopeToggle />
      </View>
    </Card>
  );
}

/**
 * Empty-state copy for the split column while nothing is selected. Kept out of
 * PanelSections so the sheet never shows it (the sheet is always opened by an
 * explicit tap).
 */
export function PanelHeading({ section }: { section: DrawerSection }) {
  const subtitle = useMemo(() => {
    switch (section) {
      case 'activity':
        return 'Every deposit, transfer and withdrawal on this account.';
      case 'mine':
        return 'What you hold inside the pools right now.';
    }
  }, [section]);

  return (
    <View className="gap-[3px]">
      <Text className="font-pp-sans-semi-bold text-[19px] text-text">{PANEL_TITLES[section]}</Text>
      <Text className="font-pp-sans text-[12.5px] text-text-secondary">{subtitle}</Text>
    </View>
  );
}
