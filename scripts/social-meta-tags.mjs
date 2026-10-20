// The social <head> for the exported web shell, from config/social-meta.json.
// Shared by scripts/inject-social-meta.mjs (build step) and its test.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE_META = JSON.parse(readFileSync(join(ROOT, 'config', 'social-meta.json'), 'utf8'));
// EXPO_PUBLIC_APP_ORIGIN overrides the JSON url at build time (default in the JSON: https://privacypools.com).
const ORIGIN_OVERRIDE = process.env.EXPO_PUBLIC_APP_ORIGIN?.trim();
export const META = ORIGIN_OVERRIDE ? { ...FILE_META, url: ORIGIN_OVERRIDE.replace(/\/+$/, '') } : FILE_META;

const START = '<!-- social-meta:start -->';
const END = '<!-- social-meta:end -->';

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The tag block. Every size is declared with its dimensions so each crawler
 *  can pick the ratio it renders: Facebook/LinkedIn/Telegram/WhatsApp read
 *  og:image (first = 1.91:1, then square), Twitter reads twitter:image. */
export function socialMetaTags(meta = META) {
  const base = meta.url.replace(/\/+$/, '');
  const abs = (file) => `${base}/${file}`;
  const byRole = (role) => meta.images.find((i) => i.role === role);
  const og = meta.images.filter((i) => i.role.startsWith('og'));
  const twitterLarge = byRole('twitter-large') ?? byRole('og');
  const lines = [
    START,
    `<title>${esc(meta.title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}" />`,
    `<link rel="canonical" href="${esc(base)}/" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(meta.title)}" />`,
    `<meta property="og:title" content="${esc(meta.title)}" />`,
    `<meta property="og:description" content="${esc(meta.description)}" />`,
    `<meta property="og:url" content="${esc(base)}/" />`,
    `<meta property="og:locale" content="en_US" />`,
  ];
  for (const img of og) {
    lines.push(
      `<meta property="og:image" content="${esc(abs(img.file))}" />`,
      `<meta property="og:image:secure_url" content="${esc(abs(img.file))}" />`,
      `<meta property="og:image:type" content="image/png" />`,
      `<meta property="og:image:width" content="${img.width}" />`,
      `<meta property="og:image:height" content="${img.height}" />`,
      `<meta property="og:image:alt" content="${esc(img.alt)}" />`,
    );
  }
  lines.push(
    `<meta name="twitter:card" content="summary_large_image" />`,
    ...(meta.twitterSite ? [`<meta name="twitter:site" content="${esc(meta.twitterSite)}" />`] : []),
    `<meta name="twitter:title" content="${esc(meta.title)}" />`,
    `<meta name="twitter:description" content="${esc(meta.description)}" />`,
    `<meta name="twitter:image" content="${esc(abs(twitterLarge.file))}" />`,
    `<meta name="twitter:image:alt" content="${esc(twitterLarge.alt)}" />`,
    END,
  );
  return lines.join('\n');
}

/** Replaces the social block without pushing the encoding declaration past the browser's first 1024 bytes. */
export function injectSocialMeta(html, meta = META) {
  let out = html;
  const s = out.indexOf(START);
  const e = out.indexOf(END);
  if (s !== -1 && e !== -1) out = out.slice(0, s) + out.slice(e + END.length);
  // Expo's single-output shell titles the page with the app slug.
  out = out.replace(/<title>[^<]*<\/title>\s*/i, '');
  const headOpen = out.match(/<head[^>]*>/i);
  if (!headOpen) throw new Error('no <head> in the exported HTML');
  const charset = out.match(/<meta\s+charset\s*=[^>]+>/i);
  const at = charset ? charset.index + charset[0].length : headOpen.index + headOpen[0].length;
  return out.slice(0, at) + '\n' + socialMetaTags(meta) + '\n' + out.slice(at);
}
