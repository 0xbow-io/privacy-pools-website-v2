// Native specimen of the Floating UI cell: Floating UI is a DOM library, so
// the native gallery renders an explicit no-op instead of running the hook.
// (Native gallery rendering itself is still blocked by the vendored SDK's
// fs/promises native-export failure — recorded in nativewind-fb-gates.md.)
import { StyleSheet, Text, View } from 'react-native';

export function FloatingProbe({ variant }: { variant: 'ss' | 'nw' }) {
  return (
    <View style={styles.zone} testID={`nwg-float-native-noop-${variant}`}>
      <Text style={styles.note}>Floating UI is web-only; no native specimen.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  zone: { minHeight: 72, alignItems: 'flex-start', justifyContent: 'center' },
  note: { fontSize: 11, color: '#6b7280' },
});
