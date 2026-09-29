#!/usr/bin/env node
/* Test suite for src/sim.js, src/input.js, src/i18n.js, the pure helpers of src/share.js and the GAME OVER layout of
 * src/render.js (plain Node, no dependencies).
 *
 *   node tools/sim_test.js                 # full suite (real manifest if assets/manifest.js exists, plus defaults)
 *   node tools/sim_test.js --seeds 40      # more bot seeds
 *   node tools/sim_test.js --minutes 5     # longer bot runs
 *
 * Exits non-zero on any failure. */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..');
require(path.join(ROOT, 'src/config.js'));
require(path.join(ROOT, 'src/rng.js'));
var RDG = require(path.join(ROOT, 'src/sim.js'));
var Sim = RDG.Sim, Bot = RDG.Bot, C = RDG.config;
var STATUS = Sim.STATUS, EV = Sim.EV, OT = Sim.OT;

function arg(name, def) {
  var i = process.argv.indexOf('--' + name);
  return i > 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : def;
}
var SEEDS = arg('seeds', 24);
var MINUTES = arg('minutes', 4);
var TICKS_PER_MIN = 60 * 60;

var failures = 0, checks = 0;
function check(cond, msg) {
  checks++;
  if (!cond) throw new Error(msg);
}
function test(name, fn) {
  var t0 = Date.now();
  try {
    var note = fn();
    console.log('  ok   ' + name + (note ? '  — ' + note : '') + '  (' + (Date.now() - t0) + ' ms)');
  } catch (e) {
    failures++;
    console.log('  FAIL ' + name + ': ' + e.message);
  }
}

function loadManifest() {
  var p = path.join(ROOT, 'assets/manifest.js');
  if (!fs.existsSync(p)) return null;
  var ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(p, 'utf8'), ctx, { filename: p });
  var m = ctx.window.ASSET_MANIFEST;
  return m && Object.keys(m).length ? m : null;
}

var I = { jumpPressed: false, jumpHeld: false, duckPressed: false, duckHeld: false };
function inp(jp, jh, dp, dh) { I.jumpPressed = !!jp; I.jumpHeld = !!jh; I.duckPressed = !!dp; I.duckHeld = !!dh; return I; }
function stepN(sim, n, input) { for (var i = 0; i < n; i++) { Sim.step(sim, input || Sim.IDLE_INPUT); sim.nEv = 0; } }

/** Run the bot from the start for `ticks`. Returns { sim, bot, events[] }. */
function botRun(M, seed, ticks, opts) {
  opts = opts || {};
  var sim = Sim.create({ seed: seed, metrics: M });
  sim.log = [];
  var bot = Bot.create(opts.bot || {});
  var out = { jumpPressed: false, jumpHeld: false, duckPressed: false, duckHeld: false };
  var events = [];
  Sim.start(sim);
  var nonFinite = -1, maxSpeedTick = -1;
  for (var t = 0; t < ticks && sim.status === STATUS.RUNNING; t++) {
    bot.update(sim, out);
    Sim.step(sim, out);
    for (var i = 0; i < sim.nEv; i++) if (opts.events) events.push({ e: sim.ev[i], tick: sim.tick, score: sim.score, time: sim.runningTime });
    sim.nEv = 0;
    if (maxSpeedTick < 0 && sim.speed >= C.MAX_SPEED) maxSpeedTick = sim.tick;
    if (t % 30 === 0 && nonFinite < 0 && !Sim.isFiniteState(sim)) nonFinite = sim.tick;
  }
  return { sim: sim, bot: bot, events: events, nonFinite: nonFinite, maxSpeedTick: maxSpeedTick };
}

