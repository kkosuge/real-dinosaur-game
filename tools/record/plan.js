#!/usr/bin/env node
/* Plan the X gameplay video (docs/video/real-dinosaur-game-x.mp4): pick the seed, the main segment's time window and
 * (day / early story) the recording-only night length.
 *
 *   node tools/record/plan.js                              # early story, seeds 1..2000 -> tools/record/plan.json, prints the top 3
 *   node tools/record/plan.js --from 1 --to 3000 --top 5 --out /tmp/plan.json --workers 8
 *   node tools/record/plan.js --seed 123                   # one seed: its best window (writes nothing)
 *   node tools/record/plan.js --night-ms 5000              # one fixed night length (default: 4100..7000 ms)
 *   node tools/record/plan.js --story day --lang ja        # the second video's story (exactly 20.0 s, dusk at 7.6 s)
 *   node tools/record/plan.js --story night --lang ja      # the first video's story (crash at night, 12 s night)
 *
 * Options: --lang en|ja (UI language of the recorded pages, default en: "Press Space to play", "GAME OVER", "Share";
 * the HUD digits are the same in both), --intro-frames N (early story: intro length incl. the crossfade, default
 * 150), --night-on-at A,B (early story: the 700 milestone / NIGHT_ON window in VIDEO seconds, default 3.6,4.4).
 *
 * The video = intro (idle start screen with the start hint, the bot's auto-start, ~1.7 s of running)
 * + a 0.4 s crossfade + the main segment: ONE continuous deterministic run, recorded frame by frame from a
 * `?seed=S&bot=1&sim=MS&freeze=1&lang=L&hi=N&share=1` page (MS = mainStartMs: the page fast-forwards the bot run
 * to that running time before its first frame).
 *
 * Early story (default, the third video; free length, no padding; the GAME OVER is in daylight):
 *   the intro -> the main segment starts at score ~670-690, a short day part with (ideally) a jump -> the 700
 *   milestone blink + chime and the dusk (NIGHT_ON) 3.6-4.4 s after the video's FIRST frame (counting the intro)
 *   -> a SHORT full night with a pterodactyl -> dawn -> >= 1.5 s of full daylight (a pterodactyl there is a plus)
 *   -> bot off -> the dino runs into a cactus in full daylight -> the day-theme GAME OVER, restart icon and share
 *   button -> a 2.0 s hold. The video ends there: its length is whatever that story takes (about 14-17 s).
 *   Uses the day story's machinery (the recording-only NIGHT_DURATION override, nightTrack, confirmDay).
 *
 * Day story (--story day, the second video; exactly TOTAL_FRAMES = 1200 frames = 20.0 s, GAME OVER in daylight):
 *   late day (score ~560-690) with a pterodactyl (+ ideally a multi-cactus jump) -> the 700 milestone blink + chime
 *   -> dusk -> a SHORT full night (moon, stars, Milky Way) with a pterodactyl -> dawn -> >= 1.5 s of full daylight
 *   -> the bot stops acting at botOffTick -> the dino runs into a cactus in full daylight (night phase exactly 0)
 *   -> ゲームオーバー, restart icon and the シェア button in the day theme -> a 1.6-2.2 s hold.
 *   The game's night lasts NIGHT_DURATION = 12 s from the 700 trigger (incl. the 2.6 s dusk fade), then a 2.6 s
 *   dawn: too long for 20 s. The night cycle is purely visual (sim.js: no obstacle, physics, bot or RNG code reads
 *   it), so for the VIDEO ONLY the recorder shortens it: after the main page has loaded and fast-forwarded (?sim=
 *   stops before score 700) and before the first step it sets the page's RDG.config.NIGHT_DURATION (= sim.cfg) to
 *   the planned nightDurationMs (plan.json main.nightDurationMs; lib.Game opts.nightDurationMs does the same here).
 *   The shipped game (src/) keeps its 12 s night. Since the night does not change the run, each seed's bot run is
 *   simulated once and the night phase of every candidate length is replayed exactly (nightTrack, checked against
 *   the real sim), then the chosen candidates are replayed end to end with the override (confirmDay).
 *
 * Night story (--story night, the first video): late day with a pterodactyl -> 700 -> dusk -> full night with a
 *   pterodactyl -> bot off -> crash into a cactus at night -> GAME OVER; main segment 15.9-17 s, 12 s night.
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
 *     Video frame of main frame j = INTRO_FRAMES - XFADE_FRAMES + j (126 + j).
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
var LANG = 'en'; // default UI language of the recorded pages (--lang); the first two videos used 'ja'
var INTRO_FRAMES = 150; // 2.5 s: 46 idle frames, the auto-start press on the 47th tick, ~1.7 s of running (no obstacles)
var XFADE_FRAMES = 24; // 0.4 s intro -> main crossfade
var MAIN_OFFSET = INTRO_FRAMES - XFADE_FRAMES; // video frame of main frame 0
var INTRO_SEED = 909; // the intro of the first video (start screen -> auto-start; the seed hardly shows there)
var XFADE_QUIET = 30; // no obstacle crossing in the first 0.5 s (half hidden by the crossfade)
var MIN_VIS = 40; // a pterodactyl counts when on screen >= 40 frames (0.67 s) of the segment
var MAX_SIM_TICKS = 7200;

// night story (the first video)
var HOLD_MIN = 90, HOLD_MAX = 120; // GAME OVER hold 1.5-2 s (share button from gameOverTime >= 750 ms)
var MAIN_MIN = 954, MAIN_MAX = 1020; // main segment 15.9-17.0 s -> total (intro + main - xfade) 18.0-19.1 s
var RUN_MIN = MAIN_MIN - HOLD_MAX, RUN_MAX = MAIN_MAX - HOLD_MIN; // startTick -> crashTick
var SCORE0 = [590, 692]; // HUD score on the first main frame: late day
var MIN_700_LEAD = 150; // >= 2.5 s of day before the 700 milestone

// day story (default)
var TOTAL_FRAMES = 1200; // exactly 20.0 s
var DAY = {
  MAIN_FRAMES: TOTAL_FRAMES - MAIN_OFFSET, // 1074 main frames (the first 24 under the crossfade)
  HOLD: [96, 132], // crash frame .. last frame: 1.6-2.2 s (the share button shows from crash + 45 frames)
  HOLD_PREF: 120, // 2.0 s (the share button fully in view for ~1.2 s)
  SCORE0: [560, 692], // HUD score on the first main frame: late day
  LEAD: [150, 390], // the 700 milestone 2.5-6.5 s into the main segment
  DAYLIGHT_MIN: 90, // night phase exactly 0 on the last >= 90 ticks (1.5 s) up to the crash
  NIGHT_MS: [4100, 7000], NIGHT_STEP: 100, // candidate NIGHT_DURATION overrides: 1.5-4.4 s of full night
  NIGHT_PTERO_NP: 0.97 // the night pterodactyl crosses the dino at night phase >= 0.97
};

// early story (default): the dusk ~4 s into the video, free length
var EARLY = {
  NIGHT_ON_VIDEO: [3.6, 4.4], NIGHT_ON_PREF: 4.0, // the 700 milestone (= NIGHT_ON) in VIDEO seconds (counting the intro)
  SCORE0: [640, 699], // HUD score on the first main frame (just before the 700 milestone)
  DAY_GRACE: 12, // a day-part crossing may be up to 0.2 s after the milestone (night phase < 0.08: still day)
  HOLD: 120, // crash frame .. last frame: 2.0 s (the share button fully in view for ~1.2 s)
  DAYLIGHT_MIN: 90, // night phase exactly 0 on the last >= 90 ticks (1.5 s) up to the crash
  DAYLIGHT_PREF: 210, // more daylight than 3.5 s before the crash costs (no padding)
  DAYLIGHT_MAX: 360, // crash tests up to 6 s after full daylight returns
  NIGHT_PTERO_NP: 0.97
};

/** Canvas / DOM strings the video shows per language (render.js TEXT[lang].start / .keys / .over, i18n.js
 * 'share.button'); verify_plan.js checks the page's own strings against these. */
