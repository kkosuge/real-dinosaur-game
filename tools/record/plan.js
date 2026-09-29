#!/usr/bin/env node
/* Plan the X gameplay video (docs/video/real-dinosaur-game-x.mp4): pick the seed and the main segment's time window.
 *
 *   node tools/record/plan.js                              # seeds 1..2000 -> tools/record/plan.json, prints the top 3
 *   node tools/record/plan.js --from 1 --to 3000 --top 5 --out /tmp/plan.json --workers 8
 *   node tools/record/plan.js --seed 123                   # one seed: its best window (writes nothing)
 *
 * The video = intro (idle start screen with 「スペースキーでスタート」, the bot's auto-start, ~1.7 s of running)
 * + a 0.4 s crossfade + the main segment: ONE continuous deterministic run, recorded frame by frame from a
 * `?seed=S&bot=1&sim=MS&freeze=1&lang=ja&hi=N&share=1` page (MS = mainStartMs: the page fast-forwards the bot run
 * to that running time before its first frame):
 *   late day (score ~600-690) with a pterodactyl (+ ideally a multi-cactus jump) -> the 700 milestone blink + the
 *   dusk -> night fade -> full night (moon, stars) with a pterodactyl -> the bot stops acting at botOffTick -> the dino
 *   runs into a cactus -> ゲームオーバー, restart icon and the シェア button -> a 1.5-2 s hold.
 *
 * Everything is simulated with the page's own scripts (lib.js loads assets/manifest.js, config.js, rng.js, sim.js
 * and mirrors main.js's bot tick), at the recording viewport: 1920x1080 CSS px -> the renderer's playfield is
 * W = 1350 world units wide (render.js resize: never less road than Chrome, VIEW_MIN_W), the extra height becomes
 * sky / ground. "On screen" below means inside that playfield.
 *
 * Tick / frame conventions (the recorder follows them):
 *   - a sim tick is 1/60 s; one video frame = one __rdg.step(1000 / 60) = one tick.
 *   - main page: after load sim.tick === startTick (running ticks since the run started, the ?sim= fast-forward);
 *     main frame j (0-based) shows sim.tick === startTick + j; frames = crashTick - startTick + holdFrames.
 *   - before the step that starts at sim.tick === botOffTick the recorder disables the bot (its update() must clear
 *     its output object: main.js reuses it). Before that tick the bot's plan presses nothing, so the state is the
 *     bot run's; from it, pressing nothing runs the dino into the planned cactus (verified here: crashSerial).
 *   - running time (ms) = ticks * 1000 / 60; mainStartMs is the integer ?sim= value that advance() rounds to
 *     startTick ticks.
 */
'use strict';

var path = require('path');
var fs = require('fs');
var lib = require('./lib');

// ---- video layout ------------------------------------------------------------------------------------------------
var VIEW = { width: 1920, height: 1080 };
var FPS = 60;
var LANG = 'ja';
var INTRO_FRAMES = 150; // 2.5 s: 46 idle frames, the auto-start press on the 47th tick, ~1.7 s of running (no obstacles)
var XFADE_FRAMES = 24; // 0.4 s intro -> main crossfade
var HOLD_MIN = 90, HOLD_MAX = 120; // GAME OVER hold 1.5-2 s (share button from gameOverTime >= 750 ms)
var MAIN_MIN = 954, MAIN_MAX = 1020; // main segment 15.9-17.0 s -> total (intro + main - xfade) 18.0-19.1 s
var RUN_MIN = MAIN_MIN - HOLD_MAX, RUN_MAX = MAIN_MAX - HOLD_MIN; // startTick -> crashTick
var SCORE0 = [590, 692]; // HUD score on the first main frame: late day
var MIN_700_LEAD = 150; // >= 2.5 s of day before the 700 milestone
var XFADE_QUIET = 30; // no obstacle crossing in the first 0.5 s (half hidden by the crossfade)
var MIN_VIS = 40; // a pterodactyl counts when on screen >= 40 frames (0.67 s) of the segment
var MAX_SIM_TICKS = 7200;

var ALT = ['LOW', 'MID', 'HIGH'];
var EV_NAMES = ['', 'START', 'JUMP', 'LAND', 'FASTDROP', 'MILESTONE', 'CRASH', 'NIGHT_ON', 'NIGHT_OFF', 'SPAWN'];

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

