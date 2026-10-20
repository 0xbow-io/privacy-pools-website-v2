import { useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Colors } from '@/constants/theme';
import { usePoolSession } from '@/hooks/use-pool-session';

/**
 * Paste-an-account-key sign-in form, shared by the connect-wallet modal and
 * the home card's wallet flip. Builds a wallet-less session: enough to see
 * balances and withdraw/transfer through the relayer — for users who don't
 * want to reveal the note-owner wallet to this browser at all.
 *
 * The pasted key is a secret, so the field is BLURRED until the eye in its
 * corner reveals it (Pat, 2026-09-03). `secureTextEntry` is single-line only
 * and would turn a multi-line key into one row of dots, so a CSS blur on the
 * text is the multi-line equivalent; on native the blur filter is not
 * available and the field simply shows the key.
 */
export function AccountKeySignIn({
  colors,
  onDone,
}: {
  colors: typeof Colors.light;
  onDone: () => void;
}) {
  const { signInWithAccountKey } = usePoolSession();
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);

  const submit = async () => {
    if (busy || !value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await signInWithAccountKey(value.trim());
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const masked = Platform.OS === 'web' && !revealed && value.length > 0;

  return (
    <View className="gap-[10px]">
      <Text className="font-pp-regular text-[12px] leading-[17px] text-text-secondary">
        Paste the account key you exported earlier. It rebuilds your balance
        without connecting a wallet. Withdrawals and transfers go through the
        relayer.
      </Text>
      {/* The border sits on the wrapper so the blur only touches the text,
          and the eye can be pinned to the field's corner. */}
      <View className="relative rounded-control border border-border">
        <TextInput
          value={value}
          onChangeText={(text) => { setValue(text); setError(null); }}
          placeholder="Paste account key…"
          // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
          placeholderTextColor={colors.textMuted}
          multiline
          autoCapitalize="none"
          autoCorrect={false}
          testID="account-key-input"
          className="min-h-[76px] px-[10px] py-[8px] pr-[36px] font-pp-mono text-[12px] text-text"
          // nw-keep(platform-css): textAlignVertical is not a css-interop-compatible property (the
          // [textAlignVertical:top] arbitrary class compiles to nothing on native); filter is a
          // web-only CSS property with no className path in react-native-web.
          style={{ textAlignVertical: 'top', ...(masked ? { filter: 'blur(4px)' } : null) } as never}
        />
        {value.length > 0 && Platform.OS === 'web' ? (
          <Pressable
            onPress={() => setRevealed((v) => !v)}
            accessibilityRole="button"
            accessibilityLabel={revealed ? 'Hide account key' : 'Show account key'}
            testID="account-key-reveal"
            className="absolute bottom-[6px] right-[6px] h-[24px] w-[24px] items-center justify-center"
          >
            {/* nw-keep(data-color): icon color is a theme token into the vector-icon sink */}
            <Ionicons name={revealed ? 'eye-off-outline' : 'eye-outline'} size={16} color={colors.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {error ? (
        <Text className="font-pp-regular text-[12px] text-danger">{error}</Text>
      ) : null}
      <Pressable
        onPress={submit}
        disabled={busy || !value.trim()}
        className={`items-center rounded-control bg-button-primary py-[12px] ${busy || !value.trim() ? 'opacity-60' : 'opacity-100'}`}
      >
        <Text className="font-pp-semi-bold text-[14px] text-button-primary-text">
          {busy ? 'Unlocking…' : 'Sign in'}
        </Text>
      </Pressable>
    </View>
  );
}
