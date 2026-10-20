import { useEffect, useRef, useState, type ReactNode } from 'react';

/* ANIMATION STORYBOARD
 *    0ms   section begins revealing as it enters the viewport
 *  550ms   section settles from 24px below, once per mount
 * Reduced motion shows every section immediately.
 */
export const TIMING = {
  reveal: 550, // one-time section entrance
  custody: 4000, // personal key gently rises and settles while visible
  hint: 2400, // scroll cue cycle
  actionFade: 360, // gentle handoff between Swap, Earn, and Send
  disclosure: 460, // concealed rows resolve into shared activity
};
const REVEAL = { offset: 24, viewportInset: 48, easing: 'cubic-bezier(.22, .75, .25, 1)' };

/** Web-only landing content. Visible by default, including without motion support. */
export function LandingReveal({ children, loop = false }: { children: ReactNode; loop?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    element.dataset.motionReady = 'true';
    const observer = new IntersectionObserver(([entry]) => {
      if (loop) {
        setStage(entry.isIntersecting ? 1 : 0);
      } else if (entry.isIntersecting) {
        setStage(1);
        observer.disconnect();
      }
    }, { threshold: 0, rootMargin: `0px 0px -${loop ? 48 : REVEAL.viewportInset}px 0px` });
    observer.observe(element);
    return () => { observer.disconnect(); delete element.dataset.motionReady; };
  }, [loop]);
  return <div ref={ref} className={loop ? 'landing-step-motion' : 'landing-reveal'} data-stage={stage} onFocusCapture={() => setStage(1)}>{children}</div>;
}