// ---- one seed: the bot run on the ?sim= path, per-tick facts, obstacle tracks and crash tests ----------------------

function pteroVisX(G) {
  var P = G.manifest.ptero, s = G.metrics.ptero.s, x0 = Infinity, x1 = -Infinity;
  if (P && P.frames) {
    P.frames.forEach(function (f) {
      var ob = f.opaqueBox;
      if (Array.isArray(ob) && ob.length >= 4) { x0 = Math.min(x0, ob[0]); x1 = Math.max(x1, ob[0] + ob[2]); }
    });
  }
  if (!isFinite(x0)) return [0, G.metrics.ptero.frameW];
  return [x0 * s, x1 * s];
}

/** render.js Renderer.prototype._crashShift (visual x shift of the dead pose so it just touches what it hit). */
function crashShift(G, sim, dy) {
  var M = sim.M, D = M.dino, c = G.cfg, OT = G.Sim.OT, dead = D.frames.dead[0], o = null, i, m;
  for (i = 0; i < sim.nObs; i++) if (sim.obs[i].serial === sim.crashSerial) { o = sim.obs[i]; break; }
  if (!dead || !o) return { shift: 0, gap: null };
  var gap = Infinity;
  function test(r, n, ox, oy) {
    for (var a = 0; a < dead.n; a++) {
      var ax1 = dead.r[a * 4 + 2], ay0 = dead.r[a * 4 + 1] + dy, ay1 = dead.r[a * 4 + 3] + dy;
      for (var b = 0; b < n; b++) {
        if (r[b * 4 + 3] + oy <= ay0 || r[b * 4 + 1] + oy >= ay1) continue;
        var g = r[b * 4] + ox - ax1;
        if (g < gap) gap = g;
      }
    }
  }
  if (o.type === OT.PTERO) test(M.ptero.union.r, M.ptero.union.n, o.x, o.y);
  else {
    var list = M.cactusByType[o.type];
    for (m = 0; m < o.n; m++) { var v = list[o.vs[m]]; test(v.r, v.n, o.x + o.oxs[m], c.GROUND_Y); }
  }
  var lean = D.front - dead.x1, maxBack = c.MAX_SPEED + lean + 8;
  if (gap === Infinity || gap + 2 < -maxBack) return { shift: 0, gap: gap === Infinity ? null : gap };
  var md = G.manifest.dino && G.manifest.dino.frames && G.manifest.dino.frames.dead;
  var ox0 = md && md[0] && isFinite(md[0].opaqueX0) ? md[0].opaqueX0 : 0;
  return { shift: Math.max(-(D.drawX + ox0 * D.s), Math.min(gap + 2, Math.max(0, lean * 0.6))), gap: gap };
}

/** From `pre` (the state before the step at botOffTick): press nothing. Where does the dino crash? */
function crashTest(G, pre, target, W, visX) {
  var Sim = G.Sim, ST = Sim.STATUS, GY = G.cfg.GROUND_Y;
  var c = Sim.clone(pre), k;
  for (k = 0; k < 600 && c.status === ST.RUNNING; k++) { Sim.step(c, Sim.IDLE_INPUT); c.nEv = 0; }
  var res = { botOffTick: pre.tick, target: target, crashTick: -1 };
  if (c.status !== ST.CRASHED) return res;
  var o = null;
  for (k = 0; k < c.nObs; k++) if (c.obs[k].serial === c.crashSerial) o = c.obs[k];
  res.crashTick = c.tick;
  res.serial = c.crashSerial;
  res.type = c.crashType;
  res.n = o ? o.n : 0;
  res.alt = o ? o.alt : -1;
  res.intended = c.crashSerial === target;
  res.rise = GY - c.dino.y; // 0: hit while running on the ground
  res.np = c.nightPhase;
  res.nightActive = c.nightActive;
  res.score = c.score;
  res.speed = c.speed;
  res.obsX = o ? o.x : null;
  // other obstacles frozen on screen through the GAME OVER hold
  res.others = [];
  for (k = 0; k < c.nObs; k++) {
    var q = c.obs[k];
    if (q.serial === c.crashSerial) continue;
    var vx = q.type === Sim.OT.PTERO ? visX : [0, q.w];
    if (q.x + vx[0] < W && q.x + vx[1] > 0) res.others.push({ serial: q.serial, type: q.type, n: q.n, alt: q.alt, x: Math.round(q.x) });
  }
  // settle (a mid-air hit rests on the cactus), then the renderer's crash-pose shift
  for (k = 0; k < 40; k++) { Sim.step(c, Sim.IDLE_INPUT); c.nEv = 0; }
  var cs = crashShift(G, c, c.dino.y);
  res.restRise = GY - c.dino.y;
  res.shift = cs.shift;
  res.gap = cs.gap;
  return res;
}

