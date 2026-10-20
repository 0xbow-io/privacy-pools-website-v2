// Render committed social-card PNGs from the approved HTML/SVG composition.
// Run: bun scripts/build-social-cards.mjs (requires Playwright Chromium).
// Deployments serve the committed PNGs and do not need a browser.
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const META = JSON.parse(readFileSync(join(ROOT, 'config/social-meta.json'), 'utf8'));
const TEMPLATE = readFileSync(join(ROOT, 'scripts/social-card.html'), 'utf8');
const SQUARE_TEMPLATE = readFileSync(join(ROOT, 'scripts/social-card-square.html'), 'utf8');
const OUT = join(ROOT, 'public');
const FONT_FACES = [[400, 'Regular'], [500, 'Medium']].map(([weight, name]) => {
  const file = join(ROOT, 'node_modules/@expo-google-fonts/geist', `${weight}${name}`, `Geist_${weight}${name}.ttf`);
  return `@font-face { font-family: Geist; font-weight: ${weight}; src: url(data:font/ttf;base64,${readFileSync(file).toString('base64')}) format('truetype'); }`;
}).join('\n');
const escape = (text) => text.replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function card({ width, height }) {
  const square = width === height;
  const designHeight = square ? 1200 : 630;
  const scale = Math.min(width / 1200, height / designHeight);
  // Center the 1.91:1 composition inside Twitter's slightly wider 2:1 canvas.
  const offset = (width - 1200 * scale) / 2;
  return (square ? SQUARE_TEMPLATE : TEMPLATE)
    .replace('{{fonts}}', FONT_FACES)
    .replace('{{headline}}', escape(META.headline))
    .replace('{{support}}', escape(META.description).replace('. ', '.<br>'))
    .replace('<article>', `<article class="${square ? 'square' : ''}">`)
    .replace('</style>', `
      html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
      article { transform: translateX(${offset}px) scale(${scale}); transform-origin: top left; }
    </style>`);
}

const browser = await chromium.launch(process.env.PW_EXECUTABLE
  ? { executablePath: process.env.PW_EXECUTABLE }
  : {});
mkdirSync(OUT, { recursive: true });
try {
  for (const img of META.images) {
    const page = await browser.newPage({ viewport: { width: img.width, height: img.height }, deviceScaleFactor: 1 });
    await page.setContent(card(img), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const png = await page.screenshot({ type: 'png' });
    writeFileSync(join(OUT, img.file), png);
    console.log(`${img.file} ${img.width}x${img.height} ${(png.length / 1024).toFixed(0)} KB`);
    await page.close();
  }
} finally {
  await browser.close();
}
