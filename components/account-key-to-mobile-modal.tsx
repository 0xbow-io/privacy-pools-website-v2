import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, Text, TextInput, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import { Modal } from '@/components/ui/modal';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { usePoolSession } from '@/hooks/use-pool-session';
import {
  TRANSFER_QR_TTL_MS,
  normalizeTransferCode,
  sealAccountKeyForTransfer,
} from '@/services/account-key-transfer';
import { transferKdf } from '@/services/account-key-transfer-kdf';

type Phase = 'enter' | 'sealing' | 'qr' | 'expired';

/**
 * Web half of "account key to mobile". The phone made the code; the user
 * types it here into a masked field. We check its check symbol, encrypt the
 * account key under Argon2id(code) and show the ciphertext as a QR for 45 s.
 *
 * Nothing is stored or sent: the code, key and QR live in this component's
 * state only and are dropped on hide, close, and unmount.
 */
export function AccountKeyToMobileModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const { exportAccountKey } = usePoolSession();
  const [code, setCode] = useState('');
  const [phase, setPhase] = useState<Phase>('enter');
  const [payload, setPayload] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  // Bumped on every reset so a derivation that finishes after close is dropped.
  const epochRef = useRef(0);
  const inputRef = useRef<TextInput>(null);

  const reset = useCallback(() => {
    epochRef.current++;
    setCode('');
    setPayload(null);
    setError(null);
    setSecondsLeft(0);
    setPhase('enter');
  }, []);

  // The header mounts this only while open, so unmount is the real close:
  // drop any derivation still in flight. State dies with the component.
  useEffect(() => {
    const epoch = epochRef;
    return () => { epoch.current++; };
  }, []);

  // Mask without type=password, so the browser never offers to save the code.
  useEffect(() => {
    if (!visible || phase !== 'enter' || Platform.OS !== 'web') return;
    const el = inputRef.current as unknown as HTMLInputElement | null;
    if (!el?.style) return;
    const css = (globalThis as { CSS?: { supports?: (p: string, v: string) => boolean } }).CSS;
    if (css?.supports?.('-webkit-text-security', 'disc')) el.style.setProperty('-webkit-text-security', 'disc');
    else el.style.setProperty('filter', 'blur(5px)');
  }, [visible, phase]);

  // The QR lives for TRANSFER_QR_TTL_MS, then it is gone.
  useEffect(() => {
    if (phase !== 'qr') return;
    const expiresAt = Date.now() + TRANSFER_QR_TTL_MS;
    const timer = setInterval(() => {
      const left = expiresAt - Date.now();
      if (left <= 0) {
        clearInterval(timer);
        setPayload(null);
        setPhase('expired');
        setSecondsLeft(0);
      } else {
        setSecondsLeft(Math.ceil(left / 1000));
      }
    }, 250);
    return () => clearInterval(timer);
  }, [phase]);

  const submit = useCallback(async () => {
    if (phase !== 'enter') return;
    const normalized = normalizeTransferCode(code);
    if (!normalized) {
      setError('That code is not valid. Check it in the app.');
      return;
    }
    const epoch = ++epochRef.current;
    setCode('');
    setError(null);
    setPhase('sealing');
    try {
      const accountKey = await exportAccountKey();
      if (epochRef.current !== epoch) return;
      const sealed = await sealAccountKeyForTransfer({ code: normalized, plaintext: accountKey, kdf: transferKdf });
      if (epochRef.current !== epoch) return;
      setPayload(sealed);
      setSecondsLeft(Math.ceil(TRANSFER_QR_TTL_MS / 1000));
      setPhase('qr');
    } catch (err) {
      if (epochRef.current !== epoch) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase('enter');
    }
  }, [code, phase, exportAccountKey]);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  return (
    <Modal animationType="fade" transparent visible={visible} onRequestClose={close}>
      <View className="flex-1 items-center justify-center bg-[rgba(0,0,0,0.5)] p-[20px]">
        <View className="w-full max-w-[420px] gap-[14px] rounded-card border border-border bg-card-background p-[24px]">
          <Text className="font-pp-bold text-[20px] leading-[24px] text-text">Export account key to mobile</Text>

          {phase === 'enter' || phase === 'sealing' ? (
            <>
              <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
                In the app, tap Import account key from web. Type the code it shows.
              </Text>
              <TextInput
                ref={inputRef}
                value={code}
                onChangeText={(t) => { setCode(t); setError(null); }}
                onSubmitEditing={submit}
                editable={phase === 'enter'}
                placeholder="XXXX-XXXX-XX"
                // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                placeholderTextColor={colors.textMuted}
                autoCapitalize="characters"
                autoCorrect={false}
                autoComplete="off"
                spellCheck={false}
                maxLength={16}
                accessibilityLabel="Code from the app"
                testID="ak-mobile-code"
                className="rounded-control border border-border px-[12px] py-[10px] font-pp-mono text-[16px] tracking-[2px] text-text"
              />
              {error ? <Text className="font-pp-regular text-[12px] text-danger">{error}</Text> : null}
            </>
          ) : null}

          {phase === 'qr' && payload ? (
            <View className="items-center gap-[10px]">
              <View className="rounded-control bg-[#FFFFFF] p-[12px]">
                {/* nw-keep(svg-or-canvas): fixed QR module/background colors (theme-independent for scannability; QRCode color props) */}
                <QRCode value={payload} size={260} ecl="M" backgroundColor="#FFFFFF" color="#000000" />
              </View>
              <Text className="font-pp-medium text-[13px] text-text-secondary">
                Scan it with the app. Hides in {secondsLeft}s.
              </Text>
            </View>
          ) : null}

          {phase === 'expired' ? (
            <Text className="font-pp-regular text-[13px] leading-[19px] text-text-secondary">
              QR hidden. Start again for a new one.
            </Text>
          ) : null}

          <View className="flex-row justify-end gap-[10px]">
            <Pressable onPress={close} className="items-center rounded-control border border-border-light px-[14px] py-[10px]">
              <Text className="font-pp-medium text-[13px] text-text">{phase === 'qr' ? 'Done' : 'Close'}</Text>
            </Pressable>
            {phase === 'enter' || phase === 'sealing' ? (
              <Pressable
                onPress={submit}
                disabled={phase !== 'enter' || !code.trim()}
                testID="ak-mobile-show-qr"
                className={`items-center rounded-control bg-button-primary px-[18px] py-[10px] ${phase === 'enter' && code.trim() ? 'opacity-100' : 'opacity-50'}`}
              >
                <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">
                  {phase === 'sealing' ? 'Encrypting…' : 'Show QR'}
                </Text>
              </Pressable>
            ) : null}
            {phase === 'expired' ? (
              <Pressable onPress={reset} className="items-center rounded-control bg-button-primary px-[18px] py-[10px]">
                <Text className="font-pp-semi-bold text-[13px] text-button-primary-text">Start again</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </View>
    </Modal>
  );
}