function simulateSeed(G, seed, W) {
  var Sim = G.Sim, M = G.metrics, D = M.dino, EV = Sim.EV, ANIM = Sim.ANIM, ST = Sim.STATUS, OT = Sim.OT;
  var visX = pteroVisX(G);
  var R = {
    seed: seed, W: W, score: [], np: [], air: [], duck: [], speed: [], ev: [], obs: new Map(), plans: [], tests: [],
    t700: -1, nightOn: -1, fullNight: -1, nightOff: -1, botCrash: -1
  };
  var seenPlan = '', testedStart = -1;
  var game = new lib.Game(G, {
    seed: seed, started: true,
    beforeStep: function (sim, inp, g) {
      var pl = g.bot.plan;
      if (!g.botEnabled || !pl.active) return;
      var key = pl.start + ':' + pl.target + ':' + pl.p;
      if (key !== seenPlan) { seenPlan = key; R.plans.push({ tick: sim.tick, start: pl.start, p: pl.p, name: Sim.PLANS[pl.p].name, target: pl.target }); }
      // the bot presses for this plan on this very tick: a botOff here = the dino never acts on `target`
      if (pl.start === sim.tick && testedStart !== pl.start && pl.target >= 0 && sim.nightActive) {
        testedStart = pl.start;
        R.tests.push(crashTest(G, sim, pl.target, W, visX));
      }
    },
    onEvents: function (sim, evs) {
      for (var i = 0; i < evs.length; i++) {
        var e = evs[i];
        if (e === EV.SPAWN) continue;
        R.ev.push({ tick: sim.tick, e: e, score: sim.score });
        if (e === EV.NIGHT_ON && R.nightOn < 0) R.nightOn = sim.tick;
        if (e === EV.NIGHT_OFF && R.nightOff < 0) R.nightOff = sim.tick;
        if (e === EV.MILESTONE && sim.score >= 700 && R.t700 < 0) R.t700 = sim.tick;
      }
    }
  });
  function snap(sim) {
    var k = sim.tick, d = sim.dino;
    R.score[k] = sim.score; R.np[k] = sim.nightPhase; R.air[k] = d.jumping ? 1 : 0; R.duck[k] = d.anim === ANIM.DUCK ? 1 : 0;
    R.speed[k] = sim.speed;
    if (R.nightOn >= 0 && R.fullNight < 0 && sim.nightPhase >= 1) R.fullNight = k;
    for (var i = 0; i < sim.nObs; i++) {
      var o = sim.obs[i], r = R.obs.get(o.serial);
      if (!r) {
        r = {
          serial: o.serial, type: o.type, n: o.n, alt: o.alt, so: o.so, vs: [o.vs[0], o.vs[1], o.vs[2]].slice(0, o.n), spawn: k,
          visL: o.type === OT.PTERO ? visX[0] : 0, visR: o.type === OT.PTERO ? visX[1] : o.w,
          visFirst: -1, visLast: -1, fullFirst: -1, fullLast: -1, crossFirst: -1, crossLast: -1, jumped: false, ducked: false
        };
        R.obs.set(o.serial, r);
      }
      var x0 = o.x + r.visL, x1 = o.x + r.visR;
      if (x0 < W && x1 > 0) { if (r.visFirst < 0) r.visFirst = k; r.visLast = k; }
      if (x0 >= 0 && x1 <= W) { if (r.fullFirst < 0) r.fullFirst = k; r.fullLast = k; }
      if (o.x + o.hitL < D.front && o.x + o.hitR > D.back) {
        if (r.crossFirst < 0) r.crossFirst = k;
        r.crossLast = k;
        if (d.jumping) r.jumped = true;
        if (d.anim === ANIM.DUCK) r.ducked = true;
      }
    }
  }
  snap(game.sim);
  while (game.sim.tick < MAX_SIM_TICKS) {
    game.tick();
    snap(game.sim);
    if (game.sim.status !== ST.RUNNING) { R.botCrash = game.sim.tick; break; }
    if (R.nightOff >= 0 && game.sim.tick > R.nightOff + 30) break;
  }
  R.lastTick = game.sim.tick;
  R.botStats = { decisions: game.bot.decisions, degraded: game.bot.degraded, fails: game.bot.fails };
  return R;
}