function runSuite(label, M, seeds, minutes) {
  console.log('\n# ' + label + '  (sources: ' + JSON.stringify(M.source) + ')');
  var D = M.dino;

  test('metrics are sane', function () {
    check(D.front > D.back && D.hitLen > 50, 'dino front/back ' + D.front + '/' + D.back);
    check(D.standTop > 60 && D.standTop < 160, 'standTop ' + D.standTop);
    check(D.duckTop < D.standTop - 2 * C.PTERO_ALT_MARGIN, 'duckTop ' + D.duckTop + ' vs standTop ' + D.standTop);
    check(M.pteroY[0] > M.pteroY[1] && M.pteroY[1] > M.pteroY[2], 'ptero altitudes ordered (low, mid, high)');
    ['idle', 'run', 'duck', 'jump', 'dead'].forEach(function (k) {
      D.frames[k].forEach(function (f) { for (var i = 0; i < f.r.length; i++) check(isFinite(f.r[i]), 'dino rect finite'); });
    });
    check(M.cactus.large.length >= 1 && M.cactus.small.length >= 1 && M.ptero.frames.length >= 1, 'sprite lists');
    return 'hitLen ' + D.hitLen.toFixed(1) + 'u, standTop ' + D.standTop.toFixed(1) + 'u, duckTop ' + D.duckTop.toFixed(1) + 'u';
  });

  test('determinism: same seed -> same run; clones evolve identically', function () {
    var a = botRun(M, 4242, 6000), b = botRun(M, 4242, 6000);
    check(Sim.stateHash(a.sim) === Sim.stateHash(b.sim), 'state hash differs');
    check(JSON.stringify(a.sim.log) === JSON.stringify(b.sim.log), 'spawn log differs');
    var c = botRun(M, 4243, 6000);
    check(JSON.stringify(a.sim.log) !== JSON.stringify(c.sim.log), 'different seeds should differ');
    // clone equivalence
    var s1 = Sim.create({ seed: 7, metrics: M });
    Sim.start(s1);
    stepN(s1, 900);
    var s2 = Sim.clone(s1);
    for (var i = 0; i < 400; i++) {
      var x = i % 37 === 0 ? inp(1, 1, 0, 0) : i % 53 === 0 ? inp(0, 0, 1, 1) : inp(0, i % 37 < 10, 0, 0);
      Sim.step(s1, x); Sim.step(s2, x);
      s1.nEv = s2.nEv = 0;
    }
    check(Sim.stateHash(s1) === Sim.stateHash(s2), 'clone diverged');
    // obstacle sequence is independent of the player's actions
    var p = Sim.create({ seed: 99, metrics: M }), q = Sim.create({ seed: 99, metrics: M, noCollide: true });
    p.log = []; q.log = [];
    Sim.start(p); Sim.start(q);
    var bot = Bot.create();
    var o = { jumpPressed: false, jumpHeld: false, duckPressed: false, duckHeld: false };
    for (var t = 0; t < 3000 && p.status === STATUS.RUNNING; t++) { bot.update(p, o); Sim.step(p, o); p.nEv = 0; }
    for (t = 0; t < 3000; t++) { Sim.step(q, t % 20 === 0 ? inp(1, 1, 0, 0) : t % 47 < 9 ? inp(0, 0, 0, 1) : Sim.IDLE_INPUT); q.nEv = 0; }
    var n = Math.min(p.log.length, q.log.length);
    check(n > 3, 'expected spawns');
    for (var k = 0; k < n; k++) check(p.log[k].tick === q.log[k].tick && p.log[k].type === q.log[k].type && p.log[k].x === q.log[k].x, 'spawn ' + k + ' depends on actions');
    return Sim.stateHash(a.sim).toString(16);
  });

  var allLogs = [];
  var ticks = Math.round(minutes * TICKS_PER_MIN);
  test('bot survives ' + seeds + ' seeds x ' + minutes + ' min (reaches MAX speed, no NaN)', function () {
    var worst = null, totalDecisions = 0, degraded = 0, spawns = 0, types = [0, 0, 0], groups = [0, 0, 0, 0];
    for (var s = 1; s <= seeds; s++) {
      var r = botRun(M, s * 7919 + 13, ticks);
      var sim = r.sim;
      if (sim.status !== STATUS.RUNNING) {
        var crash = sim.log.filter(function (l) { return l.serial === sim.crashSerial; })[0];
        throw new Error('seed ' + (s * 7919 + 13) + ' crashed at tick ' + sim.tick + ' (score ' + sim.score + ', speed ' + (sim.speed / C.K).toFixed(2) + ') into ' + JSON.stringify(crash) + ' bot fails ' + r.bot.fails);
      }
      check(r.nonFinite < 0, 'non-finite state at tick ' + r.nonFinite + ' seed ' + s);
      check(r.maxSpeedTick > 0, 'MAX speed not reached (seed ' + s + ')');
      check(sim.runningTime >= 3 * 60 * 1000, 'ran less than 3 minutes');
      check(r.bot.fails === 0, 'bot had ' + r.bot.fails + ' unsolvable situations (seed ' + s + ')');
      check(sim.unfair === 0, 'spawner produced ' + sim.unfair + ' obstacles without a fair window (seed ' + s + ')');
      totalDecisions += r.bot.decisions; degraded += r.bot.degraded; spawns += sim.log.length;
      sim.log.forEach(function (l) { types[l.type]++; if (l.type !== OT.PTERO) groups[l.n]++; });
      allLogs.push(sim.log);
      if (!worst || sim.score < worst) worst = sim.score;
    }
    return spawns + ' obstacles (small/large/ptero ' + types.join('/') + ', cactus groups x1/x2/x3 ' + groups.slice(1).join('/') + '), ' + totalDecisions + ' bot plans (' + degraded + ' at reduced depth), min score ' + worst;
  });

  test('obstacle rules: clear time, gaps, duplication, ptero speed threshold, group speeds', function () {
    var minPteroSpeed = Infinity, n = 0;
    allLogs.forEach(function (log) {
      check(log.length > 0, 'no spawns');
      check(log[0].runningTime > C.CLEAR_TIME, 'obstacle before CLEAR_TIME');
      for (var i = 0; i < log.length; i++) {
        var l = log[i];
        n++;
        check(l.ok, 'unfair spawn ' + JSON.stringify(l));
        if (l.type === OT.PTERO) {
          check(l.speed >= C.OBSTACLE_MIN_SPEED[OT.PTERO], 'ptero below min speed: ' + l.speed);
          minPteroSpeed = Math.min(minPteroSpeed, l.speed);
          check(l.n === 1, 'ptero group');
        } else if (l.n > 1) {
          check(l.speed >= C.OBSTACLE_MULTIPLE_SPEED[l.type], 'group of ' + l.n + ' below multipleSpeed');
        }
        check(l.n >= 1 && l.n <= C.MAX_OBSTACLE_LENGTH, 'group size');
        if (l.prevType >= 0) {
          check(l.spriteGap > l.chromeGap - 1e-6, 'Chrome gap violated: ' + l.spriteGap + ' < ' + l.chromeGap);
          check(l.gapActual >= l.req - 1e-6, 'fairness gap violated: ' + l.gapActual + ' < ' + l.req);
          check(l.chromeGap > 0, 'gap must be positive');
        }
        if (i >= 2) check(!(log[i].type === log[i - 1].type && log[i - 1].type === log[i - 2].type), 'more than ' + C.MAX_OBSTACLE_DUPLICATION + ' consecutive ' + Sim.OT_NAMES[l.type]);
      }
    });
    check(minPteroSpeed < Infinity, 'no pterodactyls spawned at all');
    return n + ' spawns checked; first ptero at speed ' + (minPteroSpeed / C.K).toFixed(2) + ' (threshold ' + (C.OBSTACLE_MIN_SPEED[2] / C.K) + ')';
  });

  test('ptero altitudes: low needs a jump, mid is cleared by ducking, high clears a standing dino', function () {
    var notes = [];
    [C.OBSTACLE_MIN_SPEED[OT.PTERO], C.MAX_SPEED].forEach(function (speed) {
      for (var frame = 0; frame < M.ptero.frames.length; frame++) {
        var res = [0, 1, 2].map(function (alt) {
          function scenario(mode) {
            var sim = Sim.create({ seed: 1, metrics: M, noSpawn: true, fixedSpeed: true });
            Sim.start(sim);
            sim.speed = speed;
            var o = Sim.placeObstacle(sim, OT.PTERO, D.front + 600, { alt: alt, frame: frame });
            var hold = mode === 'duck' ? inp(0, 0, 0, 1) : Sim.IDLE_INPUT;
            for (var t = 0; t < 400 && sim.status === STATUS.RUNNING; t++) {
              if (mode === 'duck') inp(0, 0, t === 0, 1);
              Sim.step(sim, mode === 'duck' ? I : hold); sim.nEv = 0;
              if (o.x + o.hitR < D.back - 5) break;
            }
            return sim.status === STATUS.RUNNING;
          }
          var stand = scenario('stand'), duck = scenario('duck');
          // jump: some start delay must clear it
          var jumpOk = false;
          for (var delay = 0; delay < 60 && !jumpOk; delay++) {
            for (var p = 0; p < 5 && !jumpOk; p++) {
              var sim = Sim.create({ seed: 1, metrics: M, noSpawn: true, fixedSpeed: true });
              Sim.start(sim); sim.speed = speed;
              var o = Sim.placeObstacle(sim, OT.PTERO, D.front + 600, { alt: alt, frame: frame });
              stepN(sim, delay);
              var start = sim.tick, pl = Sim.PLANS[p];
              for (var t = 0; t < 400 && sim.status === STATUS.RUNNING; t++) {
                var tt = sim.tick - start, d = sim.dino, ff = pl.ff && d.jumping && d.vy >= 0;
                Sim.step(sim, inp(tt === 0, tt < pl.hold, ff && !d.speedDrop, ff)); sim.nEv = 0;
                if (o.x + o.hitR < D.back - 5 && !sim.dino.jumping) break;
              }
              if (sim.status === STATUS.RUNNING) jumpOk = true;
            }
          }
          return { stand: stand, duck: duck, jump: jumpOk };
        });
        var sp = (speed / C.K).toFixed(1) + '/f' + frame;
        check(!res[0].stand && !res[0].duck && res[0].jump, 'low ptero @' + sp + ': ' + JSON.stringify(res[0]));
        check(!res[1].stand && res[1].duck, 'mid ptero @' + sp + ': ' + JSON.stringify(res[1]));
        check(res[2].stand, 'high ptero @' + sp + ': ' + JSON.stringify(res[2]));
      }
      // the fairness probe agrees that every altitude is clearable
      [0, 1, 2].forEach(function (alt) {
        var sim = Sim.create({ seed: 1, metrics: M, noSpawn: true });
        var o = Sim.placeObstacle(sim, OT.PTERO, 1000, { alt: alt });
        check(Sim.probeObstacle(M, C, o, speed).ok, 'probe: alt ' + alt + ' not clearable at speed ' + speed);
      });
      notes.push((speed / C.K).toFixed(1));
    });
    // visible wingtips (manifest opaqueBox) never dip into the ground, a ducking dino's back or a standing dino's head
    var P = M.ptero, vis = [0, 1, 2].map(function (alt) { return C.GROUND_Y - (M.pteroY[alt] + P.visBottom); });
    check(P.visBottom >= P.union.y1, 'ptero visible bottom below its lowest hitbox');
    check(vis[0] >= C.PTERO_VIS_CLEAR - 1e-6, 'low ptero wingtips in the ground: ' + vis[0].toFixed(1));
    check(vis[1] >= D.duckTop + C.PTERO_VIS_CLEAR - 1e-6, 'mid ptero wingtips through a ducking dino: ' + vis[1].toFixed(1));
    check(vis[2] >= D.standTop + C.PTERO_VIS_CLEAR - 1e-6, 'high ptero wingtips through a standing dino: ' + vis[2].toFixed(1));
    notes.push('visible bottom ' + vis.map(function (v) { return v.toFixed(1); }).join(' / ') + 'u' + (P.hasVis ? '' : ' (from hitboxes)'));
    return 'speeds ' + notes.join(', ') + '; ptero lowest point above ground: ' + M.pteroY.map(function (y) { return (C.GROUND_Y - y - M.ptero.union.y1).toFixed(1); }).join(' / ') + 'u';
  });

  test('every single cactus of every variant is clearable at start speed', function () {
    [0, 1].forEach(function (type) {
      M.cactusByType[type].forEach(function (v, vi) {
        var sim = Sim.create({ seed: 1, metrics: M, noSpawn: true });
        var o = Sim.placeObstacle(sim, type, 1000, { v0: vi });
        var r = Sim.probeObstacle(M, C, o, C.SPEED);
        check(r.ok, Sim.OT_NAMES[type] + '[' + vi + '] not clearable at start speed');
      });
    });
  });
}