var UI_TEXT = {
  en: { start: 'Press Space to play', keys: 'Space / ↑ jump   ↓ duck   P pause   M mute', over: 'GAME OVER', share: 'Share' },
  ja: { start: 'スペースキーでスタート', keys: 'スペース / ↑ ジャンプ　↓ しゃがむ　P 一時停止　M 消音', over: 'ゲームオーバー', share: 'シェア' }
};

/** Per-run layout of the video (story, UI language, intro length) from the CLI options (also passed to the workers). */
function videoParams(story, opts) {
  opts = opts || {};
  var lang = String(opts.lang || LANG);
  if (!UI_TEXT[lang]) throw new Error('--lang en|ja');
  var intro = story === 'early' && opts.introFrames != null ? Number(opts.introFrames) : INTRO_FRAMES;
  if (!(intro >= XFADE_FRAMES + 60 && intro <= 240)) throw new Error('--intro-frames ' + intro);
  var on = EARLY.NIGHT_ON_VIDEO;
  if (opts.nightOnAt) on = String(opts.nightOnAt).split(',').map(Number);
  return {
    story: story, lang: lang, text: UI_TEXT[lang], introFrames: intro, mainOffset: intro - XFADE_FRAMES,
    nightOnVideo: on, nightOnPref: opts.nightOnAt ? (on[0] + on[1]) / 2 : EARLY.NIGHT_ON_PREF
  };
}

var ALT = ['LOW', 'MID', 'HIGH'];
var EV_NAMES = ['', 'START', 'JUMP', 'LAND', 'FASTDROP', 'MILESTONE', 'CRASH', 'NIGHT_ON', 'NIGHT_OFF', 'SPAWN'];

function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
function fadeTicks(cfg) { return Math.ceil(cfg.NIGHT_FADE / cfg.STEP_MS); }

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

/** From `pre` (the state before the step at botOffTick): press nothing. Where does the dino crash? (a clone) */
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
  res.np = c.nightPhase; // (with the shipped 12 s night; the day story replays the night phase per length)
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

/**
 * The bot run of one seed (shipped config, no override) with per-tick facts and obstacle tracks, plus a crash test
 * at every bot plan start (= a possible botOffTick): night story while the night is active, day story from where a
 * daylight crash after the shortest planned night is possible up to the latest crash a 1074-frame segment can hold.
 */
