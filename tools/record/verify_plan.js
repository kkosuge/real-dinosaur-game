#!/usr/bin/env node
/* Check tools/record/plan.json in real headless Chrome (served over http): the page with
 * ?seed=S&bot=1&sim=mainStartMs&freeze=1&lang=L&hi=N&share=1, stepped with __rdg.step(1000 / 60) one frame at a time
 * (the bot disabled before the step at botOffTick), must reproduce the Node plan tick for tick: the same state hash
 * on every frame (dino, obstacles, score, RNG), the same events and the same crash. Also checks the intro page
 * (idle, auto-start on tick 47) and the playfield width, and saves a few key frames for a visual check.
 *
 *   node tools/record/verify_plan.js [--plan tools/record/plan.json] [--candidate 0] [--shots DIR] [--no-intro]
 *
 * --candidate N verifies plan.candidates[N] instead of the chosen main segment (0 = the chosen one).
 * A day-story plan (candidate.nightDurationMs) is played with the recording-only night length: after the load and the
 * ?sim= fast-forward, before the first step, RDG.config.NIGHT_DURATION = nightDurationMs (lib.Game does the same in
 * Node). The state hash does not cover the night, so the night phase of every frame is compared too, and the GAME
 * OVER must be in daylight (night phase 0, the share UI in its day theme).
 * UI language (plan.lang, plan.ui): on every frame of both pages the renderer's language (__rdg.ui.lang, keyboard
 * hints, not touch) must be plan.lang, the canvas strings it draws (RDG.TEXT[lang]: the start hint, the key line,
 * GAME OVER) must be plan.ui's, the share button must read plan.ui.share whenever it shows, <html lang> must match,
 * and the visible DOM text of the start screen and the last GAME OVER frame must hold no CJK when plan.lang is 'en'. */
'use strict';

var fs = require('fs');
var path = require('path');
var lib = require('./lib');
var cdp = require('./cdp');

function argv(name, def) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  var v = process.argv[i + 1];
  return v == null || v.slice(0, 2) === '--' ? true : v;
}

var SCRATCH = process.env.RDG_VIDEO_WORK || path.join(require('os').tmpdir(), 'rdg-video');
var planFile = argv('plan', path.join(__dirname, 'plan.json'));
var plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
var ci = Number(argv('candidate', 0));
var cand = plan.candidates[ci];
var shotsDir = argv('shots', path.join(SCRATCH, 'verify', 'seed' + cand.seed));
var G = lib.loadGame(), cfg = G.cfg, Sim = G.Sim;

/** The Node expectation: per-frame state hashes and the events of every tick, exactly as the recorder steps. */
function expected(c) {
  var events = [];
  var game = new lib.Game(G, {
    seed: c.seed, simMs: c.mainStartMs, hi: c.hi, nightDurationMs: c.nightDurationMs,
    onEvents: function (sim, evs) { evs.forEach(function (e) { if (e !== Sim.EV.SPAWN) events.push([sim.tick, e, sim.score]); }); }
  });
  if (game.sim.tick !== c.startTick) throw new Error('Node: ?sim=' + c.mainStartMs + ' gives tick ' + game.sim.tick + ', plan says ' + c.startTick);
  events.length = 0; // (the fast-forward's events are not part of the segment)
  var hashes = [Sim.stateHash(game.sim)], np = [game.sim.nightPhase];
  for (var j = 1; j < c.mainFrames; j++) {
    if (game.sim.tick === c.botOffTick) game.botOff();
    game.tick();
    hashes.push(Sim.stateHash(game.sim));
    np.push(game.sim.nightPhase);
  }
  cfg.NIGHT_DURATION = G.defaults.NIGHT_DURATION;
  return { hashes: hashes, np: np, events: events, crashSerial: game.sim.crashSerial, score: game.sim.score, status: game.sim.status, crashTick: crashTickOf(events) };
}
function crashTickOf(events) { for (var i = 0; i < events.length; i++) if (events[i][1] === Sim.EV.CRASH) return events[i][0]; return -1; }

function pageUrl(s, c, main) {
  return s.url('index.html?seed=' + c.seed + '&bot=1' + (main ? '&sim=' + c.mainStartMs : '') + '&freeze=1&lang=' + plan.lang + '&hi=' + c.hi + '&share=1');
}