function physicsSuite(M) {
  console.log('\n# physics, score & cycle (' + M.source.dino + ' dino)');
  function fresh() {
    var sim = Sim.create({ seed: 5, metrics: M, noSpawn: true });
    Sim.start(sim);
    return sim;
  }
  /** Jump from flat ground; the key is held while t < holdTicks (or, with tillMin, until min height is reached). */
  function jumpApex(holdTicks, ffAtApex, tillMin, speed) {
    var sim = fresh(), apex = 0, t = 0;
    if (speed) { sim.fixedSpeed = true; sim.speed = speed; }
    Sim.step(sim, inp(1, holdTicks > 0, 0, 0)); sim.nEv = 0;
    apex = C.GROUND_Y - sim.dino.y;
    while (sim.dino.jumping && t < 300) {
      t++;
      var ff = ffAtApex && sim.dino.vy >= 0;
      Sim.step(sim, inp(0, t < holdTicks || (tillMin && !sim.dino.reachedMin), ff && !sim.dino.speedDrop, ff)); sim.nEv = 0;
      apex = Math.max(apex, C.GROUND_Y - sim.dino.y);
    }
    return { apex: apex, air: t };
  }

  test('variable jump height, max height cap, fast-fall', function () {
    var full = jumpApex(999, false), hop = jumpApex(1, false, true), ff = jumpApex(999, true);
    check(hop.apex <= full.apex - 40, 'short hop apex ' + hop.apex + ' vs full ' + full.apex);
    check(hop.apex >= C.MIN_JUMP_RISE, 'hop below min height');
    check(full.apex > C.MAX_JUMP_RISE && full.apex < C.MAX_JUMP_RISE * 1.6, 'full apex ' + full.apex);
    check(ff.air < full.air - 5, 'fast-fall should land sooner: ' + ff.air + ' vs ' + full.air);
    // Chrome key-up rule: a release before min height is ignored, so a 1-tick tap (press + release in one frame)
    // still gives a full jump
    var taps = [6, 8].map(function (v) {
      var f = jumpApex(999, false, false, v * C.K), tap = jumpApex(1, false, false, v * C.K), same = jumpApex(0, false, false, v * C.K);
      check(Math.abs(tap.apex - f.apex) <= 1, '1-tick tap apex ' + tap.apex.toFixed(1) + ' vs full ' + f.apex.toFixed(1) + ' at speed ' + v);
      check(Math.abs(same.apex - f.apex) <= 1, 'press+release in one tick: apex ' + same.apex.toFixed(1) + ' vs full ' + f.apex.toFixed(1) + ' at speed ' + v);
      return tap.apex.toFixed(0) + 'u@' + v;
    });
    return 'apex full ' + full.apex.toFixed(0) + 'u / hop ' + hop.apex.toFixed(0) + 'u / tap ' + taps.join(', ') + '; air ' + full.air + ' / ' + hop.air + ' / fast-fall ' + ff.air + ' ticks';
  });

  test('jump buffer (<=100 ms before landing) and no auto-repeat while held', function () {
    function buffered(before) {
      var sim = fresh();
      var air = jumpApex(999, false).air;
      Sim.step(sim, inp(1, 1, 0, 0)); sim.nEv = 0;
      var jumps0 = sim.dino.jumps;
      for (var t = 1; t < air + 12; t++) {
        Sim.step(sim, inp(t === air - before, 1, 0, 0)); sim.nEv = 0;
      }
      return sim.dino.jumps - jumps0;
    }
    check(buffered(3) === 1, 'press 3 ticks before landing should re-jump');
    check(buffered(6) === 1, 'press 6 ticks (100 ms) before landing should re-jump');
    check(buffered(12) === 0, 'press 12 ticks before landing must not re-jump');
    // a buffered press released before touchdown (pressed 5 ticks before landing, held 3) still gives a full jump:
    // the release happens during the previous jump, so the new jump sees no key-up
    var full = jumpApex(999, false);
    var bs = fresh(), p = full.air - 5, apex2 = 0;
    Sim.step(bs, inp(1, 1, 0, 0)); bs.nEv = 0;
    var j0 = bs.dino.jumps;
    for (var t = 1; t < full.air + 80; t++) {
      Sim.step(bs, inp(t === p, t < p - 3 || (t >= p && t < p + 3), 0, 0)); bs.nEv = 0;
      if (bs.dino.jumps > j0) apex2 = Math.max(apex2, C.GROUND_Y - bs.dino.y);
    }
    check(bs.dino.jumps - j0 === 1, 'buffered press released before landing should re-jump');
    check(apex2 >= 0.9 * full.apex, 'buffered press released before landing: apex ' + apex2.toFixed(1) + ' < 90% of full ' + full.apex.toFixed(1));
    var sim = fresh();
    Sim.step(sim, inp(1, 1, 0, 0));
    stepN(sim, 200, inp(0, 1, 0, 0)); // key held: no second jump
    check(sim.dino.jumps === 1, 'holding jump must not auto-repeat (' + sim.dino.jumps + ' jumps)');
  });

  test('duck lowers the hitbox; jump from duck; duck in air = fast-fall', function () {
    var sim = fresh();
    stepN(sim, 5, inp(0, 0, 0, 1));
    check(sim.dino.ducking && sim.dino.anim === Sim.ANIM.DUCK, 'ducking');
    var fr = Sim.dinoFrameRects(sim);
    check(-fr.y0 < M.dino.standTop - 20, 'duck hitbox not lower');
    Sim.step(sim, inp(1, 1, 0, 1)); sim.nEv = 0;
    check(sim.dino.jumping, 'jump from duck');
    stepN(sim, 3, inp(0, 1, 0, 1));
    check(!sim.dino.speedDrop, 'holding duck through the take-off must not fast-fall');
    Sim.step(sim, inp(0, 1, 1, 1)); sim.nEv = 0;
    check(sim.dino.speedDrop, 'duck press in air -> fast-fall');
  });

  test('score and hi-score math', function () {
    var sim = Sim.create({ seed: 3, metrics: M, hiScore: 0 });
    Sim.start(sim);
    var t = 0;
    while (sim.status === STATUS.RUNNING && t < 20000) { Sim.step(sim); sim.nEv = 0; t++; }
    check(sim.status === STATUS.CRASHED, 'idle dino should crash into the first obstacle');
    check(sim.score === Math.round(sim.distance * C.SCORE_COEFFICIENT), 'score formula');
    check(Math.abs(sim.score - Math.round((sim.distance / C.K) * 0.025)) <= 0, 'score = Chrome px x 0.025');
    check(sim.hiScore === sim.score && sim.score > 0, 'hi-score after first crash');
    var first = sim.score;
    Sim.start(sim);
    check(sim.score === 0 && sim.hiScore === first && sim.status === STATUS.RUNNING, 'restart keeps hi-score, resets score');
    stepN(sim, 10);
    var hi = Sim.create({ seed: 3, metrics: M, hiScore: 99999 });
    Sim.start(hi);
    t = 0;
    while (hi.status === STATUS.RUNNING && t < 20000) { Sim.step(hi); hi.nEv = 0; t++; }
    check(hi.hiScore === 99999, 'lower score must not replace hi-score');
    check(Sim.pad5(43) === '00043' && Sim.pad5(0) === '00000' && Sim.pad5(123456) === '99999', 'pad5');
    // first 3 s: score rate matches Chrome (speed 6 -> 0.15 points / frame)
    var s2 = Sim.create({ seed: 1, metrics: M, noSpawn: true });
    Sim.start(s2);
    stepN(s2, 60);
    check(Math.abs(s2.score - 9) <= 1, 'score after 1 s at speed 6 should be ~9, got ' + s2.score);
    return 'first crash at score ' + first;
  });

  test('100-point milestones: event + 4 blinks', function () {
    var sim = Sim.create({ seed: 1, metrics: M, noSpawn: true });
    Sim.start(sim);
    var ms = [], blinks = 0, prevVisible = true, flashSeen = false;
    for (var t = 0; t < 60 * 60 && sim.score < 420; t++) {
      Sim.step(sim);
      for (var i = 0; i < sim.nEv; i++) if (sim.ev[i] === EV.MILESTONE) ms.push(sim.score);
      sim.nEv = 0;
      var h = Sim.hudScore(sim);
      if (sim.flashActive && sim.flashValue === 100) {
        flashSeen = true;
        if (!h.visible && prevVisible) blinks++;
      }
      prevVisible = h.visible;
    }
    check(ms.length === 4 && ms[0] === 100 && ms[1] === 200 && ms[2] === 300 && ms[3] === 400, 'milestones ' + ms.join(','));
    check(flashSeen && blinks === C.FLASH_ITERATIONS + 1, 'blinks ' + blinks);
    return 'milestones at ' + ms.join(', ');
  });

  test('crash during milestone blink shows the real score', function () {
    function isReal(h, sim) {
      return JSON.stringify(h) === JSON.stringify({ value: sim.score, visible: true });
    }
    var notes = [];
    [0, 10, 78].forEach(function (delay) {
      var sim = Sim.create({ seed: 1, metrics: M, noSpawn: true });
      Sim.start(sim);
      for (var t = 0; t < 60 * 60 && sim.score < 100; t++) { Sim.step(sim); sim.nEv = 0; }
      check(sim.score >= 100, 'score 100 not reached');
      stepN(sim, delay);
      Sim.placeObstacle(sim, OT.LARGE, M.dino.front - 10);
      for (t = 0; t < 60 && sim.status !== STATUS.CRASHED; t++) { Sim.step(sim); sim.nEv = 0; }
      check(sim.status === STATUS.CRASHED, 'no crash (delay ' + delay + ')');
      check(isReal(Sim.hudScore(sim), sim), 'delay ' + delay + ': HUD at crash ' + JSON.stringify(Sim.hudScore(sim)) + ', score ' + sim.score);
      stepN(sim, 300);
      check(isReal(Sim.hudScore(sim), sim), 'delay ' + delay + ': HUD after GAME OVER ' + JSON.stringify(Sim.hudScore(sim)) + ', score ' + sim.score);
      check(sim.flashActive === false, 'delay ' + delay + ': milestone blink still active on GAME OVER');
      var o = { value: -1, visible: false };
      check(Sim.hudScore(sim, o) === o && o.value === sim.score && o.visible === true, 'hudScore(sim, out) must fill and return out');
      notes.push(delay + ' -> ' + sim.score);
    });
    return 'crash delay (ticks) -> score: ' + notes.join(', ');
  });

  test('a mid-air crash rests on the cactus it hit; a ground crash stays on the ground', function () {
    function crash(jumpTick) {
      var sim = Sim.create({ seed: 1, metrics: M, noSpawn: true, fixedSpeed: true });
      Sim.start(sim);
      sim.speed = 8; // world units per tick
      Sim.placeObstacle(sim, OT.LARGE, M.dino.front + 384, { v0: 2 });
      for (var t = 0; t < 400 && sim.status === STATUS.RUNNING; t++) {
        Sim.step(sim, inp(t === jumpTick, jumpTick >= 0 && t >= jumpTick, 0, 0)); sim.nEv = 0;
      }
      check(sim.status === STATUS.CRASHED, 'no crash (jump at ' + jumpTick + ')');
      var atCrash = C.GROUND_Y - sim.dino.y;
      stepN(sim, 90);
      return { atCrash: atCrash, rest: C.GROUND_Y - sim.dino.y };
    }
    var air = crash(33), ground = crash(-1);
    check(air.atCrash > 40, 'expected a mid-air crash, rise ' + air.atCrash.toFixed(1));
    check(Math.abs(air.rest - air.atCrash) <= 2, 'dead dino dropped from ' + air.atCrash.toFixed(1) + 'u to ' + air.rest.toFixed(1) + 'u');
    check(ground.rest === 0, 'ground crash ends at rise ' + ground.rest);
    return 'crash at rise ' + air.atCrash.toFixed(1) + 'u -> rests at ' + air.rest.toFixed(1) + 'u';
  });

  test('night toggles on every 700 points and ends after NIGHT_DURATION', function () {
    var sim = Sim.create({ seed: 1, metrics: M, noSpawn: true });
    Sim.start(sim);
    var on = [], off = [], maxPhase = 0;
    for (var t = 0; t < 60 * 60 * 5 && sim.score < 2250; t++) {
      Sim.step(sim);
      for (var i = 0; i < sim.nEv; i++) {
        if (sim.ev[i] === EV.NIGHT_ON) on.push({ score: sim.score, time: sim.runningTime });
        if (sim.ev[i] === EV.NIGHT_OFF) off.push({ score: sim.score, time: sim.runningTime });
      }
      sim.nEv = 0;
      maxPhase = Math.max(maxPhase, sim.nightPhase);
    }
    check(on.length === 3, 'night starts: ' + JSON.stringify(on));
    [700, 1400, 2100].forEach(function (s, k) { check(on[k].score === s, 'night ' + k + ' started at score ' + on[k].score); });
    check(off.length >= 2, 'night ends');
    for (var k = 0; k < off.length; k++) {
      var dt = off[k].time - on[k].time;
      check(Math.abs(dt - C.NIGHT_DURATION) <= C.STEP_MS + 1e-6, 'night duration ' + dt);
    }
    check(maxPhase === 1, 'full night reached');
    return 'on at ' + on.map(function (o) { return o.score; }).join(', ') + '; off at ' + off.map(function (o) { return o.score; }).join(', ');
  });
}

