import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { Colors } from '@/constants/theme';
import { usePasskeyAccount } from '@/components/passkey-account-context';
import { truncateAddress } from '@/services/hex-format';

/**
 * Native passkey sign-in + account picker (privacypools.com passkey). Renders
 * nothing on the web or on a device without passkeys. Shows public data only.
 */
export function PasskeySignInPanel({ colors, onDone }: { colors: typeof Colors.light; onDone?: () => void }) {
  const { available, passkeyAddress, accounts, activeId, busy, error, signIn, create, pick } = usePasskeyAccount();
  if (!available) return null;

  const thenDone = (ok: boolean) => {
    if (ok) onDone?.();
  };

  return (
    <View className="gap-[10px]">
      {!passkeyAddress ? (
        <>
          <Pressable
            onPress={() => { void signIn().then(thenDone); }}
            disabled={busy}
            accessibilityRole="button"
            className={`h-[56px] flex-row items-center justify-center gap-[10px] rounded-inner bg-button-primary ${busy ? 'opacity-70' : 'active:opacity-[0.88]'}`}
          >
            {busy ? (
              // nw-keep(data-color): spinner tint is a theme token fed to the ActivityIndicator color prop
              <ActivityIndicator color={colors.buttonPrimaryText} />
            ) : (
              <>
                <Ionicons name="finger-print" size={20} color={colors.buttonPrimaryText} />
                <Text className="font-pp-semi-bold text-[16px] text-button-primary-text">Sign in with passkey</Text>
              </>
            )}
          </Pressable>
          <Pressable onPress={() => { void create().then(thenDone); }} disabled={busy} accessibilityRole="button" className="h-[40px] items-center justify-center">
            <Text className="font-pp-medium text-[13px] text-text-secondary underline">Create a passkey</Text>
          </Pressable>
        </>
      ) : (
        <>
          <Text className="font-pp-medium text-[12px] text-text-secondary">Choose an account</Text>
          {accounts.map((a) => {
            const active = a.id === activeId;
            return (
              <Pressable
                key={a.id}
                onPress={() => { void pick(a.id).then(thenDone); }}
                disabled={busy}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: busy }}
                className={`min-h-[60px] flex-row items-center gap-[12px] rounded-[8px] border bg-background px-[16px] py-[12px] active:opacity-[0.85] ${active ? 'border-tint' : 'border-border-light'}`}
              >
                <Ionicons name={a.kind === 'passkey' ? 'finger-print' : 'key-outline'} size={18} color={colors.textSecondary} />
                <View className="flex-1">
                  <Text className="font-pp-semi-bold text-[14px] text-text">{a.label}</Text>
                  <Text className="font-pp-regular text-[12px] text-text-secondary">{truncateAddress(a.address)}</Text>
                </View>
                {active && <Ionicons name="checkmark" size={18} color={colors.tint} />}
              </Pressable>
            );
          })}
          <Pressable onPress={() => { void signIn({ anyPasskey: true }).then(thenDone); }} disabled={busy} accessibilityRole="button" className="h-[36px] items-center justify-center">
            <Text className="font-pp-medium text-[12px] text-text-secondary underline">Use another passkey</Text>
          </Pressable>
        </>
      )}
      {error && <Text className="text-center font-pp-regular text-[12px] text-[#E11D48]">{error}</Text>}
    </View>
  );
}