// in-page helpers: record events as main.js's Sim.step calls happen (the bot's own look-ahead uses sim.js's local
// step, so it is not recorded), hash every frame, and disable the bot before the step at botOffTick; the recording's
// night length (when given) is set here, after the load / fast-forward and before the first step
var INJECT = function (startTick, botOffTick, nightDurationMs, lang) {
  var S = RDG.Sim, orig = S.step;
  var sameCfg = __rdg.sim.cfg === __rdg.config && __rdg.config === RDG.config;
  if (nightDurationMs != null) __rdg.config.NIGHT_DURATION = nightDurationMs;
  window.__rec = {
    ev: [], hashes: [S.stateHash(__rdg.sim)], np: [__rdg.sim.nightPhase], botOff: -1, sameCfg: sameCfg, nightDuration: __rdg.config.NIGHT_DURATION,
    langFrames: 0, langBad: 0, touchFrames: 0, hintFrames: 0, overFrames: 0, shareLabels: {}
  };
  // the UI language of the frame just stepped (the renderer draws RDG.TEXT[ui.lang]; the share button is DOM)
  window.__recUi = function () {
    var ui = __rdg.ui, b = document.getElementById('share-btn');
    __rec.langFrames++;
    if (ui.lang !== lang || document.documentElement.lang !== lang) __rec.langBad++;
    if (ui.touch) __rec.touchFrames++;
    if (__rdg.state === 'idle' && ui.hint) __rec.hintFrames++;
    if (__rdg.state === 'gameover') __rec.overFrames++;
    if (b && !b.hidden) { var l = b.textContent.replace(/\s+/g, ' ').trim(); __rec.shareLabels[l] = (__rec.shareLabels[l] || 0) + 1; }
  };
  __recUi();
  S.step = function (sim, inp) {
    orig(sim, inp);
    for (var i = 0; i < sim.nEv; i++) if (sim.ev[i] !== S.EV.SPAWN) __rec.ev.push([sim.tick, sim.ev[i], sim.score]);
  };
  window.__stepTo = function (frame) {
    while (__rdg.sim.tick < startTick + frame) {
      if (botOffTick >= 0 && __rdg.sim.tick === botOffTick && __rec.botOff < 0) {
        __rec.botOff = __rdg.sim.tick;
        __rdg.bot.update = function (sim, out) { out.jumpPressed = false; out.jumpHeld = false; out.duckPressed = false; out.duckHeld = false; return out; };
      }
      __rdg.step(1000 / 60);
      __rec.hashes.push(S.stateHash(__rdg.sim));
      __rec.np.push(__rdg.sim.nightPhase);
      __recUi();
    }
    return __rdg.sim.tick;
  };
  return true;
};