/** src/input.js loaded into a vm context with a stub window (listeners are called directly). */
function inputSuite() {
  console.log('\n# input (src/input.js, stub window)');
  function load(opts) {
    var listeners = {};
    var win = {
      innerHeight: 800, innerWidth: 1200,
      addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      matchMedia: function () { return { matches: false }; }
    };
    vm.createContext(win);
    var file = path.join(ROOT, 'src/input.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), win, { filename: file });
    var st = win.RDG.Input.create(opts);
    st.fire = function (type, e) {
      e.type = type; e.preventDefault = function () {};
      (listeners[type] || []).forEach(function (fn) { fn(e); });
    };
    st.touch = function (type, id, primary, y, x) {
      st.fire(type, { pointerId: id, isPrimary: primary, pointerType: 'touch', button: 0, clientY: y, clientX: x == null ? LEFT : x });
    };
    st.key = function (type, code, repeat) { st.fire(type, { code: code, repeat: !!repeat }); };
    return st;
  }
  var LOW = 0.9 * 800, HIGH = 0.2 * 800, LEFT = 0.2 * 1200, RIGHT = 0.8 * 1200;

  test('touch holds are tracked per pointer (a second finger lifting keeps the first held)', function () {
    var st = load({ canDuck: function () { return true; } });
    st.touch('pointerdown', 1, true, LOW);
    check(st.duckHeld && !st.jumpHeld, 'finger A in the duck zone (lower left) ducks');
    st.touch('pointerdown', 2, false, LOW);
    st.touch('pointerup', 2, false, LOW);
    check(st.duckHeld, 'finger B lifting released finger A\'s duck');
    st.touch('pointerup', 1, true, LOW);
    check(!st.duckHeld, 'duck still held after both fingers lifted');
    st.touch('pointerdown', 3, true, HIGH);
    check(st.jumpHeld && !st.duckHeld, 'finger A in the upper part holds jump');
    st.touch('pointerdown', 4, false, HIGH);
    st.touch('pointercancel', 4, false, HIGH);
    check(st.jumpHeld, 'finger B cancelling released finger A\'s jump');
    st.touch('pointerup', 3, true, HIGH);
    check(!st.jumpHeld, 'jump still held after both fingers lifted');
    // a lost pointerup (id 5) is dropped when the next first finger goes down
    st.touch('pointerdown', 5, true, HIGH);
    st.touch('pointerdown', 6, true, LOW);
    st.touch('pointerup', 6, true, LOW);
    check(!st.jumpHeld && !st.duckHeld, 'stale pointer id kept a hold alive');
  });

  test('duck-zone taps start / restart outside a run; ducking only during a run; mouse never ducks', function () {
    var running = false;
    var st = load({ canDuck: function () { return running; } });
    st.touch('pointerdown', 1, true, LOW);
    check(st.takeJump() && !st.takeDuck() && st.jumpHeld, 'outside a run a duck-zone tap is a jump press');
    st.touch('pointerup', 1, true, LOW);
    running = true;
    st.touch('pointerdown', 2, true, LOW);
    check(!st.takeJump() && st.takeDuck() && st.duckHeld, 'during a run the duck zone ducks');
    st.touch('pointerup', 2, true, LOW);
    st.fire('pointerdown', { pointerId: 3, isPrimary: true, pointerType: 'mouse', button: 0, clientY: LOW });
    check(st.takeJump() && !st.takeDuck(), 'a mouse click in the lower third jumps');
    st.fire('pointerup', { pointerId: 3, isPrimary: true, pointerType: 'mouse', button: 0, clientY: LOW });
  });

  test('duck zone = bottom third of the LEFT half: a lower-right touch jumps, a lower-left one ducks', function () {
    var st = load({ canDuck: function () { return true; }, duckZone: { x1: 0.5, y0: 2 / 3 } });
    st.touch('pointerdown', 1, true, LOW, RIGHT);
    check(st.takeJump() && !st.takeDuck() && st.jumpHeld && !st.duckHeld, 'a lower-right touch during a run must jump');
    st.touch('pointerup', 1, true, LOW, RIGHT);
    st.touch('pointerdown', 2, true, LOW, LEFT);
    check(!st.takeJump() && st.takeDuck() && st.duckHeld && st.touchDucks === 1, 'a lower-left touch during a run must duck');
    st.touch('pointerdown', 3, false, LOW, RIGHT); // second finger on the right: jump while the left one holds duck
    check(st.takeJump() && st.duckHeld && st.jumpHeld, 'a right-hand second finger must jump');
    st.touch('pointerup', 3, false, LOW, RIGHT);
    st.touch('pointerup', 2, true, LOW, LEFT);
    st.touch('pointerdown', 4, true, HIGH, LEFT);
    check(st.takeJump() && !st.takeDuck(), 'an upper-left touch must jump');
    st.touch('pointerup', 4, true, HIGH, LEFT);
    check(st.inDuckZone(0.49 * 1200, 0.67 * 800) && !st.inDuckZone(0.51 * 1200, 0.9 * 800) && !st.inDuckZone(10, 0.66 * 800), 'zone edges');
    // measured on the play surface's client rect (a canvas offset by a pillarbox band / notch padding)
    var st2 = load({ canDuck: function () { return true; }, surface: { getBoundingClientRect: function () { return { left: 200, top: 0, width: 800, height: 800 }; } } });
    check(st2.inDuckZone(550, LOW) && !st2.inDuckZone(650, LOW) && st2.inDuckZone(100, LOW), 'surface rect: left half = client x < 600');
  });

  test('on-canvas button (hitUi) presses never jump / duck; a key held across releaseAll is held again on repeat', function () {
    var hits = 0;
    var st = load({ canDuck: function () { return true; }, hitUi: function (x, y) { if (x < 50 && y < 50) { hits++; return true; } return false; } });
    st.touch('pointerdown', 1, true, 20, 20);
    check(hits === 1 && !st.takeJump() && !st.takeDuck() && !st.takeAny() && !st.jumpHeld, 'a button press must not be a game press');
    st.touch('pointerup', 1, true, 20, 20);
    st.touch('pointerdown', 2, true, HIGH, RIGHT);
    check(st.takeJump(), 'outside the button a tap still jumps');
    st.touch('pointerup', 2, true, HIGH, RIGHT);
    st.clear();
    st.key('keydown', 'ArrowDown');
    check(st.duckHeld && st.takeDuck(), 'ArrowDown ducks');
    st.releaseAll(); // pause / blur
    st.clear();
    check(!st.duckHeld, 'releaseAll releases');
    st.key('keydown', 'ArrowDown', true); // auto-repeat of the still-held key
    check(st.duckHeld && !st.takeDuck() && !st.takeAny(), 'a repeat restores the hold without a new press');
    st.key('keyup', 'ArrowDown');
    check(!st.duckHeld, 'keyup releases');
    st.key('keydown', 'Space');
    st.releaseAll();
    st.clear();
    st.key('keydown', 'Space', true);
    check(st.jumpHeld && !st.takeJump(), 'a held jump key is held again on repeat, never re-pressed');
  });

  test('overlay UI ([data-ui], e.g. the share button): never a game press, keeps its default action', function () {
    var UI = { ui: true }, CANVAS = { ui: false }, consumed = null, mutes = 0;
    var st = load({
      canDuck: function () { return true; }, onMute: function () { mutes++; },
      isUiTarget: function (t, e) { return (t && t.ui) || (e && e === consumed); }
    });
    /** Fire `type`; returns whether a listener called preventDefault (fire() assigns a no-op preventDefault, so the
     * recording one is an accessor that ignores that assignment). */
    function send(type, props) {
      var e = props, n = { prevented: false };
      Object.defineProperty(e, 'preventDefault', { get: function () { return function () { n.prevented = true; }; }, set: function () {}, configurable: true });
      e.cancelable = true;
      st.fire(type, e);
      return n.prevented;
    }
    var pd = send('pointerdown', { target: UI, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0, clientX: 600, clientY: 400 });
    check(!pd && !st.takeJump() && !st.takeAny() && !st.jumpHeld, 'a click on the share button must not jump / restart, nor be cancelled');
    send('pointerup', { target: UI, pointerId: 1, isPrimary: true, pointerType: 'mouse', button: 0 });
    var kd = send('keydown', { target: UI, code: 'Space' });
    check(!kd && !st.takeJump() && !st.takeAny() && !st.jumpHeld, 'Space on a focused UI button must activate it (no jump, not cancelled)');
    check(!send('keyup', { target: UI, code: 'Space' }), 'Space key-up on a UI button must keep its default (activation)');
    check(!send('keydown', { target: UI, code: 'Enter' }) && !st.takeRestart() && !st.takeAny(), 'Enter on a UI button must not restart');
    var paused = 0;
    var st2 = load({ onPause: function () { paused++; }, isUiTarget: function (t) { return t && t.ui; } });
    st2.fire('keydown', { target: UI, code: 'Escape' });
    check(paused === 0, 'Escape on the UI (closing the share menu) must not pause');
    send('keydown', { target: UI, code: 'KeyM' });
    check(mutes === 1, 'M still mutes while the share button has focus');
    check(!send('touchstart', { target: UI }) && send('touchstart', { target: CANVAS }), 'touchstart: kept on the UI (its click), cancelled on the canvas');
    // a press that only dismissed the share menu (share.consumes(e)) is not a game press either
    var outside = { target: CANVAS, pointerId: 2, isPrimary: true, pointerType: 'touch', button: 0, clientX: 900, clientY: 100 };
    consumed = outside;
    send('pointerdown', outside);
    check(!st.takeJump() && !st.takeDuck() && !st.takeAny(), 'the press that closed the menu must not restart');
    send('pointerup', outside);
    consumed = null;
    check(send('pointerdown', { target: CANVAS, pointerId: 3, isPrimary: true, pointerType: 'touch', button: 0, clientX: 900, clientY: 100 }) && st.takeJump(), 'the next canvas tap jumps / restarts');
    check(send('keydown', { target: CANVAS, code: 'Space' }) && st.takeJump(), 'Space on the page (not on the UI) still jumps / restarts');
  });

  test('audio unlock on activation events: pointerup and touchend, not pointercancel', function () {
    var n = 0;
    var st = load({ onGesture: function () { n++; } });
    st.touch('pointerdown', 1, true, HIGH);
    check(n === 1, 'pointerdown unlocks');
    st.touch('pointerup', 1, true, HIGH);
    check(n === 2, 'pointerup unlocks');
    st.touch('pointerdown', 2, true, HIGH);
    st.touch('pointercancel', 2, true, HIGH);
    check(n === 3, 'pointercancel must not unlock');
    st.fire('touchend', {});
    check(n === 4, 'touchend unlocks');
  });

  test('a modifier on its own is no press: Shift of Shift+D (debug) must not resume a paused game', function () {
    var debug = 0;
    var st = load({ onDebug: function () { debug++; } });
    // a real Shift+D sends a keydown for Shift itself first (then KeyD with shiftKey); main.js resumes a pause on takeAny()
    st.fire('keydown', { code: 'ShiftLeft', key: 'Shift', shiftKey: true });
    st.fire('keydown', { code: 'KeyD', key: 'D', shiftKey: true });
    check(debug === 1, 'Shift+D toggles the debug overlay');
    check(!st.takeAny() && !st.takeJump() && !st.takeDuck() && !st.takeRestart(), 'Shift / Shift+D must not count as a press (a pause would resume)');
    ['ShiftRight', 'CapsLock', 'MetaLeft', 'AltRight', 'ControlLeft'].forEach(function (c) { st.fire('keydown', { code: c, key: c.replace(/(Left|Right)$/, '') }); });
    st.fire('keydown', { code: '', key: 'Shift' }); // (a keyboard that reports no code)
    check(!st.takeAny(), 'modifier keys alone must not resume a pause');
    st.fire('keydown', { code: 'KeyX', key: 'x' });
    check(st.takeAny(), 'any other key still resumes');
  });
}

/** src/i18n.js (language negotiation, ?lang, strings, live languagechange) and src/share.js's pure helpers. */
function i18nShareSuite() {
  console.log('\n# i18n + share (src/i18n.js, src/share.js helpers, stub window)');
  function loadI18n(languages, search) {
    var listeners = {};
    var win = {
      navigator: { languages: languages, language: languages[0] },
      location: { search: search || '' },
      URLSearchParams: URLSearchParams,
      addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      console: console
    };
    vm.createContext(win);
    var file = path.join(ROOT, 'src/i18n.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), win, { filename: file });
    win.fire = function (type) { (listeners[type] || []).forEach(function (fn) { fn({ type: type }); }); };
    return win;
  }
  function loadShare() {
    var win = { console: console };
    vm.createContext(win);
    var file = path.join(ROOT, 'src/share.js');
    vm.runInContext(fs.readFileSync(file, 'utf8'), win, { filename: file });
    return win.RDG.Share;
  }

  test('language: first ja / en entry of navigator.languages (else en); ?lang=ja|en overrides', function () {
    var cases = [
      [['ja'], 'ja'], [['en-US'], 'en'], [['fr', 'ja'], 'ja'], [['fr'], 'en'], [['en-GB', 'ja'], 'en'],
      [['ja-JP', 'en'], 'ja'], [['de-DE', 'en-US', 'ja'], 'en'], [['zh-Hant-TW', 'JA_jp'], 'ja'], [[], 'en']
    ];
    cases.forEach(function (c) {
      var w = loadI18n(c[0]);
      check(w.RDG.i18n.lang === c[1], JSON.stringify(c[0]) + ' -> ' + w.RDG.i18n.lang + ', expected ' + c[1]);
    });
    check(loadI18n(['en-US'], '?lang=ja').RDG.i18n.lang === 'ja', '?lang=ja on an English browser');
    check(loadI18n(['ja'], '?seed=3&lang=en').RDG.i18n.lang === 'en', '?lang=en on a Japanese browser');
    check(loadI18n(['ja'], '?lang=de').RDG.i18n.lang === 'ja', 'an unsupported ?lang falls back to the browser');
  });

  test('strings: en / ja key parity, {name} interpolation, fallbacks', function () {
    var i = loadI18n(['ja']).RDG.i18n, S = i.STRINGS;
    Object.keys(S.en).forEach(function (k) { check(S.ja[k] != null, 'ja lacks ' + k); });
    Object.keys(S.ja).forEach(function (k) { check(S.en[k] != null, 'en lacks ' + k); });
    check(i.t('a11y.over', { score: 46, hi: 812 }) === 'ゲームオーバー。スコア 46、ハイスコア 812。スペースキーかタップでリスタート。', 'ja game-over announcement');
    check(i.t('title') === 'リアル恐竜ゲーム' && i.t('share.button') === 'シェア' && i.t('share.copied') === 'コピーしました', 'ja UI strings');
    check(i.t('a11y.over', { score: 1 }).indexOf('{hi}') !== -1, 'a missing variable keeps its placeholder');
    check(i.t('no.such.key') === 'no.such.key', 'an unknown key returns the key');
    i.setLang('en');
    check(i.t('title') === 'Real Dinosaur Game' && i.t('share.button') === 'Share' && i.t('share.copied') === 'Copied!', 'en UI strings');
  });

  test('live languagechange follows the browser (unless ?lang pins it) and notifies listeners', function () {
    var w = loadI18n(['ja']), seen = [];
    w.RDG.i18n.onChange(function (l) { seen.push(l); });
    w.navigator.languages = ['fr-FR', 'en-GB'];
    w.fire('languagechange');
    check(w.RDG.i18n.lang === 'en' && seen.join() === 'en', 'switched to en: ' + w.RDG.i18n.lang + ' / ' + seen);
    w.fire('languagechange');
    check(seen.length === 1, 'no notification without a change');
    var p = loadI18n(['ja'], '?lang=ja');
    p.navigator.languages = ['en-US'];
    p.fire('languagechange');
    check(p.RDG.i18n.lang === 'ja', '?lang=ja must pin the language');
  });

  test('share text (exact), public URL rules, intent links', function () {
    var Share = loadShare(), ja = loadI18n(['ja']).RDG.i18n, en = loadI18n(['en']).RDG.i18n;
    check(Share.shareText(ja.t, 123, false) === 'リアル恐竜ゲームで 123 点を記録！\uD83E\uDD96 #RealDinosaurGame', 'ja text: ' + Share.shareText(ja.t, 123, false));
    check(Share.shareText(ja.t, 123, true) === 'リアル恐竜ゲームで 123 点を記録！自己ベスト更新！\uD83E\uDD96 #RealDinosaurGame', 'ja best text');
    check(Share.shareText(en.t, 123, false) === 'I scored 123 in Real Dinosaur Game! \uD83E\uDD96 #RealDinosaurGame', 'en text: ' + Share.shareText(en.t, 123, false));
    check(Share.shareText(en.t, 123, true) === 'I scored 123 in Real Dinosaur Game! New personal best! \uD83E\uDD96 #RealDinosaurGame', 'en best text');
    check(Share.shareText(en.t, 45.9, false).indexOf('scored 45 ') !== -1, 'score is a plain integer');
    function loc(href) { var u = new URL(href); return { protocol: u.protocol, host: u.host, hostname: u.hostname, pathname: u.pathname }; }
    var priv = ['file:///Users/me/rdg/index.html', 'http://localhost:8000/', 'http://app.localhost/', 'http://127.0.0.1:9000/',
      'http://127.8.9.10/', 'http://[::1]:8080/', 'http://10.0.0.5/', 'http://172.16.0.1/', 'http://172.31.255.254/',
      'http://192.168.1.20:8765/', 'http://169.254.10.10/', 'http://mac-mini.local/', 'http://devbox/', 'http://[fd12::1]/',
      'http://[fe80::1]/', 'http://[::ffff:192.168.0.1]/', 'http://0.0.0.0:8765/', 'http://100.101.102.103/'];
    priv.forEach(function (h) { check(Share.publicUrl(loc(h), '') === '', h + ' must not be shared'); });
    check(Share.publicUrl(loc('https://example.com/games/rdg/index.html?seed=3&bot=1#x'), '') === 'https://example.com/games/rdg/index.html', 'query / hash dropped');
    check(Share.publicUrl(loc('http://172.32.0.1:8080/'), '') === 'http://172.32.0.1:8080/', '172.32/16 is public');
    check(Share.publicUrl(loc('file:///x/index.html'), 'https://example.com/rdg/') === 'https://example.com/rdg/', 'SHARE_URL wins');
    var t = Share.shareText(ja.t, 7, false), L = Share.links(t, '');
    check(!L.facebook && L.x.indexOf('&url=') === -1 && L.line && L.bluesky, 'no URL: no Facebook, no url= param');
    check(/^https:\/\/x\.com\/intent\/post\?text=[^ #]+$/.test(L.x) && L.x.indexOf('%23RealDinosaurGame') !== -1 && L.x.indexOf('%F0%9F%A6%96') !== -1, 'X text encoded: ' + L.x);
    var U = 'https://example.com/rdg/?a=1&b=2', L2 = Share.links(t, U);
    check(L2.x.slice(-('&url=' + encodeURIComponent(U)).length) === '&url=' + encodeURIComponent(U), 'X url= param');
    check(L2.facebook === 'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(U), 'Facebook u=');
    check(decodeURIComponent(L2.bluesky.split('?text=')[1]) === t + ' ' + U && L2.bluesky.indexOf('https://bsky.app/intent/compose?text=') === 0, 'Bluesky text carries the URL');
    check(decodeURIComponent(L2.line.split('?text=')[1]) === t + ' ' + U && L2.line.indexOf('https://line.me/R/share?text=') === 0, 'LINE text carries the URL');
  });

  test('share button: the OS share sheet first only on a touch UI; desktop gets the SNS menu (with "More…")', function () {
    var Share = loadShare(), fn = function () {};
    check(!Share.nativeFirst({ share: fn, canShare: fn }, false), 'desktop Chrome / Edge / Safari (share + canShare, no touch) -> the menu');
    check(Share.nativeFirst({ share: fn, canShare: fn }, true) && Share.nativeFirst({ share: fn }, true), 'touch + navigator.share -> the OS share sheet');
    check(!Share.nativeFirst({}, true) && !Share.nativeFirst({}, false) && !Share.nativeFirst(null, true), 'no navigator.share -> the menu');
    var ja = loadI18n(['ja']).RDG.i18n, en = loadI18n(['en']).RDG.i18n;
    check(ja.t('share.more') === 'その他…' && en.t('share.more') === 'More…', '"More…" item label');
    var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    ['x', 'bluesky', 'facebook', 'line', 'copy', 'save', 'more'].forEach(function (k) {
      check(html.indexOf('data-share="' + k + '"') !== -1, 'index.html lacks the menu item ' + k);
    });
  });
}

/** src/render.js: the GAME OVER composition on screen and in the share image (renderer.captureShareImage). */
function renderLayoutSuite() {
  console.log('\n# GAME OVER layout (src/render.js, no canvas)');
  require(path.join(ROOT, 'src/render.js'));
  var Renderer = RDG.Renderer;
  /** A renderer sized for a (vw x vh) CSS px viewport at dpr with a top safe-area inset (no canvas: layout only). */
  function sized(vw, vh, dpr, safeTop) {
    var R = Object.create(Renderer.prototype);
    R.cfg = C; R.canvas = { style: {} }; R.ctx = {}; R.A = null; R.layer = null;
    R.resize(vw, vh, dpr, safeTop);
    R._layoutGameOver(); // (what _build does on every resize once the assets are in)
    return R;
  }
  /** Device-px bottom of the score HUD's glyph cells (render.js _buildHud / _hud) and the title's top, in a layout. */
  function hudBottom(R) {
    var px = Math.max(6, Math.round(C.HUD_SIZE * R.bs)), ch = Math.ceil(px * 1.3);
    return Math.round(C.HUD_TOP * R.bs - ch / 2) + R.tpx + R.hudDy + ch;
  }
  function titleTop(go) { return go.titleY - 0.5 * go.titlePx; }

  test('share image: GAME OVER never under the score HUD (portrait phones pin the HUD on screen, not in the image)', function () {
    var sizes = [[390, 844, 2, 47], [430, 932, 2, 47], [320, 568, 2, 20], [360, 800, 2, 24], [375, 667, 2, 20],
      [412, 915, 2.625, 24], [600, 960, 2, 0], [768, 1024, 2, 0], [1024, 768, 2, 0], [1280, 1024, 1, 0],
      [844, 390, 2, 0], [667, 375, 2, 0], [1600, 632, 1, 0], [1600, 632, 2, 0], [2560, 1080, 2, 0], [2400, 600, 1, 0]];
    var pinned = 0;
    sizes.forEach(function (a) {
      var R = sized(a[0], a[1], a[2], a[3]), tag = a.join('x'), live = R._go, hudDy = R.hudDy, hudY = R.hudY;
      check(live && titleTop(live) > hudBottom(R), tag + ': on screen the title must be below the HUD');
      if (hudDy) pinned++;
      R._shareState(true); // what captureShareImage renders
      var g = R._go, band0 = R.tpx, band1 = R.tpx + C.H * R.bs;
      check(R.hudDy === 0 && R.hudY === hudY - hudDy, tag + ': the image has the HUD on its playfield line');
      check(titleTop(g) > hudBottom(R) + 2, tag + ': image title top ' + titleTop(g).toFixed(1) + ' overlaps the HUD (bottom ' + hudBottom(R) + ')');
      check(titleTop(g) >= band0 && g.iconY > g.titleY + 0.5 * g.titlePx && g.iconY + g.iconS <= R.tpx + (C.MOUNTAIN_PEAK_Y) * R.bs && g.iconY + g.iconS < band1,
        tag + ': image title / icon inside the crop, the icon above the mountains');
      check(g.titlePx === live.titlePx && g.iconS === live.iconS, tag + ': same title / icon sizes (the cached title font and icon)');
      if (!hudDy && titleTop(live) - R.tpx > 0.3 * C.H * R.bs) check(g.titleY === live.titleY && g.iconY === live.iconY, tag + ': desktop image = the screen');
      R._shareState(false);
      check(R._go === live && R.hudDy === hudDy && R.hudY === hudY, tag + ': the on-screen state is restored');
    });
    check(pinned >= 8, 'the portrait / tall sizes pin the HUD on screen: ' + pinned);
  });
}

// -----------------------------------------------------------------------------------------------------------------
var t0 = Date.now();
var manifest = loadManifest();
var metricsReal = manifest ? Sim.buildMetrics(manifest, C) : null;
var metricsDefault = Sim.buildMetrics(null, C);
console.log('Real Dinosaur Game — sim tests (node ' + process.version + ')');
if (!metricsReal) console.log('(assets/manifest.js not found or empty: testing built-in default sprite metrics only)');

var primary = metricsReal || metricsDefault;
physicsSuite(primary);
inputSuite();
i18nShareSuite();
renderLayoutSuite();
runSuite(metricsReal ? 'real asset manifest' : 'built-in defaults', primary, SEEDS, MINUTES);
if (metricsReal) runSuite('built-in default metrics (placeholder fallback)', metricsDefault, Math.max(4, Math.round(SEEDS / 4)), 3.2);

console.log('\n' + (failures ? failures + ' test(s) FAILED' : 'all tests passed') + ' — ' + checks + ' checks in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
process.exit(failures ? 1 : 0);