// ---- window scoring ----------------------------------------------------------------------------------------------

function obsLabel(r) {
  if (r.type === 2) return 'ptero ' + ALT[r.alt] + (r.so > 0 ? ' (fast)' : ' (slow)');
  return r.n + 'x ' + (r.type === 1 ? 'large' : 'small') + ' cactus';
}
function actionOf(r) { return r.ducked ? 'duck' : r.jumped ? 'jump' : 'under'; }
function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0) + 1); }

/**
 * Score one window (0-10): main segment starts at n0, the bot stops at t.botOffTick, the crash is at t.crashTick,
 * then `hold` GAME OVER frames. Hard requirements are checked by the caller; this ranks what the viewer sees.
 *   base 1.6
 *   day pterodactyl (crossing the dino at night phase < 0.35; a dusk one counts less): 2.0 + action (duck under a MID
 *     0.6, jump a LOW 0.5, jump a MID 0.3, HIGH passing over 0) + fully on screen >= 50 / 35 frames 0.2 / 0.1
 *   night pterodactyl (night phase >= 0.97, handled before botOff): the same, counting frames at night phase >= 0.9
 *   variety: the two pterodactyls get different actions (duck + jump) 0.2
 *   multi-cactus jump: 2 small 0.5, 2 large 0.6, 3 small 0.7, 3 large 0.8
 *   crash obstacle: large 0.15, a group 0.15, dead pose touching it naturally (render.js crash shift) 0.1
 *   extra pterodactyls on screen 0.1 each (max 0.4), encounters (bot actions) 0.03 each (max 0.3)
 *   700 milestone 3-5.5 s in 0.2, no crossing during the crossfade 0.1
 *   readability: the day / night pterodactyl crossing >= 0.5 s away from any other crossing 0.1 each; another
 *   pterodactyl crossing in the dusk light (night phase 0.2-0.9) 0.1; their frames fully on screen / 2000 (<= 0.1)
 *   penalties: the cactus it hits on screen < 0.6 s before the crash -0.5; an obstacle cut by the screen edge frozen
 *   through the GAME OVER hold -0.1 each
 */
