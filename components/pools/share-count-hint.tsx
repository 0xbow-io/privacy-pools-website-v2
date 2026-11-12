import { Text } from 'react-native';
import { HoverHint } from '@/components/ui/hover-hint';

/** An (i) that explains a yield balance on hover or press. Nothing when there is no hint. */
export function ShareCountHint({ hint, testID }: { hint: string | null; testID?: string }) {
  if (!hint) return null;
  return (
    <HoverHint hint={hint} wrap testID={testID}>
      <Text accessibilityLabel="Balance details" className="text-[12px] leading-[14px] text-text-muted font-pp-medium">
        {'ⓘ'}
      </Text>
    </HoverHint>
  );
}
