// The three-dot stage list the relayed flows show while a proof is generated and
// submitted, plus the mapping from a loading message to the active stage.
//
// The withdraw and transfer modals drew this identically; only the stage LABELS
// differ, so those stay with their flows and are passed in. Moved verbatim from
// components/withdraw-modal-provider.tsx — the bodies and comments are the
// originals, with `export` added.
import { Text, View } from 'react-native';

export function progressStageIndex(message: string): number {
  const text = message.trim().toLowerCase();
  if (/^(preparing|syncing|checking|selecting)/.test(text)) return 0;
  if (/^(submitting|confirm|waiting)/.test(text)) return 2;
  if (/(proving|proofs?)/.test(text)) return 1;
  return 0;
}

export function ProgressStages({
  stages,
  activeIndex,
  activeLabel,
}: {
  stages: readonly string[];
  activeIndex: number;
  activeLabel?: string;
}) {
  return (
    <View className="w-full gap-[8px]">
      {stages.map((stage, index) => {
        const done = index < activeIndex;
        const active = index === activeIndex;
        return (
          <View key={stage} className="flex-row items-center gap-[8px]">
            <View
              className={`h-[8px] w-[8px] shrink-0 rounded-[4px] ${done ? 'bg-success' : active ? 'bg-text' : 'bg-border'}`}
            />
            <Text
              className={`flex-1 text-[13px] ${done ? 'font-pp-regular text-success' : active ? 'font-pp-medium text-text' : 'font-pp-regular text-text-muted'}`}
            >
              {active && activeLabel ? activeLabel : stage}
            </Text>
          </View>
        );
      })}
    </View>
  );
}