function scoreWindow(R, t, n0, hold) {
  var crash = t.crashTick, off = t.botOffTick, i, k;
  var items = [];
  R.obs.forEach(function (r) {
    if (r.serial === t.serial || r.crossFirst < 0) return;
    var mid = (r.crossFirst + r.crossLast) >> 1;
    if (mid < n0 || mid > crash) return;
    var vis = r.visFirst < 0 ? 0 : overlap(r.visFirst, r.visLast, n0, crash);
    var full = r.fullFirst < 0 ? 0 : overlap(r.fullFirst, r.fullLast, n0, crash);
    var nightVis = 0, nightFull = 0;
    if (r.visFirst >= 0) for (k = Math.max(r.visFirst, n0); k <= Math.min(r.visLast, crash); k++) if (R.np[k] >= 0.9) nightVis++;
    if (r.fullFirst >= 0) for (k = Math.max(r.fullFirst, n0); k <= Math.min(r.fullLast, crash); k++) if (R.np[k] >= 0.9) nightFull++;
    items.push({ r: r, mid: mid, np: R.np[mid], vis: vis, full: full, nightVis: nightVis, nightFull: nightFull, action: actionOf(r), afterOff: mid >= off });
  });
  items.sort(function (a, b) { return a.mid - b.mid; });
  var f = { day: null, night: null, multi: null, pteros: 0, encounters: 0, quietStart: true, parts: {} };
  var dayS = 0, nightS = 0, multiS = 0;
  function act(it) {
    var r = it.r;
    if (r.alt === 1 && it.action === 'duck') return 0.6;
    if (r.alt === 0 && it.action === 'jump') return 0.5;
    if (r.alt === 1) return 0.3;
    return 0;
  }
  function visB(n) { return n >= 50 ? 0.2 : n >= 35 ? 0.1 : 0; }
  for (i = 0; i < items.length; i++) {
    var it = items[i], r = it.r;
    if (it.mid < n0 + XFADE_QUIET) f.quietStart = false;
    if (!it.afterOff && (it.action !== 'under' || r.type !== 2)) f.encounters++;
    if (r.type === 2) {
      if (it.vis >= MIN_VIS) f.pteros++;
      if (it.mid < n0 + XFADE_QUIET || it.afterOff) continue;
      if (it.np < 0.35 && it.vis >= MIN_VIS) {
        var ds = 2.0 + act(it) + visB(it.full);
        if (ds > dayS) { dayS = ds; f.day = it; }
      } else if (it.np < 0.97 && it.vis >= MIN_VIS) {
        var dus = 1.2 + act(it) * 0.5; // dusk: second best
        if (dus > dayS) { dayS = dus; f.day = it; }
      } else if (it.np >= 0.97 && it.nightVis >= MIN_VIS) {
        var ns = 2.0 + act(it) + visB(it.nightFull);
        if (ns > nightS) { nightS = ns; f.night = it; }
      }
    } else if (r.n >= 2 && it.action === 'jump' && it.mid >= n0 + XFADE_QUIET && !it.afterOff) {
      var ms = r.n >= 3 ? (r.type === 1 ? 0.8 : 0.7) : (r.type === 1 ? 0.6 : 0.5);
      if (ms > multiS) { multiS = ms; f.multi = it; }
    }
  }
  var variety = f.day && f.night && f.day.action !== f.night.action && f.day.action !== 'under' && f.night.action !== 'under' ? 0.2 : 0;
  var residual = t.gap == null ? 99 : t.gap + 2 - t.shift; // > 0: the dead pose stops short of the cactus
  var pose = residual <= 4 && t.shift > -12 ? 0.1 : 0;
  var crashS = (t.type === 1 ? 0.15 : 0) + (t.n >= 2 ? 0.15 : 0) + pose;
  var used = (f.day ? 1 : 0) + (f.night ? 1 : 0);
  var extra = Math.min(0.4, Math.max(0, f.pteros - used) * 0.1);
  var density = Math.min(0.3, f.encounters * 0.03);
  var a = R.t700 - n0;
  var timing = a >= 180 && a <= 330 ? 0.2 : 0;
  var tgt = R.obs.get(t.serial);
  var tgtVis = tgt && tgt.visFirst >= 0 ? crash - Math.max(tgt.visFirst, n0) : 0;
  var framing = tgtVis >= 36 ? 0 : -0.5; // the cactus it hits is on screen >= 0.6 s before the crash
  var W = R.W, edge = 0;
  t.others.forEach(function (o) { var w = o.type === 2 ? 166 : 60 * o.n; if (o.x < 0 || o.x + w > W) edge -= 0.1; });
  function isolated(x) {
    if (!x) return 0;
    for (var j = 0; j < items.length; j++) if (items[j] !== x && Math.abs(items[j].mid - x.mid) < 30) return 0;
    return Math.abs(t.crashTick - x.mid) >= 30 ? 0.1 : 0;
  }
  var iso = isolated(f.day) + isolated(f.night);
  var dusk = 0;
  items.forEach(function (x) { if (x.r.type === 2 && x !== f.day && x !== f.night && x.np >= 0.2 && x.np <= 0.9 && x.vis >= MIN_VIS) dusk = 0.1; });
  var frames = Math.min(0.1, ((f.day ? f.day.full : 0) + (f.night ? f.night.nightFull : 0)) / 2000);
  var base = 1.6;
  var score = base + dayS + nightS + variety + multiS + crashS + extra + density + timing + (f.quietStart ? 0.1 : 0) + iso + dusk + frames + framing + edge;
  f.parts = {
    base: base, dayPtero: dayS, nightPtero: nightS, variety: variety, multiCactus: multiS, crashObstacle: +crashS.toFixed(2),
    extraPteros: extra, encounters: +density.toFixed(2), timing700: timing, quietStart: f.quietStart ? 0.1 : 0,
    isolation: iso, duskPtero: dusk, pteroFrames: frames, framing: framing, edge: edge
  };
  for (k in f.parts) f.parts[k] = Math.round(f.parts[k] * 100) / 100;
  return { score: Math.round(Math.min(10, score) * 1000) / 1000, n0: n0, hold: hold, items: items, f: f, targetVis: tgtVis };
}

