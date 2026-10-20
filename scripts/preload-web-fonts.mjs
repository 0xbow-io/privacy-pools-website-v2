// Run after Expo export: discover hashed asset URLs before JavaScript loads fonts.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const target = process.argv[2] ?? 'dist/index.html';
const assets = join(dirname(target), 'assets');
const fonts = readdirSync(assets, { recursive: true })
  .filter(file => /(?:Geist_\w+|Ionicons|MaterialIcons)\.[a-f0-9]+\.woff2$/.test(file))
  .sort();
if (!fonts.length) throw new Error('No compressed web fonts in the Expo export');
const links = fonts.map(file => `<link rel="preload" href="/assets/${file}" as="font" type="font/woff2" crossorigin />`);
const block = `<!-- font-preloads:start -->\n${links.join('\n')}\n<!-- font-preloads:end -->`;
const html = readFileSync(target, 'utf8').replace(/<!-- font-preloads:start -->[\s\S]*?<!-- font-preloads:end -->\n?/g, '');
writeFileSync(target, html.replace('</head>', `${block}\n</head>`));
console.log(`Preloaded ${fonts.length} web fonts in ${target}`);
