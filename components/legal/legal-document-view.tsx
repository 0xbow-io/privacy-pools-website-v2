import { useTabBarClearance } from '@/hooks/use-tab-bar-clearance';
import { Linking, Platform, Pressable, ScrollView, Text, View } from 'react-native';
import { Stack, useRouter } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { Header } from '@/components/ui/header';
import { Footer } from '@/components/ui/footer';

import type { LegalBlock, LegalDocument, LegalRun } from '@/config/legal/types';

const URL_RUN = /^https:\/\/\S+$/;

// Static classes so NativeWind can compile them (12px + 18px per nesting level).
const LIST_INDENT = ['pl-[12px]', 'pl-[30px]', 'pl-[48px]', 'pl-[66px]'] as const;

function runClass(run: LegalRun): string {
  return [
    run.b ? 'font-pp-sans-semi-bold text-text' : '',
    run.i ? 'italic' : '',
    run.u ? 'underline' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function Runs({ runs }: { runs: LegalRun[] }) {
  return (
    <>
      {runs.map((run, i) =>
        URL_RUN.test(run.t) ? (
          // A URL the document names (e.g. the source code). Opened only on tap.
          <Text
            key={i}
            className={`${runClass(run)} text-tint underline`}
            accessibilityRole="link"
            onPress={() => Linking.openURL(run.t)}
          >
            {run.t}
          </Text>
        ) : (
          <Text key={i} className={runClass(run)}>
            {run.t}
          </Text>
        ),
      )}
    </>
  );
}

function Block({ block, letterIndex }: { block: LegalBlock; letterIndex: number }) {
  if (block.heading) {
    return (
      <Text
        accessibilityRole="header"
        className="mt-[14px] font-pp-sans-semi-bold text-[16px] leading-[22px] text-text"
      >
        {block.runs.map((r) => r.t).join('')}
      </Text>
    );
  }
  const body = 'font-pp-sans text-[14px] leading-[22px] text-text-secondary';
  if (block.list) {
    const marker =
      block.list === 'letter'
        ? `${String.fromCharCode(97 + letterIndex)}.`
        : (block.level ?? 0) > 0
          ? '○'
          : '•';
    return (
      <View
        className={`flex-row gap-[8px] ${LIST_INDENT[Math.min(block.level ?? 0, LIST_INDENT.length - 1)]}`}
      >
        <Text className={body}>{marker}</Text>
        <Text className={`${body} flex-1`}>
          <Runs runs={block.runs} />
        </Text>
      </View>
    );
  }
  return (
    <Text className={body}>
      <Runs runs={block.runs} />
    </Text>
  );
}

/** Renders a bundled legal document verbatim. Nothing is fetched. */
// Same chrome as /transactions: the shared Header (logo, nav) plus a back row,
// because the root Stack draws no header and these routes sit outside (tabs).
// The Stack contentStyle owns the top inset, so no SafeAreaView here.
export function LegalDocumentView({ doc }: { doc: LegalDocument }) {
  const tabClearance = useTabBarClearance();
  const router = useRouter();
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const goBack = () => {
    if (router.canGoBack()) router.back();
    else router.replace('/');
  };
  let letters = 0;
  return (
    <View className="flex-1 bg-background">
      <Stack.Screen options={{ title: doc.title }} />
      <Header />
      <ScrollView className="flex-1" contentContainerClassName="grow"
        // nw-keep(measured-or-inset): clearance for the floating bottom bar
        contentContainerStyle={{ paddingBottom: 48 + (Platform.OS === 'web' ? tabClearance : 0) }}
      >
        <View className="w-full max-w-[760px] grow gap-[12px] self-center px-[18px] pt-[22px]">
          <Pressable
            onPress={goBack}
            className="flex-row items-center gap-[6px] self-start py-[4px] active:opacity-60"
            accessibilityRole="button"
            accessibilityLabel="Back to Privacy Pools"
            testID="legal-back"
          >
            {/* nw-keep(data-color): arrow tint is the secondary text theme token into the vector-icon sink */}
            <Ionicons name="arrow-back" size={15} color={colors.textSecondary} />
            <Text className="font-pp-sans-medium text-[13px] text-text-secondary">Back to Privacy Pools</Text>
          </Pressable>
          <Text accessibilityRole="header" className="font-pp-sans-bold text-[26px] text-text">
            {doc.title}
          </Text>
          <Text className="font-pp-sans text-[13px] text-text-muted">
            Last Updated: {doc.lastUpdated}
          </Text>
          {doc.blocks.map((block, i) => {
            const letterIndex = block.list === 'letter' ? letters++ : 0;
            return <Block key={i} block={block} letterIndex={letterIndex} />;
          })}
          {Platform.OS === 'web' && <Footer />}
        </View>
      </ScrollView>
      {Platform.OS !== 'web' && (
        <View
            className="px-[20px]"
            // nw-keep(measured-or-inset): native footer sits under the floating bottom bar
            style={{ paddingBottom: 20 + tabClearance }}
          >
          <Footer />
        </View>
      )}
    </View>
  );
}