function bestWindows(R) {
  var out = [];
  if (R.botCrash >= 0 || R.t700 < 0) return out;
  R.tests.forEach(function (t) {
    // hard requirements for the ending: the intended cactus, hit while running on the ground, in full night
    if (t.crashTick < 0 || !t.intended || t.type === 2 || t.rise > 0.5 || t.np < 0.999 || !t.nightActive) return;
    var best = null;
    for (var run = RUN_MIN; run <= RUN_MAX; run += 2) {
      var n0 = t.crashTick - run;
      if (n0 < 1) continue;
      var s0 = R.score[n0];
      if (s0 < SCORE0[0] || s0 > SCORE0[1]) continue;
      if (R.t700 - n0 < MIN_700_LEAD) continue;
      var hold = clamp(MAIN_MAX - run, HOLD_MIN, HOLD_MAX);
      var w = scoreWindow(R, t, n0, hold);
      w.test = t;
      w.run = run;
      w.main = run + hold;
      // ties: the longer segment (closer to 20 s total), a longer GAME OVER hold, the 700 milestone nearer 4 s in
      w.rank = w.score + (w.main - MAIN_MIN) * 1e-5 + hold * 1e-6 - Math.abs(R.t700 - n0 - 240) * 1e-7;
      if (!best || w.rank > best.rank) best = w;
    }
    if (best) out.push(best);
  });
  out.sort(function (a, b) { return b.rank - a.rank; });
  return out;
}

// ---- reporting ---------------------------------------------------------------------------------------------------

function describe(G, R, w) {
  var t = w.test, n0 = w.n0, K = G.cfg.K;
  function ts(k) { return ((k - n0) / FPS).toFixed(2) + 's'; }
  var L = [];
  L.push(ts(n0) + ' main start: score ' + R.score[n0] + ', day, speed ' + (R.speed[n0] / K).toFixed(2));
  var marks = [];
  w.items.forEach(function (it) {
    var r = it.r;
    var s = obsLabel(r) + ' -> ' + it.action + ' @' + ts(it.mid) + ' (on screen ' + ts(Math.max(r.visFirst, n0)) + '-' + ts(Math.min(r.visLast, t.crashTick)) +
      ', night ' + it.np.toFixed(2) + ')';
    marks.push({ k: it.mid, s: s });
  });
  R.ev.forEach(function (e) {
    if (e.tick < n0 || e.tick > t.crashTick) return;
    if (e.e === 5) marks.push({ k: e.tick, s: 'milestone ' + e.score + ' (HUD blink + sound) @' + ts(e.tick) });
    if (e.e === 7) marks.push({ k: e.tick + 0.5, s: 'NIGHT_ON: dusk -> night fade @' + ts(e.tick) + ', full night @' + ts(R.fullNight) });
  });
  marks.push({ k: t.botOffTick, s: 'bot off @' + ts(t.botOffTick) });
  var tgt = R.obs.get(t.serial);
  marks.push({
    k: t.crashTick, s: 'CRASH into ' + obsLabel(tgt) + ' @' + ts(t.crashTick) + ' (on the ground, night ' + t.np.toFixed(2) + ', score ' + t.score +
      ', on screen from ' + ts(Math.max(tgt.visFirst, n0)) + ', pose shift ' + t.shift.toFixed(1) + 'u' +
      (t.others.length ? ', also on screen: ' + t.others.map(function (o) { return (o.type === 2 ? 'ptero ' + ALT[o.alt] : o.n + 'x ' + (o.type ? 'large' : 'small') + ' cactus') + ' x=' + o.x; }).join(', ') : '') + ')'
  });
  marks.push({ k: t.crashTick + 45, s: 'restart icon full + share button @' + ts(t.crashTick + 45) });
  marks.push({ k: t.crashTick + w.hold, s: 'end @' + ts(t.crashTick + w.hold) + ' (hold ' + (w.hold / FPS).toFixed(2) + 's)' });
  marks.sort(function (a, b) { return a.k - b.k; });
  return L.concat(marks.map(function (m) { return m.s; }));
}

