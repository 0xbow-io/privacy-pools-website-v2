// Post-export step (vercel.json buildCommand): put the social <head> into the
// served shell. With web.output "single" Expo never renders app/+html.tsx, so
// the live page carried the app slug as its title and no og:/twitter: tags
// (link previews on X, Facebook, Telegram, WhatsApp showed nothing;
// Pat, 2026-09-04). Run: bun scripts/inject-social-meta.mjs [dist/index.html]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectSocialMeta, META } from './social-meta-tags.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = process.argv[2] ?? join(ROOT, 'dist', 'index.html');
if (!existsSync(target)) {
  console.error(`inject-social-meta: ${target} not found (run after expo export)`);
  process.exit(1);
}
for (const img of META.images) {
  if (!existsSync(join(ROOT, 'public', img.file))) {
    console.error(`inject-social-meta: public/${img.file} missing; run scripts/build-social-cards.mjs`);
    process.exit(1);
  }
}
const html = readFileSync(target, 'utf8');
writeFileSync(target, injectSocialMeta(html));
console.log(`inject-social-meta: ${target} now carries the ${META.title} social head (${META.images.length} images)`);