export function LandingMotionStyles() {
  return <style>{`
    .landing-reveal, .landing-step-motion { width: 100%; }
    .landing-cta { box-sizing:border-box; display:inline-flex; align-items:center; justify-content:center; gap:12px; align-self:flex-start; min-height:48px; padding:12px 20px; border:1px solid transparent; border-radius:var(--pp-radius-pill); background:var(--pp-button-primary); color:var(--pp-button-primary-text); font-size:15px; line-height:24px; text-decoration:none; cursor:pointer; }
    .landing-resource { display:inline-flex; align-items:center; gap:6px; align-self:flex-start; padding:10px 0; color:var(--pp-text-secondary); font-size:15px; line-height:24px; text-decoration:none; cursor:pointer; }
    .landing-footer { display:grid; grid-template-columns:1fr 1.5fr; gap:64px; padding:64px 0 24px; }
    .landing-footer-brand { display:flex; align-items:center; align-self:start; gap:12px; }
    .landing-footer-brand a { color:inherit; }
    .landing-footer-mark { display:block; flex-shrink:0; object-fit:contain; }
    .landing-footer-links { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:32px; }
    .landing-footer-column { display:flex; flex-direction:column; align-items:flex-start; }
    .landing-footer-column > :first-child { margin-bottom:8px; }
    .landing-footer .landing-resource { min-height:32px; box-sizing:border-box; padding:6px 0; font-size:14px; line-height:20px; }
    @media(max-width:767px) { .landing-footer { grid-template-columns:1fr; gap:36px; padding:48px 0 20px; } .landing-footer-links { gap:20px; } }
    @media(max-width:380px) { .landing-footer-links { grid-template-columns:repeat(2,minmax(0,1fr)); row-gap:28px; } }
    .landing-resource-arrow { display:inline-block; }
    .landing-resource:focus-visible { outline:2px solid var(--pp-text); outline-offset:4px; border-radius:4px; }
    .landing-resource:focus:not(:focus-visible) { outline:none; }
    @media (hover:hover) {
      .landing-resource:hover { text-decoration:underline; text-underline-offset:4px; }
      .landing-resource:hover .landing-resource-arrow { transform:translate(2px,-2px); }
    }
    .landing-cta-arrow { display:inline-flex; align-items:center; justify-content:center; width:18px; flex-shrink:0; }
    .landing-cta:focus:not(:focus-visible) { outline:none; }
    .landing-cta:focus-visible { outline:2px solid var(--pp-text); outline-offset:4px; }
    .landing-cta:active { background:var(--pp-button-primary-pressed); }
    @media (hover:hover) {
      .landing-cta:hover .landing-cta-arrow { transform:translateX(4px); }
      .landing-cta:hover .landing-cta-arrow-external { transform:translate(3px,-3px); }
    }
    .landing-art { --art-token:var(--art-surface); --art-hover:var(--art-edge); --art-field:var(--art-bg); --art-bg:#eff3fb; --art-ink:#2864ed; --art-surface:#fff; --art-edge:#dfe7f6; position:relative; height:280px; overflow:hidden; border-radius:var(--pp-radius-card); background:var(--art-bg); color:var(--art-ink); display:flex; align-items:center; justify-content:center; isolation:isolate; }
    .landing-art[data-theme="dark"] { --art-token:var(--art-surface); --art-hover:rgba(255,255,255,.05); --art-field:#1b2639; --art-bg:#151d2c; --art-ink:#79a6ff; --art-surface:#28364f; --art-edge:#374965; }
    .landing-art-02 { --art-bg:#f0eef9; --art-ink:#8c70d9; --art-edge:#e6e0f2; }
    .landing-art-02[data-theme="dark"] { --art-field:#251e34; --art-bg:#211c30; --art-ink:#b09ae8; --art-surface:#342b49; --art-edge:#493d60; }
    .landing-art-03 { --art-bg:#edf5f2; --art-ink:#499c81; --art-edge:#dcebe4; }
    .landing-art-03[data-theme="dark"] { --art-field:#1c2e25; --art-bg:#172822; --art-ink:#79b69d; --art-surface:#293e35; --art-edge:#3b5347; }
    .action-preview { box-sizing:border-box; width:calc(100% - 48px); max-width:288px; padding:16px; border-radius:var(--pp-radius-card); background:var(--art-surface); border:1px solid var(--art-edge); box-shadow:0 4px 8px #17264504,0 16px 28px #17264512; color:var(--art-ink); display:flex; flex-direction:column; gap:10px; }
    .preview-header { display:flex; align-items:center; justify-content:space-between; padding:0 2px 3px; }
    .preview-header strong { font-size:18px; font-weight:500; }
    .preview-field { position:relative; background:var(--art-field); border-radius:var(--pp-radius-inner); padding:10px 12px; }
    .preview-label { display:block; font-size:13px; line-height:18px; }
    .demo-amount { width:100%; min-width:0; padding:0; border:0; border-radius:4px; background:transparent; color:inherit; font-family:inherit; outline:none; }
    .demo-amount:focus-visible { box-shadow:0 2px 0 var(--art-ink); }
    .demo-amount:disabled { opacity:1; -webkit-text-fill-color:currentColor; }
    .preview-asset { display:flex; justify-content:space-between; align-items:center; gap:8px; }
    .preview-asset strong, .demo-amount { font-size:29px; line-height:35px; letter-spacing:-1px; font-weight:500; }
    .preview-token { display:flex; align-items:center; gap:5px; font-size:13px; font-weight:500; background:var(--art-token); border-radius:var(--pp-radius-pill); padding:5px 7px 5px 5px; }
    .preview-destination { display:flex; align-items:center; gap:8px; min-height:35px; font-size:13px; padding:0 3px; }
    .preview-destination span { flex:1; }
    .preview-caption { display:inline-grid; }
    .preview-caption > span { grid-area:1 / 1; opacity:0; visibility:hidden; }
    .preview-caption > span[data-active="true"] { opacity:1; visibility:visible; }

    .preview-cta { display:flex; align-items:center; justify-content:center; gap:8px; min-height:39px; border-radius:var(--pp-radius-control); background:var(--art-ink); color:var(--art-surface); font-size:14px; font-weight:500; }
    .shield-picker { position:relative; }
    .shield-token-picker { color:inherit; font-family:inherit; border:1px solid transparent; cursor:pointer; transition:background 160ms ease; }
    .shield-token-picker:disabled { opacity:.65; cursor:default; }
    .shield-token-picker:not(:disabled):hover, .shield-token-picker[aria-expanded="true"] { background:var(--art-hover); }
    .shield-preview button:focus:not(:focus-visible) { outline:none; }
    .shield-preview button { -webkit-tap-highlight-color:transparent; user-select:none; }
    .shield-token-picker:focus-visible, .shield-asset-menu button:focus-visible { outline:2px solid var(--art-ink); outline-offset:2px; }
    .shield-asset-menu { display:flex; flex-direction:column; gap:4px; position:absolute; top:calc(100% + 8px); right:0; z-index:5; width:144px; padding:8px; border-radius:var(--pp-radius-inner); border:1px solid var(--art-edge); background:var(--art-surface); box-shadow:0 8px 24px #17264524; }
    .shield-asset-menu button { box-sizing:border-box; display:flex; align-items:center; gap:9px; width:100%; padding:9px; border:0; border-radius:var(--pp-radius-control); background:transparent; color:var(--art-ink); font:inherit; font-size:14px; cursor:pointer; }
    .shield-asset-menu button span { flex:1; text-align:left; }
    .shield-asset-menu button:hover, .shield-asset-menu button[aria-pressed="true"] { background:var(--art-hover); }
    .shield-demo-button { width:100%; border:0; font-family:inherit; cursor:pointer; transition:filter 160ms ease, box-shadow 160ms ease; }
    .shield-demo-button:hover:not(:disabled) { filter:brightness(1.1); box-shadow:0 4px 10px #17264518; }
    .shield-demo-button:active:not(:disabled) { filter:brightness(.95); }
    .shield-demo-button:focus-visible { outline:2px solid var(--art-ink); outline-offset:3px; }
    .shield-demo-button:disabled { cursor:wait; opacity:.65; }
    .shield-demo-spinner { width:17px; height:17px; box-sizing:border-box; border:2px solid var(--art-edge); border-top-color:var(--art-ink); border-radius:50%; flex:none !important; }
    .landing-step-art { height:auto; aspect-ratio:1; min-height:370px; }
    .private-preview-cycle { width:100%; display:flex; justify-content:center; }
    .private-preview-stack { display:grid; width:calc(100% - 48px); max-width:288px; }
    .private-preview-slide { grid-area:1 / 1; width:100%; height:320px; padding:20px; gap:12px; opacity:0; visibility:hidden; pointer-events:none; }
    .private-preview-slide[data-active="true"] { opacity:1; visibility:visible; pointer-events:auto; }
    .private-preview-slide .payment-demo-reset { width:24px; height:24px; }
    .private-preview-slide .preview-header { min-height:24px; padding:0; }
    .private-preview-slide .preview-field { padding:10px 12px; }
    .private-preview-slide .preview-asset { margin-top:4px; }
    .private-preview-slide .preview-token { flex-shrink:0; white-space:nowrap; }
    .private-preview-slide .preview-cta { min-height:44px; flex-shrink:0; }
    .demo-action-result { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; text-align:center; }
    .demo-action-result strong { font-size:19px; font-weight:500; }
    .demo-action-result > span:last-child { font-size:14px; }
    .demo-action-result .shield-demo-spinner { width:36px; height:36px; border-width:3px; }
    .demo-portfolio { flex:1; display:flex; flex-direction:column; gap:6px; }
    .demo-portfolio-row { display:flex; align-items:center; gap:10px; padding:8px 10px; background:var(--art-field); border-radius:var(--pp-radius-control); }
    .demo-portfolio-row > span { flex:1; display:flex; flex-direction:column; gap:2px; }
    .demo-portfolio-row strong { font-size:14px; font-weight:500; }
    .demo-portfolio-row small { font-size:12px; }
    .demo-portfolio-row > .demo-portfolio-balance { flex:none; align-items:flex-end; white-space:nowrap; font-variant-numeric:tabular-nums; }
    .demo-portfolio-balance small { color:var(--pp-success); font-weight:600; }
    .demo-portfolio > .preview-label { font-size:11px; text-align:center; }
    .private-preview-fields { flex:1; display:flex; flex-direction:column; gap:4px; }
    .preview-connector { height:24px; display:grid; place-items:center; flex-shrink:0; }
    .preview-yield { flex:1; display:flex; flex-direction:column; justify-content:center; gap:4px; padding:12px; }
    .preview-yield-rate { display:flex; align-items:baseline; gap:7px; }
    .preview-yield-rate strong { font-size:38px; line-height:46px; font-weight:500; letter-spacing:-1px; }
    .preview-yield-rate strong span { font-size:25px; }
    .preview-yield-rate > span { font-size:14px; }
    .preview-yield-rate > :last-child { margin-left:auto; align-self:center; }
    .preview-recipient { margin-top:24px; padding:10px 12px; background:var(--art-field); border-radius:var(--pp-radius-inner); }
    .preview-recipient > div { display:flex; gap:8px; align-items:center; min-height:35px; margin-top:4px; }
    .preview-recipient strong { flex:1; font-size:14px; font-weight:500; }
    .payment-art { height:440px; --art-bg:#eef2fb; }
    .payment-widget { width:calc(100% - 48px); max-width:338px; padding:24px; gap:18px; border-radius:var(--pp-radius-card); }
    .payment-widget .preview-header strong { font-size:23px; }
    .payment-widget .preview-field { padding:16px; }
    .payment-widget .preview-label { font-size:14px; margin-bottom:10px; }
    .payment-widget .preview-asset strong, .payment-widget .demo-amount { font-size:42px; line-height:48px; }
    .payment-widget .preview-token { font-size:15px; }
    .payment-widget .preview-destination { font-size:14px; }
    .payment-widget .preview-cta { min-height:48px; font-size:16px; }
    .payment-demo-reset { display:grid; place-items:center; width:32px; height:32px; padding:0; border:0; border-radius:var(--pp-radius-control); background:transparent; color:inherit; cursor:pointer; }
    .payment-demo-reset:hover { background:var(--art-field); }
    .payment-demo-reset:focus-visible { outline:2px solid var(--art-ink); outline-offset:2px; }
    .payment-widget .preview-header { min-height:32px; }
    .disclosure-art { height:auto; min-height:440px; box-sizing:border-box; padding:32px 0; --art-bg:#edf5f2; --art-ink:#367d65; --art-edge:#d6e8df; }
    .disclosure-art[data-theme="dark"] { --art-bg:#172822; --art-ink:#9acdb6; --art-surface:#293e35; --art-edge:#3b5347; }
    .disclosure-scene { width:calc(100% - 40px); max-width:384px; }
    .disclosure-scope { position:relative; display:flex; padding:4px; margin-bottom:24px; border:0; border-radius:var(--pp-radius-pill); background:var(--art-bg); }
    .disclosure-scope-thumb { position:absolute; top:4px; bottom:4px; left:4px; width:calc((100% - 8px) / 3); border-radius:var(--pp-radius-pill); background:var(--art-ink); }
    .disclosure-art[data-stage="1"] .disclosure-scope-thumb { transform:translateX(100%); }
    .disclosure-art[data-stage="2"] .disclosure-scope-thumb { transform:translateX(200%); }
    .disclosure-scope button { position:relative; flex:1; min-width:0; min-height:40px; padding:6px 2px; border:0; border-radius:var(--pp-radius-pill); background:transparent; color:inherit; font:inherit; font-family:var(--pp-font-sans-medium); font-size:13px; line-height:18px; cursor:pointer; }
    .disclosure-scope button[aria-pressed="true"] { color:var(--art-surface); }
    .disclosure-scope button:focus-visible { outline:2px solid var(--art-ink); outline-offset:3px; }
    .disclosure-card { padding:24px 20px; border:1px solid var(--art-edge); border-radius:var(--pp-radius-card); background:var(--art-surface); box-shadow:0 4px 8px #17264504,0 16px 28px #17264512; }
    @media(max-width:380px) { .disclosure-scene { width:calc(100% - 24px); } .disclosure-card { padding-inline:12px; } .disclosure-scope button { font-size:12px; } }
    .disclosure-heading { display:flex; align-items:center; gap:10px; margin-bottom:24px; }
    .disclosure-heading > span { flex:1; font-size:18px; font-family:var(--pp-font-sans-medium); }
    .disclosure-rows { display:flex; flex-direction:column; gap:10px; }
    .disclosure-row { display:grid; height:60px; border-radius:var(--pp-radius-control); background:var(--art-bg); }
    .disclosure-row > span { grid-area:1 / 1; display:flex; align-items:center; gap:10px; padding:0 14px; font-size:14px; }
    .disclosure-row > span > :last-child { margin-left:auto; }
    .disclosure-row strong { font-weight:500; white-space:nowrap; }
    .disclosure-amount { display:inline-flex; align-items:center; gap:6px; }
    .disclosure-asset { display:inline-flex; align-items:center; gap:8px; }
    .disclosure-asset > span { display:flex; flex-shrink:0; }
    @media(max-width:380px) { .disclosure-row > span { gap:6px; padding-inline:8px; } }
    .disclosure-row-mask { letter-spacing:2px; }
    .disclosure-row-detail { opacity:0; visibility:hidden; transform:translateY(5px); }
    .disclosure-row[data-revealed="true"] .disclosure-row-detail { opacity:1; visibility:visible; transform:none; }
    .disclosure-row[data-revealed="true"] .disclosure-row-mask { opacity:0; visibility:hidden; transform:translateY(-5px); }
    .custody-art,.sdk-art { height:440px; }
    .custody-art { --art-bg:#f8f6e9; --art-ink:#54554d; --art-edge:#e8e3cd; --custody-key-bg:#e7d579; --custody-key-ink:#45463f; }
    .custody-art[data-theme="dark"] { --art-bg:#25251f; --art-ink:#dbdccf; --art-surface:#34352d; --art-edge:#49493b; --custody-key-bg:#e0cf7c; --custody-key-ink:#35362f; }
    .custody-scene { position:relative; width:calc(100% - 48px); max-width:320px; height:290px; }
    .custody-balance-card { position:absolute; top:30px; left:0; width:calc(100% - 24px); box-sizing:border-box; padding:26px; border-radius:var(--pp-radius-card); background:var(--art-surface); border:1px solid var(--art-edge); box-shadow:0 4px 8px #17264504,0 16px 28px #17264512; transform:rotate(-5deg); }
    .custody-balance-heading { display:flex; justify-content:space-between; align-items:center; gap:12px; font-size:17px; }
    .custody-hidden-balance { font-size:40px; line-height:64px; letter-spacing:5px; margin:8px 0; }
    .custody-asset { display:flex; align-items:center; gap:8px; font-size:15px; }
    .custody-key-tile { position:absolute; right:0; bottom:20px; width:116px; height:116px; display:grid; place-items:center; border-radius:var(--pp-radius-card); background:var(--custody-key-bg); border:1px solid var(--art-edge); color:var(--custody-key-ink); transform:rotate(8deg); box-shadow:0 12px 24px #17264512; }

    .sdk-art { height:480px; --art-bg:#f0eef9; --art-ink:#7855c6; }
    .sdk-art[data-theme="dark"] { --art-bg:#211c30; --art-ink:#b09ae8; --art-surface:#342b49; --art-edge:#4a3b65; }
    .sdk-scene { position:relative; width:min(300px, calc(100% - 64px)); padding-bottom:0; }
    .sdk-app { box-sizing:border-box; padding:18px; border-radius:var(--pp-radius-card); background:var(--art-surface); border:1px solid var(--art-edge); box-shadow:0 12px 28px #251b4010; }
    .sdk-app-title { display:flex; align-items:center; justify-content:space-between; margin-bottom:14px; font-size:18px; font-family:var(--pp-font-sans-medium); }
    .sdk-mode { display:flex; align-items:center; justify-content:space-between; width:100%; box-sizing:border-box; gap:10px; margin-top:12px; padding:12px 14px; border:1px solid var(--art-edge); border-radius:var(--pp-radius-card); background:var(--art-surface); color:inherit; font:inherit; font-size:14px; cursor:pointer; }
    .sdk-mode > span:first-of-type { flex:1; text-align:left; }
    .sdk-mode:focus-visible { outline:2px solid var(--art-ink); outline-offset:3px; }
    .sdk-switch { width:34px; height:20px; border-radius:999px; padding:3px; box-sizing:border-box; background:var(--art-edge); }
    .sdk-switch > span { display:block; width:14px; height:14px; border-radius:50%; background:var(--art-surface); }
    .sdk-scene[data-private="true"] .sdk-switch { background:var(--art-ink); }
    .sdk-scene[data-private="true"] .sdk-switch > span { transform:translateX(14px); }
    .sdk-label { font-size:12px; opacity:.75; margin-bottom:6px; }
    .sdk-token-row { display:flex; align-items:center; gap:10px; padding:8px 0; font-size:14px; }
    .sdk-token-row > span { flex:1; }
    .sdk-transfer-recipient { display:block; margin-top:3px; font-size:11px; opacity:.75; }
    .sdk-transfer-recipient > span { letter-spacing:2px; }
    .sdk-token-row strong { text-align:right; font-variant-numeric:tabular-nums; font-size:16px; font-weight:500; }
    .sdk-wallet-actions { display:flex; gap:0; margin-top:0; }
    .sdk-wallet-action + .sdk-wallet-action { margin-left:8px; }
    .sdk-wallet-action { flex:1; display:flex; flex-direction:column; align-items:center; gap:5px; }
    .sdk-wallet-action > span { display:grid; place-items:center; height:36px; width:100%; border-radius:var(--pp-radius-control); background:var(--art-bg); }
    .sdk-wallet-action strong { font-size:12px; font-weight:500; }
    .sdk-wallet-action.sdk-shield-action { flex:0; min-width:0; margin-left:0; overflow:hidden; opacity:0; visibility:hidden; }
    .sdk-scene[data-private="true"] .sdk-shield-action { flex:1; margin-left:8px; opacity:1; visibility:visible; }
    .sdk-wallet-tabs { display:flex; gap:0; margin:18px 0 14px; }
    .sdk-wallet-tabs button:first-child { margin-right:22px; }
    .sdk-wallet-tabs button { display:flex; align-items:center; justify-content:center; gap:5px; padding:8px 0 3px; border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:inherit; font:inherit; font-size:13px; cursor:pointer; }
    .sdk-wallet-tabs button[aria-pressed="true"] { border-bottom-color:currentColor; }
    .sdk-wallet-tabs button:focus-visible { outline:2px solid var(--art-ink); outline-offset:2px; }
    .sdk-wallet-tabs .sdk-privacy-tab { width:0; min-width:0; flex-shrink:0; margin-right:0; overflow:hidden; white-space:nowrap; opacity:0; visibility:hidden; }
    .sdk-scene[data-private="true"] .sdk-privacy-tab { width:46px; margin-right:22px; opacity:1; visibility:visible; }
    .sdk-wallet-panels { display:grid; }
    .sdk-wallet-panel { grid-area:1 / 1; opacity:0; visibility:hidden; }
    .sdk-wallet-panel[data-active="true"] { opacity:1; visibility:visible; }
    .custody-eye { display:grid; place-items:center; flex-shrink:0; width:40px; height:40px; margin:-9px; border:0; border-radius:var(--pp-radius-control); background:transparent; color:inherit; cursor:pointer; }
    .custody-eye:hover { background:var(--art-bg); }
    .custody-eye:focus-visible { outline:2px solid currentColor; outline-offset:3px; }
    .custody-eye span { display:flex; }
    .custody-status { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); }
    @media (prefers-reduced-motion: reduce) { .landing-cta .landing-cta-arrow, .landing-resource .landing-resource-arrow { transform:none; } }
    @media (prefers-reduced-motion: no-preference) {
      .disclosure-row > span { transition:opacity ${TIMING.disclosure}ms ease, transform ${TIMING.disclosure}ms cubic-bezier(.22,.75,.25,1), visibility ${TIMING.disclosure}ms; }
      .disclosure-scope-thumb { transition:transform ${TIMING.disclosure}ms cubic-bezier(.22,.75,.25,1); }
      .disclosure-scope button { transition:color ${TIMING.disclosure}ms ease; }
      .landing-resource { transition:color 180ms ease; }
      .landing-resource-arrow { transition:transform 220ms cubic-bezier(.22,1,.36,1); }
      .landing-cta { transition:background 180ms ease, box-shadow 180ms ease; }
      .landing-cta-arrow { transition:transform 220ms cubic-bezier(.22,1,.36,1); }
      .sdk-switch, .sdk-switch > span, .sdk-wallet-action > span { transition:transform 320ms cubic-bezier(.4,0,.2,1), background 320ms ease, color 320ms ease; }
      .sdk-wallet-tabs button { transition:border-color 320ms ease, opacity 240ms ease; }
      .sdk-shield-action { transition:flex-grow 440ms cubic-bezier(.4,0,.2,1), margin-left 440ms cubic-bezier(.4,0,.2,1), opacity 180ms ease, visibility 440ms; }
      .sdk-scene[data-private="true"] .sdk-shield-action { transition:flex-grow 440ms cubic-bezier(.4,0,.2,1), margin-left 440ms cubic-bezier(.4,0,.2,1), opacity 260ms ease 140ms, visibility 0ms; }
      .sdk-wallet-tabs .sdk-privacy-tab { transition:width 440ms cubic-bezier(.4,0,.2,1), margin-right 440ms cubic-bezier(.4,0,.2,1), opacity 180ms ease, visibility 440ms, border-color 320ms ease; }
      .sdk-scene[data-private="true"] .sdk-privacy-tab { transition:width 440ms cubic-bezier(.4,0,.2,1), margin-right 440ms cubic-bezier(.4,0,.2,1), opacity 260ms ease 140ms, visibility 0ms, border-color 320ms ease; }
      .sdk-wallet-panel { transition:opacity 420ms ease, visibility 420ms; }
      .custody-refusal { animation:custody-refuse 420ms ease-in-out; }
      .shield-demo-spinner { animation:shield-demo-spin 800ms linear infinite; }
      .landing-step-motion[data-stage="1"] .custody-key-tile { animation:custody-key-float ${TIMING.custody}ms ease-in-out infinite; }
      .preview-caption > span, .private-preview-slide { transition:opacity ${TIMING.actionFade}ms cubic-bezier(.4,0,.2,1), visibility ${TIMING.actionFade}ms; }
      .landing-reveal { transition:opacity ${TIMING.reveal}ms ${REVEAL.easing}, transform ${TIMING.reveal}ms ${REVEAL.easing}; }
      .landing-reveal[data-motion-ready="true"][data-stage="0"] { opacity:0; transform:translateY(${REVEAL.offset}px); }
      .landing-reveal[data-stage="1"], .landing-reveal:focus-within { opacity:1; transform:none; }
      [data-testid="front-scroll-hint"] { animation:scroll-nudge ${TIMING.hint}ms ease-in-out infinite; border-radius:var(--pp-radius-card); padding:8px 18px; }
    }
    @keyframes custody-refuse { 0%,100% { transform:translateX(0); } 20%,60% { transform:translateX(-4px); } 40%,80% { transform:translateX(4px); } }
    @keyframes shield-demo-spin { to { transform:rotate(360deg); } }
    @keyframes custody-key-float { 0%,100% { transform:translateY(0) rotate(8deg); } 50% { transform:translateY(-12px) rotate(3deg); } }
    @keyframes scroll-nudge { 0%,20%,80%,100% { transform:translateY(0); opacity:.72; } 40%,60% { transform:translateY(6px); opacity:1; } }
  `}</style>;
}
