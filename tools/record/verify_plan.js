#!/usr/bin/env node
/* Check tools/record/plan.json in real headless Chrome (served over http): the page with
 * ?seed=S&bot=1&sim=mainStartMs&freeze=1&lang=ja&hi=N&share=1, stepped with __rdg.step(1000 / 60) one frame at a time
 * (the bot disabled before the step at botOffTick), must reproduce the Node plan tick for tick: the same state hash
 * on every frame (dino, obstacles, score, RNG), the same events and the same crash. Also checks the intro page
 * (idle, auto-start on tick 47) and the playfield width, and saves a few key frames for a visual check.
 *
 *   node tools/record/verify_plan.js [--plan tools/record/plan.json] [--candidate 0] [--shots DIR] [--no-intro]
 *
 * --candidate N verifies plan.candidates[N] instead of the chosen main segment (0 = the chosen one). */
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
    seed: c.seed, simMs: c.mainStartMs, hi: c.hi,
    onEvents: function (sim, evs) { evs.forEach(function (e) { if (e !== Sim.EV.SPAWN) events.push([sim.tick, e, sim.score]); }); }
  });
  if (game.sim.tick !== c.startTick) throw new Error('Node: ?sim=' + c.mainStartMs + ' gives tick ' + game.sim.tick + ', plan says ' + c.startTick);
  events.length = 0; // (the fast-forward's events are not part of the segment)
  var hashes = [Sim.stateHash(game.sim)];
  for (var j = 1; j < c.mainFrames; j++) {
    if (game.sim.tick === c.botOffTick) game.botOff();
    game.tick();
    hashes.push(Sim.stateHash(game.sim));
  }
  return { hashes: hashes, events: events, crashSerial: game.sim.crashSerial, score: game.sim.score, status: game.sim.status, crashTick: crashTickOf(events) };
}
function crashTickOf(events) { for (var i = 0; i < events.length; i++) if (events[i][1] === Sim.EV.CRASH) return events[i][0]; return -1; }

function pageUrl(s, c, main) {
  return s.url('index.html?seed=' + c.seed + '&bot=1' + (main ? '&sim=' + c.mainStartMs : '') + '&freeze=1&lang=' + plan.lang + '&hi=' + c.hi + '&share=1');
}

