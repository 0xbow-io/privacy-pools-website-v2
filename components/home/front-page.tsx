// nw-keep(data-color): vector icons receive the active theme color or inherit currentColor.
import { useState, type ReactNode } from 'react';
import { Pressable, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTheme } from '@/components/theme-provider';
import { Colors } from '@/constants/theme';
import { DOCS_URL, SUPPORT_TELEGRAM_URL } from '@/config/support';
import { footerLinks } from '@/config/footer-links';
import { STEPS, QUESTIONS, LANDING } from '@/config/landing-content';
import { NewsletterModal } from '@/components/newsletter-modal';
import { LandingReveal, LandingMotionStyles } from './landing-motion';
import {
  PaymentIllustration,
  CustodyIllustration,
  SdkIllustration,
  DisclosureIllustration,
  StepIllustration,
} from './landing-illustrations';

type Action = 'shield' | 'send' | 'swap' | 'request' | 'withdraw';

function Heading({ children, small = false }: { children: ReactNode; small?: boolean }) {
  const { width } = useWindowDimensions();
  return (
    <Text
      role="heading"
      aria-level={2}
      className={`font-pp-sans-medium text-text tracking-[-1.5px] ${small || width < 768 ? 'text-[34px] leading-[40px]' : 'text-[48px] leading-[54px]'}`}
    >
      {children}
    </Text>
  );
}

function FooterHeading({ children }: { children: ReactNode }) {
  return <Text className="font-pp-sans-medium text-[14px] text-text">{children}</Text>;
}

function Body({ children }: { children: ReactNode }) {
  return (
    <Text className="font-pp-sans text-[17px] leading-[28px] text-text-secondary">{children}</Text>
  );
}

function ActionLink({
  label,
  onPress,
  testID,
}: {
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      testID={testID}
      className="landing-cta self-start min-h-[48px] flex-row items-center gap-[12px] rounded-pill px-[20px] py-[12px]"
    >
      <Text className="font-pp-sans-medium text-[15px] text-button-primary-text">{label}</Text>
      <span className="landing-cta-arrow" aria-hidden="true">
        <Ionicons name="arrow-forward" size={18} color="currentColor" />
      </span>
    </Pressable>
  );
}

function ResourceLink({ label, href }: { label: string; href: string }) {
  const hasArrow = label.endsWith(' ↗');
  return (
    <a href={href} className="landing-resource font-pp-sans">
      <span>{hasArrow ? label.slice(0, -2) : label}</span>
      {hasArrow && (
        <span className="landing-resource-arrow" aria-hidden="true">
          ↗
        </span>
      )}
    </a>
  );
}

function Faq({ wide }: { wide: boolean }) {
  const [open, setOpen] = useState<number | null>(0);
  const { colorScheme } = useTheme();
  return (
    <View className={wide ? 'flex-1 min-w-0' : 'w-full'}>
      {QUESTIONS.map((item, i) => (
        <View key={item.question} className="border-b border-border-light">
          <Pressable
            onPress={() => setOpen(open === i ? null : i)}
            accessibilityRole="button"
            accessibilityState={{ expanded: open === i }}
            aria-expanded={open === i}
            aria-controls={`landing-answer-${i}`}
            className="flex-row items-center gap-[20px] py-[24px]"
            testID={`landing-faq-${i}`}
          >
            <Text className="flex-1 font-pp-sans-medium text-[18px] leading-[26px] text-text">
              {item.question}
            </Text>
            <Ionicons
              name={open === i ? 'remove' : 'add'}
              size={22}
              color={Colors[colorScheme].text}
            />
          </Pressable>
          {open === i && (
            <View nativeID={`landing-answer-${i}`} className="pb-[24px] pr-[16px]">
              <Body>{item.answer}</Body>
            </View>
          )}
        </View>
      ))}
    </View>
  );
}

