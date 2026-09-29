/* GAME OVER share button (DOM overlay on the canvas; markup in index.html, styles in style.css).
 *
 * - Shown by main.js on GAME OVER once the restart delay has passed; hidden during play / idle / pause (and on frozen
 *   test pages unless ?share=1). Placed into renderer.getGameOverLayout().shareSlot (CSS px from the canvas's top-left),
 *   or below the restart icon when the renderer has no layout.
 * - Click on a touch UI with navigator.share (phones / tablets: their share sheet lists the installed SNS apps): the OS
 *   share sheet; the PNG screenshot (renderer.captureShareImage) rides along as a File when navigator.canShare({files})
 *   accepts it. AbortError (the user closed the sheet) is silent; any other error falls back to the menu.
 *   Everywhere else (desktop, where the OS sheet has no X / Bluesky / LINE target): a small menu (role=menu): X,
 *   Bluesky, Facebook (public URL only), LINE, copy text, save image (only when the canvas can be read: never on
 *   file://), and "More…" (the OS share sheet, when navigator.share exists).
 * - Every element carries [data-ui] inside #share-ui: input.js ignores presses on it, so it never restarts the game.
 *   A pointer press outside the open menu only closes the menu (consumes(e) tells input.js to ignore that press).
 *
 * Pure helpers (publicUrl, isPrivateHost, links, shareText, nativeFirst) are exported for tools/sim_test.js. */
