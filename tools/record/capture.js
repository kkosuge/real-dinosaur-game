#!/usr/bin/env node
/* Capture the video frames of tools/record/plan.json in headless Chrome (served over http), one PNG per video frame.
 *
 *   node tools/record/capture.js [--work DIR] [--candidate 0] [--hold 1700] [--only intro|main] [--limit N]
 *
 * Both pages are frozen (?freeze=1: no rAF loop, no auto-restart) and advanced by the recorder alone: per frame one
 * __rdg.step(1000 / 60) (= one fixed tick incl. the dust FX and the page's own event handling, then a render) and one
 * CDP Page.captureScreenshot (PNG, so the DOM share button is in the picture). Nothing depends on the wall clock:
 * the only wall-clock effect in view, the share button's 0.22 s CSS fade-in (style.css rdg-share-in, ease-out), is
 * switched off by recording-only CSS injected here and replayed from sim.gameOverTime with the same curve; the
 * shipped game is not touched. Everything else (star twinkle, hint pulse, idle breathing, camera shake, the GAME
 * OVER fade) already runs on the sim clock.
 *
 * The sim events of every tick are collected by wrapping RDG.Sim.step in the page (main.js calls it once per tick
 * and clears sim.ev afterwards; the bot's look-ahead uses sim.js's internal step, so it is not recorded). The bot is
 * switched off before the step that starts at botOffTick (its update() then clears the reused output object), so
 * the dino runs into the planned cactus. The main segment's state hash is checked against the Node replay of the
 * plan on every frame (a mismatch aborts: use the next --candidate).
 * A day-story plan (main.nightDurationMs) shortens the night for the recording only: PAGE_SETUP sets the page's
 * RDG.config.NIGHT_DURATION (the sim's cfg) after the load / ?sim= fast-forward, before the first step (the shipped
 * game keeps 12 s). The state hash does not cover the night, so the night phase is checked on every frame as well,
 * and the GAME OVER must be in daylight (night phase 0, share UI in the day theme).
 *
 * Output (DIR = --work, default $RDG_VIDEO_WORK or <tmp>/rdg-video):
 *   DIR/frames/intro/000000.png ..   DIR/frames/main/000000.png ..   DIR/capture.json (timeline, per-frame facts,
 *   events with their video frames, checks). */
'use strict';

var fs = require('fs');
var fsp = require('fs/promises');
var os = require('os');
var path = require('path');
var crypto = require('crypto');
var lib = require('./lib');
var cdp = require('./cdp');

function argv(name, def) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  var v = process.argv[i + 1];
  return v == null || v.slice(0, 2) === '--' ? true : v;
}

var EV_NAMES = ['', 'START', 'JUMP', 'LAND', 'FASTDROP', 'MILESTONE', 'CRASH', 'NIGHT_ON', 'NIGHT_OFF', 'SPAWN'];

/* ---- in-page recorder (serialised into the page; recording only) ------------------------------------------------ */
var PAGE_SETUP = function (opt) {
  var S = RDG.Sim, cfg = __rdg.config, orig = S.step;
  if (opt.nightDurationMs != null) cfg.NIGHT_DURATION = opt.nightDurationMs; // recording-only short night (sim.cfg === cfg)
  // The share button's CSS fade-in and hover transition run on the wall clock: off here, replayed from the sim below.
  var css = document.createElement('style');
  css.id = 'rdg-record-css';
  css.textContent = '#share-btn{animation:none!important;transition:none!important}' +
    'html,body,#stage,#game,button{cursor:none!important}*{caret-color:transparent!important}';
  document.head.appendChild(css);
  if (document.activeElement && document.activeElement !== document.body && document.activeElement.blur) document.activeElement.blur();

  var pending = [];
  S.step = function (sim, inp) {
    orig(sim, inp);
    for (var i = 0; i < sim.nEv; i++) if (sim.ev[i] !== S.EV.SPAWN) pending.push(sim.ev[i]);
  };
  // CSS 'ease-out' = cubic-bezier(0, 0, 0.58, 1)
  function easeOut(x) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    var lo = 0, hi = 1, t = x;
    for (var k = 0; k < 40; k++) {
      t = (lo + hi) / 2;
      var bx = 3 * (1 - t) * t * t * 0.58 + t * t * t;
      if (bx < x) lo = t; else hi = t;
    }
    return 3 * (1 - t) * t * t + t * t * t;
  }
  var btn = document.getElementById('share-btn');
  var rec = window.__rec = { botOff: -1, nightDuration: cfg.NIGHT_DURATION, sameCfg: __rdg.sim.cfg === cfg };
  function info() {
    var sim = __rdg.sim, d = sim.dino, op = null, rect = null, label = null, theme = null;
    if (btn && !btn.hidden) {
      // the keyframes run 0 -> 1 over 0.22 s from the frame the button appears (gameOverTime >= GAMEOVER_CLEAR_TIME)
      op = easeOut((sim.gameOverTime - cfg.GAMEOVER_CLEAR_TIME) / 220);
      btn.style.opacity = String(Math.round(op * 1000) / 1000);
      var r = btn.getBoundingClientRect();
      rect = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
      label = btn.textContent.replace(/\s+/g, ' ').trim();
      theme = document.getElementById('share-ui').getAttribute('data-theme');
    }
    var ev = pending;
    pending = [];
    return {
      tick: sim.tick, state: __rdg.state, hash: S.stateHash(sim), score: Math.floor(sim.score), hud: sim.flashActive,
      y: Math.round(d.y * 100) / 100, anim: d.anim, jumping: d.jumping, ducking: d.ducking,
      night: Math.round(sim.nightPhase * 1000) / 1000, np: sim.nightPhase, got: Math.round(sim.gameOverTime * 100) / 100,
      share: op, shareRect: rect, shareLabel: label, shareTheme: theme, ev: ev,
      focus: document.activeElement ? document.activeElement.tagName : null
    };
  }
  window.__recInfo = info;
  window.__recStep = function () {
    if (opt.botOffTick >= 0 && __rdg.sim.tick === opt.botOffTick && rec.botOff < 0) {
      rec.botOff = __rdg.sim.tick;
      __rdg.bot.update = function (sim, out) { out.jumpPressed = false; out.jumpHeld = false; out.duckPressed = false; out.duckHeld = false; return out; };
    }
    __rdg.step(1000 / 60);
    return info();
  };
  pending.length = 0; // (events of the load / ?sim= fast-forward are not part of the segment)
  return info();
};

