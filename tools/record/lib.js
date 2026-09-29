/* Shared helpers for the video recorder (tools/record/*.js). Plain Node 22, no dependencies.
 *
 * loadGame() evaluates the page's own classic scripts in a vm context, in index.html's order (assets/manifest.js,
 * src/config.js, src/rng.js, src/sim.js), so the simulation, the sprite metrics and the bot are exactly the page's.
 * Game(...) then mirrors src/main.js for a `?seed=S&bot=1[&sim=MS]&freeze=1` page: the same Sim.create options, the
 * same Bot.create({}) and the same bot branch of main.js's tick() (auto-start 45 ticks after load; no auto-restart
 * on a frozen page). Keep it in step with main.js. */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var ROOT = path.resolve(__dirname, '..', '..');
var SCRIPTS = ['assets/manifest.js', 'src/config.js', 'src/rng.js', 'src/sim.js']; // index.html order (sim-relevant)

/** Evaluate the page scripts in a fresh context. Returns { RDG, Sim, Bot, cfg, manifest, metrics }. */
function loadGame() {
  var ctx = vm.createContext({ console: console });
  vm.runInContext('var window = globalThis;', ctx);
  SCRIPTS.forEach(function (rel) {
    var file = path.join(ROOT, rel);
    vm.runInContext(fs.readFileSync(file, 'utf8'), ctx, { filename: file });
  });
  var RDG = ctx.RDG, cfg = RDG.config, Sim = RDG.Sim;
  var manifest = ctx.ASSET_MANIFEST || {}; // main.js: root.ASSET_MANIFEST || {}
  var metrics = Sim.buildMetrics(manifest, cfg); // main.js: Sim.buildMetrics(manifest, cfg)
  // the shipped values of the keys a recording may override (see Game opts.nightDurationMs)
  var defaults = { NIGHT_DURATION: cfg.NIGHT_DURATION };
  return { RDG: RDG, Sim: Sim, Bot: RDG.Bot, cfg: cfg, manifest: manifest, metrics: metrics, defaults: defaults };
}

/** Playfield width in world units for a viewport (render.js Renderer.prototype.resize, RC.VIEW_MIN_W / DINO_MIN_CSS_H). */
function viewWidth(cfg, vw, vh) {
  var H = cfg.H, VIEW_MIN_W = 1350, DINO_MIN_CSS_H = 44;
  var wMin = Math.min(VIEW_MIN_W, Math.max(Math.round(H * cfg.ASPECT_MIN), Math.floor((cfg.DINO_HEIGHT * vw) / DINO_MIN_CSS_H)));
  return Math.min(Math.round(H * cfg.ASPECT_MAX), Math.max(Math.round((H * vw) / vh), wMin));
}

/** ms value for ?sim= that main.js's advance() turns into exactly `ticks` ticks (n = Math.round(ms / STEP_MS)). */
function simMsForTicks(cfg, ticks) {
  var ms = Math.round(ticks * cfg.STEP_MS);
  if (Math.round(ms / cfg.STEP_MS) !== ticks) throw new Error('no integer ?sim= for ' + ticks + ' ticks');
  return ms;
}

/**
 * A page-equivalent game: main.js with ?seed=seed&bot=1 (&sim=simMs when given) &freeze=1 (&hi=hi).
 * tick() = main.js tick() (bot branch); botOff(): from now on the bot presses nothing (the recorder does the same in
 * the page by replacing __rdg.bot.update with a function that clears its output).
 * opts.nightDurationMs (recording only, the promo video's short night): after the load and the ?sim= fast-forward
 * the recorder sets the page's RDG.config.NIGHT_DURATION (= sim.cfg, shared by the sim and the bot's clones) to this
 * value, before it steps the first frame; this game does the same on G.cfg (reset to the shipped value first, so
 * an earlier game's override never leaks into the fast-forward). The night cycle is visual only (sim.js: no
 * obstacle, physics, bot or RNG code reads it) and the state hash does not include it, so compare nightPhase too.
 */
function Game(G, opts) {
  opts = opts || {};
  var Sim = G.Sim, cfg = G.cfg;
  if (G.defaults) cfg.NIGHT_DURATION = G.defaults.NIGHT_DURATION; // the page loads with the shipped config
  this.G = G;
  this.params = { seed: (opts.seed == null ? 1 : Number(opts.seed)) >>> 0, sim: Math.max(0, opts.simMs || 0), hi: opts.hi | 0, freeze: true };
  this.sim = Sim.create({ seed: this.params.seed, metrics: G.metrics, cfg: cfg, hiScore: Math.max(0, this.params.hi) });
  this.bot = G.Bot.create({});
  this.botEnabled = true;
  this.inp = { jumpPressed: false, jumpHeld: false, duckPressed: false, duckHeld: false }; // main.js tickInput (reused)
  this.onEvents = opts.onEvents || null; // (sim, evArray) after each tick, before they are cleared (main.js handleEvents)
  this.beforeStep = opts.beforeStep || null; // (sim, inp, game) after the input is decided, before Sim.step
  // main.js applyParams(): ?sim= starts the run directly (no jump press) and fast-forwards n = round(ms / STEP_MS) ticks.
  // opts.started: the same start with 0 ticks (the search walks the ?sim= path tick by tick).
  if (this.params.sim > 0 || opts.started) {
    Sim.start(this.sim);
    if (this.params.sim > 0) this.advance(this.params.sim);
  }
  this.nightDurationMs = opts.nightDurationMs == null ? null : Number(opts.nightDurationMs);
  if (this.nightDurationMs != null) cfg.NIGHT_DURATION = this.nightDurationMs; // the recorder's override, after load
}
Game.prototype.tick = function () {
  var Sim = this.G.Sim, sim = this.sim, STATUS = Sim.STATUS, inp = this.inp;
  // main.js tick(), bot branch
  if (sim.status === STATUS.RUNNING) {
    if (this.botEnabled) this.bot.update(sim, inp);
    else { inp.jumpPressed = false; inp.jumpHeld = false; inp.duckPressed = false; inp.duckHeld = false; }
  } else { inp.jumpPressed = false; inp.jumpHeld = false; inp.duckPressed = false; inp.duckHeld = false; }
  if (sim.status === STATUS.IDLE && sim.tick > 45) inp.jumpPressed = true; // demo: auto-start
  // (main.js restarts 1600 ms after a crash only when not frozen; the recorder's pages are frozen)
  if (this.beforeStep) this.beforeStep(sim, inp, this);
  Sim.step(sim, inp);
  if (this.onEvents && sim.nEv) this.onEvents(sim, Array.prototype.slice.call(sim.ev, 0, sim.nEv));
  sim.nEv = 0; // main.js handleEvents()
};
Game.prototype.advance = function (ms) {
  var n = Math.round(ms / this.G.cfg.STEP_MS);
  for (var i = 0; i < n; i++) this.tick();
};
Game.prototype.botOff = function () { this.botEnabled = false; };