// in-page helpers: record events as main.js's Sim.step calls happen (the bot's own look-ahead uses sim.js's local
// step, so it is not recorded), hash every frame, and disable the bot before the step at botOffTick
var INJECT = function (startTick, botOffTick) {
  var S = RDG.Sim, orig = S.step;
  window.__rec = { ev: [], hashes: [S.stateHash(__rdg.sim)], botOff: -1 };
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
  if (c.dayPtero) key('day-ptero', Math.round(c.dayPtero.at * 60) - 12);
  key('dusk', Math.round(c.milestone700At * 60) + 80);
  if (c.nightPtero) key('night-ptero', Math.round(c.nightPtero.at * 60) - 12);
  key('crash', c.crashTick - n0 + 2);
  key('gameover-end', c.mainFrames - 1);
  keys.sort(function (a, b) { return a.frame - b.frame; });

  var result = await cdp.withSession({ width: plan.viewport.width, height: plan.viewport.height, workDir: SCRATCH }, async function (s) {
    var out = { intro: null };
    // ---- intro page: idle, then the bot's auto-start ----
    if (!argv('no-intro', false)) {
      await s.goto(pageUrl(s, c, false), 'window.__rdg && __rdg.renderer && __rdg.renderer.A && document.readyState === "complete"');
      await s.eval('(' + INJECT.toString() + ')(0, -1)');
      var st0 = await s.eval('({ state: __rdg.state, tick: __rdg.sim.tick, hint: __rdg.ui.hint, lang: __rdg.ui.lang })');
      await s.eval('__stepTo(20)');
      await s.screenshot(path.join(shotsDir, 'intro-idle.png'));
      await s.eval('__stepTo(' + (plan.intro.frames - 1) + ')');
      await s.screenshot(path.join(shotsDir, 'intro-end.png'));
      var iev = await s.eval('__rec.ev');
      out.intro = { start: st0, events: iev.slice(0, 6), startTick: (iev.filter(function (e) { return e[1] === 1; })[0] || [])[0] };
    }
    // ---- main segment ----
    await s.goto(pageUrl(s, c, true), 'window.__rdg && __rdg.sim.tick === ' + n0 + ' && document.readyState === "complete"');
    out.view = await s.eval('({ W: __rdg.renderer.W, inner: [innerWidth, innerHeight], dpr: devicePixelRatio, tick: __rdg.sim.tick, status: __rdg.state, frozen: __rdg.params.freeze, share: __rdg.params.share, lang: __rdg.ui.lang, hi: __rdg.sim.hiScore })');
    await s.eval('(' + INJECT.toString() + ')(' + n0 + ', ' + c.botOffTick + ')');
    for (var i = 0; i < keys.length; i++) {
      await s.eval('__stepTo(' + keys[i].frame + ')');
      await s.screenshot(path.join(shotsDir, String(keys[i].frame).padStart(4, '0') + '-' + keys[i].name + '.png'));
    }
    await s.eval('__stepTo(' + (c.mainFrames - 1) + ')');
    var rec = await s.eval('({ hashes: __rec.hashes, ev: __rec.ev, botOff: __rec.botOff, crashSerial: __rdg.sim.crashSerial, score: __rdg.sim.score, status: __rdg.state, tick: __rdg.sim.tick, result: __rdg.result, shareVisible: !document.getElementById("share-btn").hidden, crashShift: __rdg.renderer._crashShiftVal })');
    out.rec = rec;
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
  if (JSON.stringify(rec.ev) !== JSON.stringify(exp.events)) problems.push('events differ');
  if (rec.crashSerial !== c.crash.serial) problems.push('crash serial ' + rec.crashSerial + ' != ' + c.crash.serial);
  if (rec.botOff !== c.botOffTick) problems.push('bot off at ' + rec.botOff);
  if (rec.status !== 'gameover') problems.push('state ' + rec.status);
  if (result.intro && result.intro.startTick !== plan.intro.autoStartTick) problems.push('intro start tick ' + result.intro.startTick);
  var errs = (result.logs || []).filter(function (l) { return /^(error|exception|warning)/.test(l); });
  if (errs.length) problems.push('console: ' + errs.join(' | '));

  var crashEv = rec.ev.filter(function (e) { return e[1] === Sim.EV.CRASH; })[0];
  console.log('seed ' + c.seed + ' candidate #' + ci + ': ' + (problems.length ? 'MISMATCH' : 'OK — Chrome reproduces the Node plan'));
  console.log('  view ' + JSON.stringify(result.view));
  if (result.intro) console.log('  intro: ' + JSON.stringify(result.intro));
  console.log('  frames ' + rec.hashes.length + ', events ' + rec.ev.length + ' (' + rec.ev.map(function (e) { return e[0] + ':' + lib_evName(e[1]) + (e[1] === 5 ? '(' + e[2] + ')' : ''); }).filter(function (x) { return !/JUMP|LAND/.test(x); }).join(' ') + ')');
  console.log('  crash tick ' + (crashEv && crashEv[0]) + ' serial ' + rec.crashSerial + ' final score ' + rec.score + ' result ' + JSON.stringify(rec.result) + ' crash-pose shift ' + rec.crashShift + ' share button visible ' + rec.shareVisible);
  console.log('  key frames -> ' + shotsDir);
  problems.forEach(function (p) { console.log('  ! ' + p); });
  if (problems.length) process.exitCode = 1;
}

function lib_evName(e) { return ['', 'START', 'JUMP', 'LAND', 'FASTDROP', 'MILESTONE', 'CRASH', 'NIGHT_ON', 'NIGHT_OFF', 'SPAWN'][e] || String(e); }

main().catch(function (e) { console.error(e && e.stack || e); process.exitCode = 1; });
