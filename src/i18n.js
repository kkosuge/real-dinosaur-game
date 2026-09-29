/* UI language (ja / en): negotiated from the browser's languages, overridable with ?lang=ja|en, followed live on the
 * window 'languagechange' event. Owns every DOM-side string (document title, meta description, the canvas label, the
 * live-region announcements, the share UI); the renderer draws its canvas text in ui.lang (main.js passes it).
 *
 *   RDG.i18n.lang                 'ja' | 'en' (current)
 *   RDG.i18n.t(key, vars)         localized string, {name} placeholders filled from vars (missing -> English -> key)
 *   RDG.i18n.negotiate(list)      first entry whose primary subtag is ja / en, else 'en'
 *   RDG.i18n.apply()              write the strings into the document ([data-i18n], [data-i18n-attr], title, ...)
 *   RDG.i18n.onChange(fn)         fn(lang) after a live language change (not for the initial language)
 *
 * Classic script (no modules: file:// must work); also loads in Node for tools/sim_test.js. */
(function (root) {
  'use strict';
  var RDG = (root.RDG = root.RDG || {});

  var STRINGS = {
    en: {
      'title': 'Real Dinosaur Game',
      'description': 'A photorealistic remake of Chrome\'s offline T-Rex runner. Space / Up to jump, Down to duck.',
      'a11y.canvas': 'Real Dinosaur Game. Press Space or tap to play. Space or Up to jump, Down to duck.',
      'a11y.start': 'Game started',
      'a11y.over': 'Game over. Score {score}. High score {hi}. Press Space or tap to restart.',
      'a11y.paused': 'Paused',
      'share.button': 'Share',
      'share.buttonTitle': 'Share your score',
      'share.menu': 'Share to',
      'share.x': 'Post on X',
      'share.bluesky': 'Post on Bluesky',
      'share.facebook': 'Share on Facebook',
      'share.line': 'Share on LINE',
      'share.copy': 'Copy text',
      'share.copied': 'Copied!',
      'share.copyFailed': 'Could not copy',
      'share.save': 'Save image',
      'share.saveFailed': 'Could not save the image',
      'share.more': 'More…', // the OS share sheet (desktop menu)
      'share.title': 'Real Dinosaur Game',
      // {best} is '' or share.best
      'share.text': 'I scored {score} in Real Dinosaur Game!{best} 🦖 #RealDinosaurGame',
      'share.best': ' New personal best!'
    },
    ja: {
      'title': 'リアル恐竜ゲーム',
      'description': 'Chrome のオフライン恐竜ゲーム（T-Rex Runner）を実写風に作り直したブラウザゲーム。スペース / ↑ でジャンプ、↓ でしゃがむ。',
      'a11y.canvas': 'リアル恐竜ゲーム。スペースキーかタップでスタート。スペースか↑でジャンプ、↓でしゃがむ。',
      'a11y.start': 'ゲーム開始',
      'a11y.over': 'ゲームオーバー。スコア {score}、ハイスコア {hi}。スペースキーかタップでリスタート。',
      'a11y.paused': '一時停止',
      'share.button': 'シェア',
      'share.buttonTitle': 'スコアをシェア',
      'share.menu': 'シェア先',
      'share.x': 'X でポスト',
      'share.bluesky': 'Bluesky でポスト',
      'share.facebook': 'Facebook でシェア',
      'share.line': 'LINE で送る',
      'share.copy': 'テキストをコピー',
      'share.copied': 'コピーしました',
      'share.copyFailed': 'コピーできませんでした',
      'share.save': '画像を保存',
      'share.saveFailed': '画像を保存できませんでした',
      'share.more': 'その他…',
      'share.title': 'リアル恐竜ゲーム',
      'share.text': 'リアル恐竜ゲームで {score} 点を記録！{best}🦖 #RealDinosaurGame',
      'share.best': '自己ベスト更新！'
    }
  };

  function primary(tag) { return String(tag == null ? '' : tag).trim().toLowerCase().split(/[-_]/)[0]; }

  /** First entry of `list` (BCP 47 tags, e.g. navigator.languages) whose primary subtag is ja or en; else 'en'. */
  function negotiate(list) {
    if (!list) return 'en';
    if (typeof list === 'string') list = [list];
    for (var i = 0; i < list.length; i++) {
      var p = primary(list[i]);
      if (p === 'ja' || p === 'en') return p;
    }
    return 'en';
  }

  /** The browser's preference list: navigator.languages, else [navigator.language]. */
  function browserLanguages() {
    var n = root.navigator;
    if (!n) return [];
    if (n.languages && n.languages.length) return Array.prototype.slice.call(n.languages);
    return n.language ? [n.language] : [];
  }

  /** ?lang=ja|en (anything else: no override). */
  function readOverride() {
    try {
      var v = new URLSearchParams(root.location.search).get('lang');
      v = v ? v.toLowerCase() : '';
      return v === 'ja' || v === 'en' ? v : '';
    } catch (e) { return ''; }
  }

  var override = readOverride();
  var listeners = [];

  function t(key, vars) {
    var table = STRINGS[api.lang] || STRINGS.en, s = table[key];
    if (s == null) s = STRINGS.en[key];
    if (s == null) return key;
    return s.replace(/\{(\w+)\}/g, function (m, k) { return vars && vars[k] != null ? String(vars[k]) : m; });
  }

  /** Write the current language into the document: <html lang>, the title, the meta description, and every element's
   * [data-i18n] text / [data-i18n-attr="attr:key,attr2:key2"] attributes (the canvas label, the share UI). */
  function apply() {
    var doc = root.document;
    if (!doc) return;
    try {
      if (doc.documentElement) doc.documentElement.lang = api.lang;
      doc.title = t('title');
      var md = doc.querySelector && doc.querySelector('meta[name="description"]');
      if (md) md.setAttribute('content', t('description'));
      if (!doc.querySelectorAll) return;
      var els = doc.querySelectorAll('[data-i18n]');
      for (var i = 0; i < els.length; i++) els[i].textContent = t(els[i].getAttribute('data-i18n'));
      els = doc.querySelectorAll('[data-i18n-attr]');
      for (var j = 0; j < els.length; j++) {
        var pairs = els[j].getAttribute('data-i18n-attr').split(',');
        for (var k = 0; k < pairs.length; k++) {
          var kv = pairs[k].split(':');
          if (kv.length === 2) els[j].setAttribute(kv[0].trim(), t(kv[1].trim()));
        }
      }
    } catch (e) { /* never break the game over a label */ }
  }

  /** Switch to `lang` ('ja' | 'en'): re-apply the document strings and notify listeners when it changed. */
  function setLang(lang) {
    lang = lang === 'ja' ? 'ja' : 'en';
    if (lang === api.lang) return false;
    api.lang = lang;
    apply();
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](lang); } catch (e) { if (root.console) root.console.warn('[RDG] i18n listener', e); }
    }
    return true;
  }

  var api = {
    lang: override || negotiate(browserLanguages()),
    override: override,
    STRINGS: STRINGS,
    t: t,
    negotiate: negotiate,
    apply: apply,
    setLang: setLang,
    onChange: function (fn) { if (typeof fn === 'function') listeners.push(fn); }
  };
  RDG.i18n = api;

  // the head strings right away (this script is in <head>: no English title flash), the rest once the body is parsed
  apply();
  if (root.document && root.document.readyState === 'loading' && root.document.addEventListener) {
    root.document.addEventListener('DOMContentLoaded', apply);
  }
  // the user changed the browser's language preferences: follow them (unless ?lang= pins one)
  if (root.addEventListener) {
    root.addEventListener('languagechange', function () {
      if (!override) setLang(negotiate(browserLanguages()));
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = RDG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