/** Node replay of the main segment (per-frame state hashes), exactly as the page is stepped. */
function expectedMain(G, tl) {
  var m = tl.main;
  var game = new lib.Game(G, { seed: m.seed, simMs: m.mainStartMs, hi: tl.hi, nightDurationMs: m.nightDurationMs });
  if (game.sim.tick !== m.startTick) throw new Error('Node: ?sim=' + m.mainStartMs + ' gives tick ' + game.sim.tick);
  var hashes = [G.Sim.stateHash(game.sim)], np = [game.sim.nightPhase];
  for (var j = 1; j < m.frames; j++) {
    if (game.sim.tick === m.botOffTick) game.botOff();
    game.tick();
    hashes.push(G.Sim.stateHash(game.sim));
    np.push(game.sim.nightPhase);
  }
  G.cfg.NIGHT_DURATION = G.defaults.NIGHT_DURATION;
  hashes.np = np;
  return hashes;
}

async function captureSegment(s, name, url, readyExpr, opt, frames, outDir, log) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  await s.goto(url, readyExpr, 60000);
  await s.eval('document.fonts && document.fonts.ready ? document.fonts.ready.then(function () { return true; }) : true');
  var page = await s.eval('({ W: __rdg.renderer.W, inner: [innerWidth, innerHeight], dpr: devicePixelRatio, missing: __rdg.renderer.A ? __rdg.renderer.A.missing.slice() : null, lang: __rdg.ui.lang, title: document.title, frozen: __rdg.params.freeze, share: __rdg.params.share, hi: __rdg.sim.hiScore, seed: __rdg.sim.seed })');
  if (page.missing && page.missing.length) throw new Error(name + ': images missing: ' + page.missing.join(', '));
  await s.eval('__rdg.render()'); // (fonts are in: the first frame is drawn with them)
  var first = await s.eval('(' + PAGE_SETUP.toString() + ')(' + JSON.stringify(opt) + ')');
  var infos = [], digests = [], writes = [], dup = [], t0 = Date.now();
  for (var f = 0; f < frames; f++) {
    var inf = f === 0 ? first : await s.eval('__recStep()');
    var buf = await s.screenshot(null, 'png', true);
    var dg = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    if (f > 0 && dg === digests[f - 1]) dup.push(f);
    digests.push(dg);
    inf.png = dg;
    infos.push(inf);
    writes.push(fsp.writeFile(path.join(outDir, String(f).padStart(6, '0') + '.png'), buf));
    if (writes.length >= 16) { await Promise.all(writes); writes = []; }
    if (f % 120 === 0 || f === frames - 1) {
      var el = (Date.now() - t0) / 1000;
      log('  ' + name + ' frame ' + f + '/' + frames + '  tick ' + inf.tick + '  ' + inf.state + '  score ' + inf.score + '  night ' + inf.night + '  (' + (el / (f + 1) * 1000).toFixed(0) + ' ms/frame)');
    }
  }
  await Promise.all(writes);
  var extra = await s.eval('({ botOff: __rec.botOff, nightDuration: __rec.nightDuration, sameCfg: __rec.sameCfg, crashSerial: __rdg.sim.crashSerial, result: __rdg.result })');
  return {
    page: page, frames: infos, identicalToPrevious: dup, botOff: extra.botOff, nightDuration: extra.nightDuration, sameCfg: extra.sameCfg,
    crashSerial: extra.crashSerial, result: extra.result, logs: s.logs.slice()
  };
}

