/* Boot, fixed-step loop, game state machine, resize, URL params and test hooks (window.__rdg).
 * URL params: seed=N bot=1 sim=MS freeze=1 state=idle|gameover night=1 dusk=1 debug=1 lang=ja|en hi=N touch=1 share=1
 * (lang is read by src/i18n.js; share=1 shows the GAME OVER share button on frozen / bot pages too) */
(function (root) {
  'use strict';
  var RDG = root.RDG, cfg = RDG.config, Sim = RDG.Sim, STATUS = Sim.STATUS, EV = Sim.EV;

  // ---------------------------------------------------------------------------------------------------------------
  // Params
  var qs;
  try { qs = new URLSearchParams(root.location.search); } catch (e) { qs = { get: function () { return null; }, has: function () { return false; } }; }
  function num(name, def) {
    var v = qs.get(name);
    if (v === null || v === '') return def;
    var n = Number(v);
    return isFinite(n) ? n : def;
  }
  function flag(name) { var v = qs.get(name); return v === '1' || v === 'true' || v === ''; }
  var params = {
    seed: qs.has('seed') ? num('seed', 1) >>> 0 : RDG.rng.randomSeed(),
    bot: qs.has('bot') && flag('bot'),
    sim: Math.max(0, num('sim', 0)),
    freeze: qs.has('freeze') && flag('freeze'),
    state: qs.get('state') || '',
    night: qs.has('night') && flag('night'),
    dusk: qs.has('dusk') && flag('dusk'),
    debug: qs.has('debug') && flag('debug'),
    lang: '', // (set below from RDG.i18n: ?lang=ja|en, else the browser's languages)
    hi: Math.max(0, Math.min(99999, Math.floor(num('hi', 0)))), // demo / screenshots: show this hi-score (never saved)
    touch: qs.has('touch') && flag('touch'), // screenshots: the touch UI (hints, duck-zone marker, speaker button)
    share: qs.has('share') && flag('share') // screenshots / tests: the share button also on frozen and bot pages
  };
  // any test / demo hook (hi, state, sim, bot, freeze) shows a hi-score but never saves one
  var persistHi = !(params.hi > 0) && !qs.has('state') && !(params.sim > 0) && !params.bot && !params.freeze;
  params.persistHi = persistHi;

  function readStore(k) { try { return root.localStorage.getItem(k); } catch (e) { return null; } }
  function writeStore(k, v) { try { root.localStorage.setItem(k, v); } catch (e) { /* ignore */ } }

  // ---------------------------------------------------------------------------------------------------------------
  // Game objects
  var manifest = root.ASSET_MANIFEST || {};
  var metrics = Sim.buildMetrics(manifest, cfg);
  if (metrics.source.dino !== 'manifest' || metrics.source.cactus !== 'manifest' || metrics.source.ptero !== 'manifest') {
    console.warn('[RDG] sprite metrics: ' + JSON.stringify(metrics.source) + ' (built-in defaults used where the manifest has no data)');
  }
  var storedHi = parseInt(readStore(cfg.STORAGE_HI) || '0', 10) || 0;
  var sim = Sim.create({ seed: params.seed, metrics: metrics, cfg: cfg, hiScore: Math.max(storedHi, params.hi) });
  var bot = params.bot ? RDG.Bot.create({}) : null;
  var canvas = document.getElementById('game');
  var renderer = new RDG.Renderer(canvas, cfg, metrics);
  var fx = renderer.fx;
  fx.reset(params.seed);
  var audio = RDG.Audio.create(cfg);
  // UI language (src/i18n.js: ?lang=ja|en, else the first ja / en entry of navigator.languages, followed live on
  // 'languagechange'); it owns the DOM strings: title, meta description, the canvas label, announcements, share UI
  var i18n = RDG.i18n || { lang: 'en', override: '', t: function (k) { return k; }, apply: function () {}, onChange: function () {} };
  var lang = i18n.lang;
  params.lang = i18n.override;
  i18n.apply();
  var statusEl = document.getElementById('a11y-status');
  var themeMeta = document.querySelector('meta[name="theme-color"]');
  var stageEl = document.getElementById('stage');

  var ui = {
    phase: params.night ? 1 : params.dusk ? 0.5 : -1,
    hint: true, paused: false, debug: params.debug, fps: 60, toastAlpha: 0, muted: audio.isMuted(),
    touch: false, lang: lang, botInfo: '', duckGuide: 0, muteBtn: false, shareBtn: false
  };
  // the finished run, for the share text: final score (plain integer) and whether it beat the best held at its start
  var runStartHi = sim.hiScore;
  var lastResult = { score: 0, best: false };
  var toastUntil = 0;
  var fastForward = false;
  var announceTimer = 0;

  /** Polite live-region announcement (start / pause / game over only; never per frame). Cleared first when the
   * text repeats so screen readers announce it again. Silent for the bot, fast-forward and frozen test pages. */
  function announce(msg) {
    if (bot || fastForward || params.freeze || !statusEl) return;
    if (announceTimer) clearTimeout(announceTimer);
    if (statusEl.textContent === msg) statusEl.textContent = '';
    announceTimer = setTimeout(function () { announceTimer = 0; statusEl.textContent = msg; }, 30);
  }

  // GAME OVER share button (src/share.js; DOM overlay in index.html). Its presses are never game presses.
  var share = RDG.Share && RDG.Share.create ? RDG.Share.create({
    i18n: i18n, renderer: renderer, canvas: canvas, config: cfg,
    isTouch: function () { return isTouchUi(); },
    getResult: function () { return lastResult; }
  }) : null;
  /** Overlay UI ([data-ui]: the share button and its menu), or a press that only closed the share menu. */
  function isUiTarget(el, e) {
    if (share && e && share.consumes(e)) return true;
    return !!(el && el.closest && el.closest('[data-ui]'));
  }

  var input = RDG.Input.create({
    onGesture: function () { audio.unlock(); },
    onMute: function () { ui.muted = audio.toggleMute(); toastUntil = now() + 1400; requestRender(); },
    onDebug: function () { ui.debug = !ui.debug; requestRender(); },
    // P / Esc toggle. pause() clears the input first, so this press can never unpause on the next frame.
    onPause: function () { if (ui.paused) { resume(); needsRender = true; } else if (sim.status === STATUS.RUNNING) pause(); },
    // the touch duck zone (bottom-left) ducks only during a run; otherwise a tap there starts / restarts like any tap
    canDuck: function () { return sim.status === STATUS.RUNNING && !ui.paused; },
    surface: canvas,
    duckZone: cfg.TOUCH_DUCK_ZONE,
    isUiTarget: isUiTarget,
    // the touch speaker button (top left; start, pause and GAME OVER screens): toggles mute, never jumps / restarts
    hitUi: function (x, y) {
      if (!muteButtonShown()) return false;
      var r = canvas.getBoundingClientRect(), b = renderer.muteButtonRect();
      if (!r.width || !b) return false;
      var k = renderer.cw / r.width, px = (x - r.left) * k, py = (y - r.top) * k;
      if (px < b.x || px > b.x + b.s || py < b.y || py > b.y + b.s) return false;
      ui.muted = audio.toggleMute(); toastUntil = now() + 1400; requestRender();
      return true;
    }
  });
  function isTouchUi() { return params.touch || !!(input && input.isTouch()); }
  ui.touch = isTouchUi();

  // a live language change (browser settings): canvas text follows ui.lang; i18n.js already relabelled the DOM
  i18n.onChange(function (l) {
    lang = ui.lang = l;
    if (share) share.relabel();
    requestRender();
  });

  function now() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }

  /** Share button: GAME OVER once the restart delay has passed (never during play / idle / pause). Frozen screenshot
   * pages and the bot demo leave it out unless ?share=1. */
  function shareButtonShown() {
    if (!share || !ready || ui.paused || sim.status !== STATUS.CRASHED || sim.gameOverTime < cfg.GAMEOVER_CLEAR_TIME) return false;
    return params.share || (!params.freeze && !bot);
  }

  /** Touch speaker button: shown on the start, pause and GAME OVER screens (never during a run, where a tap in that
   * corner must stay a jump). */
  function muteButtonShown() {
    return ready && ui.touch && (ui.paused || sim.status !== STATUS.RUNNING);
  }
  /** Opacity of the touch duck-zone marker: the start screen (with its hint), pause, the first seconds of the
   * session's first run (fading out over TOUCH_GUIDE_FADE_MS), and GAME OVER until the player has ducked by touch. */
  function duckGuideAlpha() {
    if (!ui.touch || bot || !cfg.TOUCH_DUCK_ZONE) return 0;
    if (ui.paused) return 1;
    if (sim.status === STATUS.IDLE) return ui.hint ? 1 : 0;
    if (sim.status === STATUS.CRASHED) return input.touchDucks > 0 ? 0 : Math.min(1, sim.gameOverTime / 250);
    if (sim.runs > 1) return 0;
    var f = cfg.TOUCH_GUIDE_FADE_MS || [5000, 7000];
    return Math.max(0, Math.min(1, (f[1] - sim.runningTime) / Math.max(1, f[1] - f[0])));
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Simulation tick
  var tickInput = { jumpPressed: false, jumpHeld: false, duckPressed: false, duckHeld: false };

  function restartGame() {
    Sim.start(sim); // resets the run (hi-score kept), status -> RUNNING
    input.clear();
    audio.button();
  }

  function saveHi() {
    if (!persistHi) return; // test / demo hooks: display only
    // another tab may have saved a better score meanwhile: never lower the stored best
    var cur = parseInt(readStore(cfg.STORAGE_HI) || '0', 10) || 0;
    if (cur > storedHi) storedHi = cur;
    if (cur > sim.hiScore) sim.hiScore = cur;
    if (sim.hiScore > storedHi) { storedHi = sim.hiScore; writeStore(cfg.STORAGE_HI, String(storedHi)); }
  }
  // a better score saved by another tab raises this one's HI (values only ever go up)
  root.addEventListener('storage', function (e) {
    if (!persistHi || e.key !== cfg.STORAGE_HI) return; // key null = storage cleared
    var v = parseInt(e.newValue || '0', 10) || 0;
    if (v > storedHi) storedHi = v;
    if (v > sim.hiScore) { sim.hiScore = v; requestRender(); }
  });

  function handleEvents() {
    for (var i = 0; i < sim.nEv; i++) {
      var e = sim.ev[i];
      fx.onEvent(e, sim);
      if (e === EV.START) runStartHi = sim.hiScore;
      else if (e === EV.CRASH) {
        var fin = Math.min(cfg.MAX_SCORE, Math.floor(sim.score));
        lastResult = { score: fin, best: runStartHi > 0 && fin > runStartHi }; // a first-ever score is not "beaten"
      }
      if (fastForward) continue;
      if (e === EV.JUMP) audio.jump();
      else if (e === EV.MILESTONE) audio.milestone();
      else if (e === EV.CRASH) {
        audio.crash(); saveHi();
        announce(i18n.t('a11y.over', { score: Math.floor(sim.score), hi: Math.floor(sim.hiScore) }));
      }
      else if (e === EV.LAND) audio.land();
      else if (e === EV.START) announce(i18n.t('a11y.start'));
    }
    sim.nEv = 0;
  }

  function tick() {
    var inp = tickInput;
    var jp = input.takeJump(), dp = input.takeDuck(), rp = input.takeRestart();
    input.takeAny();
    if (bot) {
      if (sim.status === STATUS.RUNNING) bot.update(sim, inp);
      else { inp.jumpPressed = false; inp.jumpHeld = false; inp.duckPressed = false; inp.duckHeld = false; }
      if (sim.status === STATUS.IDLE && sim.tick > 45) inp.jumpPressed = true; // demo: auto-start
      if (sim.status === STATUS.CRASHED && sim.gameOverTime > 1600 && !params.freeze) restartGame();
    } else {
      inp.jumpPressed = jp || (sim.status === STATUS.IDLE && rp);
      inp.jumpHeld = input.jumpHeld;
      inp.duckPressed = dp;
      inp.duckHeld = input.duckHeld;
      if (sim.status === STATUS.CRASHED) {
        if ((jp || rp) && sim.gameOverTime >= cfg.GAMEOVER_CLEAR_TIME) restartGame();
        inp.jumpPressed = false;
      }
    }
    Sim.step(sim, inp);
    fx.step(sim);
    handleEvents();
  }

  function advance(ms) {
    var n = Math.round(ms / cfg.STEP_MS);
    for (var i = 0; i < n; i++) tick();
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Loop
  var acc = 0, last = -1, rafId = 0, ready = false, frozen = false, needsRender = true, fpsAcc = 0, fpsN = 0;
  var pageSky = '', pageGround = '';
  var assetsTable = null, lateAssets = false;

  function renderNow(alpha) {
    if (!ready) {
      if (renderer.drawLoading) renderer.drawLoading(assetsTable && assetsTable.total ? assetsTable.loaded / assetsTable.total : undefined);
      return;
    }
    var t = now();
    ui.toastAlpha = toastUntil > t ? Math.min(1, (toastUntil - t) / 300) : 0;
    if (!ui.touch && input.touchSeen) ui.touch = true; // the first touch switches the hints to their touch versions
    ui.duckGuide = duckGuideAlpha();
    ui.muteBtn = muteButtonShown();
    ui.shareBtn = shareButtonShown();
    ui.lang = lang;
    if (ui.debug && bot) ui.botInfo = 'bot ' + bot.decisions + '/' + bot.degraded + '/' + bot.fails;
    renderer.render(sim, alpha == null ? 1 : alpha, ui);
    var phase = ui.phase >= 0 ? ui.phase : sim.nightPhase;
    // (after the render: a share image captured now shows this GAME OVER frame). night: the colours the renderer just
    // used for GAME OVER and the restart icon (getGameOverLayout().night: light from dusk on, night phase > ~0.33)
    if (share) {
      var goL = ui.shareBtn && renderer.getGameOverLayout ? renderer.getGameOverLayout() : null;
      share.update({ visible: ui.shareBtn, night: goL ? goL.night : phase > 0.33 });
    }
    var cols = renderer.pageColorsFor(phase);
    if (cols[0] !== pageSky || cols[1] !== pageGround) {
      pageSky = cols[0]; pageGround = cols[1];
      var st = document.documentElement.style;
      st.setProperty('--sky', pageSky);
      st.setProperty('--ground', pageGround);
      if (themeMeta) themeMeta.setAttribute('content', pageSky); // browser chrome follows the sky
    }
    needsRender = false;
  }

  function requestRender() {
    needsRender = true;
    if (frozen && ready) renderNow(1);
  }

  function frame(ts) {
    rafId = 0;
    if (!ready) { checkSize(); renderNow(1); schedule(); return; } // loading screen (no ticks until the assets are in)
    if (lateAssets) { lateAssets = false; renderer.setAssets(assetsTable); needsRender = true; } // slow image arrived
    if (last < 0) last = ts;
    var dt = ts - last;
    last = ts;
    if (dt > cfg.MAX_FRAME_MS) dt = cfg.MAX_FRAME_MS; // clamp (tab switch, breakpoints): nothing teleports
    if (dt < 0) dt = 0;
    checkSize(); // cheap; catches DPR changes that fire no resize event
    if (ui.paused) {
      if (input.takeAny() || input.takeJump() || input.takeDuck() || input.takeRestart()) resume();
    } else {
      acc += dt;
      var n = 0;
      while (acc >= cfg.STEP_MS && n < cfg.MAX_STEPS_PER_FRAME) { tick(); acc -= cfg.STEP_MS; n++; }
      if (n >= cfg.MAX_STEPS_PER_FRAME) acc = 0;
      needsRender = true;
    }
    if (dt > 0) { fpsAcc += dt; fpsN++; if (fpsAcc >= 500) { ui.fps = (fpsN * 1000) / fpsAcc; fpsAcc = 0; fpsN = 0; } }
    if (renderer.needsRedraw) { renderer.needsRedraw = false; needsRender = true; } // e.g. prefers-reduced-motion changed
    // (a toast shown on the last frame gets one more render: a paused screen must not keep its faded ghost)
    if (needsRender || toastUntil > now() || ui.toastAlpha > 0) renderNow(ui.paused ? 1 : acc / cfg.STEP_MS);
    schedule();
  }

  function schedule() {
    if (!rafId && !frozen) rafId = root.requestAnimationFrame(frame);
  }

  function pause() {
    if (ui.paused || sim.status !== STATUS.RUNNING || frozen) return;
    ui.paused = true;
    input.releaseAll();
    input.clear();
    needsRender = true;
    announce(i18n.t('a11y.paused'));
  }
  function resume() {
    ui.paused = false;
    input.clear();
    acc = 0;
    last = -1;
  }

  // back in the foreground (tab switch, bfcache restore): try to resume an audio context the OS suspended /
  // interrupted; this never creates one (that needs a user gesture)
  document.addEventListener('visibilitychange', function () { if (document.hidden) pause(); else { last = -1; audio.unlock(true); } });
  root.addEventListener('pageshow', function () { audio.unlock(true); });
  root.addEventListener('blur', pause);
  root.addEventListener('focus', function () { last = -1; needsRender = true; });

  /** Top safe-area inset in CSS px (a portrait notch / status bar; the HUD pins below it on tall screens), measured
   * on a hidden probe whose height is env(safe-area-inset-top) (works where custom properties keep env() unresolved). */
  var satProbe = null;
  function safeTopCss() {
    try {
      if (!satProbe) {
        satProbe = document.createElement('div');
        satProbe.setAttribute('aria-hidden', 'true');
        satProbe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:env(safe-area-inset-top,0px);visibility:hidden;pointer-events:none';
        document.body.appendChild(satProbe);
      }
      return satProbe.getBoundingClientRect().height || 0;
    } catch (e) { return 0; }
  }

  function layout() {
    var vv = root.visualViewport;
    var w = root.innerWidth || (vv && vv.width) || 800, h = root.innerHeight || (vv && vv.height) || 400;
    // horizontal safe-area insets (a landscape notch) are padding on #stage: the canvas fits inside them
    if (stageEl && root.getComputedStyle) {
      var cs = root.getComputedStyle(stageEl);
      w = Math.max(1, w - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0));
    }
    renderer.resize(w, h, root.devicePixelRatio || 1, safeTopCss());
    // page bands (pillarbox / letterbox) split sky / ground at the canvas horizon
    var r = canvas.getBoundingClientRect();
    var hz = r.top + (renderer.horizonCss != null ? renderer.horizonCss : cfg.HORIZON_Y * renderer.cssScale);
    document.documentElement.style.setProperty('--hz', hz.toFixed(1) + 'px');
    ui.touch = isTouchUi();
    if (share) share.relayout(); // follow the canvas (placed on the next render)
    requestRender();
  }
  var lastVW = 0, lastVH = 0, lastDPR = 0;
  function checkSize() {
    var w = root.innerWidth, h = root.innerHeight, d = root.devicePixelRatio || 1;
    if (w !== lastVW || h !== lastVH || d !== lastDPR) { lastVW = w; lastVH = h; lastDPR = d; layout(); return true; }
    return false;
  }
  root.addEventListener('resize', checkSize);
  if (root.visualViewport) root.visualViewport.addEventListener('resize', checkSize);

  // ---------------------------------------------------------------------------------------------------------------
  // Boot
  checkSize();

  function applyParams() {
    fastForward = true;
    if (params.state === 'gameover') {
      Sim.start(sim);
      for (var i = 0; i < 60 * 90 && sim.status === STATUS.RUNNING; i++) tick(); // run into the first obstacle
      advance(cfg.GAMEOVER_CLEAR_TIME + 50);
    } else if (params.sim > 0) {
      Sim.start(sim);
      advance(params.sim);
    }
    fastForward = false;
    saveHi();
  }

  assetsTable = RDG.Assets.load(manifest, metrics, function (assets) {
    renderer.setAssets(assets);
    ready = true;
    applyParams();
    if (params.freeze) frozen = true;
    if (frozen && rafId) { root.cancelAnimationFrame(rafId); rafId = 0; } // stop the loading loop
    checkSize();
    renderNow(1);
    schedule();
    registerServiceWorker();
  }, function () {
    // an image that missed LOAD_TIMEOUT_MS arrived: swap it in (coalesced to at most once per frame)
    if (frozen) { renderer.setAssets(assetsTable); renderNow(1); }
    else lateAssets = true;
  });
  if (renderer.drawLoading && !ready) schedule(); // animate the loading screen until the assets are in

  // ---------------------------------------------------------------------------------------------------------------
  // Test hooks
  root.__rdg = {
    sim: sim, config: cfg, metrics: metrics, renderer: renderer, bot: bot, params: params, ui: ui, i18n: i18n, share: share,
    get result() { return lastResult; },
    get state() { return sim.status === STATUS.IDLE ? 'idle' : sim.status === STATUS.RUNNING ? 'running' : 'gameover'; },
    step: function (ms) { advance(ms == null ? cfg.STEP_MS : ms); renderNow(1); return sim.tick; },
    render: function () { renderNow(1); },
    freeze: function (on) { frozen = on !== false; if (!frozen) { last = -1; schedule(); } }
  };

  // Offline cache (only meaningful over http/https). Registered once the game is ready: right away when the page has
  // loaded, else on 'load' or after 3 s, whichever comes first (a stalled image must not block offline caching).
  function registerServiceWorker() {
    if (!/^https?:$/.test(root.location.protocol) || !root.navigator || !('serviceWorker' in root.navigator) || params.freeze) return;
    var registered = false;
    function register() {
      if (registered) return;
      registered = true;
      root.navigator.serviceWorker.register('sw.js').catch(function (err) { console.warn('[RDG] service worker not registered', err && err.message); });
    }
    if (document.readyState === 'complete') register();
    else { root.addEventListener('load', register); setTimeout(register, 3000); }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