/** Frames after the crash frame until the GAME OVER share button shows (sim.gameOverTime >= GAMEOVER_CLEAR_TIME;
 * gameOverTime is 0 on the crash tick and grows by STEP_MS per tick, summed exactly like sim.js). */
function shareDelayFrames(cfg) {
  var t = 0, k = 0;
  while (t < cfg.GAMEOVER_CLEAR_TIME) { t += cfg.STEP_MS; k++; }
  return k;
}

/**
 * The video timeline for plan.candidates[candidate] (0 = the chosen plan), in video frames (1 frame = 1 tick):
 *   intro page (?seed=introSeed&bot=1&freeze=1...): intro frame i shows sim.tick === i, frames 0..introFrames-1;
 *   main page (?sim=mainStartMs): main frame j shows sim.tick === startTick + j, frames 0..mainFrames-1;
 *   video frame v: v < mainOffset -> intro v; v >= introFrames -> main v - mainOffset; in between the two are
 *   crossfaded (mainOffset = introFrames - xfadeFrames).
 * Main segment length: a plan with exactFrames (plan.js's early and day stories) is played exactly as planned
 * (candidate.mainFrames, so the video is exactly plan.totalFrames long); an older plan ends holdMs after the frame
 * on which the share button appears (its own hold was shorter, since the planner capped the segment at 17 s).
 * --hold (opts.holdMs) always overrides. The page is frozen, nothing restarts, so the recorder may run on.
 * main.nightDurationMs: the recording-only night length to set on the main page (null: the shipped 12 s).
 */
function timeline(plan, cfg, opts) {
  opts = opts || {};
  var ci = Number(opts.candidate || 0), c = plan.candidates[ci];
  if (!c) throw new Error('plan has no candidate #' + ci);
  var step = cfg.STEP_MS;
  var introSeed = ci === 0 || plan.intro.fixedSeed ? plan.intro.seed : c.seed;
  var q = function (seed, extra) {
    return 'index.html?seed=' + seed + '&bot=1' + extra + '&freeze=1&lang=' + plan.lang + '&hi=' + c.hi + '&share=1';
  };
  var crashFrame = c.crashTick - c.startTick;
  var shareFrame = crashFrame + shareDelayFrames(cfg);
  var holdMs = opts.holdMs != null ? Number(opts.holdMs) : plan.exactFrames ? Math.round((c.mainFrames - shareFrame) * step) : 1700;
  var mainFrames = opts.holdMs == null && plan.exactFrames ? c.mainFrames : shareFrame + Math.round(holdMs / step);
  var introFrames = plan.intro.frames, xfade = plan.xfadeFrames, mainOffset = introFrames - xfade;
  var total = mainOffset + mainFrames;
  return {
    candidate: ci, fps: plan.fps, viewport: plan.viewport, lang: plan.lang, hi: c.hi,
    intro: { seed: introSeed, url: q(introSeed, ''), frames: introFrames, startTick: 0, autoStartTick: plan.intro.autoStartTick },
    main: {
      seed: c.seed, url: q(c.seed, '&sim=' + c.mainStartMs), mainStartMs: c.mainStartMs, startTick: c.startTick,
      botOffTick: c.botOffTick, crashTick: c.crashTick, crashSerial: c.crash.serial, finalScore: c.finalScore,
      nightDurationMs: c.nightDurationMs == null ? null : c.nightDurationMs,
      crashFrame: crashFrame, shareFrame: shareFrame, frames: mainFrames,
      posterFrame: ci === 0 && plan.main.posterFrame != null ? plan.main.posterFrame : c.posterFrame != null ? c.posterFrame
        : c.nightPtero ? Math.round(c.nightPtero.at * plan.fps) - 12 : crashFrame - 60
    },
    xfadeFrames: xfade, mainOffset: mainOffset, totalFrames: total, seconds: total / plan.fps, holdMs: holdMs,
    /** video frame of intro frame i / main frame j */
    introVideoFrame: function (i) { return i; },
    mainVideoFrame: function (j) { return mainOffset + j; }
  };
}

module.exports = {
  ROOT: ROOT, loadGame: loadGame, viewWidth: viewWidth, simMsForTicks: simMsForTicks, Game: Game,
  shareDelayFrames: shareDelayFrames, timeline: timeline
};