async function main() {
  var work = path.resolve(argv('work', process.env.RDG_VIDEO_WORK || path.join(os.tmpdir(), 'rdg-video')));
  var planFile = argv('plan', path.join(__dirname, 'plan.json'));
  var plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  var G = lib.loadGame();
  var tl = lib.timeline(plan, G.cfg, { candidate: argv('candidate', 0), holdMs: argv('hold', undefined) });
  var only = argv('only', null), limit = Number(argv('limit', 0)) || 0;
  var log = function (m) { console.log(m); };
  log('timeline: seed ' + tl.main.seed + ', intro ' + tl.intro.frames + ' + main ' + tl.main.frames + ' - xfade ' + tl.xfadeFrames +
    ' = ' + tl.totalFrames + ' frames (' + tl.seconds.toFixed(3) + ' s); crash at main frame ' + tl.main.crashFrame + ', share button at ' + tl.main.shareFrame);

  var expHashes = only === 'intro' ? null : expectedMain(G, tl);
  var out = { timeline: JSON.parse(JSON.stringify(tl)), plan: path.relative(lib.ROOT, path.resolve(planFile)), capturedAt: new Date().toISOString() };
  var capFile = path.join(work, 'capture.json');
  if (only && fs.existsSync(capFile)) {
    var prev = JSON.parse(fs.readFileSync(capFile, 'utf8'));
    if (prev.timeline && prev.timeline.main.seed === tl.main.seed) { out.intro = prev.intro; out.main = prev.main; }
  }

  await cdp.withSession({ width: tl.viewport.width, height: tl.viewport.height, workDir: work }, async function (s) {
    if (!only || only === 'intro') {
      var n = limit ? Math.min(limit, tl.intro.frames) : tl.intro.frames;
      out.intro = await captureSegment(s, 'intro', s.url(tl.intro.url),
        'window.__rdg && __rdg.renderer && __rdg.renderer.A && document.readyState === "complete"',
        { botOffTick: -1 }, n, path.join(work, 'frames', 'intro'), log);
    }
    if (!only || only === 'main') {
      var m = limit ? Math.min(limit, tl.main.frames) : tl.main.frames;
      out.main = await captureSegment(s, 'main', s.url(tl.main.url),
        'window.__rdg && __rdg.renderer && __rdg.renderer.A && __rdg.sim.tick === ' + tl.main.startTick + ' && document.readyState === "complete"',
        { botOffTick: tl.main.botOffTick, nightDurationMs: tl.main.nightDurationMs }, m, path.join(work, 'frames', 'main'), log);
    }
  });

  // ---- checks -------------------------------------------------------------------------------------------------------
  var problems = [];
  var W = lib.viewWidth(G.cfg, tl.viewport.width, tl.viewport.height);
  ['intro', 'main'].forEach(function (k) {
    var seg = out[k];
    if (!seg) return;
    if (seg.page.W !== W) problems.push(k + ': playfield W ' + seg.page.W + ' != ' + W);
    if (seg.page.inner[0] !== tl.viewport.width || seg.page.inner[1] !== tl.viewport.height || seg.page.dpr !== 1) problems.push(k + ': viewport ' + JSON.stringify(seg.page));
    if (seg.page.lang !== tl.lang) problems.push(k + ': lang ' + seg.page.lang);
    var t0 = k === 'intro' ? tl.intro.startTick : tl.main.startTick;
    seg.frames.forEach(function (f, j) { if (f.tick !== t0 + j && !problems.some(function (p) { return p.indexOf(k + ': tick') === 0; })) problems.push(k + ': tick ' + f.tick + ' on frame ' + j); });
    if (seg.frames.some(function (f) { return f.focus && f.focus !== 'BODY'; })) problems.push(k + ': something has focus');
    var errs = (seg.logs || []).filter(function (l) { return /^(error|exception|warning)/.test(l); });
    if (errs.length) problems.push(k + ': console ' + errs.join(' | '));
    // events with their video frames
    seg.events = [];
    seg.frames.forEach(function (f, j) {
      f.ev.forEach(function (e) { seg.events.push({ frame: j, video: k === 'intro' ? tl.introVideoFrame(j) : tl.mainVideoFrame(j), tick: f.tick, ev: EV_NAMES[e] || String(e), score: f.score }); });
    });
  });
  if (out.intro && !limit) {
    var st = out.intro.events.filter(function (e) { return e.ev === 'START'; })[0];
    if (!st || st.frame !== tl.intro.autoStartTick) problems.push('intro: START on frame ' + (st && st.frame));
    if (out.intro.frames[0].state !== 'idle') problems.push('intro: frame 0 is ' + out.intro.frames[0].state);
  }
  if (out.main && expHashes) {
    var mf = out.main.frames, bad = -1;
    for (var j = 0; j < mf.length; j++) if (mf[j].hash !== expHashes[j]) { bad = j; break; }
    if (bad >= 0) problems.push('main: state hash differs from the Node plan from frame ' + bad + ' (tick ' + mf[bad].tick + ')');
    var npBad = -1;
    for (var jn = 0; jn < mf.length; jn++) if (mf[jn].np !== expHashes.np[jn]) { npBad = jn; break; }
    if (npBad >= 0) problems.push('main: night phase differs from the Node plan from frame ' + npBad + ' (' + mf[npBad].np + ' != ' + expHashes.np[npBad] + ')');
    if (!out.main.sameCfg) problems.push('main: the page sim does not use __rdg.config');
    var wantNight = tl.main.nightDurationMs != null ? tl.main.nightDurationMs : G.cfg.NIGHT_DURATION;
    if (out.main.nightDuration !== wantNight) problems.push('main: NIGHT_DURATION ' + out.main.nightDuration + ' != ' + wantNight);
    if (!limit) {
      var cr = out.main.events.filter(function (e) { return e.ev === 'CRASH'; });
      if (cr.length !== 1 || cr[0].frame !== tl.main.crashFrame) problems.push('main: crash ' + JSON.stringify(cr));
      if (out.main.crashSerial !== tl.main.crashSerial) problems.push('main: crash serial ' + out.main.crashSerial + ' != ' + tl.main.crashSerial);
      if (out.main.botOff !== tl.main.botOffTick) problems.push('main: bot off at ' + out.main.botOff);
      var sh = -1;
      for (var q = 0; q < mf.length; q++) if (mf[q].share != null) { sh = q; break; }
      if (sh !== tl.main.shareFrame) problems.push('main: share button from frame ' + sh + ', expected ' + tl.main.shareFrame);
      if (!mf[mf.length - 1].share || mf[mf.length - 1].share < 1) problems.push('main: share button not fully shown at the end');
      // the share button's label in the plan's language (plan.ui, written by plan.js) on every frame it shows
      var badLabel = plan.ui ? mf.filter(function (x) { return x.shareLabel != null && x.shareLabel !== plan.ui.share; }) : [];
      if (badLabel.length) problems.push('main: share button label ' + JSON.stringify(badLabel[0].shareLabel) + ' != ' + JSON.stringify(plan.ui.share) + ' on ' + badLabel.length + ' frames');
      if (tl.main.nightDurationMs != null) { // day story: the GAME OVER in daylight
        var cf = tl.main.crashFrame;
        if (mf.slice(Math.max(0, cf - 90)).some(function (x) { return x.np !== 0; })) problems.push('main: night phase not 0 from 1.5 s before the crash to the end');
        if (mf.slice(cf).some(function (x) { return x.shareTheme && x.shareTheme !== 'day'; })) problems.push('main: share UI not in the day theme');
        if (!mf.some(function (x) { return x.np >= 1; })) problems.push('main: never full night');
      }
    }
  }
  out.problems = problems;
  fs.mkdirSync(work, { recursive: true });
  fs.writeFileSync(capFile, JSON.stringify(out));
  ['intro', 'main'].forEach(function (k) {
    var seg = out[k];
    if (!seg) return;
    log(k + ': ' + seg.frames.length + ' frames, identical to the previous frame: ' + (seg.identicalToPrevious.length ? seg.identicalToPrevious.length + ' (' + seg.identicalToPrevious.slice(0, 12).join(',') + (seg.identicalToPrevious.length > 12 ? ',...' : '') + ')' : 'none'));
    log('  events: ' + seg.events.filter(function (e) { return e.ev !== 'LAND'; }).map(function (e) { return e.frame + ':' + e.ev; }).join(' '));
  });
  log('wrote ' + capFile);
  problems.forEach(function (p) { console.log('  ! ' + p); });
  if (problems.length) process.exitCode = 1;
}

if (require.main === module) main().catch(function (e) { console.error(e && e.stack || e); process.exitCode = 1; });

module.exports = { PAGE_SETUP: PAGE_SETUP };
