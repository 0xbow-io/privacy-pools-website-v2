import { useRef, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';
import { formatUnits } from 'viem';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { displayTokenSymbol, tokenAmountLabel } from '@/services/share-display';
import {
  consolidationSelectionError, consolidationNet, MAX_CONSOLIDATION_INPUTS, planConsolidation, selectConsolidationGroup,
  type ConsolidationCandidate,
} from '@/services/consolidate-notes';

export function ConsolidationSummary({ total, fee, decimals, symbol }: {
  total: bigint; fee: bigint | null; decimals: number; symbol: string;
}) {
  const net = consolidationNet(total, fee);
  const units = (value: bigint) => tokenAmountLabel(formatUnits(value, decimals), symbol);
  return (
    <View className="w-full rounded-control border border-border-light bg-background-secondary p-[14px] gap-[10px]">
      {[
        ['Selected value', units(total)],
        ['Estimated relayer fee', fee === null ? 'Unavailable' : units(fee)],
        ['Value after fee', net === null ? '—' : units(net)],
      ].map(([label, value]) => (
        <View key={label} className="flex-row justify-between gap-[16px]">
          <Text className="font-pp-regular text-[13px] text-text-secondary">{label}</Text>
          <Text className="flex-1 text-right font-pp-medium text-[13px] text-text" selectable>{value}</Text>
        </View>
      ))}
    </View>
  );
}

/** Local selection only. Opening, switching groups and checking notes never fetch. */
export function ConsolidationPanel({ groups, selected, fee, decimals, symbol, error, onChange, onReview, onClose, onBack }: {
  groups: ConsolidationCandidate[];
  selected: string[];
  fee: bigint | null;
  decimals: number;
  symbol: string;
  error: string | null;
  onChange: (commitments: string[]) => void;
  onReview: () => void;
  onClose: () => void;
  /** Present when the picker was opened from the asset list. */
  onBack?: () => void;
}) {
  // Keep the open group when its last note is unchecked; recover if a sync removes it.
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const [groupLabel, setGroupLabel] = useState(() => groups.find((g) => g.notes.some((n) => selected.includes(n.commitment)))?.label);
  const group = groups.find((g) => g.label === groupLabel) ?? groups[0];
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
  const change = (next: string[]) => { setSelectionMessage(null); onChange(next); };
  const groupAction = (candidate: ConsolidationCandidate, action: 'include' | 'fill' | 'clear') => {
    const result = selectConsolidationGroup(candidate, selected, action);
    setSelectionMessage(result.error);
    if (!result.error) onChange(result.selected);
  };
  const currentCount = group?.notes.filter((note) => selected.includes(note.commitment)).length ?? 0;
  const selectCount = Math.min(group?.notes.length ?? 0, currentCount + MAX_CONSOLIDATION_INPUTS - selected.length);
  const notesScrollRef = useRef<ScrollView>(null);
  const allNotes = groups.flatMap((candidate) => candidate.notes);
  const selectedNotes = allNotes.filter((note) => selected.includes(note.commitment));
  const invalid = error ?? (selectedNotes.length !== selected.length
    ? 'These notes are no longer available. Choose your notes again.'
    : consolidationSelectionError(selectedNotes, fee));
  return (
    <View className="w-full gap-[16px] shrink" testID="consolidation-select">
      <View className="gap-[6px] pr-[30px]">
        <Text className="font-pp-bold text-[22px] leading-[28px] text-text">Consolidate notes</Text>
        <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
          Select at least two notes per group, up to five in total. Each group becomes one larger note in your private balance.
        </Text>
      </View>
      {groups.length > 1 && (
        /* Bounded and scrollable: an account with dozens of two-note groups
           pushed Review consolidation out of the modal, where nothing could
           reach it (e2e run 37795174958, 42+ groups). */
        <ScrollView className="max-h-[220px] shrink" accessibilityLabel="Note groups" testID="consolidation-group-list">
          <View className="flex-row flex-wrap gap-[8px]">
            {groups.map((candidate, index) => {
              const active = candidate === group;
              return (
                <View key={candidate.label}
                  className={`min-w-[150px] flex-1 flex-row items-center rounded-control border ${active ? 'border-tint bg-background-secondary' : 'border-border-light'}`}>
                  <Pressable accessibilityRole="checkbox"
                    accessibilityLabel={`Include note group ${index + 1}`}
                    accessibilityState={{ checked: candidate.notes.every((note) => selected.includes(note.commitment)) ? true : candidate.notes.some((note) => selected.includes(note.commitment)) ? 'mixed' : false }}
                    testID={`consolidation-group-check-${index}`}
                    onPress={() => groupAction(candidate, candidate.notes.some((note) => selected.includes(note.commitment)) ? 'clear' : 'include')}
                    className="w-[44px] h-[44px] items-center justify-center">
                    {/* nw-keep(data-color): shared themed checkbox glyphs. */}
                    {candidate.notes.some((note) => selected.includes(note.commitment)) && !candidate.notes.every((note) => selected.includes(note.commitment)) ? (
                      <View className="w-[18px] h-[18px] rounded-[3px] bg-button-primary items-center justify-center">
                        <Ionicons name="remove" size={14} color={colors.buttonPrimaryText} />
                      </View>
                    ) : <Ionicons name={candidate.notes.every((note) => selected.includes(note.commitment)) ? 'checkbox' : 'square-outline'} size={18}
                      color={candidate.notes.some((note) => selected.includes(note.commitment)) ? colors.buttonPrimary : colors.textMuted} />}
                  </Pressable>
                  <Pressable accessibilityRole="button" accessibilityState={{ selected: active }}
                    accessibilityLabel={`View note group ${index + 1}, ${candidate.notes.length} notes`}
                    testID={`consolidation-group-${index}`}
                    className="flex-1 py-[12px] pr-[12px] gap-[3px]"
                    onPress={() => {
                      if (active) return;
                      setGroupLabel(candidate.label);
                      setSelectionMessage(null);
                      notesScrollRef.current?.scrollTo({ y: 0, animated: false });
                    }}>
                    <Text className="font-pp-medium text-[14px] text-text">Note group {index + 1}</Text>
                    <Text className="font-pp-regular text-[12px] text-text-secondary">{candidate.notes.length} notes</Text>
                  </Pressable>
                </View>
              );
            })}
          </View>
        </ScrollView>
      )}
      {group ? (
        <View className="gap-[8px] shrink">
          <View className="flex-row flex-wrap justify-between items-center gap-[12px]">
            <Text className="font-pp-regular text-[12px] text-text-secondary">{currentCount} selected in this group</Text>
            <View className="flex-row gap-[12px]">
              <Pressable accessibilityRole="button" testID="consolidation-select-all" disabled={selectCount <= currentCount}
                onPress={() => groupAction(group, 'fill')} className={`py-[8px] ${selectCount <= currentCount ? 'opacity-40' : ''}`}>
                <Text className="font-pp-medium text-[12px] text-text">{selectCount === group.notes.length ? 'Select all' : `Select ${selectCount}`}</Text>
              </Pressable>
              <Pressable accessibilityRole="button" testID="consolidation-deselect-all" disabled={currentCount === 0}
                onPress={() => groupAction(group, 'clear')} className={`py-[8px] ${currentCount === 0 ? 'opacity-40' : ''}`}>
                <Text className="font-pp-medium text-[12px] text-text">Deselect all</Text>
              </Pressable>
            </View>
          </View>
          {/* Keep the same scroll view mounted when a checkbox changes. Only switching groups resets it. */}
          <ScrollView ref={notesScrollRef} className="max-h-[280px] shrink rounded-control border border-border-light"
            testID="consolidation-note-list">
            {group.notes.map((note, noteIndex) => {
              const checked = selected.includes(note.commitment);
              const disabled = !checked && selected.length >= MAX_CONSOLIDATION_INPUTS;
              return (
                <Pressable key={note.commitment}
                  accessibilityRole="checkbox" aria-checked={checked} accessibilityState={{ checked, disabled }}
                  accessibilityLabel={`Note ${noteIndex + 1}, ${formatUnits(BigInt(note.value), decimals)} ${displayTokenSymbol(symbol)}`}
                  testID={`consolidation-note-${note.commitment}`}
                  disabled={disabled}
                  onPress={() => change(checked ? selected.filter((c) => c !== note.commitment) : [...selected, note.commitment])}
                  className={`flex-row items-center gap-[12px] px-[14px] py-[12px] ${noteIndex > 0 ? 'border-t border-border-light' : ''} ${disabled ? 'opacity-40' : ''}`}
                >
                  {/* nw-keep(data-color): same themed checkbox glyph as the RPC modal. */}
                  <Ionicons name={checked ? 'checkbox' : 'square-outline'} size={18}
                    color={checked ? colors.buttonPrimary : colors.textMuted} />
                  <Text className="font-pp-regular text-[13px] text-text-secondary">Note {noteIndex + 1}</Text>
                  <Text className="flex-1 text-right font-pp-medium text-[13px] text-text">{tokenAmountLabel(formatUnits(BigInt(note.value), decimals), symbol)}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : <Text className="font-pp-regular text-[14px] text-text-secondary">No compatible notes are available for this asset.</Text>}
      <ConsolidationGroupSummary groups={groups} selected={selected} fee={fee} />
      {(selectionMessage || invalid) && <Text accessibilityRole="alert" className="font-pp-regular text-[13px] leading-[18px] text-warning">{selectionMessage ?? invalid}</Text>}
      <View className="flex-row gap-[10px]">
        <Pressable accessibilityRole="button" onPress={onBack ?? onClose} className="h-[46px] px-[18px] items-center justify-center rounded-control border border-border">
          <Text className="font-pp-medium text-[14px] text-text">{onBack ? 'Back' : 'Cancel'}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={!!invalid} onPress={onReview}
          testID="consolidation-review"
          className={`flex-1 h-[46px] items-center justify-center rounded-control bg-button-primary ${invalid ? 'opacity-50' : ''}`}>
          <Text className="font-pp-medium text-[14px] text-button-primary-text">Review consolidation</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Keep the note reduction and group breakdown separate from the fee summary. */
export function ConsolidationGroupSummary({ groups, selected, fee }: {
  groups: ConsolidationCandidate[]; selected: string[]; fee: bigint | null;
}) {
  const picks = groups.flatMap((group) => group.notes).filter((note) => selected.includes(note.commitment));
  let plan: ReturnType<typeof planConsolidation> | null = null;
  try { plan = planConsolidation(picks, fee); } catch { /* Partial selection is valid editing state. */ }
  const selectedGroups = groups.map((group, index) => ({ ...group, index,
    count: group.notes.filter((note) => selected.includes(note.commitment)).length,
  })).filter((group) => group.count > 0);
  if (selectedGroups.length === 0) return null;
  return (
    <View className="gap-[6px]" accessibilityLiveRegion="polite">
      {plan && <Text className="font-pp-medium text-[14px] text-text">{selected.length} notes → {plan.outputs.length} {plan.outputs.length === 1 ? 'note' : 'notes'}</Text>}
      {selectedGroups.map((group) => (
        <View key={group.label} className="flex-row justify-between gap-[16px]">
          <Text className="font-pp-regular text-[12px] text-text-secondary">Note group {group.index + 1}</Text>
          <Text className="font-pp-medium text-[12px] text-text">{group.count} {group.count === 1 ? 'note' : 'notes'}{group.count >= 2 ? ' → 1' : ' · choose one more'}</Text>
        </View>
      ))}
    </View>
  );
}
