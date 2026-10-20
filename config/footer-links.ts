import { PRIVACY_ROUTE, TERMS_ROUTE } from './legal/routes';
import { WHITEPAPER_URL } from './site-urls';
import { DOCS_URL, SUPPORT_TELEGRAM_URL } from './support';

export type FooterLink = {
  label: string;
  href: string;
  action?: 'newsletter';
};

// The about/docs links. Reused by the settings "About" section when the
// embedded smart-wallet experience is active (the footer is hidden then).
export const footerLinks: FooterLink[] = [
  { label: 'White Paper', href: WHITEPAPER_URL },
  { label: 'Docs', href: DOCS_URL },
  { label: 'X', href: 'https://x.com/0xbowio' },
  { label: 'Telegram', href: SUPPORT_TELEGRAM_URL },
  { label: 'Support', href: 'https://docs.privacypools.com/support' },
  { label: 'Github', href: 'https://github.com/0xbow-io' },
  { label: 'Terms', href: TERMS_ROUTE },
  { label: 'Privacy', href: PRIVACY_ROUTE },
  { label: 'Newsletter', href: '', action: 'newsletter' },
];