function summarize(G, R, w) {
  var t = w.test, cfg = G.cfg;
  var hi = t.score + 47; // display-only HI a little above the final score (no fake new record)
  var ms = lib.simMsForTicks(cfg, w.n0);
  return {
    seed: R.seed,
    score: Math.min(10, w.score),
    parts: w.f.parts,
    startTick: w.n0,
    mainStartMs: ms,
    botOffTick: t.botOffTick,
    botOffMs: Math.round(t.botOffTick * cfg.STEP_MS),
    crashTick: t.crashTick,
    crashMs: Math.round(t.crashTick * cfg.STEP_MS),
    holdFrames: w.hold,
    endTick: t.crashTick + w.hold,
    endMs: Math.round((t.crashTick + w.hold) * cfg.STEP_MS),
    mainFrames: w.run + w.hold,
    mainSeconds: +((w.run + w.hold) / FPS).toFixed(3),
    startScore: R.score[w.n0],
    milestone700At: +((R.t700 - w.n0) / FPS).toFixed(3),
    fullNightAt: +((R.fullNight - w.n0) / FPS).toFixed(3),
    finalScore: t.score,
    hi: hi,
    crash: { serial: t.serial, type: t.type, n: t.n, rise: t.rise, restRise: t.restRise, shift: +t.shift.toFixed(2), gap: t.gap == null ? null : +t.gap.toFixed(2), others: t.others },
    dayPtero: w.f.day ? { serial: w.f.day.r.serial, alt: ALT[w.f.day.r.alt], action: w.f.day.action, at: +((w.f.day.mid - w.n0) / FPS).toFixed(2), np: +w.f.day.np.toFixed(2), visFrames: w.f.day.vis } : null,
    nightPtero: w.f.night ? { serial: w.f.night.r.serial, alt: ALT[w.f.night.r.alt], action: w.f.night.action, at: +((w.f.night.mid - w.n0) / FPS).toFixed(2), np: +w.f.night.np.toFixed(2), nightVisFrames: w.f.night.nightVis } : null,
    multiCactus: w.f.multi ? { serial: w.f.multi.r.serial, n: w.f.multi.r.n, large: w.f.multi.r.type === 1, at: +((w.f.multi.mid - w.n0) / FPS).toFixed(2) } : null,
    timeline: describe(G, R, w)
  };
}

function evalSeed(G, seed, W) {
  var R = simulateSeed(G, seed, W);
  var ws = bestWindows(R);
  if (!ws.length) return null;
  return summarize(G, R, ws[0]);
}

// ---- CLI / workers -----------------------------------------------------------------------------------------------

function argv(name, def) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  var v = process.argv[i + 1];
  return v == null || v.slice(0, 2) === '--' ? true : v;
}

function runRange(seeds) {
  var G = lib.loadGame(), W = lib.viewWidth(G.cfg, VIEW.width, VIEW.height), out = [];
  seeds.forEach(function (s) { var r = evalSeed(G, s, W); if (r) out.push(r); });
  return out;
}

