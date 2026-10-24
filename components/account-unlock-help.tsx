import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

const COPY = {
  en: {
    action: 'Find your original unlock',
    account: 'Use your original wallet or passkey. Connecting the same wallet alone may open a different private account.',
    phone: 'On Chrome for Mac, cancel the Touch ID prompt, then choose your phone if offered. Use your existing Privacy Pools passkey.',
    preserve: 'Do not create a new passkey or clear browser data to recover funds.',
  },
  zh: {
    action: '找回原来的解锁方式',
    account: '请使用原来的钱包或通行密钥。连接同一个钱包，并不代表已解锁同一个隐私账户。',
    phone: '在 Mac 的 Chrome 中，取消触控 ID 提示，再选择手机（如有此选项），使用原来的 Privacy Pools 通行密钥登录。',
    preserve: '找回资金时，请勿新建通行密钥或清除浏览器数据。',
  },
};

export function AccountUnlockNotice({ network }: { network: string }) {
  return (
    <View className="gap-[8px] rounded-control border border-warning px-[16px] py-[12px]" testID="account-unlock-mismatch">
      <Text accessibilityRole="alert" className="font-pp-sans-medium text-[13px] leading-[18px] text-warning">
        This unlock does not match your account on {network}.
      </Text>
      <AccountUnlockHelp />
    </View>
  );
}

/** Local instructions only: opening help never fetches account or note data. */
export function AccountUnlockHelp() {
  const [expanded, setExpanded] = useState(false);
  const [language, setLanguage] = useState<'en' | 'zh'>('en');
  const copy = COPY[language];
  return (
    <View className="gap-[8px]" testID="account-unlock-help">
      <View className="flex-row flex-wrap items-center gap-[12px]">
        <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => setExpanded(!expanded)}>
          <Text className="font-pp-sans-medium text-[13px] text-text underline">{copy.action}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={language === 'en' ? '中文帮助' : 'Help in English'} onPress={() => { setLanguage(language === 'en' ? 'zh' : 'en'); setExpanded(true); }}>
          <Text className="font-pp-sans text-[13px] text-text underline">{language === 'en' ? '中文' : 'English'}</Text>
        </Pressable>
      </View>
      {expanded ? (
        <View className="gap-[6px]">
          <Text className="font-pp-sans text-[12px] leading-[18px] text-text-secondary">{copy.account}</Text>
          <Text className="font-pp-sans text-[12px] leading-[18px] text-text-secondary">{copy.phone}</Text>
          <Text className="font-pp-sans text-[12px] leading-[18px] text-text-secondary">{copy.preserve}</Text>
        </View>
      ) : null}
    </View>
  );
}
