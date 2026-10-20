/** In-app routes for the legal documents (bundled, no network request). */
export const TERMS_ROUTE = '/terms';
export const PRIVACY_ROUTE = '/privacy';

/** Footer and settings links that point inside the app rather than out. */
export function isInternalHref(href: string): boolean {
  return href.startsWith('/') && !href.startsWith('//');
}