async function main() {
  var c = cand;
  var exp = expected(c);
  if (exp.crashTick !== c.crashTick || exp.crashSerial !== c.crash.serial) {
    throw new Error('Node re-run disagrees with the plan: crash tick ' + exp.crashTick + ' serial ' + exp.crashSerial);
  }
  fs.mkdirSync(shotsDir, { recursive: true });
  var keys = [];
  function key(name, frame) { if (frame >= 0 && frame < c.mainFrames) keys.push({ name: name, frame: frame }); }
  var n0 = c.startTick;
  if (c.dayJump && (!c.dayPtero || c.dayJump.serial !== c.dayPtero.serial)) key('day-jump', Math.round(c.dayJump.at * 60) - 4);
  if (c.dayPtero) key('day-ptero', Math.round(c.dayPtero.at * 60) - 12);
  key('dusk', Math.round(c.milestone700At * 60) + 80);
  if (c.nightPtero) key('night-ptero', Math.round(c.nightPtero.at * 60) - 12);
  if (c.nightOffAt != null) key('dawn', Math.round(c.nightOffAt * 60) + 78);
  if (c.dayAgainPtero) key('day-again-ptero', Math.round(c.dayAgainPtero.at * 60) - 12);
  key('crash', c.crashTick - n0 + 2);
  if (c.shareFrame != null) key('share', c.shareFrame + 20);
  key('gameover-end', c.mainFrames - 1);
  keys.sort(function (a, b) { return a.frame - b.frame; });

  var result = await cdp.withSession({ width: plan.viewport.width, height: plan.viewport.height, workDir: SCRATCH }, async function (s) {
    var out = { intro: null };
    // ---- intro page: idle, then the bot's auto-start ----
    if (!argv('no-intro', false)) {
      await s.goto(pageUrl(s, c, false), 'window.__rdg && __rdg.renderer && __rdg.renderer.A && document.readyState === "complete"');
      await s.eval('(' + INJECT.toString() + ')(0, -1, null, ' + JSON.stringify(plan.lang) + ')');
      var st0 = await s.eval('({ state: __rdg.state, tick: __rdg.sim.tick, hint: __rdg.ui.hint, lang: __rdg.ui.lang })');
      await s.eval('__stepTo(20)');
      await s.screenshot(path.join(shotsDir, 'intro-idle.png'));
      var ui0 = await s.eval('(' + PAGE_UI.toString() + ')()');
      await s.eval('__stepTo(' + (plan.intro.frames - 1) + ')');
      await s.screenshot(path.join(shotsDir, 'intro-end.png'));
      var iev = await s.eval('__rec.ev');
      var iui = await s.eval('({ langFrames: __rec.langFrames, langBad: __rec.langBad, touchFrames: __rec.touchFrames, hintFrames: __rec.hintFrames })');
      out.intro = { start: st0, events: iev.slice(0, 6), startTick: (iev.filter(function (e) { return e[1] === 1; })[0] || [])[0], ui: ui0, uiFrames: iui };
    }
    // ---- main segment ----
    await s.goto(pageUrl(s, c, true), 'window.__rdg && __rdg.sim.tick === ' + n0 + ' && document.readyState === "complete"');
    out.view = await s.eval('({ W: __rdg.renderer.W, inner: [innerWidth, innerHeight], dpr: devicePixelRatio, tick: __rdg.sim.tick, status: __rdg.state, frozen: __rdg.params.freeze, share: __rdg.params.share, lang: __rdg.ui.lang, hi: __rdg.sim.hiScore })');
    await s.eval('(' + INJECT.toString() + ')(' + n0 + ', ' + c.botOffTick + ', ' + (c.nightDurationMs == null ? 'null' : Number(c.nightDurationMs)) + ', ' + JSON.stringify(plan.lang) + ')');
    for (var i = 0; i < keys.length; i++) {
      await s.eval('__stepTo(' + keys[i].frame + ')');
      await s.screenshot(path.join(shotsDir, String(keys[i].frame).padStart(4, '0') + '-' + keys[i].name + '.png'));
    }
    await s.eval('__stepTo(' + (c.mainFrames - 1) + ')');
    var rec = await s.eval('({ hashes: __rec.hashes, np: __rec.np, ev: __rec.ev, botOff: __rec.botOff, sameCfg: __rec.sameCfg, nightDuration: __rec.nightDuration, crashSerial: __rdg.sim.crashSerial, score: __rdg.sim.score, status: __rdg.state, tick: __rdg.sim.tick, result: __rdg.result, shareVisible: !document.getElementById("share-btn").hidden, shareTheme: document.getElementById("share-ui").getAttribute("data-theme"), goNight: __rdg.renderer.getGameOverLayout ? __rdg.renderer.getGameOverLayout().night : null, crashShift: __rdg.renderer._crashShiftVal })');
    out.rec = rec;
    out.mainUi = await s.eval('(' + PAGE_UI.toString() + ')()');
    out.mainUiFrames = await s.eval('({ langFrames: __rec.langFrames, langBad: __rec.langBad, touchFrames: __rec.touchFrames, overFrames: __rec.overFrames, shareLabels: __rec.shareLabels })');
    out.logs = s.logs;
    return out;
  });

  // ---- compare ----
  var rec = result.rec, problems = [];
  if (result.view.W !== plan.viewport.playfieldW) problems.push('playfield W ' + result.view.W + ' != ' + plan.viewport.playfieldW);
  if (result.view.tick !== n0) problems.push('page starts at tick ' + result.view.tick);
  if (rec.hashes.length !== exp.hashes.length) problems.push('frames ' + rec.hashes.length + ' != ' + exp.hashes.length);
  var firstBad = -1;
  for (var j = 0; j < Math.min(rec.hashes.length, exp.hashes.length); j++) if (rec.hashes[j] !== exp.hashes[j]) { firstBad = j; break; }
  if (firstBad >= 0) problems.push('state hash differs from frame ' + firstBad + ' (tick ' + (n0 + firstBad) + ')');
  var npBad = -1, npMax = 0;
  for (j = 0; j < Math.min(rec.np.length, exp.np.length); j++) { if (rec.np[j] !== exp.np[j] && npBad < 0) npBad = j; npMax = Math.max(npMax, rec.np[j]); }
  if (npBad >= 0) problems.push('night phase differs from frame ' + npBad + ': ' + rec.np[npBad] + ' != ' + exp.np[npBad]);
  if (!rec.sameCfg) problems.push('the page sim does not use RDG.config');
  var dayCheck = null;
  if (c.nightDurationMs != null) {
    if (rec.nightDuration !== c.nightDurationMs) problems.push('NIGHT_DURATION ' + rec.nightDuration + ' != ' + c.nightDurationMs);
    var cf = c.crashTick - n0, firstDay = -1;
    for (j = cf; j >= 0 && rec.np[j] === 0; j--) firstDay = j;
    var holdDay = rec.np.slice(cf).every(function (v) { return v === 0; });
    dayCheck = { maxNightPhase: npMax, daylightFramesBeforeCrash: firstDay < 0 ? 0 : cf - firstDay, holdAllDay: holdDay, shareTheme: rec.shareTheme, gameOverNight: rec.goNight };
    if (npMax < 1) problems.push('never full night');
    if (firstDay < 0 || cf - firstDay < 90) problems.push('daylight before the crash: ' + (firstDay < 0 ? 0 : cf - firstDay) + ' frames');
    if (!holdDay) problems.push('night phase not 0 through the GAME OVER hold');
    if (rec.shareTheme !== 'day' || rec.goNight !== false) problems.push('GAME OVER theme ' + rec.shareTheme + ' / night ' + rec.goNight);
    if (!rec.shareVisible) problems.push('share button not visible at the end');
  }
  if (JSON.stringify(rec.ev) !== JSON.stringify(exp.events)) problems.push('events differ');
  if (rec.crashSerial !== c.crash.serial) problems.push('crash serial ' + rec.crashSerial + ' != ' + c.crash.serial);
  if (rec.botOff !== c.botOffTick) problems.push('bot off at ' + rec.botOff);
  if (rec.status !== 'gameover') problems.push('state ' + rec.status);
  if (result.intro && result.intro.startTick !== plan.intro.autoStartTick) problems.push('intro start tick ' + result.intro.startTick);
  var errs = (result.logs || []).filter(function (l) { return /^(error|exception|warning)/.test(l); });
  if (errs.length) problems.push('console: ' + errs.join(' | '));
  // ---- UI language: every frame of both pages, the strings the video shows ----
  var want = plan.ui || null, CJK = /[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]/, langSummary = {};
  function uiCheck(name, u, frames, hintScreen) {
    if (!u) return;
    if (u.lang !== plan.lang || u.htmlLang !== plan.lang) problems.push(name + ': ui.lang ' + u.lang + ', <html lang> ' + u.htmlLang + ' (want ' + plan.lang + ')');
    if (u.touch) problems.push(name + ': touch UI (the hint would be the tap one)');
    if (want && u.text && (u.text.start !== want.start || u.text.keys !== want.keys || u.text.over !== want.over)) problems.push(name + ': canvas strings ' + JSON.stringify(u.text) + ' != plan.ui');
    if (want && u.share !== want.share) problems.push(name + ': share label ' + u.share + ' != ' + want.share);
    if (plan.lang === 'en') {
      var cjk = u.visibleText.filter(function (t) { return CJK.test(t); });
      if (cjk.length) problems.push(name + ': visible CJK text ' + JSON.stringify(cjk));
    }
    if (hintScreen && !(u.state === 'idle' && u.hint)) problems.push(name + ': not the start screen with its hint');
    if (frames.langBad) problems.push(name + ': ' + frames.langBad + ' of ' + frames.langFrames + ' frames in another language');
    if (frames.touchFrames) problems.push(name + ': ' + frames.touchFrames + ' frames with the touch UI');
    langSummary[name] = { lang: u.lang, frames: frames.langFrames, otherLang: frames.langBad, strings: u.text, share: u.share, visibleDomText: u.visibleText };
  }
  if (result.intro) {
    uiCheck('intro', result.intro.ui, result.intro.uiFrames, true);
    if (result.intro.uiFrames.hintFrames !== plan.intro.autoStartTick) problems.push('intro: start hint on ' + result.intro.uiFrames.hintFrames + ' frames, want ' + plan.intro.autoStartTick);
    langSummary.intro.hintFrames = result.intro.uiFrames.hintFrames;
  }
  uiCheck('main', result.mainUi, result.mainUiFrames, false);
  langSummary.main.gameOverFrames = result.mainUiFrames.overFrames;
  langSummary.main.shareLabels = result.mainUiFrames.shareLabels;
  var labels = Object.keys(result.mainUiFrames.shareLabels);
  if (want && (labels.length !== 1 || labels[0] !== want.share)) problems.push('main: share button labels ' + JSON.stringify(result.mainUiFrames.shareLabels));
  if (result.mainUiFrames.overFrames !== c.mainFrames - (c.crashTick - n0)) problems.push('main: GAME OVER on ' + result.mainUiFrames.overFrames + ' frames');

  var crashEv = rec.ev.filter(function (e) { return e[1] === Sim.EV.CRASH; })[0];
  console.log('seed ' + c.seed + ' candidate #' + ci + ': ' + (problems.length ? 'MISMATCH' : 'OK — Chrome reproduces the Node plan'));
  console.log('  view ' + JSON.stringify(result.view));
  if (result.intro) console.log('  intro: ' + JSON.stringify(result.intro));
  console.log('  frames ' + rec.hashes.length + ', events ' + rec.ev.length + ' (' + rec.ev.map(function (e) { return e[0] + ':' + lib_evName(e[1]) + (e[1] === 5 ? '(' + e[2] + ')' : ''); }).filter(function (x) { return !/JUMP|LAND/.test(x); }).join(' ') + ')');
  console.log('  crash tick ' + (crashEv && crashEv[0]) + ' serial ' + rec.crashSerial + ' final score ' + rec.score + ' result ' + JSON.stringify(rec.result) + ' crash-pose shift ' + rec.crashShift + ' share button visible ' + rec.shareVisible);
  console.log('  state hash equal on ' + (firstBad < 0 ? 'all ' + rec.hashes.length : firstBad) + ' frames; night phase equal on ' + (npBad < 0 ? 'all ' + rec.np.length : npBad) + ' frames' +
    (c.nightDurationMs != null ? '; NIGHT_DURATION ' + rec.nightDuration + ' ms (recording override); ' + JSON.stringify(dayCheck) : ''));
  console.log('  UI language: ' + JSON.stringify(langSummary));
  console.log('  key frames -> ' + shotsDir);
  problems.forEach(function (p) { console.log('  ! ' + p); });
  if (problems.length) process.exitCode = 1;
}