(function (root) {
  'use strict';
  var RDG = (root.RDG = root.RDG || {});

  var FILE_NAME = 'real-dinosaur-game-score.png';
  var IMAGE_MAX_W = 1200; // share image width cap (CSS-independent device px)
  var TOAST_MS = 1800;

  // -----------------------------------------------------------------------------------------------------------------
  // Pure helpers

  function ipv4(host) {
    var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return null;
    var a = [+m[1], +m[2], +m[3], +m[4]];
    for (var i = 0; i < 4; i++) if (a[i] > 255) return null;
    return a;
  }

  /** True for hosts a friend could not open: localhost, *.localhost / *.local / *.test / *.internal / *.lan /
   * *.home.arpa, single-label names, IPv4 loopback / private / link-local / CGNAT / 0.0.0.0, IPv6 ::1 / :: / unique-local
   * (fc00::/7) / link-local (fe80::/10) and IPv4-mapped private addresses. */
  function isPrivateHost(host) {
    host = String(host == null ? '' : host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!host) return true;
    if (host.indexOf(':') !== -1) { // IPv6 literal
      if (host === '::1' || host === '::') return true;
      if (/^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host)) return true;
      var mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(host);
      if (mapped) {
        if (mapped[1]) return isPrivateHost(mapped[1]);
        var hi = parseInt(mapped[2], 16), lo = parseInt(mapped[3], 16);
        return isPrivateHost([hi >> 8, hi & 255, lo >> 8, lo & 255].join('.'));
      }
      return false;
    }
    var v4 = ipv4(host);
    if (v4) {
      var a = v4[0], b = v4[1];
      return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
    }
    if (host === 'localhost' || /\.(localhost|local|test|internal|lan|home\.arpa)$/.test(host)) return true;
    return host.indexOf('.') === -1; // an intranet name
  }

  /** The URL to share: `configured` (config SHARE_URL) when set; else this page's origin + path (never its query / hash:
   * those are test hooks) when it is public http(s); else '' (file:, localhost, LAN addresses). */
  function publicUrl(loc, configured) {
    if (configured) return String(configured);
    if (!loc || !/^https?:$/.test(loc.protocol || '') || isPrivateHost(loc.hostname)) return '';
    return loc.protocol + '//' + loc.host + (loc.pathname || '/');
  }

  /** Localized share text for `score` (a plain integer); `best` adds the new-personal-best line. */
  function shareText(t, score, best) {
    return t('share.text', { score: String(Math.max(0, Math.floor(score) || 0)), best: best ? t('share.best') : '' });
  }

  /** Share-intent URLs (every value URI-encoded). Facebook only shares a URL, so it is present only with one. */
  function links(text, url) {
    var e = encodeURIComponent, full = url ? text + ' ' + url : text, out = {};
    out.x = 'https://x.com/intent/post?text=' + e(text) + (url ? '&url=' + e(url) : '');
    out.bluesky = 'https://bsky.app/intent/compose?text=' + e(full);
    if (url) out.facebook = 'https://www.facebook.com/sharer/sharer.php?u=' + e(url);
    out.line = 'https://line.me/R/share?text=' + e(full);
    return out;
  }

  /** The button opens the OS share sheet directly (else the menu): only on a touch UI with navigator.share. Desktop
   * Chrome / Edge / Safari have navigator.share too, but their sheet (Mail, Messages, AirDrop...) has no SNS targets:
   * there the menu comes first and offers the sheet as its "More…" item. */
  function nativeFirst(nav, touch) { return !!touch && !!nav && typeof nav.share === 'function'; }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  // -----------------------------------------------------------------------------------------------------------------
  /**
   * opts: { i18n, renderer, canvas, config, isTouch(), getResult() -> {score, best} }.
   * Returns null when the markup is missing. API: update({visible, night}) (after every rendered frame; cheap when
   * nothing changed), relayout() (after a resize), relabel() (after a language change: the prepared image and the open
   * menu's texts are rebuilt on the next update(), i.e. once the canvas shows the new language), consumes(e), isOpen(),
   * close().
   */
  function create(opts) {
    var doc = root.document;
    if (!doc || !opts) return null;
    var box = doc.getElementById('share-ui'), btn = doc.getElementById('share-btn'), menu = doc.getElementById('share-menu');
    var toastEl = doc.getElementById('share-toast');
    if (!box || !btn || !menu) return null;
    var nav = root.navigator || {}, i18n = opts.i18n, cfg = opts.config || {};
    function t(k, v) { return i18n && i18n.t ? i18n.t(k, v) : k; }

    var st = {
      shown: false, night: null, dirty: true, stale: false, open: false, byPointer: false, swallow: null,
      links: null, copyText: '', capture: null, file: undefined, pending: null, gen: 0, toastTimer: 0
    };

    // ---- data -------------------------------------------------------------------------------------------------------
    function data() {
      var r = (opts.getResult && opts.getResult()) || { score: 0, best: false };
      return { title: t('share.title'), text: shareText(t, r.score, r.best), url: publicUrl(root.location, cfg.SHARE_URL) };
    }
    function isTouch() { return !!(opts.isTouch && opts.isTouch()); }
    function hasShare() { return typeof nav.share === 'function'; }
    /** The button opens the OS share sheet (touch UI); else it opens the menu (see nativeFirst). */
    function useNative() { return nativeFirst(nav, isTouch()); }

    /** The game-over screenshot as a canvas, or null when unavailable (a tainted canvas on file://). */
    function capture() {
      var R = opts.renderer;
      if (R && typeof R.captureShareImage === 'function') {
        try { return R.captureShareImage(IMAGE_MAX_W) || null; } catch (e) { return null; }
      }
      // (a renderer without captureShareImage) a scaled copy of the canvas; reading a pixel throws when tainted
      try {
        var src = opts.canvas, k = Math.min(1, IMAGE_MAX_W / Math.max(1, src.width));
        var c = doc.createElement('canvas');
        c.width = Math.max(1, Math.round(src.width * k)); c.height = Math.max(1, Math.round(src.height * k));
        var x = c.getContext('2d');
        x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
        x.drawImage(src, 0, 0, c.width, c.height);
        x.getImageData(0, 0, 1, 1);
        return c;
      } catch (e) { return null; }
    }

    /** Native share only: the PNG File, prepared ahead (when the button shows on a touch UI, when the menu with its
     * "More…" item opens elsewhere) so the click can call navigator.share synchronously, inside its user activation.
     * src: an image captured already (optional). Resolves to null when files cannot be shared. */
    function prepareFile(src) {
      if (st.pending) return st.pending;
      var gen = st.gen;
      if (!hasShare() || typeof nav.canShare !== 'function' || typeof root.File !== 'function') {
        st.file = null;
        return (st.pending = Promise.resolve(null));
      }
      var cv = src !== undefined ? src : capture();
      if (!cv || typeof cv.toBlob !== 'function') { st.file = null; return (st.pending = Promise.resolve(null)); }
      st.pending = new Promise(function (resolve) {
        function done(f) { if (gen === st.gen) st.file = f; resolve(f); }
        try {
          cv.toBlob(function (blob) {
            var f = null;
            if (blob) {
              try {
                f = new root.File([blob], FILE_NAME, { type: 'image/png' });
                if (!nav.canShare({ files: [f] })) f = null;
              } catch (e) { f = null; }
            }
            done(f);
          }, 'image/png');
        } catch (e) { done(null); }
      });
      return st.pending;
    }

    // ---- placement --------------------------------------------------------------------------------------------------
    function validRect(s) { return s && isFinite(s.x) && isFinite(s.y) && s.w > 0 && s.h > 0; }
    /** Share slot in viewport px. Fallback: centred below the restart icon (render's layout: 46u icon at 0.43 H). */
    function slot() {
      var r = opts.canvas.getBoundingClientRect(), R = opts.renderer || {}, L = null, s = null;
      try { L = typeof R.getGameOverLayout === 'function' ? R.getGameOverLayout() : null; } catch (e) { L = null; }
      if (L && validRect(L.shareSlot)) s = L.shareSlot;
      else {
        var H = cfg.H || 540, css = R.cssScale > 0 ? R.cssScale : r.height / H;
        var size = 46 * css, top = ((R.T || 0) + 0.43 * H + 46 + 16) * css;
        if (!(top > r.height * 0.5) || top + size > r.height) top = r.height * 0.5 + size;
        var w = Math.max(2.7 * size, 120);
        s = { x: r.width / 2 - w / 2, y: top, w: w, h: size };
      }
      return { x: r.left + s.x, y: r.top + s.y, w: s.w, h: s.h };
    }
    function place() {
      st.dirty = false;
      var s = slot(), h = Math.max(44, Math.round(s.h));
      var bs = btn.style;
      bs.left = Math.round(s.x + s.w / 2) + 'px';
      bs.top = Math.round(s.y + s.h / 2) + 'px';
      bs.height = h + 'px';
      bs.minWidth = Math.max(44, Math.round(s.w)) + 'px';
      bs.fontSize = clamp(Math.round(h * 0.37), 15, 28) + 'px'; // (70 px on big screens: 26 px, the same proportion)
      bs.borderRadius = Math.round(h * 0.2) + 'px'; // the restart icon's corner radius (0.2 of its side)
      if (st.open) placeMenu();
      if (st.toastTimer) placeToast();
    }

    var insetProbe = null;
    function insets() {
      try {
        if (!insetProbe) {
          insetProbe = doc.createElement('div');
          insetProbe.setAttribute('aria-hidden', 'true');
          insetProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
            'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
          doc.body.appendChild(insetProbe);
        }
        var cs = root.getComputedStyle(insetProbe);
        return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
      } catch (e) { return { t: 0, r: 0, b: 0, l: 0 }; }
    }

    /** Menu next to the button: below, right, above or left (keeps GAME OVER readable when there is room beside the
     * button), whichever fits first inside the safe viewport; if none does, on the roomier vertical side, scrolling. */
    function placeMenu() {
      var ms = menu.style, ins = insets(), m = 8, gap = 8;
      ms.maxHeight = ''; ms.left = '0px'; ms.top = '0px';
      var vw = root.innerWidth || doc.documentElement.clientWidth, vh = root.innerHeight || doc.documentElement.clientHeight;
      var x0 = ins.l + m, x1 = vw - ins.r - m, y0 = ins.t + m, y1 = vh - ins.b - m;
      var b = btn.getBoundingClientRect(), mr = menu.getBoundingClientRect(), w = mr.width, h = mr.height;
      var cx = b.left + b.width / 2, cy = b.top + b.height / 2;
      var hx = clamp(cx - w / 2, x0, Math.max(x0, x1 - w)), vy = clamp(cy - h / 2, y0, Math.max(y0, y1 - h));
      var cands = [
        ['below', hx, b.bottom + gap], ['right', b.right + gap, vy],
        ['above', hx, b.top - gap - h], ['left', b.left - gap - w, vy]
      ];
      var pick = null;
      for (var i = 0; i < cands.length && !pick; i++) {
        var c = cands[i];
        if (c[1] >= x0 - 0.5 && c[1] + w <= x1 + 0.5 && c[2] >= y0 - 0.5 && c[2] + h <= y1 + 0.5) pick = c;
      }
      if (!pick) {
        var below = y1 - (b.bottom + gap), above = b.top - gap - y0, room = Math.max(88, Math.max(below, above));
        ms.maxHeight = Math.floor(room) + 'px';
        pick = below >= above ? ['below', hx, b.bottom + gap] : ['above', hx, b.top - gap - Math.min(h, room)];
      }
      ms.left = Math.round(pick[1]) + 'px';
      ms.top = Math.round(pick[2]) + 'px';
      menu.setAttribute('data-side', pick[0]);
    }

    /** Toast under the button (clear of the GAME OVER title and restart icon above it); above when there is no room. */
    function placeToast() {
      if (!toastEl) return;
      var b = btn.getBoundingClientRect(), ins = insets(), vh = root.innerHeight || doc.documentElement.clientHeight;
      var below = b.bottom + 10 + 40 < vh - ins.b;
      toastEl.style.left = Math.round(b.left + b.width / 2) + 'px';
      toastEl.style.top = Math.round(below ? b.bottom + 10 : b.top - 10) + 'px';
      toastEl.setAttribute('data-side', below ? 'below' : 'above');
    }
    function toast(msg) {
      if (!toastEl) return;
      if (st.toastTimer) clearTimeout(st.toastTimer);
      toastEl.textContent = msg; // role=status: announced politely
      placeToast();
      toastEl.classList.add('is-shown');
      st.toastTimer = setTimeout(hideToast, TOAST_MS);
    }
    function hideToast() {
      if (!toastEl) return;
      if (st.toastTimer) clearTimeout(st.toastTimer);
      st.toastTimer = 0;
      toastEl.classList.remove('is-shown');
      toastEl.textContent = '';
    }

    // ---- show / hide ------------------------------------------------------------------------------------------------
    /** Button semantics: a menu button when the click opens the menu, a plain button when it opens the OS share sheet. */
    function configureButton() {
      if (useNative()) {
        btn.removeAttribute('aria-haspopup'); btn.removeAttribute('aria-expanded'); btn.removeAttribute('aria-controls');
      } else {
        btn.setAttribute('aria-haspopup', 'menu'); btn.setAttribute('aria-expanded', 'false'); btn.setAttribute('aria-controls', 'share-menu');
      }
    }
    function releaseFocus() {
      var ae = doc.activeElement;
      if (ae && ae !== doc.body && box.contains(ae) && ae.blur) ae.blur();
    }
    function show() {
      st.shown = true; st.stale = false;
      st.gen++; st.file = undefined; st.pending = null;
      configureButton();
      btn.hidden = false;
      place();
      if (useNative()) prepareFile(); // (desktop: when the menu opens)
    }
    function hide() {
      st.shown = false; st.stale = false;
      st.gen++; st.file = undefined; st.pending = null;
      closeMenu(false);
      releaseFocus(); // a focused, now hidden button must not keep the keyboard from the game
      btn.hidden = true;
      hideToast();
    }
    function update(s) {
      var vis = !!(s && s.visible), night = !!(s && s.night);
      if (vis !== st.shown) { if (vis) show(); else hide(); }
      if (night !== st.night) { st.night = night; box.setAttribute('data-theme', night ? 'night' : 'day'); }
      if (vis && st.dirty) place();
      if (vis && st.stale) refresh();
    }
    /** After a language change (relabel), once a frame in the new language is on the canvas: a new share image, and
     * the open menu's texts / links / image, so nothing shared mixes the old language with the new one. */
    function refresh() {
      st.stale = false;
      st.gen++; st.file = undefined; st.pending = null;
      if (st.open) fillMenu();
      if (useNative() || (st.open && hasShare())) prepareFile(st.open ? st.capture : undefined);
    }

    // ---- menu -------------------------------------------------------------------------------------------------------
    function items() {
      var all = menu.querySelectorAll('[data-share]'), out = [];
      for (var i = 0; i < all.length; i++) if (!all[i].hidden) out.push(all[i]);
      return out;
    }
    function focusItem(i) {
      var list = items();
      if (!list.length) return;
      i = (i + list.length) % list.length;
      for (var k = 0; k < list.length; k++) list[k].tabIndex = k === i ? 0 : -1;
      list[i].focus();
    }
    /** The menu's data (text, links, image) in the current language, and which items it shows: Save only with an image,
     * Facebook only with a URL, "More…" (the OS share sheet) only where the button does not open that sheet itself. */
    function fillMenu() {
      var d = data();
      st.links = links(d.text, d.url);
      st.copyText = d.url ? d.text + ' ' + d.url : d.text;
      st.capture = capture();
      var all = menu.querySelectorAll('[data-share]'), more = hasShare() && !useNative();
      for (var i = 0; i < all.length; i++) {
        var k = all[i].getAttribute('data-share');
        all[i].hidden = k === 'save' ? !st.capture : k === 'copy' ? false : k === 'more' ? !more : !st.links[k];
      }
      return more;
    }
    function openMenu(last) {
      if (!st.shown) return;
      var more = fillMenu(), all = menu.querySelectorAll('[data-share]');
      for (var i = 0; i < all.length; i++) all[i].tabIndex = -1;
      if (more) prepareFile(st.capture); // ("More…": the PNG is ready by the time it is chosen)
      hideToast();
      menu.hidden = false;
      st.open = true;
      btn.setAttribute('aria-haspopup', 'menu'); // (also after a failed native share: the button now drives the menu)
      btn.setAttribute('aria-controls', 'share-menu');
      btn.setAttribute('aria-expanded', 'true');
      placeMenu();
      focusItem(last ? -1 : 0);
    }
    /** focus: 'button' (keyboard users get focus back on the button; after a pointer activation the keyboard goes back
     * to the game instead), or false (leave focus alone; a hidden element's focus is released). */
    function closeMenu(focus) {
      if (!st.open) return;
      st.open = false;
      menu.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
      st.capture = null;
      if (focus === 'button' && st.shown) { if (st.byPointer) releaseFocus(); else btn.focus(); }
      else releaseFocus();
    }

    function openUrl(url) {
      try { root.open(url, '_blank', 'noopener,noreferrer'); } catch (e) { /* popup blocked */ }
    }
    function legacyCopy(text) {
      var ta = doc.createElement('textarea'), ok = false, prev = doc.activeElement;
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.setAttribute('data-ui', '');
      ta.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none;-webkit-user-select:text;user-select:text';
      box.appendChild(ta);
      try { ta.select(); ta.setSelectionRange(0, text.length); ok = doc.execCommand('copy'); } catch (e) { ok = false; }
      box.removeChild(ta);
      if (prev && prev.focus && prev !== doc.body) { try { prev.focus(); } catch (e) { /* ignore */ } }
      return ok;
    }
    function copy(text) {
      var cb = nav.clipboard;
      if (cb && typeof cb.writeText === 'function') {
        return cb.writeText(text).then(null, function () {
          if (!legacyCopy(text)) throw new Error('copy failed');
        });
      }
      return legacyCopy(text) ? Promise.resolve() : Promise.reject(new Error('copy failed'));
    }
    function save(cv) {
      function fail() { toast(t('share.saveFailed')); }
      if (!cv || typeof cv.toBlob !== 'function') { fail(); return; }
      try {
        cv.toBlob(function (blob) {
          if (!blob) { fail(); return; }
          var url = root.URL.createObjectURL(blob), a = doc.createElement('a');
          a.href = url; a.download = FILE_NAME; a.rel = 'noopener'; a.style.display = 'none';
          box.appendChild(a);
          a.click();
          box.removeChild(a);
          setTimeout(function () { root.URL.revokeObjectURL(url); }, 30000);
        }, 'image/png');
      } catch (e) { fail(); }
    }

    function choose(item) {
      var k = item.getAttribute('data-share'), cv = st.capture, text = st.copyText, url = st.links && st.links[k];
      closeMenu('button');
      if (k === 'copy') {
        copy(text).then(function () { toast(t('share.copied')); }, function () { toast(t('share.copyFailed')); });
      } else if (k === 'save') save(cv);
      else if (k === 'more') { if (hasShare()) nativeShare(); }
      else if (url) openUrl(url);
    }

    // ---- native share -----------------------------------------------------------------------------------------------
    function nativeShare() {
      var d = data(), payload = { title: d.title, text: d.text };
      if (d.url) payload.url = d.url;
      function finish() { if (st.byPointer) releaseFocus(); }
      function go(file) {
        if (file) payload.files = [file];
        var p;
        try { p = nav.share(payload); } catch (err) { p = Promise.reject(err); }
        return Promise.resolve(p).then(finish, function (err) {
          if (err && err.name === 'AbortError') { finish(); return; } // the user closed the share sheet
          if (st.shown) openMenu();
        });
      }
      // prepared already: call share() synchronously, inside this click's user activation
      if (st.file !== undefined) return go(st.file);
      return prepareFile().then(go);
    }

    // ---- events -----------------------------------------------------------------------------------------------------
    btn.addEventListener('click', function (e) {
      st.byPointer = e.detail > 0; // Space / Enter activations have detail 0
      if (st.open) { closeMenu('button'); return; }
      if (useNative()) nativeShare();
      else openMenu();
    });
    btn.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !st.open) { e.preventDefault(); releaseFocus(); } // hand the keyboard back to the game
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !st.open && !useNative()) {
        e.preventDefault(); st.byPointer = false; openMenu(e.key === 'ArrowUp');
      }
    });
    menu.addEventListener('click', function (e) {
      var it = e.target && e.target.closest ? e.target.closest('[data-share]') : null;
      if (it && !it.hidden) { st.byPointer = e.detail > 0; choose(it); }
    });
    menu.addEventListener('keydown', function (e) {
      var list = items(), i = list.indexOf(doc.activeElement);
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); focusItem(i + 1); break;
        case 'ArrowUp': e.preventDefault(); focusItem(i < 0 ? -1 : i - 1); break;
        case 'Home': case 'PageUp': e.preventDefault(); focusItem(0); break;
        case 'End': case 'PageDown': e.preventDefault(); focusItem(-1); break;
        case 'Escape': e.preventDefault(); st.byPointer = false; closeMenu('button'); break;
        case 'Tab': e.preventDefault(); st.byPointer = false; closeMenu('button'); break;
        default: break;
      }
    });
    // a press outside the open menu closes it, and is not a game press (input.js asks consumes(e))
    doc.addEventListener('pointerdown', function (e) {
      if (!st.open || box.contains(e.target)) return;
      st.swallow = e;
      closeMenu(false);
    }, true);
    // (resizes: main.js calls relayout() once the canvas has its new size)

    return {
      update: update,
      relayout: function () { st.dirty = true; if (st.shown) place(); },
      relabel: function () {
        st.dirty = true;
        if (!st.shown) return;
        if (!st.open) configureButton();
        place();
        st.stale = true; // (the image / menu data: on the next update, after the canvas has redrawn in the new language)
      },
      consumes: function (e) { return !!e && e === st.swallow; },
      isShown: function () { return st.shown; },
      isOpen: function () { return st.open; },
      close: function () { closeMenu(false); },
      data: data,
      capture: capture,
      button: btn,
      menu: menu
    };
  }

  RDG.Share = {
    create: create, publicUrl: publicUrl, isPrivateHost: isPrivateHost, links: links, shareText: shareText,
    nativeFirst: nativeFirst, FILE_NAME: FILE_NAME
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = RDG;
})(typeof globalThis !== 'undefined' ? globalThis : this);
