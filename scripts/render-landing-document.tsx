// The exported SPA replaces #root with createRoot (it does not hydrate).
// Supply the same public story for readers without JavaScript. Browsers with
// scripting keep the existing blank-to-app startup, without a second layout.
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { LANDING, STEPS, QUESTIONS } from '../config/landing-content';
import { footerLinks } from '../config/footer-links';
import { DOCS_URL, SUPPORT_TELEGRAM_URL } from '../config/support';
import { META } from './social-meta-tags.mjs';

function LandingDocument() {
  return <main id="landing-document">
    <h1>{LANDING.hero.prefix} {LANDING.hero.phrases[0]}</h1>
    <p>{LANDING.hero.body}</p>
    <section>
      <h2>{LANDING.balance.title}</h2>
      <p>{LANDING.balance.body}</p>
      {STEPS.map(step => <section key={step.number}>
        <h3>{step.title}</h3><p>{step.copy}</p>
      </section>)}
    </section>
    <section>
      <h2>{LANDING.payments.title}</h2><p>{LANDING.payments.body}</p>
      <a href="/?action=request">Create a request</a>
    </section>
    <section>
      <h2>{LANDING.custody.title}</h2><p>{LANDING.custody.body}</p>
      <a href="/explore">Explore pools</a>
    </section>
    <section>
      <h2>{LANDING.sdk.title}</h2><p>{LANDING.sdk.body}</p><p>{LANDING.sdk.detail}</p>
      <p><a href={LANDING.sdk.href}>Explore the SDK</a></p>
      <a href={SUPPORT_TELEGRAM_URL}>Talk to the team</a>
    </section>
    <section>
      <h2>{LANDING.disclosure.title}</h2><p>{LANDING.disclosure.body}</p><p>{LANDING.disclosure.detail}</p>
      <a href={LANDING.disclosure.href}>{LANDING.disclosure.linkLabel}</a>
    </section>
    <section>
      <h2>{LANDING.faqTitle}</h2>
      <a href={DOCS_URL}>Read the docs</a>
      {QUESTIONS.map(item => <section key={item.question}>
        <h3>{item.question}</h3><p>{item.answer}</p>
      </section>)}
    </section>
    <section>
      <h2>{LANDING.cta.title}</h2><p>{LANDING.cta.body}</p>
      <a href="/?action=shield">Start shielding</a>
    </section>
    <footer>
      <p>Privacy Pools is built by <a href={LANDING.builder.url}>{LANDING.builder.name}</a></p>
      <nav aria-label="Footer">{footerLinks.filter(link => link.href && link.label !== 'Support').map(link =>
        <p key={link.label}><a href={link.href}>{link.label === 'Github' ? 'GitHub' : link.label === 'Privacy' ? 'Privacy policy' : link.label}</a></p>,
      )}</nav>
    </footer>
  </main>;
}

const dist = resolve(process.argv[2] ?? 'dist');
const file = join(dist, 'index.html');
const marker = /<!-- landing-document:start -->[\s\S]*?<!-- landing-document:end -->/g;
let html = readFileSync(file, 'utf8').replace(marker, '');
if (!html.includes('<div id="root"></div>')) throw new Error('Expected the empty Expo single-output root');
const document = renderToStaticMarkup(<LandingDocument />);
html = html.replace('<div id="root"></div>', `<div id="root"><!-- landing-document:start -->${document}<!-- landing-document:end --></div>`);
html = html.replace(/<noscript>[\s\S]*?<\/noscript>\s*/, '');
const url = `${META.url.replace(/\/+$/, '')}/`;
const organizationId = `${LANDING.builder.url}/#organization`;
const graph = {
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'Organization', '@id': organizationId, name: LANDING.builder.name, url: LANDING.builder.url },
    { '@type': 'WebSite', '@id': `${url}#website`, name: META.title, url, description: META.description, publisher: { '@id': organizationId } },
  ],
};
const head = `<style>
#landing-document { box-sizing: border-box; width: 100%; overflow-y: auto; padding: 32px max(24px, calc((100% - 800px) / 2)); font: 18px/1.6 system-ui, sans-serif; color: #171717; background: white; }
#landing-document h1, #landing-document h2 { line-height: 1.2; white-space: pre-line; }
#landing-document section { margin-block: 32px; }
#landing-document a { color: inherit; text-decoration: underline; }
@media (scripting: enabled) { #landing-document { display: none; } }
</style>
<script type="application/ld+json">${JSON.stringify(graph).replace(/</g, '\\u003c')}</script>`;
// Separate markers keep repeated exports idempotent without matching app styles.
html = html.replace(/<!-- landing-head:start -->[\s\S]*?<!-- landing-head:end -->/g, '');
html = html.replace('</head>', `<!-- landing-head:start -->${head}<!-- landing-head:end --></head>`);
writeFileSync(file, html);
writeFileSync(join(dist, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${url.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</loc></url></urlset>\n`);
const robots = readFileSync(join(dist, 'robots.txt'), 'utf8').replace(/^Sitemap:.*\n?/gm, '').trimEnd();
writeFileSync(join(dist, 'robots.txt'), `${robots}\n\nSitemap: ${url}sitemap.xml\n`);
console.log('Rendered existing landing content, structured data and sitemap');