function main() {
  var wt = require('worker_threads');
  if (!wt.isMainThread) { wt.parentPort.postMessage(runRange(wt.workerData.seeds)); return; }
  var G = lib.loadGame(), cfg = G.cfg, W = lib.viewWidth(cfg, VIEW.width, VIEW.height);
  if (G.metrics.source.dino !== 'manifest' || G.metrics.source.cactus !== 'manifest' || G.metrics.source.ptero !== 'manifest') {
    console.warn('warning: sprite metrics not all from the manifest: ' + JSON.stringify(G.metrics.source));
  }
  var one = argv('seed', null);
  if (one != null) {
    var r = evalSeed(G, Number(one) >>> 0, W);
    console.log(r ? JSON.stringify(r, null, 2) : 'seed ' + one + ': no window satisfies the hard requirements');
    return;
  }
  var from = Number(argv('from', 1)), to = Number(argv('to', 2000)), top = Number(argv('top', 3));
  var nW = Math.max(1, Number(argv('workers', Math.max(1, require('os').cpus().length - 1))));
  var outFile = argv('out', path.join(__dirname, 'plan.json'));
  var seeds = [];
  for (var s = from; s <= to; s++) seeds.push(s);
  var chunks = [];
  for (var i = 0; i < nW; i++) chunks.push([]);
  seeds.forEach(function (sd, j) { chunks[j % nW].push(sd); });
  var t0 = Date.now();
  Promise.all(chunks.filter(function (c) { return c.length; }).map(function (c) {
    return new Promise(function (res, rej) {
      var w = new wt.Worker(__filename, { workerData: { seeds: c } });
      w.once('message', res);
      w.once('error', rej);
    });
  })).then(function (parts) {
    var all = [].concat.apply([], parts);
    all.sort(function (a, b) { return b.score - a.score || b.mainFrames - a.mainFrames || a.seed - b.seed; });
    var hist = {};
    all.forEach(function (c) { var k = Math.floor(c.score); hist[k] = (hist[k] || 0) + 1; });
    console.log('W = ' + W + 'u at ' + VIEW.width + 'x' + VIEW.height + '; searched seeds ' + from + '..' + to + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) +
      ' s; ' + all.length + ' seeds have a valid window; score histogram ' + JSON.stringify(hist));
    var best = all.slice(0, top);
    best.forEach(function (c, j) {
      console.log('\n#' + (j + 1) + ' seed ' + c.seed + '  score ' + c.score + '  ' + JSON.stringify(c.parts));
      console.log('   ?sim=' + c.mainStartMs + ' (tick ' + c.startTick + ')  botOff tick ' + c.botOffTick + '  crash tick ' + c.crashTick + '  main ' + c.mainSeconds + ' s  final ' + c.finalScore + '  hi ' + c.hi);
      c.timeline.forEach(function (l) { console.log('   ' + l); });
    });
    if (!best.length) { console.error('no candidate'); process.exitCode = 1; return; }
    var b = best[0];
    var q = function (extra) { return 'index.html?seed=' + b.seed + '&bot=1' + extra + '&freeze=1&lang=' + LANG + '&hi=' + b.hi + '&share=1'; };
    var plan = {
      generatedBy: 'tools/record/plan.js --from ' + from + ' --to ' + to,
      gameVersion: cfg.VERSION,
      viewport: { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, playfieldW: W },
      fps: FPS,
      lang: LANG,
      hi: b.hi,
      intro: {
        seed: b.seed, frames: INTRO_FRAMES, autoStartTick: 47,
        url: q(''),
        note: 'frame j shows sim.tick === j; the bot presses start on the step from tick 46 (main.js: sim.tick > 45), so frame 47 is the first running frame (the start press is also a jump)'
      },
      xfadeFrames: XFADE_FRAMES,
      main: {
        seed: b.seed, startTick: b.startTick, mainStartMs: b.mainStartMs, botOffTick: b.botOffTick, botOffMs: b.botOffMs,
        crashTick: b.crashTick, crashMs: b.crashMs, holdFrames: b.holdFrames, endTick: b.endTick, endMs: b.endMs, frames: b.mainFrames,
        // poster suggestion: the night pterodactyl ~0.2 s before it meets the dino (main frame index)
        posterFrame: b.nightPtero ? Math.round(b.nightPtero.at * FPS) - 12 : null,
        url: q('&sim=' + b.mainStartMs),
        finalScore: b.finalScore, crashSerial: b.crash.serial,
        note: 'frame j shows sim.tick === startTick + j; disable the bot before the step that starts at sim.tick === botOffTick'
      },
      totalFrames: INTRO_FRAMES + b.mainFrames - XFADE_FRAMES,
      totalSeconds: +((INTRO_FRAMES + b.mainFrames - XFADE_FRAMES) / FPS).toFixed(3),
      candidates: best
    };
    fs.writeFileSync(outFile, JSON.stringify(plan, null, 2) + '\n');
    console.log('\nwrote ' + path.relative(process.cwd(), outFile) + ' (seed ' + b.seed + ', ' + plan.totalSeconds + ' s total)');
  }).catch(function (e) { console.error(e); process.exitCode = 1; });
}

module.exports = {
  VIEW: VIEW, FPS: FPS, LANG: LANG, INTRO_FRAMES: INTRO_FRAMES, XFADE_FRAMES: XFADE_FRAMES,
  simulateSeed: simulateSeed, bestWindows: bestWindows, evalSeed: evalSeed, crashTest: crashTest, EV_NAMES: EV_NAMES
};

if (require.main === module || !require('worker_threads').isMainThread) main();