function simulateSeed(G, seed, W, story) {
  var Sim = G.Sim, M = G.metrics, D = M.dino, EV = Sim.EV, ANIM = Sim.ANIM, ST = Sim.STATUS, OT = Sim.OT, cfg = G.cfg;
  var day = story === 'day' || story === 'early'; // (the early story is a day story with a short day part)
  var visX = pteroVisX(G);
  var R = {
    seed: seed, W: W, story: story === 'early' ? 'early' : day ? 'day' : 'night', score: [], np: [], air: [], duck: [], speed: [], ev: [], obs: new Map(), plans: [], tests: [],
    t700: -1, nightOn: -1, fullNight: -1, nightOff: -1, botCrash: -1
  };
  var testFrom = Math.ceil(DAY.NIGHT_MS[0] / cfg.STEP_MS) + fadeTicks(cfg) + DAY.DAYLIGHT_MIN - 60; // ticks after NIGHT_ON
  var simAfter = story === 'early'
    ? Math.ceil(DAY.NIGHT_MS[1] / cfg.STEP_MS) + fadeTicks(cfg) + EARLY.DAYLIGHT_MAX + 10 // longest night + dawn + daylight
    : DAY.MAIN_FRAMES - DAY.HOLD[0] - DAY.LEAD[0] + 10; // the latest crash tick - NIGHT_ON (+ margin)
  var seenPlan = '', testedStart = -1;
  var game = new lib.Game(G, {
    seed: seed, started: true,
    beforeStep: function (sim, inp, g) {
      var pl = g.bot.plan;
      if (!g.botEnabled || !pl.active) return;
      var key = pl.start + ':' + pl.target + ':' + pl.p;
      if (key !== seenPlan) { seenPlan = key; R.plans.push({ tick: sim.tick, start: pl.start, p: pl.p, name: Sim.PLANS[pl.p].name, target: pl.target }); }
      // the bot presses for this plan on this very tick: a botOff here = the dino never acts on `target`
      var testNow = day ? R.nightOn >= 0 && sim.tick >= R.nightOn + testFrom : sim.nightActive;
      if (pl.start === sim.tick && testedStart !== pl.start && pl.target >= 0 && testNow) {
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
    if (!day && R.nightOff >= 0 && game.sim.tick > R.nightOff + 30) break;
    if (day && R.nightOn >= 0 && game.sim.tick > R.nightOn + simAfter) break;
  }
  R.lastTick = game.sim.tick;
  R.botStats = { decisions: game.bot.decisions, degraded: game.bot.degraded, fails: game.bot.fails };
  return R;
}

/**
 * The night phase per tick of the bot run R with NIGHT_DURATION = nightMs from the first NIGHT_ON (sim.js step():
 * the night timer, then the fade toward the target, on every running tick). Exact: with the shipped duration it
 * reproduces R.np bit for bit (checked in bestWindowsDay). cnt[k]: ticks <= k at night phase >= 0.9.
 *   fullNight: first tick at phase 1; nightOff: the NIGHT_OFF tick (dawn starts); dayFrom: first tick back at 0.
 */
function nightTrack(G, R, nightMs) {
  var c = G.cfg, n = R.lastTick + 1, np = new Float64Array(n), cnt = new Int32Array(n);
  var active = false, timer = 0, ph = 0, dp = c.STEP_MS / c.NIGHT_FADE, off = -1, full = -1, dayFrom = -1, k;
  for (k = 0; k < n; k++) {
    if (k === R.nightOn) { active = true; timer = 0; }
    else if (active) { timer += c.STEP_MS; if (timer >= nightMs) { active = false; off = k; } }
    var target = active ? 1 : 0;
    if (ph < target) ph = Math.min(target, ph + dp);
    else if (ph > target) ph = Math.max(target, ph - dp);
    np[k] = ph;
    cnt[k] = (k ? cnt[k - 1] : 0) + (ph >= 0.9 ? 1 : 0);
    if (R.nightOn >= 0 && k >= R.nightOn && full < 0 && ph >= 1) full = k;
    if (off >= 0 && dayFrom < 0 && ph === 0) dayFrom = k;
  }
  return { nightMs: nightMs, np: np, cnt: cnt, nightOn: R.nightOn, fullNight: full, nightOff: off, dayFrom: dayFrom };
}

// ---- window scoring ----------------------------------------------------------------------------------------------

function obsLabel(r) {
  if (r.type === 2) return 'ptero ' + ALT[r.alt] + (r.so > 0 ? ' (fast)' : ' (slow)');
  return r.n + 'x ' + (r.type === 1 ? 'large' : 'small') + ' cactus';
}
function actionOf(r) { return r.ducked ? 'duck' : r.jumped ? 'jump' : 'under'; }
function overlap(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0) + 1); }
function act(it) {
  var r = it.r;
  if (r.alt === 1 && it.action === 'duck') return 0.6;
  if (r.alt === 0 && it.action === 'jump') return 0.5;
  if (r.alt === 1) return 0.3;
  return 0;
}
function visB(n) { return n >= 50 ? 0.2 : n >= 35 ? 0.1 : 0; }

/**
 * Night story: score one window (0-10): main segment starts at n0, the bot stops at t.botOffTick, the crash is at
 * t.crashTick, then `hold` GAME OVER frames. Hard requirements are checked by the caller; this ranks what the viewer sees.
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

/**
 * Day story: score one window, or null when a hard requirement fails. tr = nightTrack for the window's night length.
 * Hard (besides the caller's: the intended cactus hit on the ground, daylight on the last >= 1.5 s, exact length):
 *   a pterodactyl crossing the dino before the 700 milestone (full day), on screen >= 40 frames, after the crossfade;
 *   a pterodactyl crossing at night phase >= 0.97, on screen >= 40 frames at night phase >= 0.9; both before botOff.
 * Ranking (roughly 0-10):
 *   base 1.6; day / night pterodactyl 2.0 + action + frames fully on screen (as in the night story); variety 0.2;
 *   multi-cactus jump 0.5-0.8; crash obstacle <= 0.4 (large, a group, the dead pose touching it)
 *   short night: 2.2-3.0 s of full night 0.4, 1.9-2.2 s 0.3, shorter 0.15, longer -0.25 per s -- a quick dawn, but
 *     long enough to show the night version
 *   deep night pterodactyl: crossing >= 1/3 s before the dawn starts 0.1, >= 90 % of its frames on screen at night
 *     phase >= 0.9 0.1
 *   day again: an encounter after dawn at night phase < 0.2 0.1, a pterodactyl there 0.15 (0.2 in full daylight)
 *   daylight >= 2 s before the crash 0.1; GAME OVER hold >= 1.75 s 0.05; a clean GAME OVER frame (nothing else on
 *   screen) 0.05; a small crash-pose shift (<= 8u) 0.05; the multi-cactus jump in daylight 0.05
 *   extra pterodactyls on screen 0.1 each (max 0.3), encounters 0.03 each (max 0.3), 700 milestone 3-5.5 s in 0.2,
 *   no crossing during the crossfade 0.1, isolated day / night pterodactyl 0.1 each, another pterodactyl in the
 *   dusk / dawn light 0.1, their frames on screen / 2000 (<= 0.1)
 *   penalties: the cactus it hits on screen < 0.6 s before the crash -0.5; an obstacle cut by the screen edge frozen
 *   through the GAME OVER hold -0.1 each
 */
function scoreDay(R, tr, t, n0, hold) {
  var crash = t.crashTick, off = t.botOffTick, np = tr.np, cnt = tr.cnt, i, k;
  function nightCount(a, b) {
    a = Math.max(a, n0); b = Math.min(b, crash);
    return b < a ? 0 : cnt[b] - (a > 0 ? cnt[a - 1] : 0);
  }
  var items = [];
  R.obs.forEach(function (r) {
    if (r.serial === t.serial || r.crossFirst < 0) return;
    var mid = (r.crossFirst + r.crossLast) >> 1;
    if (mid < n0 || mid > crash) return;
    items.push({
      r: r, mid: mid, np: np[mid],
      vis: r.visFirst < 0 ? 0 : overlap(r.visFirst, r.visLast, n0, crash),
      full: r.fullFirst < 0 ? 0 : overlap(r.fullFirst, r.fullLast, n0, crash),
      nightVis: r.visFirst < 0 ? 0 : nightCount(r.visFirst, r.visLast),
      nightFull: r.fullFirst < 0 ? 0 : nightCount(r.fullFirst, r.fullLast),
      action: actionOf(r), afterOff: mid >= off
    });
  });
  items.sort(function (a, b) { return a.mid - b.mid; });
  var f = { day: null, night: null, dawn: null, multi: null, pteros: 0, encounters: 0, quietStart: true, dayAgain: 0, parts: {} };
  var dayS = 0, nightS = 0, multiS = 0, dawnS = 0;
  for (i = 0; i < items.length; i++) {
    var it = items[i], r = it.r;
    if (it.mid < n0 + XFADE_QUIET) f.quietStart = false;
    if (!it.afterOff && (it.action !== 'under' || r.type !== 2)) f.encounters++;
    var early = it.mid < n0 + XFADE_QUIET || it.afterOff;
    var afterDawn = !early && tr.nightOff >= 0 && it.mid > tr.nightOff && it.np < 0.2;
    if (afterDawn && (it.action !== 'under' || r.type !== 2)) f.dayAgain = Math.max(f.dayAgain, 0.1);
    if (r.type === 2) {
      if (it.vis >= MIN_VIS) f.pteros++;
      if (early) continue;
      if (it.mid < R.t700 && it.vis >= MIN_VIS) { // full day, before the milestone
        var ds = 2.0 + act(it) + visB(it.full);
        if (ds > dayS) { dayS = ds; f.day = it; }
      } else if (it.np >= DAY.NIGHT_PTERO_NP && it.nightVis >= MIN_VIS) {
        var ns = 2.0 + act(it) + visB(it.nightFull);
        if (ns > nightS) { nightS = ns; f.night = it; }
      } else if (afterDawn && it.vis >= MIN_VIS) {
        var ws = 1 + act(it) + (it.np === 0 ? 0.5 : 0);
        if (ws > dawnS) { dawnS = ws; f.dawn = it; }
      }
    } else if (r.n >= 2 && it.action === 'jump' && !early) {
      var ms = r.n >= 3 ? (r.type === 1 ? 0.8 : 0.7) : (r.type === 1 ? 0.6 : 0.5);
      if (ms > multiS) { multiS = ms; f.multi = it; }
    }
  }
  if (!f.day || !f.night) return null;
  var variety = f.day.action !== f.night.action && f.day.action !== 'under' && f.night.action !== 'under' ? 0.2 : 0;
  var residual = t.gap == null ? 99 : t.gap + 2 - t.shift; // > 0: the dead pose stops short of the cactus
  var pose = residual <= 4 && t.shift > -12 ? 0.1 : 0;
  var crashS = (t.type === 1 ? 0.15 : 0) + (t.n >= 2 ? 0.15 : 0) + pose;
  if (f.dawn) f.dayAgain = f.dawn.np === 0 ? 0.2 : 0.15;
  var fullNightS = (tr.nightOff - tr.fullNight) / FPS; // seconds at night phase 1
  var shortNight = fullNightS < 1.9 ? 0.15 : fullNightS < 2.2 ? 0.3 : fullNightS <= 3.0 ? 0.4 : Math.max(0, 0.4 - 0.25 * (fullNightS - 3.0));
  var deep = (f.night.mid <= tr.nightOff - 20 ? 0.1 : 0) + (f.night.nightVis >= 0.9 * f.night.vis ? 0.1 : 0);
  var clean = t.others.length ? 0 : 0.05;
  var poseS = Math.abs(t.shift) <= 8 ? 0.05 : 0;
  var multiDay = f.multi && f.multi.np < 0.35 ? 0.05 : 0;
  var daylight = crash - tr.dayFrom; // ticks at night phase 0 up to the crash
  var daylightS = daylight >= 120 ? 0.1 : 0;
  var holdS = hold >= 105 ? 0.05 : 0;
  var used = 2 + (f.dawn ? 1 : 0);
  var extra = Math.min(0.3, Math.max(0, f.pteros - used) * 0.1);
  var density = Math.min(0.3, f.encounters * 0.03);
  var a = R.t700 - n0;
  var timing = a >= 180 && a <= 330 ? 0.2 : 0;
  var tgt = R.obs.get(t.serial);
  var tgtVis = tgt && tgt.visFirst >= 0 ? crash - Math.max(tgt.visFirst, n0) : 0;
  var framing = tgtVis >= 36 ? 0 : -0.5;
  var W = R.W, edge = 0;
  t.others.forEach(function (o) { var w = o.type === 2 ? 166 : 60 * o.n; if (o.x < 0 || o.x + w > W) edge -= 0.1; });
  function isolated(x) {
    if (!x) return 0;
    for (var j = 0; j < items.length; j++) if (items[j] !== x && Math.abs(items[j].mid - x.mid) < 30) return 0;
    return Math.abs(t.crashTick - x.mid) >= 30 ? 0.1 : 0;
  }
  var iso = isolated(f.day) + isolated(f.night);
  var dusk = 0;
  items.forEach(function (x) {
    if (x.r.type === 2 && x !== f.day && x !== f.night && x !== f.dawn && !x.afterOff && x.np >= 0.2 && x.np <= 0.9 && x.vis >= MIN_VIS) dusk = 0.1;
  });
  var frames = Math.min(0.1, (f.day.full + f.night.nightFull) / 2000);
  var base = 1.6;
  var score = base + dayS + nightS + variety + multiS + crashS + shortNight + deep + f.dayAgain + daylightS + holdS + clean + poseS + multiDay +
    extra + density + timing + (f.quietStart ? 0.1 : 0) + iso + dusk + frames + framing + edge;
  f.parts = {
    base: base, dayPtero: dayS, nightPtero: nightS, variety: variety, multiCactus: multiS, crashObstacle: crashS,
    shortNight: shortNight, deepNightPtero: deep, dayAgain: f.dayAgain, daylight: daylightS, hold: holdS, cleanGameOver: clean,
    smallPoseShift: poseS, multiInDay: multiDay,
    extraPteros: extra, encounters: density, timing700: timing, quietStart: f.quietStart ? 0.1 : 0,
    isolation: iso, duskPtero: dusk, pteroFrames: frames, framing: framing, edge: edge
  };
  for (k in f.parts) f.parts[k] = Math.round(f.parts[k] * 100) / 100;
  return { score: Math.round(score * 1000) / 1000, n0: n0, hold: hold, items: items, f: f, targetVis: tgtVis, fullNightSeconds: fullNightS, daylight: daylight };
}

/**
 * Early story: score one window, or null when a hard requirement fails. tr = nightTrack for the window's night length,
 * P = videoParams (mainOffset: the video frame of main frame 0). Hard (besides the caller's: the 700 milestone at
 * 3.6-4.4 s of video time, the intended cactus hit on the ground, daylight on the last >= 1.5 s):
 *   a pterodactyl crossing the dino at night phase >= 0.97, on screen >= 40 frames at night phase >= 0.9, before botOff.
 * Ranking (roughly 0-10):
 *   base 1.6; night pterodactyl 2.0 + action + frames fully on screen (as in the day story)
 *   day part (after the crossfade, up to the milestone): the dino jumps a cactus 0.8 (+0.2 a group, +0.1 large), or
 *     meets a pterodactyl 1.2 + action; +0.1 when it happens >= 0.25 s after the crossfade (clearly in view)
 *   back in the day: a pterodactyl after dawn at night phase < 0.2 1.0 + action (+0.3 in full daylight); another
 *     encounter there 0.1
 *   variety: the night pterodactyl and a day one met with different actions (jump + duck) 0.2
 *   multi-cactus jump anywhere 0.3-0.5; crash obstacle <= 0.4 (large, a group, the dead pose touching it)
 *   short night 0.15-0.4 (2.2-3.0 s of full night best), deep night pterodactyl <= 0.2 (as in the day story)
 *   the 700 milestone near 4.0 s of video time <= 0.3; no crossing in the crossfade 0.15, the dino on the ground
 *     through the crossfade 0.15 (no ghost jump)
 *   daylight >= 2 s before the crash 0.1, more than 3.5 s -0.15 per s (no padding); a clean GAME OVER 0.05; small
 *     crash-pose shift 0.05; extra pterodactyls 0.1 each (max 0.3); encounters 0.03 each (max 0.3); isolated night /
 *     dawn pterodactyl 0.1 each; another pterodactyl in the dusk / dawn light 0.1; frames on screen / 2000 (<= 0.1)
 *   penalties: the cactus it hits on screen < 0.6 s before the crash -0.5; an obstacle cut by the screen edge frozen
 *     through the GAME OVER hold -0.1 each
 */
function scoreEarly(R, tr, t, n0, hold, P) {
  var crash = t.crashTick, off = t.botOffTick, np = tr.np, cnt = tr.cnt, xfEnd = n0 + XFADE_FRAMES, i, k;
  function nightCount(a, b) {
    a = Math.max(a, n0); b = Math.min(b, crash);
    return b < a ? 0 : cnt[b] - (a > 0 ? cnt[a - 1] : 0);
  }
  var items = [];
  R.obs.forEach(function (r) {
    if (r.serial === t.serial || r.crossFirst < 0) return;
    var mid = (r.crossFirst + r.crossLast) >> 1;
    if (mid < n0 || mid > crash) return;
    items.push({
      r: r, mid: mid, np: np[mid],
      vis: r.visFirst < 0 ? 0 : overlap(r.visFirst, r.visLast, n0, crash),
      visAfterXf: r.visFirst < 0 ? 0 : overlap(r.visFirst, r.visLast, xfEnd, crash),
      full: r.fullFirst < 0 ? 0 : overlap(r.fullFirst, r.fullLast, n0, crash),
      nightVis: r.visFirst < 0 ? 0 : nightCount(r.visFirst, r.visLast),
      nightFull: r.fullFirst < 0 ? 0 : nightCount(r.fullFirst, r.fullLast),
      action: actionOf(r), afterOff: mid >= off
    });
  });
  items.sort(function (a, b) { return a.mid - b.mid; });
  var f = { day: null, dayJump: null, night: null, dawn: null, multi: null, pteros: 0, encounters: 0, quietStart: true, dayAgain: 0, parts: {} };
  var dayS = 0, nightS = 0, multiS = 0, dawnS = 0;
  for (i = 0; i < items.length; i++) {
    var it = items[i], r = it.r;
    if (it.mid < n0 + XFADE_QUIET) f.quietStart = false;
    if (!it.afterOff && (it.action !== 'under' || r.type !== 2)) f.encounters++;
    var early = it.mid < n0 + XFADE_QUIET || it.afterOff;
    var inDay = !early && it.mid <= R.t700 + EARLY.DAY_GRACE; // the short day part
    var afterDawn = !early && tr.nightOff >= 0 && it.mid > tr.nightOff && it.np < 0.2;
    var clear = it.mid >= xfEnd + 15 ? 0.1 : 0;
    if (afterDawn && (it.action !== 'under' || r.type !== 2)) f.dayAgain = Math.max(f.dayAgain, 0.1);
    if (r.type === 2) {
      if (it.vis >= MIN_VIS) f.pteros++;
      if (early) continue;
      if (inDay && it.visAfterXf >= 30) {
        var dp = 1.2 + act(it) + clear;
        if (dp > dayS) { dayS = dp; f.day = it; f.dayJump = it; }
      } else if (it.np >= EARLY.NIGHT_PTERO_NP && it.nightVis >= MIN_VIS) {
        var ns = 2.0 + act(it) + visB(it.nightFull);
        if (ns > nightS) { nightS = ns; f.night = it; }
      } else if (afterDawn && it.vis >= MIN_VIS) {
        var ws = 1.0 + act(it) + (it.np === 0 ? 0.3 : 0);
        if (ws > dawnS) { dawnS = ws; f.dawn = it; }
      }
    } else if (!early) {
      if (inDay && it.action === 'jump') {
        var dj = 0.8 + (r.n >= 2 ? 0.2 : 0) + (r.type === 1 ? 0.1 : 0) + clear;
        if (dj > dayS) { dayS = dj; f.dayJump = it; f.day = null; }
      }
      if (r.n >= 2 && it.action === 'jump') {
        var ms = r.n >= 3 ? (r.type === 1 ? 0.5 : 0.45) : (r.type === 1 ? 0.35 : 0.3);
        if (ms > multiS) { multiS = ms; f.multi = it; }
      }
    }
  }
  if (!f.night) return null;
  var dayP = f.day || f.dawn;
  var variety = dayP && dayP.action !== f.night.action && dayP.action !== 'under' && f.night.action !== 'under' ? 0.2 : 0;
  var residual = t.gap == null ? 99 : t.gap + 2 - t.shift; // > 0: the dead pose stops short of the cactus
  var pose = residual <= 4 && t.shift > -12 ? 0.1 : 0;
  var crashS = (t.type === 1 ? 0.15 : 0) + (t.n >= 2 ? 0.15 : 0) + pose;
  var fullNightS = (tr.nightOff - tr.fullNight) / FPS;
  var shortNight = fullNightS < 1.9 ? 0.15 : fullNightS < 2.2 ? 0.3 : fullNightS <= 3.0 ? 0.4 : Math.max(0, 0.4 - 0.25 * (fullNightS - 3.0));
  var deep = (f.night.mid <= tr.nightOff - 20 ? 0.1 : 0) + (f.night.nightVis >= 0.9 * f.night.vis ? 0.1 : 0);
  var clean = t.others.length ? 0 : 0.05;
  var poseS = Math.abs(t.shift) <= 8 ? 0.05 : 0;
  var daylight = crash - tr.dayFrom;
  var daylightS = (daylight >= 120 ? 0.1 : 0) - Math.max(0, daylight - EARLY.DAYLIGHT_PREF) / FPS * 0.15;
  var used = 1 + (f.day ? 1 : 0) + (f.dawn ? 1 : 0);
  var extra = Math.min(0.3, Math.max(0, f.pteros - used) * 0.1);
  var density = Math.min(0.3, f.encounters * 0.03);
  var onAt = (P.mainOffset + R.t700 - n0) / FPS; // video seconds of the milestone / NIGHT_ON
  var half = (P.nightOnVideo[1] - P.nightOnVideo[0]) / 2;
  var timing = 0.3 * Math.max(0, 1 - Math.abs(onAt - P.nightOnPref) / half);
  var ground = true;
  for (k = n0; k <= xfEnd; k++) if (R.air[k]) { ground = false; break; }
  var tgt = R.obs.get(t.serial);
  var tgtVis = tgt && tgt.visFirst >= 0 ? crash - Math.max(tgt.visFirst, n0) : 0;
  var framing = tgtVis >= 36 ? 0 : -0.5;
  var W = R.W, edge = 0;
  t.others.forEach(function (o) { var w = o.type === 2 ? 166 : 60 * o.n; if (o.x < 0 || o.x + w > W) edge -= 0.1; });
  function isolated(x) {
    if (!x) return 0;
    for (var j = 0; j < items.length; j++) if (items[j] !== x && Math.abs(items[j].mid - x.mid) < 30) return 0;
    return Math.abs(t.crashTick - x.mid) >= 30 ? 0.1 : 0;
  }
  var iso = isolated(f.night) + isolated(f.dawn);
  var dusk = 0;
  items.forEach(function (x) {
    if (x.r.type === 2 && x !== f.day && x !== f.night && x !== f.dawn && !x.afterOff && x.np >= 0.2 && x.np <= 0.9 && x.vis >= MIN_VIS) dusk = 0.1;
  });
  var frames = Math.min(0.1, (f.night.nightFull + (f.dawn ? f.dawn.full : 0)) / 2000);
  var base = 1.6;
  var score = base + nightS + dayS + dawnS + f.dayAgain + variety + multiS + crashS + shortNight + deep + daylightS + clean + poseS +
    extra + density + timing + (f.quietStart ? 0.15 : 0) + (ground ? 0.15 : 0) + iso + dusk + frames + framing + edge;
  f.parts = {
    base: base, nightPtero: nightS, dayPart: dayS, dawnPtero: dawnS, dayAgain: f.dayAgain, variety: variety, multiCactus: multiS,
    crashObstacle: crashS, shortNight: shortNight, deepNightPtero: deep, daylight: daylightS, cleanGameOver: clean, smallPoseShift: poseS,
    extraPteros: extra, encounters: density, timing700: timing, quietStart: f.quietStart ? 0.15 : 0, groundInXfade: ground ? 0.15 : 0,
    isolation: iso, duskPtero: dusk, pteroFrames: frames, framing: framing, edge: edge
  };
  for (k in f.parts) f.parts[k] = Math.round(f.parts[k] * 100) / 100;
  return { score: Math.round(score * 1000) / 1000, n0: n0, hold: hold, items: items, f: f, targetVis: tgtVis, fullNightSeconds: fullNightS, daylight: daylight, nightOnVideo: onAt };
}

/** The night lengths the day story tries (ms, NIGHT_DURATION overrides). */
function nightLengths(opts) {
  opts = opts || {};
  if (opts.nightMs != null) return [Number(opts.nightMs)];
  var lo = Number(opts.nightMin != null ? opts.nightMin : DAY.NIGHT_MS[0]), hi = Number(opts.nightMax != null ? opts.nightMax : DAY.NIGHT_MS[1]);
  var st = Number(opts.nightStep != null ? opts.nightStep : DAY.NIGHT_STEP), out = [];
  for (var v = lo; v <= hi + 1e-9; v += st) out.push(v);
  return out;
}

/** Day story: the best window of every (crash test, night length) of one seed, best first. */
function bestWindowsDay(G, R, opts) {
  var out = [];
  if (R.botCrash >= 0 || R.t700 < 0 || R.nightOn !== R.t700) return out;
  // the night replay must reproduce the real sim's night phase (shipped length) bit for bit
  var chk = nightTrack(G, R, G.defaults.NIGHT_DURATION);
  for (var k = 0; k <= R.lastTick; k++) if (chk.np[k] !== R.np[k]) throw new Error('seed ' + R.seed + ': nightTrack differs from the sim at tick ' + k);
  // ending: the intended cactus (not a pterodactyl), hit while running on the ground
  var tests = R.tests.filter(function (t) { return t.crashTick >= 0 && t.intended && t.type !== 2 && t.rise <= 0.5; });
  if (!tests.length) return out;
  var MF = DAY.MAIN_FRAMES;
  nightLengths(opts).forEach(function (nightMs) {
    var tr = nightTrack(G, R, nightMs);
    if (tr.nightOff < 0 || tr.dayFrom < 0) return;
    tests.forEach(function (t) {
      if (tr.dayFrom > t.crashTick - DAY.DAYLIGHT_MIN || tr.nightOff >= t.botOffTick) return; // daylight crash
      var best = null;
      for (var hold = DAY.HOLD[0]; hold <= DAY.HOLD[1]; hold++) {
        var run = MF - hold, n0 = t.crashTick - run;
        if (n0 < 1) continue;
        var s0 = R.score[n0], lead = R.t700 - n0;
        if (s0 < DAY.SCORE0[0] || s0 > DAY.SCORE0[1] || lead < DAY.LEAD[0] || lead > DAY.LEAD[1]) continue;
        var w = scoreDay(R, tr, t, n0, hold);
        if (!w) continue;
        w.test = t; w.tr = tr; w.run = run; w.main = MF;
        // ties: the hold nearer 2 s, the 700 milestone nearer 4 s, the shorter night
        w.rank = w.score - Math.abs(hold - DAY.HOLD_PREF) * 1e-5 - Math.abs(lead - 240) * 1e-6 - nightMs * 1e-9;
        if (!best || w.rank > best.rank) best = w;
      }
      if (best) out.push(best);
    });
  });
  out.sort(function (a, b) { return b.rank - a.rank; });
  return out;
}

/**
 * Early story: the best window of every (crash test, night length) of one seed, best first. The main segment starts
 * so that the 700 milestone falls at P.nightOnVideo (video seconds); it ends EARLY.HOLD frames after the crash.
 */
function bestWindowsEarly(G, R, opts, P) {
  var out = [];
  if (R.botCrash >= 0 || R.t700 < 0 || R.nightOn !== R.t700) return out;
  var chk = nightTrack(G, R, G.defaults.NIGHT_DURATION);
  for (var k = 0; k <= R.lastTick; k++) if (chk.np[k] !== R.np[k]) throw new Error('seed ' + R.seed + ': nightTrack differs from the sim at tick ' + k);
  var tests = R.tests.filter(function (t) { return t.crashTick >= 0 && t.intended && t.type !== 2 && t.rise <= 0.5; });
  if (!tests.length) return out;
  var lead0 = Math.ceil(P.nightOnVideo[0] * FPS - 1e-9) - P.mainOffset, lead1 = Math.floor(P.nightOnVideo[1] * FPS + 1e-9) - P.mainOffset;
  var hold = EARLY.HOLD;
  nightLengths(opts).forEach(function (nightMs) {
    var tr = nightTrack(G, R, nightMs);
    if (tr.nightOff < 0 || tr.dayFrom < 0) return;
    tests.forEach(function (t) {
      // a daylight crash after >= 1.5 s of full day, the bot still on through the dawn, no long wait
      if (tr.dayFrom > t.crashTick - EARLY.DAYLIGHT_MIN || tr.nightOff >= t.botOffTick || t.crashTick - tr.dayFrom > EARLY.DAYLIGHT_MAX) return;
      var best = null;
      for (var lead = lead0; lead <= lead1; lead++) {
        var n0 = R.t700 - lead;
        if (n0 < 1) continue;
        var s0 = R.score[n0];
        if (s0 < EARLY.SCORE0[0] || s0 > EARLY.SCORE0[1]) continue;
        var w = scoreEarly(R, tr, t, n0, hold, P);
        if (!w) continue;
        w.test = t; w.tr = tr; w.run = t.crashTick - n0; w.main = w.run + hold;
        // ties: the milestone nearer 4 s, the shorter video, the shorter night
        w.rank = w.score - Math.abs(w.nightOnVideo - P.nightOnPref) * 1e-4 - w.main * 1e-7 - nightMs * 1e-10;
        if (!best || w.rank > best.rank) best = w;
      }
      if (best) out.push(best);
    });
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

/** Day / early story timeline, in VIDEO seconds (main-segment seconds in brackets). P = videoParams (default: the
 * day story's layout in Japanese, as in the second video). */
function describeDay(G, R, w, P) {
  P = P || videoParams('day', { lang: 'ja' });
  var t = w.test, tr = w.tr, n0 = w.n0, K = G.cfg.K, share = lib.shareDelayFrames(G.cfg), T = P.text, MO = P.mainOffset;
  function vs(k) { return ((MO + k - n0) / FPS).toFixed(2) + 's'; }
  function ts(k) { return vs(k) + ' [m ' + ((k - n0) / FPS).toFixed(2) + ']'; }
  var L = [
    '0.00s intro: start screen ("' + T.start + '" + "' + T.keys + '", HI ' + (t.score + 47) + ')',
    (47 / FPS).toFixed(2) + 's intro: the bot starts the run (jump)',
    (MO / FPS).toFixed(2) + 's-' + (P.introFrames / FPS).toFixed(2) + 's crossfade intro -> main'
  ];
  var marks = [];
  marks.push({ k: n0 - 0.5, s: ts(n0) + ' main start: score ' + R.score[n0] + ', day, speed ' + (R.speed[n0] / K).toFixed(2) });
  w.items.forEach(function (it) {
    var r = it.r, tag = it === w.f.day ? ' [DAY PTERO]' : it === w.f.dayJump ? ' [DAY JUMP]' : it === w.f.night ? ' [NIGHT PTERO]' : it === w.f.dawn ? ' [DAY-AGAIN PTERO]' :
      it === w.f.multi ? ' [MULTI-CACTUS]' : '';
    marks.push({
      k: it.mid, s: ts(it.mid) + ' ' + obsLabel(r) + ' -> ' + (it.afterOff ? 'the bot is off' : it.action) + tag + ' (on screen ' + vs(Math.max(r.visFirst, n0)) + '-' +
        vs(Math.min(r.visLast, t.crashTick)) + ', night ' + it.np.toFixed(2) + ')'
    });
  });
  R.ev.forEach(function (e) {
    if (e.tick < n0 || e.tick > t.crashTick || e.e !== 5) return;
    marks.push({ k: e.tick - 0.2, s: ts(e.tick) + ' milestone ' + e.score + ' (HUD blink + chime)' });
  });
  marks.push({ k: tr.nightOn - 0.1, s: ts(tr.nightOn) + ' NIGHT_ON: dusk fade starts' });
  marks.push({ k: tr.fullNight - 0.1, s: ts(tr.fullNight) + ' full night (moon, stars, Milky Way; night phase 1) for ' + ((tr.nightOff - tr.fullNight) / FPS).toFixed(2) + ' s' });
  marks.push({ k: tr.nightOff - 0.1, s: ts(tr.nightOff) + ' NIGHT_OFF: dawn fade starts (NIGHT_DURATION ' + tr.nightMs + ' ms, recording override)' });
  marks.push({ k: tr.dayFrom - 0.1, s: ts(tr.dayFrom) + ' full daylight again (night phase 0)' });
  marks.push({ k: t.botOffTick - 0.1, s: ts(t.botOffTick) + ' bot off (daylight ' + ((t.botOffTick - tr.dayFrom) / FPS).toFixed(2) + ' s so far)' });
  var tgt = R.obs.get(t.serial);
  marks.push({
    k: t.crashTick, s: ts(t.crashTick) + ' CRASH into ' + obsLabel(tgt) + ' -> "' + T.over + '" (on the ground, night phase ' + tr.np[t.crashTick] +
      ', daylight ' + (w.daylight / FPS).toFixed(2) + ' s before, score ' + t.score + ', the cactus on screen from ' + vs(Math.max(tgt.visFirst, n0)) +
      ', pose shift ' + t.shift.toFixed(1) + 'u' +
      (t.others.length ? ', also on screen: ' + t.others.map(function (o) { return (o.type === 2 ? 'ptero ' + ALT[o.alt] : o.n + 'x ' + (o.type ? 'large' : 'small') + ' cactus') + ' x=' + o.x; }).join(', ') : '') + ')'
  });
  marks.push({ k: t.crashTick + share, s: ts(t.crashTick + share) + ' restart icon full + "' + T.share + '" button (day theme)' });
  marks.push({ k: t.crashTick + w.hold, s: ts(t.crashTick + w.hold) + ' end (GAME OVER hold ' + (w.hold / FPS).toFixed(2) + ' s incl. the crash frame; ' + (MO + w.main) + ' frames = ' + ((MO + w.main) / FPS).toFixed(2) + ' s)' });
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

/** Day / early story candidate (all "at" / "...At" times are main-segment seconds; video = main + P.mainOffset / 60).
 * P = videoParams (default: the day story's layout, as in the second video). */
function summarizeDay(G, R, w, P) {
  P = P || videoParams('day', { lang: 'ja' });
  var t = w.test, tr = w.tr, cfg = G.cfg, n0 = w.n0, f = w.f, share = lib.shareDelayFrames(cfg), MO = P.mainOffset;
  function at(k) { return +((k - n0) / FPS).toFixed(3); }
  function vat(k) { return +((MO + k - n0) / FPS).toFixed(3); }
  function pt(it, night) {
    if (!it) return null;
    var o = { serial: it.r.serial, alt: ALT[it.r.alt], action: it.action, at: +((it.mid - n0) / FPS).toFixed(2), videoAt: +((MO + it.mid - n0) / FPS).toFixed(2), np: +it.np.toFixed(3) };
    if (night) o.nightVisFrames = it.nightVis; else o.visFrames = it.vis;
    return o;
  }
  var hi = t.score + 47; // display-only HI a little above the final score (no fake new record)
  var nightPtero = pt(f.night, true);
  return {
    seed: R.seed,
    story: P.story,
    score: w.score,
    parts: f.parts,
    nightDurationMs: tr.nightMs,
    startTick: n0,
    mainStartMs: lib.simMsForTicks(cfg, n0),
    botOffTick: t.botOffTick,
    botOffMs: Math.round(t.botOffTick * cfg.STEP_MS),
    crashTick: t.crashTick,
    crashMs: Math.round(t.crashTick * cfg.STEP_MS),
    holdFrames: w.hold,
    endTick: t.crashTick + w.hold - 1,
    mainFrames: w.main,
    mainSeconds: +(w.main / FPS).toFixed(3),
    totalFrames: MO + w.main,
    crashFrame: t.crashTick - n0,
    shareFrame: t.crashTick - n0 + share,
    posterFrame: f.night ? Math.round(f.night.mid - n0) - 12 : null, // the night pterodactyl ~0.2 s before it meets the dino
    startScore: R.score[n0],
    milestone700At: at(R.t700),
    nightOnAt: at(tr.nightOn),
    fullNightAt: at(tr.fullNight),
    nightOffAt: at(tr.nightOff),
    dayAgainAt: at(tr.dayFrom),
    fullNightSeconds: +((tr.nightOff - tr.fullNight) / FPS).toFixed(3),
    daylightBeforeCrash: +(w.daylight / FPS).toFixed(3),
    video: {
      autoStart: +(47 / FPS).toFixed(3), crossfade: [+(MO / FPS).toFixed(3), +(P.introFrames / FPS).toFixed(3)],
      dayJump: f.dayJump ? vat(f.dayJump.mid) : null, dayPtero: f.day ? vat(f.day.mid) : null, multiCactus: f.multi ? vat(f.multi.mid) : null,
      milestone700: vat(R.t700), nightOn: vat(tr.nightOn), fullNight: vat(tr.fullNight), nightPtero: f.night ? vat(f.night.mid) : null,
      dayAgainPtero: f.dawn ? vat(f.dawn.mid) : null,
      dawn: vat(tr.nightOff), dayAgain: vat(tr.dayFrom), botOff: vat(t.botOffTick), crash: vat(t.crashTick), shareButton: vat(t.crashTick + share),
      end: +((MO + w.main) / FPS).toFixed(3)
    },
    finalScore: t.score,
    hi: hi,
    crash: {
      serial: t.serial, type: t.type, n: t.n, rise: t.rise, restRise: t.restRise, shift: +t.shift.toFixed(2), gap: t.gap == null ? null : +t.gap.toFixed(2),
      np: tr.np[t.crashTick], onScreenFrames: w.targetVis, others: t.others
    },
    dayJump: f.dayJump ? { serial: f.dayJump.r.serial, what: obsLabel(f.dayJump.r), action: f.dayJump.action, at: +((f.dayJump.mid - n0) / FPS).toFixed(2),
      videoAt: vat(f.dayJump.mid), np: +f.dayJump.np.toFixed(3) } : null,
    dayPtero: pt(f.day, false),
    nightPtero: nightPtero,
    dayAgainPtero: pt(f.dawn, false),
    multiCactus: f.multi ? { serial: f.multi.r.serial, n: f.multi.r.n, large: f.multi.r.type === 1, at: +((f.multi.mid - n0) / FPS).toFixed(2), np: +f.multi.np.toFixed(2) } : null,
    timeline: describeDay(G, R, w, P)
  };
}

/**
 * Replay a day-story candidate end to end exactly as the recorder steps the page (lib.Game: ?sim= fast-forward,
 * then the NIGHT_DURATION override, then per frame one tick, the bot off before the step at botOffTick) and check
 * the plan: the crash tick / serial / score, the night phase of every frame against nightTrack, full night reached,
 * and night phase exactly 0 from DAYLIGHT_MIN ticks before the crash to the last frame (the whole GAME OVER hold).
 */
function confirmDay(G, c) {
  var Sim = G.Sim, EV = Sim.EV, ST = Sim.STATUS, problems = [], evs = [];
  var game = new lib.Game(G, {
    seed: c.seed, simMs: c.mainStartMs, hi: c.hi, nightDurationMs: c.nightDurationMs,
    onEvents: function (sim, e) { e.forEach(function (x) { if (x !== EV.SPAWN) evs.push([sim.tick, x, sim.score]); }); }
  });
  if (game.sim.tick !== c.startTick) problems.push('?sim=' + c.mainStartMs + ' gives tick ' + game.sim.tick);
  if (game.sim.score >= 700 || game.sim.nightActive || game.sim.nightPhase !== 0) problems.push('the fast-forward already reached the night');
  evs.length = 0;
  var np = [game.sim.nightPhase], hashes = [Sim.stateHash(game.sim)], maxNp = 0;
  for (var j = 1; j < c.mainFrames; j++) {
    if (game.sim.tick === c.botOffTick) game.botOff();
    game.tick();
    np.push(game.sim.nightPhase);
    hashes.push(Sim.stateHash(game.sim));
    if (game.sim.nightPhase > maxNp) maxNp = game.sim.nightPhase;
  }
  G.cfg.NIGHT_DURATION = G.defaults.NIGHT_DURATION;
  var crashEv = evs.filter(function (e) { return e[1] === EV.CRASH; });
  if (crashEv.length !== 1 || crashEv[0][0] !== c.crashTick) problems.push('crash ' + JSON.stringify(crashEv));
  if (game.sim.crashSerial !== c.crash.serial) problems.push('crash serial ' + game.sim.crashSerial + ' != ' + c.crash.serial);
  if (game.sim.status !== ST.CRASHED) problems.push('status ' + game.sim.status);
  if (game.sim.score !== c.finalScore) problems.push('final score ' + game.sim.score);
  if (maxNp < 1) problems.push('never full night');
  var cf = c.crashTick - c.startTick;
  for (j = Math.max(0, cf - DAY.DAYLIGHT_MIN); j < c.mainFrames; j++) if (np[j] !== 0) { problems.push('night phase ' + np[j] + ' on frame ' + j); break; }
  var on = evs.filter(function (e) { return e[1] === EV.NIGHT_ON; }), off = evs.filter(function (e) { return e[1] === EV.NIGHT_OFF; });
  if (on.length !== 1 || off.length !== 1) problems.push('night events ' + JSON.stringify(on.concat(off)));
  else if (off[0][0] - on[0][0] !== Math.round((c.nightOffAt - c.nightOnAt) * FPS)) problems.push('night length ' + (off[0][0] - on[0][0]) + ' ticks');
  if (c._np) for (j = 0; j < c.mainFrames && j <= cf; j++) if (np[j] !== c._np[c.startTick + j]) { problems.push('night phase differs from nightTrack on frame ' + j); break; }
  return { ok: !problems.length, problems: problems, hashes: hashes, np: np, events: evs };
}

function evalSeed(G, seed, W, story, opts) {
  var R = simulateSeed(G, seed, W, story);
  if (story === 'early') {
    var P = videoParams(story, opts), we = bestWindowsEarly(G, R, opts, P);
    if (!we.length) return null;
    var ce = summarizeDay(G, R, we[0], P);
    ce.windows = we.length;
    ce.nightOnVideoAt = +we[0].nightOnVideo.toFixed(3);
    return ce;
  }
  if (story === 'day') {
    var wd = bestWindowsDay(G, R, opts);
    if (!wd.length) return null;
    var c = summarizeDay(G, R, wd[0], videoParams(story, opts));
    c.windows = wd.length;
    return c;
  }
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

function nightOpts() {
  return {
    nightMs: argv('night-ms', null), nightMin: argv('night-min', null), nightMax: argv('night-max', null), nightStep: argv('night-step', null),
    lang: argv('lang', null), introFrames: argv('intro-frames', null), nightOnAt: argv('night-on-at', null)
  };
}

function runRange(seeds, story, opts) {
  var G = lib.loadGame(), W = lib.viewWidth(G.cfg, VIEW.width, VIEW.height), out = [];
  seeds.forEach(function (s) { var r = evalSeed(G, s, W, story, opts); if (r) out.push(r); });
  return out;
}

/** The night track of a candidate (for confirmDay's per-frame comparison). */
function trackOf(G, c, W) {
  var R = simulateSeed(G, c.seed, W, c.story === 'early' ? 'early' : 'day');
  return nightTrack(G, R, c.nightDurationMs).np;
}

function main() {
  var wt = require('worker_threads');
  if (!wt.isMainThread) { wt.parentPort.postMessage(runRange(wt.workerData.seeds, wt.workerData.story, wt.workerData.opts)); return; }
  var G = lib.loadGame(), cfg = G.cfg, W = lib.viewWidth(cfg, VIEW.width, VIEW.height);
  if (G.metrics.source.dino !== 'manifest' || G.metrics.source.cactus !== 'manifest' || G.metrics.source.ptero !== 'manifest') {
    console.warn('warning: sprite metrics not all from the manifest: ' + JSON.stringify(G.metrics.source));
  }
  var story = String(argv('story', 'early'));
  if (story !== 'early' && story !== 'day' && story !== 'night') throw new Error('--story early|day|night');
  var opts = nightOpts();
  videoParams(story, opts); // (checks --lang / --intro-frames before the search)
  var one = argv('seed', null);
  if (one != null) {
    var r = evalSeed(G, Number(one) >>> 0, W, story, opts);
    if (r && story !== 'night') { r._np = trackOf(G, r, W); var cf = confirmDay(G, r); delete r._np; r.confirmed = cf.ok; r.confirmProblems = cf.problems; }
    console.log(r ? JSON.stringify(r, null, 2) : 'seed ' + one + ': no window satisfies the hard requirements');
    return;
  }
  var from = Number(argv('from', 1)), to = Number(argv('to', 2000)), top = Number(argv('top', 3));
  var nW = Math.max(1, Number(argv('workers', Math.max(1, require('os').cpus().length - 1))));
  var outFile = argv('out', path.join(__dirname, 'plan.json'));
  var introSeed = Number(argv('intro-seed', INTRO_SEED)) >>> 0;
  var seeds = [];
  for (var s = from; s <= to; s++) seeds.push(s);
  var chunks = [];
  for (var i = 0; i < nW; i++) chunks.push([]);
  seeds.forEach(function (sd, j) { chunks[j % nW].push(sd); });
  var t0 = Date.now();
  Promise.all(chunks.filter(function (c) { return c.length; }).map(function (c) {
    return new Promise(function (res, rej) {
      var w = new wt.Worker(__filename, { workerData: { seeds: c, story: story, opts: opts } });
      w.once('message', res);
      w.once('error', rej);
    });
  })).then(function (parts) {
    var all = [].concat.apply([], parts);
    all.sort(function (a, b) { return b.score - a.score || b.mainFrames - a.mainFrames || a.seed - b.seed; });
    var hist = {};
    all.forEach(function (c) { var k = Math.floor(c.score); hist[k] = (hist[k] || 0) + 1; });
    console.log('story ' + story + '; W = ' + W + 'u at ' + VIEW.width + 'x' + VIEW.height + '; searched seeds ' + from + '..' + to + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) +
      ' s; ' + all.length + ' seeds have a valid window; score histogram ' + JSON.stringify(hist));
    if (story !== 'night') return writeDay(G, W, all, top, outFile, from, to, introSeed, opts, videoParams(story, opts));
    var lang = videoParams(story, opts).lang;
    var best = all.slice(0, top);
    best.forEach(function (c, j) {
      console.log('\n#' + (j + 1) + ' seed ' + c.seed + '  score ' + c.score + '  ' + JSON.stringify(c.parts));
      console.log('   ?sim=' + c.mainStartMs + ' (tick ' + c.startTick + ')  botOff tick ' + c.botOffTick + '  crash tick ' + c.crashTick + '  main ' + c.mainSeconds + ' s  final ' + c.finalScore + '  hi ' + c.hi);
      c.timeline.forEach(function (l) { console.log('   ' + l); });
    });
    if (!best.length) { console.error('no candidate'); process.exitCode = 1; return; }
    var b = best[0];
    var q = function (extra) { return 'index.html?seed=' + b.seed + '&bot=1' + extra + '&freeze=1&lang=' + lang + '&hi=' + b.hi + '&share=1'; };
    var plan = {
      generatedBy: 'tools/record/plan.js --story night --lang ' + lang + ' --from ' + from + ' --to ' + to,
      gameVersion: cfg.VERSION,
      viewport: { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, playfieldW: W },
      fps: FPS,
      lang: lang,
      ui: UI_TEXT[lang],
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

/** Day / early story: confirm the best seeds end to end (confirmDay), keep `top` of them, write the plan. */
function writeDay(G, W, all, top, outFile, from, to, introSeed, opts, P) {
  var cfg = G.cfg, best = [], early = P.story === 'early';
  for (var i = 0; i < all.length && best.length < top; i++) {
    var c = all[i];
    c._np = trackOf(G, c, W);
    var cf = confirmDay(G, c);
    delete c._np;
    if (!cf.ok) { console.log('seed ' + c.seed + ' (score ' + c.score + ') fails the end-to-end replay: ' + cf.problems.join('; ')); continue; }
    c.confirmed = true;
    best.push(c);
  }
  best.forEach(function (c, j) {
    console.log('\n#' + (j + 1) + ' seed ' + c.seed + '  score ' + c.score + '  night ' + c.nightDurationMs + ' ms  ' + JSON.stringify(c.parts) +
      (early ? '  700 / dusk at ' + c.video.milestone700 + ' s of video' : ''));
    console.log('   ?sim=' + c.mainStartMs + ' (tick ' + c.startTick + ')  botOff tick ' + c.botOffTick + '  crash tick ' + c.crashTick + '  main ' + c.mainFrames +
      ' frames  total ' + c.totalFrames + '  final ' + c.finalScore + '  hi ' + c.hi + '  full night ' + c.fullNightSeconds + ' s  daylight before the crash ' + c.daylightBeforeCrash + ' s');
    c.timeline.forEach(function (l) { console.log('   ' + l); });
  });
  if (!best.length) { console.error('no candidate'); process.exitCode = 1; return; }
  var b = best[0];
  var q = function (seed, extra) { return 'index.html?seed=' + seed + '&bot=1' + extra + '&freeze=1&lang=' + P.lang + '&hi=' + b.hi + '&share=1'; };
  var args = ['--story', P.story, '--lang', P.lang, '--from', from, '--to', to];
  if (opts.nightMs != null) args.push('--night-ms', opts.nightMs);
  if (early && opts.introFrames != null) args.push('--intro-frames', opts.introFrames);
  if (early && opts.nightOnAt) args.push('--night-on-at', opts.nightOnAt);
  var plan = {
    generatedBy: 'tools/record/plan.js ' + args.join(' '),
    story: P.story,
    gameVersion: cfg.VERSION,
    viewport: { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, playfieldW: W },
    fps: FPS,
    lang: P.lang,
    // the text the video shows (render.js TEXT[lang], i18n.js share.button; verify_plan.js checks the page against it)
    ui: P.text,
    hi: b.hi,
    exactFrames: true,
    intro: {
      seed: introSeed, fixedSeed: true, frames: P.introFrames, autoStartTick: 47,
      url: q(introSeed, ''),
      note: 'frame j shows sim.tick === j; the bot presses start on the step from tick 46 (main.js: sim.tick > 45), so frame 47 is the first running frame (the start press is also a jump). The intro seed is the same for every candidate.'
    },
    xfadeFrames: XFADE_FRAMES,
    main: {
      seed: b.seed, startTick: b.startTick, mainStartMs: b.mainStartMs, nightDurationMs: b.nightDurationMs,
      botOffTick: b.botOffTick, botOffMs: b.botOffMs, crashTick: b.crashTick, crashMs: b.crashMs, holdFrames: b.holdFrames,
      endTick: b.endTick, frames: b.mainFrames, crashFrame: b.crashFrame, shareFrame: b.shareFrame,
      posterFrame: b.posterFrame,
      url: q(b.seed, '&sim=' + b.mainStartMs),
      finalScore: b.finalScore, crashSerial: b.crash.serial,
      note: 'frame j shows sim.tick === startTick + j (frames 0..frames-1); after the load (and the ?sim= fast-forward) and before the first step set RDG.config.NIGHT_DURATION = nightDurationMs (recording only: the game keeps its 12 s night); disable the bot before the step that starts at sim.tick === botOffTick'
    },
    overrides: {
      NIGHT_DURATION: b.nightDurationMs,
      note: 'recording only (the promo video shortens the night so the GAME OVER is in daylight); the shipped game keeps NIGHT_DURATION = ' + G.defaults.NIGHT_DURATION + ' ms. The night cycle is visual only, so the run (obstacles, bot, RNG, state hash) is unchanged.'
    },
    totalFrames: P.mainOffset + b.mainFrames,
    totalSeconds: +((P.mainOffset + b.mainFrames) / FPS).toFixed(3),
    candidates: best
  };
  if (early) {
    plan.nightOnVideoAt = b.video.milestone700;
    if (b.video.milestone700 < P.nightOnVideo[0] - 1e-9 || b.video.milestone700 > P.nightOnVideo[1] + 1e-9) throw new Error('700 milestone at ' + b.video.milestone700 + ' s');
  } else if (plan.totalFrames !== TOTAL_FRAMES) throw new Error('total frames ' + plan.totalFrames);
  fs.writeFileSync(outFile, JSON.stringify(plan, null, 2) + '\n');
  console.log('\nwrote ' + path.relative(process.cwd(), outFile) + ' (seed ' + b.seed + ', night ' + b.nightDurationMs + ' ms, ' + plan.totalFrames + ' frames = ' + plan.totalSeconds + ' s)');
}

module.exports = {
  VIEW: VIEW, FPS: FPS, LANG: LANG, INTRO_FRAMES: INTRO_FRAMES, XFADE_FRAMES: XFADE_FRAMES, TOTAL_FRAMES: TOTAL_FRAMES, DAY: DAY, EARLY: EARLY,
  UI_TEXT: UI_TEXT, videoParams: videoParams, bestWindowsEarly: bestWindowsEarly,
  simulateSeed: simulateSeed, nightTrack: nightTrack, bestWindows: bestWindows, bestWindowsDay: bestWindowsDay, evalSeed: evalSeed,
  crashTest: crashTest, confirmDay: confirmDay, EV_NAMES: EV_NAMES
};

if (require.main === module || !require('worker_threads').isMainThread) main();
