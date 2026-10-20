// Native-only globals. Metro resolves this .native.js file on Android/iOS and
// the empty native-polyfills.js on web, so none of this reaches the web bundle.
var g = globalThis;

// DOM events on native. @wallet-standard (Sui wallets) declares
// `class ... extends Event` at module load, and a few UI paths dispatch
// CustomEvents; React Native ships none of Event / CustomEvent / EventTarget,
// so the app died at startup with "Property 'Event' doesn't exist".
if (typeof g.Event === 'undefined') {
  var EventPolyfill = function Event(type, init) {
    this.type = type;
    this.bubbles = !!(init && init.bubbles);
    this.cancelable = !!(init && init.cancelable);
    this.defaultPrevented = false;
    this.timeStamp = Date.now();
  };
  EventPolyfill.prototype.preventDefault = function () { if (this.cancelable) this.defaultPrevented = true; };
  EventPolyfill.prototype.stopPropagation = function () {};
  EventPolyfill.prototype.stopImmediatePropagation = function () {};
  g.Event = EventPolyfill;
}
if (typeof g.CustomEvent === 'undefined') {
  var CustomEventPolyfill = function CustomEvent(type, init) {
    g.Event.call(this, type, init);
    this.detail = init && 'detail' in init ? init.detail : null;
  };
  CustomEventPolyfill.prototype = Object.create(g.Event.prototype);
  CustomEventPolyfill.prototype.constructor = CustomEventPolyfill;
  g.CustomEvent = CustomEventPolyfill;
}
if (typeof g.EventTarget === 'undefined') {
  var EventTargetPolyfill = function EventTarget() { this.__listeners = {}; };
  EventTargetPolyfill.prototype.addEventListener = function (type, fn) {
    if (!this.__listeners) this.__listeners = {};
    (this.__listeners[type] = this.__listeners[type] || []).push(fn);
  };
  EventTargetPolyfill.prototype.removeEventListener = function (type, fn) {
    var l = this.__listeners && this.__listeners[type];
    if (l) this.__listeners[type] = l.filter(function (f) { return f !== fn; });
  };
  EventTargetPolyfill.prototype.dispatchEvent = function (ev) {
    var l = (this.__listeners && this.__listeners[ev.type]) || [];
    for (var i = 0; i < l.length; i++) {
      try { typeof l[i] === 'function' ? l[i].call(this, ev) : l[i].handleEvent(ev); } catch (e) { console.error(e); }
    }
    return !ev.defaultPrevented;
  };
  g.EventTarget = EventTargetPolyfill;
}

// Hermes has no Intl.PluralRules; @mysten/sui builds one at module load
// (English ordinals for error messages). English rules are all it needs.
if (typeof g.Intl !== 'undefined' && typeof g.Intl.PluralRules === 'undefined') {
  var PluralRulesPolyfill = function PluralRules(locale, opts) {
    this.type = (opts && opts.type) || 'cardinal';
  };
  PluralRulesPolyfill.prototype.select = function (n) {
    n = Math.abs(Number(n));
    if (this.type === 'ordinal') {
      var m10 = n % 10, m100 = n % 100;
      if (m10 === 1 && m100 !== 11) return 'one';
      if (m10 === 2 && m100 !== 12) return 'two';
      if (m10 === 3 && m100 !== 13) return 'few';
      return 'other';
    }
    return n === 1 ? 'one' : 'other';
  };
  PluralRulesPolyfill.prototype.resolvedOptions = function () { return { locale: 'en-US', type: this.type }; };
  PluralRulesPolyfill.supportedLocalesOf = function () { return ['en-US']; };
  g.Intl.PluralRules = PluralRulesPolyfill;
}

// window.location on native. React Native defines `window` but not
// `window.location`, and the app reads location.origin/search/hash in ~45
// places (circuit artifacts URL, share links, deep-link params). Point it at
// the production web origin: artifacts are then fetched from the live site,
// and share links built on device open the web app.
if (typeof document === 'undefined' && typeof g.location === 'undefined') {
  // EXPO_PUBLIC_APP_ORIGIN is inlined by babel-preset-expo at build time.
  var PROD_ORIGIN = (process.env.EXPO_PUBLIC_APP_ORIGIN || 'https://privacypools.com').replace(/\/+$/, '');
  var PROD_HOST = PROD_ORIGIN.replace(/^[a-z]+:\/\//i, '');
  g.location = {
    origin: PROD_ORIGIN,
    href: PROD_ORIGIN + '/',
    protocol: 'https:',
    host: PROD_HOST,
    hostname: PROD_HOST.replace(/:\d+$/, ''),
    port: '',
    pathname: '/',
    search: '',
    hash: '',
    assign: function () {},
    replace: function () {},
    reload: function () {},
    toString: function () { return this.href; },
  };
  if (typeof g.window !== 'undefined' && typeof g.window.location === 'undefined') g.window.location = g.location;
}

// window as an EventTarget on native (mipd / wagmi, UI url events listen on it).
if (typeof document === 'undefined' && typeof g.window !== 'undefined' && typeof g.window.addEventListener !== 'function') {
  var wt = new g.EventTarget();
  g.window.addEventListener = wt.addEventListener.bind(wt);
  g.window.removeEventListener = wt.removeEventListener.bind(wt);
  g.window.dispatchEvent = wt.dispatchEvent.bind(wt);
}
