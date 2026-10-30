import { useState, useCallback, useEffect, useRef } from 'react';
import { WEB_NO_OUTLINE } from '@/components/ui/web-style-shims';
import { View, Text, Pressable, Platform, TextInput, Animated, Easing } from 'react-native';
import { Modal } from '@/components/ui/modal';
import { Colors } from '@/constants/theme';
import { useTheme } from '@/components/theme-provider';
import { useBackHandler } from '@/hooks/use-back-handler';
import { TURNSTILE_SCRIPT_PATH, TURNSTILE_SCRIPT_SRC } from '@/config/turnstile';

const TURNSTILE_SITE_KEY = process.env.EXPO_PUBLIC_TURNSTILE_SITE_KEY || '';
const NEWSLETTER_API_URL =
  process.env.EXPO_PUBLIC_NEWSLETTER_API_URL || '/api/newsletter-subscription';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type ModalStep = 'form' | 'loading' | 'success';

type TurnstileApi = {
  render: (container: HTMLElement, options: Record<string, unknown>) => string;
  remove: (id: string) => void;
};

export function NewsletterModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { colorScheme } = useTheme();
  const colors = Colors[colorScheme];
  const isDark = colorScheme === 'dark';

  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<ModalStep>('form');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [captchaNode, setCaptchaNode] = useState<View | null>(null);
  const turnstileWidgetId = useRef<string | null>(null);
  const submission = useRef<AbortController | null>(null);

  // Closing, hiding, or unmounting ends this submission's ownership of the UI.
  useEffect(() => {
    if (!visible) submission.current?.abort();
    return () => {
      submission.current?.abort();
    };
  }, [visible]);

  // Spinner
  const [spinAnim] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (step !== 'loading') {
      spinAnim.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(spinAnim, {
        toValue: 1,
        duration: 1000,
        easing: Easing.linear,
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [step, spinAnim]);

  // Initialize only once the portal container and Cloudflare script are ready.
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible || !TURNSTILE_SITE_KEY || step !== 'form') return;
    const el = captchaNode as unknown as HTMLElement | null;
    if (!(el instanceof HTMLElement)) return;
    let disposed = false;
    // A replacement widget must never reuse the previous widget's token.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTurnstileToken(null);
    const getApi = () => (window as unknown as { turnstile?: TurnstileApi }).turnstile;
    const fail = () => {
      if (disposed) return;
      setTurnstileToken(null);
      setError('Could not load verification. Please close this window and try again.');
    };
    const mountWidget = () => {
      const api = getApi();
      if (disposed || !api || turnstileWidgetId.current !== null) return;
      try {
        turnstileWidgetId.current = api.render(el, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: isDark ? 'dark' : 'light',
          callback: (token: string) => {
            if (!disposed) setTurnstileToken(token);
          },
          'error-callback': () => {
            if (!disposed) {
              setTurnstileToken(null);
              setError('Captcha verification failed.');
            }
          },
          'expired-callback': () => {
            if (!disposed) setTurnstileToken(null);
          },
        });
      } catch {
        fail();
      }
    };
    let script = document.querySelector<HTMLScriptElement>(
      `script[src^="${TURNSTILE_SCRIPT_PATH}"]`,
    );
    const scriptFailed = () => {
      script?.remove();
      fail();
    };
    if (getApi()) {
      mountWidget();
    } else {
      const isNew = !script;
      script ??= document.createElement('script');
      script.addEventListener('load', mountWidget);
      script.addEventListener('error', scriptFailed);
      if (isNew) {
        script.src = TURNSTILE_SCRIPT_SRC;
        script.async = true;
        // This listener belongs to the script, not the modal. A failed load
        // must be retryable even if every modal listener has been removed.
        const pendingScript = script;
        script.addEventListener('error', () => pendingScript.remove(), { once: true });
        document.head.appendChild(script);
      }
    }
    return () => {
      disposed = true;
      script?.removeEventListener('load', mountWidget);
      script?.removeEventListener('error', scriptFailed);
      if (turnstileWidgetId.current !== null) {
        try {
          getApi()?.remove(turnstileWidgetId.current);
        } catch {}
        turnstileWidgetId.current = null;
      }
    };
  }, [visible, isDark, step, captchaNode]);

  const handleClose = useCallback(() => {
    submission.current?.abort();
    submission.current = null;
    setEmail('');
    setError(null);
    setStep('form');
    setTurnstileToken(null);
    onClose();
  }, [onClose]);

  // Escape key
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };
    document.addEventListener('keydown', h);
    return () => document.removeEventListener('keydown', h);
  }, [visible, handleClose]);
  useBackHandler(visible, handleClose);

  const handleSubmit = useCallback(async () => {
    if (!email || !EMAIL_REGEX.test(email)) {
      setError('Please enter a valid email address.');
      return;
    }
    if (!turnstileToken) {
      setError('Please complete the captcha verification.');
      return;
    }
    if (submission.current && !submission.current.signal.aborted) return;
    const controller = new AbortController();
    submission.current = controller;
    setStep('loading');
    setError(null);
    try {
      const resp = await fetch(NEWSLETTER_API_URL, {
        signal: controller.signal,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, 'cf-turnstile-response': turnstileToken }),
      });
      const data = await resp.json();
      if (controller.signal.aborted) return;
      if (!resp.ok) throw new Error(data.error || 'Failed to subscribe');
      setStep('success');
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setStep('form');
    } finally {
      if (submission.current === controller) submission.current = null;
    }
  }, [email, turnstileToken]);

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      {/* Backdrop */}
      <Pressable className="absolute inset-0 bg-[rgba(0,0,0,0.5)]" onPress={handleClose}>
        <View />
      </Pressable>

      {/* Modal card */}
      <View className="absolute inset-0 items-center justify-center" pointerEvents="box-none">
        <View className="w-[420px] max-w-[90%] items-center gap-[12px] overflow-hidden rounded-card border border-border bg-card-background px-[32px] pb-[28px] pt-[36px]">
          {/* Close */}
          <Pressable
            className="absolute right-[11px] top-[11px] z-[1] h-[28px] w-[28px] items-center justify-center"
            onPress={handleClose}
          >
            <Text className="font-pp-regular text-[18px] text-text-muted">✕</Text>
          </Pressable>

          {step === 'success' ? (
            <>
              <View className="h-[48px] w-[48px] items-center justify-center rounded-full border-2 border-success">
                <Text className="text-[24px] text-success">✓</Text>
              </View>
              <Text className="text-center font-pp-bold text-[20px] text-success">
                You&apos;re subscribed!
              </Text>
              <Text className="px-[8px] text-center font-pp-regular text-[13px] leading-[18px] text-text-secondary">
                Thank you for subscribing. You&apos;ll receive the latest Privacy Pools updates
                directly in your inbox.
              </Text>
              <Pressable
                className="h-[40px] w-full items-center justify-center rounded-control bg-text"
                onPress={handleClose}
              >
                <Text className="font-pp-medium text-[14px] text-[#fff] dark:text-[#000]">
                  Done
                </Text>
              </Pressable>
            </>
          ) : step === 'loading' ? (
            <>
              {/* nw-keep(animated): spinner rotation driven by Animated.Value interpolation (no className path) */}
              <Animated.View
                style={{
                  transform: [
                    {
                      rotate: spinAnim.interpolate({
                        inputRange: [0, 1],
                        outputRange: ['0deg', '360deg'],
                      }),
                    },
                  ],
                }}
              >
                <Text className="text-[32px] text-text">⟳</Text>
              </Animated.View>
              <Text className="font-pp-regular text-[14px] text-text-muted">Subscribing...</Text>
            </>
          ) : (
            <>
              <Text className="text-center font-pp-bold text-[20px] text-text">Stay Updated</Text>
              <Text className="px-[8px] text-center font-pp-regular text-[13px] leading-[18px] text-text-secondary">
                Subscribe for the latest privacy pool updates, features, and security announcements.
              </Text>

              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                value={email}
                onChangeText={(t) => {
                  setEmail(t);
                  setError(null);
                }}
                placeholder="Enter your email address"
                // nw-keep(data-color): placeholder color is a TextInput sink (theme token, no className path)
                placeholderTextColor={colors.textMuted}
                className={`h-[42px] w-full rounded-control border px-[14px] font-pp-regular text-[14px] text-text bg-[#FAFAFA] dark:bg-[#121314] ${error ? 'border-[#C24131]' : 'border-border-light'}`}
                // nw-keep(platform-css): web-only outline reset on the focused input (RN Web TextInput, no className path)
                style={WEB_NO_OUTLINE}
              />

              {error && (
                <Text className="self-start font-pp-regular text-[12px] text-[#C24131]">
                  {error}
                </Text>
              )}

              {/* Turnstile captcha — View ref is a DOM element on RN Web */}
              {Platform.OS === 'web' && TURNSTILE_SITE_KEY ? (
                <View
                  ref={setCaptchaNode}
                  className="min-h-[65px] w-full items-center justify-center"
                />
              ) : null}

              <Pressable
                className="h-[40px] w-full items-center justify-center rounded-control bg-text"
                onPress={handleSubmit}
              >
                <Text className="font-pp-medium text-[14px] text-[#fff] dark:text-[#000]">
                  Subscribe
                </Text>
              </Pressable>

              <Text className="text-center font-pp-regular text-[11px] text-text-muted">
                We respect your privacy. Unsubscribe at any time.
              </Text>
            </>
          )}
        </View>
      </View>
    </Modal>
  );
}