/* in the page: the UI strings in use and the visible DOM text (text nodes whose element is rendered and visible) */
var PAGE_UI = function () {
  var ui = __rdg.ui, T = window.RDG && RDG.TEXT ? RDG.TEXT[/^ja(?:[-_]|$)/i.test(ui.lang) ? 'ja' : 'en'] : null, b = document.getElementById('share-btn');
  var vis = [], w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), n;
  while ((n = w.nextNode())) {
    var t = n.nodeValue.replace(/\s+/g, ' ').trim(), el = n.parentElement;
    if (!t || !el) continue;
    if (el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.getClientRects().length) vis.push(t);
  }
  return {
    lang: ui.lang, htmlLang: document.documentElement.lang, touch: !!ui.touch, state: __rdg.state, hint: !!ui.hint,
    text: T ? { start: T.start, keys: T.keys, over: T.over } : null, share: RDG.i18n ? RDG.i18n.t('share.button') : null,
    shareShown: b ? !b.hidden : false, shareLabel: b ? b.textContent.replace(/\s+/g, ' ').trim() : null, visibleText: vis, title: document.title
  };
};

function lib_evName(e) { return ['', 'START', 'JUMP', 'LAND', 'FASTDROP', 'MILESTONE', 'CRASH', 'NIGHT_ON', 'NIGHT_OFF', 'SPAWN'][e] || String(e); }

main().catch(function (e) { console.error(e && e.stack || e); process.exitCode = 1; });