export function FrontPage({
  onAction,
  onExplorePools,
}: {
  onAction: (tab: Action) => void;
  onExplorePools: () => void;
}) {
  const { width } = useWindowDimensions();
  const { colorScheme } = useTheme();
  const wide = width >= 920;
  const [newsletterOpen, setNewsletterOpen] = useState(false);
  const section = wide ? 'py-[112px]' : 'py-[72px]';
  const columns = wide ? 'flex-row items-center gap-[80px]' : 'gap-[32px]';

  return (
    <View className="w-full max-w-[1120px] mx-auto" testID="front-page">
      <LandingMotionStyles />
      <LandingReveal>
        <View className={section} testID="front-act-1">
          <View className={`${columns} ${wide ? 'mb-[88px]' : 'mb-[56px]'}`}>
            <View className={`${wide ? 'flex-1' : 'w-full'} gap-[20px]`}>
              <Heading>{LANDING.balance.title}</Heading>
            </View>
            <View className={`${wide ? 'flex-1' : 'w-full'} gap-[20px]`}>
              <Body>
                {LANDING.balance.body}
              </Body>
            </View>
          </View>
          <View className={wide ? 'flex-row gap-[24px]' : 'gap-[36px]'}>
            {STEPS.map((step) => (
              <View
                key={step.number}
                className={`${wide ? 'flex-1' : 'w-full'} min-w-0 gap-[16px]`}
              >
                <LandingReveal>
                  <StepIllustration step={step.number} />
                </LandingReveal>

                <Text
                  role="heading"
                  aria-level={3}
                  className="font-pp-sans-medium text-[22px] leading-[28px] text-text"
                >
                  {step.title}
                </Text>
                <Body>{step.copy}</Body>
              </View>
            ))}
          </View>
        </View>
      </LandingReveal>

      <LandingReveal>
        <View className={`${section} ${columns}`} testID="landing-payments">
          <View className={`${wide ? 'flex-1' : 'w-full'} min-w-0`}>
            <PaymentIllustration />
          </View>
          <View className={`${wide ? 'flex-1' : 'w-full'} gap-[24px]`}>
            <Heading>{LANDING.payments.title}</Heading>
            <Body>
              {LANDING.payments.body}
            </Body>

            <ActionLink
              label="Create a request"
              onPress={() => onAction('request')}
              testID="landing-request"
            />
          </View>
        </View>
      </LandingReveal>

      <LandingReveal>
        <View className={`${section} ${columns}`} testID="landing-proof">
          <View className={`${wide ? 'flex-1' : 'w-full'} gap-[24px]`}>
            <Heading>{LANDING.custody.title}</Heading>
            <Body>
              {LANDING.custody.body}
            </Body>
            <ActionLink
              label="Explore pools"
              onPress={onExplorePools}
              testID="landing-explore"
            />
          </View>
          <View className={`${wide ? 'flex-1' : 'w-full'} min-w-0`}>
            <CustodyIllustration />
          </View>
        </View>
      </LandingReveal>

      <LandingReveal>
        <View className={`${section} ${columns}`} testID="landing-sdk">
          <View className={`${wide ? 'flex-1' : 'w-full'} min-w-0`}>
            <SdkIllustration />
          </View>
          <View className={`${wide ? 'flex-1' : 'w-full'} gap-[24px]`}>
            <Heading>{LANDING.sdk.title}</Heading>
            <Body>
              {LANDING.sdk.body}
            </Body>
            <Body>
              {LANDING.sdk.detail}
            </Body>
            <View className="flex-row flex-wrap items-center gap-[24px]">
              <a
                href={LANDING.sdk.href}
                data-testid="landing-sdk-docs"
                className="landing-cta font-pp-sans-medium"
              >
                <span>Explore the SDK</span>
                <span className="landing-cta-arrow landing-cta-arrow-external" aria-hidden="true">
                  ↗
                </span>
              </a>
              <a href={SUPPORT_TELEGRAM_URL} className="landing-cta font-pp-sans-medium">
                <span>Talk to the team</span>
                <span className="landing-cta-arrow landing-cta-arrow-external" aria-hidden="true">
                  ↗
                </span>
              </a>
            </View>
          </View>
        </View>
      </LandingReveal>

      <LandingReveal>
        <View className={`${section} ${columns}`} testID="landing-disclosure">
          <View className={`${wide ? 'flex-1' : 'w-full'} gap-[24px]`}>
            <Heading>{LANDING.disclosure.title}</Heading>
            <Body>{LANDING.disclosure.body}</Body>
            <Body>{LANDING.disclosure.detail}</Body>
            <a href={LANDING.disclosure.href} className="landing-cta font-pp-sans-medium self-start">
              <span>{LANDING.disclosure.linkLabel}</span>
              <span className="landing-cta-arrow landing-cta-arrow-external" aria-hidden="true">↗</span>
            </a>
          </View>
          <View className={`${wide ? 'flex-1' : 'w-full'} min-w-0`}>
            <DisclosureIllustration />
          </View>
        </View>
      </LandingReveal>

      <LandingReveal>
        <View
          className={`${section} ${wide ? 'flex-row items-start gap-[80px]' : 'gap-[28px]'}`}
          testID="landing-faq"
        >
          <View className={`${wide ? 'flex-1' : 'w-full'} gap-[20px]`}>
            <Heading>{LANDING.faqTitle}</Heading>
            <a href={DOCS_URL} className="landing-cta font-pp-sans-medium self-start">
              <span>Read the docs</span>
              <span className="landing-cta-arrow landing-cta-arrow-external" aria-hidden="true">
                ↗
              </span>
            </a>
          </View>
          <Faq wide={wide} />
        </View>
      </LandingReveal>

      <LandingReveal>
        <View
          className={`rounded-card bg-background-secondary ${wide ? 'p-[56px] flex-row items-center gap-[48px]' : 'p-[28px] gap-[28px]'}`}
        >
          <View className={`${wide ? 'flex-1' : 'w-full'} gap-[14px]`}>
            <Heading small>{LANDING.cta.title}</Heading>
            <Body>{LANDING.cta.body}</Body>
          </View>
          <ActionLink
            label="Start shielding"
            onPress={() => onAction('shield')}
            testID="front-cta-shield"
          />
        </View>
      </LandingReveal>

      <LandingReveal>
        <footer className="landing-footer">
          <div className="landing-footer-brand">
            <img
              src={`/brand/0xbow-logo-${colorScheme === 'dark' ? 'white' : 'black'}.svg`}
              alt=""
              width={22}
              height={23}
              className="landing-footer-mark"
            />
            <span className="font-pp-sans text-[14px] text-text-secondary">
              {'Privacy Pools is built by '}
              <a
                href={LANDING.builder.url}
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4"
              >
                {LANDING.builder.name}
              </a>
            </span>
          </div>
          <nav className="landing-footer-links" aria-label="Footer">
            <div className="landing-footer-column">
              <FooterHeading>Learn & build</FooterHeading>
              {footerLinks
                .filter((link) => ['White Paper', 'Docs', 'Github'].includes(link.label))
                .map((link) => (
                  <ResourceLink
                    key={link.label}
                    label={link.label === 'Github' ? 'GitHub' : link.label}
                    href={link.href}
                  />
                ))}
            </div>
            <div className="landing-footer-column">
              <FooterHeading>Connect</FooterHeading>
              {footerLinks
                .filter((link) => ['X', 'Telegram'].includes(link.label))
                .map((link) => (
                  <ResourceLink key={link.label} label={link.label} href={link.href} />
                ))}
              <Pressable
                onPress={() => setNewsletterOpen(true)}
                accessibilityRole="button"
                className="landing-resource"
              >
                <Text className="font-pp-sans text-[14px] text-text-secondary">Newsletter</Text>
              </Pressable>
            </div>
            <div className="landing-footer-column">
              <FooterHeading>Legal</FooterHeading>
              {footerLinks
                .filter((link) => ['Terms', 'Privacy'].includes(link.label))
                .map((link) => (
                  <ResourceLink
                    key={link.label}
                    label={link.label === 'Privacy' ? 'Privacy policy' : link.label}
                    href={link.href}
                  />
                ))}
            </div>
          </nav>
        </footer>
      </LandingReveal>
      <NewsletterModal visible={newsletterOpen} onClose={() => setNewsletterOpen(false)} />
    </View>
  );
}
