import { Link } from 'expo-router';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';

export default function ModalScreen() {
  return (
    <ThemedView className="flex-1 items-center justify-center p-[20px]">
      <ThemedText type="title">This is a modal</ThemedText>
      <Link href="/" dismissTo className="mt-[15px] py-[15px]">
        <ThemedText type="link">Go to home screen</ThemedText>
      </Link>
    </ThemedView>
  );
}
