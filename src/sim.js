/* Real Dinosaur Game — PURE deterministic simulation. No DOM / canvas.
 * Loads as a classic browser script (attaches to globalThis.RDG) and in Node (module.exports = RDG).
 * Requires RDG.config (config.js) and RDG.rng (rng.js) to be loaded first.
 *
 * Everything advances in fixed 1/60 s ticks. The obstacle sequence depends only on the seed and elapsed ticks
 * (never on the player's actions), which makes cloned look-ahead (bot) and fairness probing exact. */
(function (root, factory) {
  var RDG = (root.RDG = root.RDG || {});
  factory(RDG);
  if (typeof module === 'object' && module && module.exports) module.exports = RDG;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (RDG) {
  'use strict';

  var RNG = RDG.rng;

  var STATUS = { IDLE: 0, RUNNING: 1, CRASHED: 2 };
  var ANIM = { IDLE: 0, RUN: 1, DUCK: 2, JUMP: 3, DEAD: 4 };
  var ANIM_KEYS = ['idle', 'run', 'duck', 'jump', 'dead'];
  var OT = { SMALL: 0, LARGE: 1, PTERO: 2 };
  var OT_NAMES = ['cactusSmall', 'cactusLarge', 'ptero'];
  var EV = { START: 1, JUMP: 2, LAND: 3, FASTDROP: 4, MILESTONE: 5, CRASH: 6, NIGHT_ON: 7, NIGHT_OFF: 8, SPAWN: 9 };
  var MAX_EV = 64;
  // union-hitbox states used by the fairness probe
  var ST_RUN = 0, ST_JUMP = 1, ST_DUCK = 2;
  var F_JUMP = 1, F_DROP = 2, F_LAND = 4;

  // --------------------------------------------------------------------------------------------------------------
  // Built-in sprite geometry (manifest-shaped) used when assets/manifest.js lacks a group. The placeholder art in
  // assets.js is drawn from these hitboxes, so what you see is what collides.
  var DEFAULT_SPRITES = {
    dino: {
      frameW: 658, frameH: 400, baselinePx: 389, standHeightPx: 300, tailTipPx: 28,
      frames: {
        idle: [{ hitboxes: [[470, 77, 126, 53], [216, 137, 297, 56], [213, 201, 257, 57], [287, 266, 107, 56], [340, 330, 47, 52], [268, 330, 31, 55]] }],
        run: [
          { hitboxes: [[468, 101, 132, 48], [301, 156, 250, 52], [173, 216, 289, 53], [200, 275, 211, 52], [158, 334, 29, 47], [410, 334, 70, 52]] },
          { hitboxes: [[468, 94, 133, 50], [283, 152, 260, 53], [207, 212, 263, 54], [273, 273, 112, 53], [324, 333, 45, 53]] },
          { hitboxes: [[466, 97, 133, 49], [293, 154, 252, 53], [189, 214, 280, 53], [213, 274, 168, 53], [175, 333, 26, 46], [374, 333, 64, 52]] },
          { hitboxes: [[468, 97, 133, 48], [304, 153, 245, 53], [202, 213, 267, 54], [254, 274, 151, 53], [223, 333, 32, 52]] }
        ],
        duck: [
          { hitboxes: [[170, 248, 388, 24], [174, 275, 440, 25], [201, 304, 411, 26], [149, 334, 50, 25], [299, 334, 108, 25], [315, 363, 71, 25]] },
          { hitboxes: [[213, 243, 352, 25], [216, 271, 402, 26], [241, 301, 375, 27], [196, 332, 31, 53], [330, 332, 70, 55]] }
        ],
        jump: [{ hitboxes: [[469, 104, 132, 40], [324, 150, 260, 44], [208, 200, 273, 44], [256, 250, 216, 44], [312, 300, 63, 40]] }],
        dead: [{ hitboxes: [[421, 14, 100, 65], [347, 89, 167, 68], [261, 166, 182, 67], [211, 242, 216, 68], [341, 318, 47, 66]] }]
      }
    },
    cactus: {
      large: [
        { w: 175, h: 480, hitboxes: [[63, 37, 50, 442], [132, 114, 34, 128], [8, 153, 36, 110], [27, 266, 97, 33], [56, 239, 96, 27]] },
        { w: 134, h: 466, hitboxes: [[13, 25, 50, 430], [93, 142, 32, 110], [8, 258, 100, 34]] },
        { w: 229, h: 494, hitboxes: [[89, 44, 56, 447], [34, 146, 27, 67], [188, 224, 28, 75], [13, 258, 26, 62], [79, 295, 119, 30], [36, 322, 119, 31]] }
      ],
      small: [
        { w: 79, h: 300, hitboxes: [[13, 20, 53, 270]] },
        { w: 78, h: 312, hitboxes: [[36, 12, 26, 296], [6, 88, 18, 50]] },
        { w: 133, h: 270, hitboxes: [[26, 30, 81, 230]] }
      ]
    },
    ptero: {
      frameW: 639, frameH: 499, wingspanPx: 620, bodyCenterYPx: 288,
      frames: [
        { hitboxes: [[317, 306, 96, 30], [284, 281, 68, 31], [174, 253, 66, 24], [395, 160, 46, 152], [289, 210, 30, 77]] },
        { hitboxes: [[317, 306, 96, 30], [284, 281, 68, 31], [174, 253, 66, 24], [361, 265, 87, 47], [437, 217, 55, 54], [161, 223, 45, 36]] },
        { hitboxes: [[317, 306, 96, 30], [284, 281, 68, 31], [174, 253, 66, 24], [194, 328, 77, 41], [238, 306, 85, 28], [173, 363, 59, 25]] },
        { hitboxes: [[317, 306, 96, 30], [284, 281, 68, 31], [174, 253, 66, 24], [361, 265, 87, 47], [437, 217, 55, 54], [161, 223, 45, 36]] }
      ]
    }
  };

  // --------------------------------------------------------------------------------------------------------------
  // Sprite metrics (world units) derived from the manifest

  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function validBoxes(b) {
    if (!Array.isArray(b) || !b.length) return false;
    for (var i = 0; i < b.length; i++) {
      var r = b[i];
      if (!Array.isArray(r) || r.length < 4 || !isNum(r[0]) || !isNum(r[1]) || !(r[2] > 0) || !(r[3] > 0)) return false;
    }
    return true;
  }
  function validFrameList(l) {
    if (!Array.isArray(l) || !l.length) return false;
    for (var i = 0; i < l.length; i++) if (!l[i] || !validBoxes(l[i].hitboxes)) return false;
    return true;
  }
  function validDino(d) {
    return !!(d && isNum(d.frameW) && isNum(d.frameH) && isNum(d.baselinePx) && d.standHeightPx > 0 && d.frames &&
      validFrameList(d.frames.run));
  }
  function validCactus(c) {
    function ok(list) {
      if (!Array.isArray(list) || !list.length) return false;
      for (var i = 0; i < list.length; i++) if (!list[i] || !(list[i].w > 0) || !(list[i].h > 0) || !validBoxes(list[i].hitboxes)) return false;
      return true;
    }
    return !!(c && ok(c.large) && ok(c.small));
  }
  function validPtero(p) {
    return !!(p && isNum(p.frameW) && isNum(p.frameH) && isNum(p.bodyCenterYPx) && validFrameList(p.frames));
  }

  /** Build a rect set {r: Float64Array[x0,y0,x1,y1...], n, x0,x1,y0,y1 (bbox)} from manifest boxes. */
  function rectSet(boxes, s, ox, oy, refY) {
    var n = boxes.length, r = new Float64Array(n * 4);
    var bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (var i = 0; i < n; i++) {
      var b = boxes[i];
      var x0 = ox + b[0] * s, y0 = oy + (b[1] - refY) * s, x1 = x0 + b[2] * s, y1 = y0 + b[3] * s;
      r[i * 4] = x0; r[i * 4 + 1] = y0; r[i * 4 + 2] = x1; r[i * 4 + 3] = y1;
      if (x0 < bx0) bx0 = x0; if (x1 > bx1) bx1 = x1; if (y0 < by0) by0 = y0; if (y1 > by1) by1 = y1;
    }
    return { r: r, n: n, x0: bx0, x1: bx1, y0: by0, y1: by1 };
  }
  function unionSets(sets) {
    var n = 0, i, j;
    for (i = 0; i < sets.length; i++) n += sets[i].n;
    var r = new Float64Array(n * 4), k = 0;
    var bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (i = 0; i < sets.length; i++) {
      var s = sets[i];
      for (j = 0; j < s.n * 4; j++) r[k++] = s.r[j];
      if (s.x0 < bx0) bx0 = s.x0; if (s.x1 > bx1) bx1 = s.x1; if (s.y0 < by0) by0 = s.y0; if (s.y1 > by1) by1 = s.y1;
    }
    return { r: r, n: n, x0: bx0, x1: bx1, y0: by0, y1: by1 };
  }

  /**
   * Sprite metrics in world units, derived from window.ASSET_MANIFEST (or built-in defaults per group).
   * Dino rects: x absolute world, y relative to the feet (negative = up).
   * Cactus rects: x relative to the sprite's left edge, y relative to its base.
   * Ptero rects: x relative to the frame's left edge, y relative to bodyCenterYPx.
   */
  function buildMetrics(manifest, cfg) {
    cfg = cfg || RDG.config;
    var man = manifest || {};
    var src = {
      dino: validDino(man.dino) ? 'manifest' : 'default',
      cactus: validCactus(man.cactus) ? 'manifest' : 'default',
      ptero: validPtero(man.ptero) ? 'manifest' : 'default'
    };
    var D = src.dino === 'manifest' ? man.dino : DEFAULT_SPRITES.dino;
    var CA = src.cactus === 'manifest' ? man.cactus : DEFAULT_SPRITES.cactus;
    var P = src.ptero === 'manifest' ? man.ptero : DEFAULT_SPRITES.ptero;
    var M = { source: src, cfg: cfg };

    // ---- dino ----
    var fr = D.frames;
    var kinds = {};
    kinds.run = fr.run;
    kinds.idle = validFrameList(fr.idle) ? fr.idle : [fr.run[0]];
    kinds.jump = validFrameList(fr.jump) ? fr.jump : [fr.run[0]];
    kinds.dead = validFrameList(fr.dead) ? fr.dead : [kinds.idle[0]];
    var duckFallback = !validFrameList(fr.duck);
    kinds.duck = duckFallback ? fr.run : fr.duck;
    var s = cfg.DINO_HEIGHT / D.standHeightPx;
    var minHit = Infinity, maxHit = -Infinity, k, i, j;
    for (i = 0; i < kinds.run.length; i++) {
      var hb = kinds.run[i].hitboxes;
      for (j = 0; j < hb.length; j++) { minHit = Math.min(minHit, hb[j][0]); maxHit = Math.max(maxHit, hb[j][0] + hb[j][2]); }
    }
    var tailTipPx = isNum(D.tailTipPx) ? D.tailTipPx : Math.max(0, Math.min(minHit, maxHit - 1.8 * D.standHeightPx));
    var drawX = cfg.DINO_TAIL_X - tailTipPx * s;
    var dm = {
      s: s, drawX: drawX, frameW: D.frameW * s, frameH: D.frameH * s, baseline: D.baselinePx * s,
      frames: {}, duckFallback: duckFallback, counts: {}
    };
    for (k in kinds) {
      dm.frames[k] = [];
      for (i = 0; i < kinds[k].length; i++) {
        var boxes = kinds[k][i].hitboxes;
        if (k === 'duck' && duckFallback) {
          // no duck art: squash the run hitboxes to 58% height (renderer squashes the run frame the same way)
          boxes = boxes.map(function (b) {
            return [b[0], D.baselinePx - (D.baselinePx - b[1]) * 0.58, b[2], b[3] * 0.58];
          });
        }
        dm.frames[k].push(rectSet(boxes, s, drawX, 0, D.baselinePx));
      }
      dm.counts[k] = dm.frames[k].length;
    }
    dm.frameList = [dm.frames.idle, dm.frames.run, dm.frames.duck, dm.frames.jump, dm.frames.dead];
    dm.union = [unionSets(dm.frames.run), unionSets(dm.frames.jump), unionSets(dm.frames.duck)];
    var front = -Infinity, back = Infinity, standTop = 0, duckTop = 0;
    dm.frames.run.forEach(function (f) { front = Math.max(front, f.x1); });
    dm.union.forEach(function (u) { back = Math.min(back, u.x0); });
    dm.frames.run.concat(dm.frames.idle).forEach(function (f) { standTop = Math.max(standTop, -f.y0); });
    dm.frames.duck.forEach(function (f) { duckTop = Math.max(duckTop, -f.y0); });
    dm.front = front; dm.back = back; dm.hitLen = front - back;
    dm.maxX = Math.max(dm.union[0].x1, dm.union[1].x1, dm.union[2].x1);
    dm.standTop = standTop; dm.duckTop = duckTop;
    // visible length (tail tip -> snout): measured from the art when the manifest gives the tail tip, else the ratio
    dm.length = isNum(D.tailTipPx) && maxHit > D.tailTipPx ? (maxHit - D.tailTipPx) * s : cfg.DINO_HEIGHT * cfg.DINO_LENGTH_RATIO;
    M.dino = dm;

    // ---- cacti ----
    function cactusList(list, classH) {
      return list.map(function (v) {
        var sc = (classH * (isNum(v.scale) && v.scale > 0 ? v.scale : 1)) / v.h;
        var rs = rectSet(v.hitboxes, sc, 0, 0, v.h);
        return {
          w: v.w * sc, h: v.h * sc, s: sc, r: rs.r, n: rs.n, x0: rs.x0, x1: rs.x1, y0: rs.y0, y1: rs.y1,
          baseX: isNum(v.baseX) ? v.baseX * sc : v.w * sc * 0.5, baseW: isNum(v.baseW) ? v.baseW * sc : v.w * sc * 0.5
        };
      });
    }
    M.cactus = { large: cactusList(CA.large, cfg.CACTUS_LARGE_H), small: cactusList(CA.small, cfg.CACTUS_SMALL_H) };
    M.cactusByType = [M.cactus.small, M.cactus.large];

    // ---- pterodactyl ----
    var span = isNum(P.wingspanPx) && P.wingspanPx > 0 ? P.wingspanPx : P.frameW * 0.94;
    var sp = (cfg.PTERO_WINGSPAN_RATIO * dm.length) / span;
    var pm = { s: sp, frameW: P.frameW * sp, frameH: P.frameH * sp, center: P.bodyCenterYPx * sp, frames: [] };
    for (i = 0; i < P.frames.length; i++) pm.frames.push(rectSet(P.frames[i].hitboxes, sp, 0, 0, P.bodyCenterYPx));
    pm.union = unionSets(pm.frames);
    // visible extent relative to the body centre (union of every flap frame). The manifest's optional per-frame
    // "opaqueBox" covers the down-stroke wingtips, which reach well below the lowest hitbox; without it the
    // hitboxes are the best estimate.
    var visTop = pm.union.y0, visBottom = pm.union.y1, hasVis = true;
    for (i = 0; i < P.frames.length; i++) {
      var ob = P.frames[i].opaqueBox;
      if (!Array.isArray(ob) || ob.length < 4 || !isNum(ob[1]) || !(ob[3] > 0)) { hasVis = false; break; }
    }
    if (hasVis) {
      for (i = 0; i < P.frames.length; i++) {
        var obx = P.frames[i].opaqueBox;
        visTop = Math.min(visTop, (obx[1] - P.bodyCenterYPx) * sp);
        visBottom = Math.max(visBottom, (obx[1] + obx[3] - P.bodyCenterYPx) * sp);
      }
    }
    pm.visTop = visTop; pm.visBottom = visBottom; pm.hasVis = hasVis;
    M.ptero = pm;
    // altitudes (ptero body-centre world y) derived from the dino's real hitboxes. Each one satisfies the gameplay
    // rule on the hitboxes AND keeps the visible wingtips clear (never in the ground, never through the dino's head
    // or a ducking dino's back), so nothing ever looks like it passes through something without a crash.
    var G = cfg.GROUND_Y, mg = cfg.PTERO_ALT_MARGIN, vc = cfg.PTERO_VIS_CLEAR, pBottom = pm.union.y1;
    M.pteroY = [
      Math.min(G - cfg.PTERO_LOW_CLEAR - pBottom, G - vc - visBottom), // low: must jump
      Math.min(G - dm.duckTop - mg - pBottom, G - dm.duckTop - vc - visBottom), // mid: clears a ducking dino, hits a standing one
      Math.min(G - dm.standTop - mg - pBottom, G - dm.standTop - vc - visBottom) // high: clears a standing dino
    ];
    return M;
  }

  // --------------------------------------------------------------------------------------------------------------
  // State

  function makeDino() {
    return {
      y: 0, prevY: 0, vy: 0, jumping: false, ducking: false, speedDrop: false, reachedMin: false, jumpHeld: false,
      prevDuckHeld: false, jumpBuffer: 0, anim: ANIM.IDLE, frame: 0, phase: 0, jumps: 0
    };
  }
  function makeObstacle() {
    return {
      type: 0, n: 1, vs: [0, 0, 0], ovl: [0, 0, 0], oxs: [0, 0, 0], x: 0, prevX: 0, y: 0, w: 0, h: 0,
      hitL: 0, hitR: 0, top: 0, gap: 0, next: false, so: 0, alt: 0, frame: 0, phase: 0, serial: 0, R: 0, xmin: 0
    };
  }

  function create(opts) {
    opts = opts || {};
    var cfg = opts.cfg || RDG.config;
    var M = opts.metrics || buildMetrics(opts.manifest || null, cfg);
    var seed = opts.seed == null ? 1 : opts.seed >>> 0;
    var sim = {
      cfg: cfg, M: M, seed: seed, rng: RNG.create(seed),
      tick: 0, time: 0, status: STATUS.IDLE, runningTime: 0, runs: 0,
      speed: cfg.SPEED, distance: 0, prevDistance: 0, score: 0, hiScore: opts.hiScore | 0,
      milestone: 0, flashActive: false, flashTimer: 0, flashIter: 0, flashValue: 0,
      nightActive: false, nightTimer: 0, nightPhase: 0, nightBlock: 0,
      gameOverTime: 0, crashSerial: -1, crashType: -1, serial: 0, hist0: -1, hist1: -1, unfair: 0,
      noSpawn: !!opts.noSpawn, fixedSpeed: !!opts.fixedSpeed, noCollide: !!opts.noCollide,
      dino: makeDino(), obs: [], nObs: 0, ev: new Int32Array(MAX_EV), nEv: 0, log: null
    };
    for (var i = 0; i < cfg.MAX_OBSTACLES; i++) sim.obs.push(makeObstacle());
    resetRun(sim);
    return sim;
  }

  /** Reset for a new run (keeps hi-score and the RNG stream so consecutive runs differ). Status -> IDLE. */
  function resetRun(sim) {
    var c = sim.cfg, d = sim.dino;
    sim.status = STATUS.IDLE;
    sim.runningTime = 0; sim.time = 0;
    sim.speed = c.SPEED; sim.distance = 0; sim.prevDistance = 0; sim.score = 0;
    sim.milestone = 0; sim.flashActive = false; sim.flashTimer = 0; sim.flashIter = 0; sim.flashValue = 0;
    sim.nightActive = false; sim.nightTimer = 0; sim.nightPhase = 0; sim.nightBlock = 0;
    sim.gameOverTime = 0; sim.crashSerial = -1; sim.crashType = -1; sim.hist0 = -1; sim.hist1 = -1;
    sim.nObs = 0;
    d.y = d.prevY = c.GROUND_Y; d.vy = 0; d.jumping = false; d.ducking = false; d.speedDrop = false;
    d.reachedMin = false; d.jumpHeld = false; d.prevDuckHeld = false; d.jumpBuffer = 0;
    d.anim = ANIM.IDLE; d.frame = 0; d.phase = 0; d.jumps = 0;
  }

  function start(sim) {
    if (sim.status === STATUS.RUNNING) return;
    if (sim.status === STATUS.CRASHED) resetRun(sim);
    sim.status = STATUS.RUNNING;
    sim.runs++;
    sim.dino.anim = ANIM.RUN;
    pushEv(sim, EV.START);
  }

  function pushEv(sim, e) { if (sim.nEv < MAX_EV) sim.ev[sim.nEv++] = e; }

  function copyObstacle(d, s) {
    d.type = s.type; d.n = s.n;
    d.vs[0] = s.vs[0]; d.vs[1] = s.vs[1]; d.vs[2] = s.vs[2];
    d.ovl[0] = s.ovl[0]; d.ovl[1] = s.ovl[1]; d.ovl[2] = s.ovl[2];
    d.oxs[0] = s.oxs[0]; d.oxs[1] = s.oxs[1]; d.oxs[2] = s.oxs[2];
    d.x = s.x; d.prevX = s.prevX; d.y = s.y; d.w = s.w; d.h = s.h; d.hitL = s.hitL; d.hitR = s.hitR; d.top = s.top;
    d.gap = s.gap; d.next = s.next; d.so = s.so; d.alt = s.alt; d.frame = s.frame; d.phase = s.phase;
    d.serial = s.serial; d.R = s.R; d.xmin = s.xmin;
  }

  /** Copy the complete game state of src into dst (dst must share cfg/metrics). Events are not copied. */
  function copyState(dst, src) {
    dst.cfg = src.cfg; dst.M = src.M; dst.seed = src.seed; dst.rng.s = src.rng.s;
    dst.tick = src.tick; dst.time = src.time; dst.status = src.status; dst.runningTime = src.runningTime; dst.runs = src.runs;
    dst.speed = src.speed; dst.distance = src.distance; dst.prevDistance = src.prevDistance; dst.score = src.score;
    dst.hiScore = src.hiScore; dst.milestone = src.milestone; dst.flashActive = src.flashActive;
    dst.flashTimer = src.flashTimer; dst.flashIter = src.flashIter; dst.flashValue = src.flashValue;
    dst.nightActive = src.nightActive; dst.nightTimer = src.nightTimer; dst.nightPhase = src.nightPhase;
    dst.nightBlock = src.nightBlock; dst.gameOverTime = src.gameOverTime; dst.crashSerial = src.crashSerial;
    dst.crashType = src.crashType; dst.serial = src.serial; dst.hist0 = src.hist0; dst.hist1 = src.hist1;
    dst.unfair = src.unfair; dst.noSpawn = src.noSpawn; dst.fixedSpeed = src.fixedSpeed; dst.noCollide = src.noCollide;
    var a = dst.dino, b = src.dino;
    a.y = b.y; a.prevY = b.prevY; a.vy = b.vy; a.jumping = b.jumping; a.ducking = b.ducking; a.speedDrop = b.speedDrop;
    a.reachedMin = b.reachedMin; a.jumpHeld = b.jumpHeld; a.prevDuckHeld = b.prevDuckHeld; a.jumpBuffer = b.jumpBuffer;
    a.anim = b.anim; a.frame = b.frame; a.phase = b.phase; a.jumps = b.jumps;
    while (dst.obs.length < src.obs.length) dst.obs.push(makeObstacle());
    for (var i = 0; i < src.nObs; i++) copyObstacle(dst.obs[i], src.obs[i]);
    dst.nObs = src.nObs;
    dst.nEv = 0; dst.log = null;
    return dst;
  }

  function clone(src) {
    var c = create({ cfg: src.cfg, metrics: src.M, seed: src.seed });
    return copyState(c, src);
  }

  // --------------------------------------------------------------------------------------------------------------
  // Dino physics (shared by the simulation and the fairness probe)

  function bufferTicks(c) { return Math.round(c.JUMP_BUFFER_MS / c.STEP_MS); }

  function startJump(d, c, speed) {
    d.jumping = true; d.ducking = false; d.speedDrop = false; d.reachedMin = false;
    d.vy = c.INITIAL_JUMP_VELOCITY - speed / 10;
    d.jumps++;
  }
  function endJump(d, c) {
    if (d.reachedMin && d.vy < c.DROP_VELOCITY) d.vy = c.DROP_VELOCITY;
  }
  /** Apply one tick of input. Returns F_* flags. */
  function dinoControl(d, c, speed, jp, jh, dp, dh) {
    var f = 0;
    // Chrome's key-up rule: only a release (held last tick, not now) cuts the jump, and Trex.endJump ignores it
    // before min height. A tap whose press and release land in the same tick (jp && !jh) has no falling edge, so it
    // gives a full jump. d.jumpHeld = held on the previous tick.
    var released = d.jumpHeld && !jh;
    d.jumpHeld = jh;
    if (released && d.jumping) endJump(d, c);
    // +2: the press tick itself and the landing tick consume one each, leaving a full JUMP_BUFFER_MS window
    if (jp) d.jumpBuffer = bufferTicks(c) + 2;
    if (!d.jumping) {
      if (d.jumpBuffer > 0) { startJump(d, c, speed); d.jumpBuffer = 0; f |= F_JUMP; }
      else d.ducking = dh;
    } else if ((dp || (dh && !d.prevDuckHeld)) && !d.speedDrop) {
      d.speedDrop = true; d.vy = c.FAST_DROP_VELOCITY; f |= F_DROP; // fast-fall
    }
    if (d.jumpBuffer > 0) d.jumpBuffer--;
    d.prevDuckHeld = dh;
    return f;
  }
  function dinoPhysics(d, c) {
    if (!d.jumping) return 0;
    d.y += d.speedDrop ? d.vy * c.SPEED_DROP_COEFFICIENT : d.vy;
    d.vy += c.GRAVITY;
    var rise = c.GROUND_Y - d.y;
    if (rise > c.MIN_JUMP_RISE || d.speedDrop) d.reachedMin = true;
    if (rise > c.MAX_JUMP_RISE || d.speedDrop) endJump(d, c);
    if (d.y >= c.GROUND_Y) {
      d.y = c.GROUND_Y; d.vy = 0; d.jumping = false; d.speedDrop = false; d.reachedMin = false;
      d.ducking = d.prevDuckHeld;
      return F_LAND;
    }
    return 0;
  }

  function dinoAnim(sim) {
    var d = sim.dino, c = sim.cfg, D = sim.M.dino;
    var kind = d.jumping ? ANIM.JUMP : d.ducking ? ANIM.DUCK : ANIM.RUN;
    if (kind !== d.anim) { d.anim = kind; if (kind !== ANIM.RUN && kind !== ANIM.DUCK) d.phase = 0; }
    var n = D.frameList[kind].length;
    if (kind === ANIM.JUMP) {
      d.frame = n === 1 ? 0 : d.vy < 0 ? 0 : n - 1;
    } else {
      var cps = kind === ANIM.RUN ? c.RUN_CYCLES_PER_SEC * Math.pow(sim.speed / c.SPEED, c.RUN_CYCLE_SPEED_EXP) : c.DUCK_CYCLES_PER_SEC * Math.pow(sim.speed / c.SPEED, c.RUN_CYCLE_SPEED_EXP);
      d.phase += (cps * n) / c.FPS;
      if (d.phase >= 1e6) d.phase -= 1e6;
      d.frame = Math.floor(d.phase) % n;
    }
  }

  // --------------------------------------------------------------------------------------------------------------
  // Collision

  function hitRects(a, na, ay, b, nb, bx, by) {
    for (var i = 0; i < na; i++) {
      var i4 = i * 4, ax0 = a[i4], ay0 = a[i4 + 1] + ay, ax1 = a[i4 + 2], ay1 = a[i4 + 3] + ay;
      for (var j = 0; j < nb; j++) {
        var j4 = j * 4;
        if (ax0 < b[j4 + 2] + bx && ax1 > b[j4] + bx && ay0 < b[j4 + 3] + by && ay1 > b[j4 + 1] + by) return true;
      }
    }
    return false;
  }

  function dinoFrameRects(sim) {
    var d = sim.dino, list = sim.M.dino.frameList[d.anim];
    return list[d.frame < list.length ? d.frame : 0];
  }

  function collides(sim) {
    var M = sim.M, d = sim.dino, fr = dinoFrameRects(sim), dy = d.y, G = sim.cfg.GROUND_Y;
    var by0 = dy + fr.y0, by1 = dy + fr.y1;
    for (var i = 0; i < sim.nObs; i++) {
      var o = sim.obs[i];
      if (o.x + o.hitR <= fr.x0 || o.x + o.hitL >= fr.x1) continue;
      if (o.type === OT.PTERO) {
        var pf = M.ptero.frames[o.frame];
        if (o.y + pf.y1 <= by0 || o.y + pf.y0 >= by1) continue;
        if (hitRects(fr.r, fr.n, dy, pf.r, pf.n, o.x, o.y)) { sim.crashSerial = o.serial; sim.crashType = o.type; return true; }
      } else {
        if (o.top >= by1) continue;
        var list = M.cactusByType[o.type];
        for (var m = 0; m < o.n; m++) {
          var v = list[o.vs[m]], ox = o.x + o.oxs[m];
          if (ox + v.x1 <= fr.x0 || ox + v.x0 >= fr.x1) continue;
          if (hitRects(fr.r, fr.n, dy, v.r, v.n, ox, G)) { sim.crashSerial = o.serial; sim.crashType = o.type; return true; }
        }
      }
    }
    return false;
  }

  // --------------------------------------------------------------------------------------------------------------
  // Obstacles

  /** Recompute member offsets / extents of an obstacle from its type, size, variants and overlaps. */
  function compose(M, c, o) {
    if (o.type === OT.PTERO) {
      var P = M.ptero;
      o.n = 1; o.w = P.frameW; o.h = P.frameH; o.hitL = P.union.x0; o.hitR = P.union.x1;
      o.y = M.pteroY[o.alt]; o.top = o.y + P.union.y0;
      return;
    }
    var list = M.cactusByType[o.type];
    var x = 0, hitL = Infinity, hitR = -Infinity, top = Infinity, h = 0, right = 0;
    for (var m = 0; m < o.n; m++) {
      var v = list[o.vs[m]];
      if (m > 0) x -= v.w * o.ovl[m];
      o.oxs[m] = x;
      hitL = Math.min(hitL, x + v.x0); hitR = Math.max(hitR, x + v.x1);
      top = Math.min(top, v.y0); h = Math.max(h, v.h);
      right = Math.max(right, x + v.w);
      x += v.w;
    }
    o.w = right; o.h = h; o.hitL = hitL; o.hitR = hitR; o.y = c.GROUND_Y; o.top = c.GROUND_Y + top;
  }

  /** All hitbox rects of an obstacle: x relative to its origin, y absolute. Ptero: union of every flap frame. */
  function obstacleRects(M, c, o) {
    if (o.type === OT.PTERO) {
      var u = M.ptero.union, r = new Float64Array(u.r.length);
      for (var i = 0; i < u.n; i++) { r[i * 4] = u.r[i * 4]; r[i * 4 + 1] = u.r[i * 4 + 1] + o.y; r[i * 4 + 2] = u.r[i * 4 + 2]; r[i * 4 + 3] = u.r[i * 4 + 3] + o.y; }
      return { r: r, n: u.n, x0: u.x0, x1: u.x1, y0: u.y0 + o.y, y1: u.y1 + o.y };
    }
    var list = M.cactusByType[o.type], n = 0, m;
    for (m = 0; m < o.n; m++) n += list[o.vs[m]].n;
    var rr = new Float64Array(n * 4), k = 0, bx0 = Infinity, bx1 = -Infinity, by0 = Infinity, by1 = -Infinity;
    for (m = 0; m < o.n; m++) {
      var v = list[o.vs[m]], ox = o.oxs[m];
      for (var j = 0; j < v.n; j++) {
        var x0 = v.r[j * 4] + ox, y0 = v.r[j * 4 + 1] + c.GROUND_Y, x1 = v.r[j * 4 + 2] + ox, y1 = v.r[j * 4 + 3] + c.GROUND_Y;
        rr[k++] = x0; rr[k++] = y0; rr[k++] = x1; rr[k++] = y1;
        if (x0 < bx0) bx0 = x0; if (x1 > bx1) bx1 = x1; if (y0 < by0) by0 = y0; if (y1 > by1) by1 = y1;
      }
    }
    return { r: rr, n: n, x0: bx0, x1: bx1, y0: by0, y1: by1 };
  }

  // ---- fairness probe --------------------------------------------------------------------------------------------
  // Action plans shared by the probe and the bot. kind: 0 none, 1 jump, 2 duck (until the obstacle passed).
  var PLAN_NONE = 0, PLAN_JUMP = 1, PLAN_DUCK = 2;
  var PLANS = [
    { kind: PLAN_JUMP, hold: 999, ff: 0, name: 'jump' },
    { kind: PLAN_JUMP, hold: 7, ff: 0, name: 'jump-mid' },
    { kind: PLAN_JUMP, hold: 1, ff: 0, name: 'hop' },
    { kind: PLAN_JUMP, hold: 999, ff: 1, name: 'jump+drop' },
    { kind: PLAN_JUMP, hold: 1, ff: 1, name: 'hop+drop' },
    { kind: PLAN_DUCK, hold: 0, ff: 0, name: 'duck' },
    { kind: PLAN_NONE, hold: 0, ff: 0, name: 'none' }
  ];

  var trajCache = new Map();
  var probeCache = new Map();
  var scratchDino = makeDino();

  /** Dino trajectory for a jump plan started on flat ground at world speed v: y[t], st[t] for t = 0..n (n = landing tick). */
  function trajectory(c, p, v) {
    var key = p + '|' + v.toFixed(5);
    var t = trajCache.get(key);
    if (t) return t;
    var pl = PLANS[p], d = scratchDino, maxT = 400;
    d.y = c.GROUND_Y; d.vy = 0; d.jumping = false; d.ducking = false; d.speedDrop = false; d.reachedMin = false;
    d.jumpHeld = false; d.prevDuckHeld = false; d.jumpBuffer = 0;
    var ys = new Float64Array(maxT + 1), st = new Uint8Array(maxT + 1), n = 0;
    ys[0] = c.GROUND_Y; st[0] = ST_RUN;
    for (var i = 1; i <= maxT; i++) {
      var tt = i - 1;
      var ff = pl.ff && d.jumping && d.vy >= 0;
      // hold at least until min height: a release before it is ignored, so the lowest hop releases right after it
      dinoControl(d, c, v, tt === 0, tt < pl.hold || (d.jumping && !d.reachedMin), ff && !d.speedDrop, ff);
      dinoPhysics(d, c);
      ys[i] = d.y; st[i] = d.jumping ? ST_JUMP : d.ducking ? ST_DUCK : ST_RUN;
      if (!d.jumping) { n = i; break; }
    }
    t = { y: ys, st: st, n: n };
    if (trajCache.size > 4000) trajCache.clear();
    trajCache.set(key, t);
    return t;
  }

  /** Simulate one approach of obstacle rects `ob` (moving at ov) starting x ahead of the dino front.
   * Returns R (dino front past the obstacle's right edge when the dino is free again) or -1 on collision. */
  function probeRun(M, c, pl, tr, ob, ov, x) {
    var D = M.dino, back = D.back, front = D.front;
    var ox0 = front + x - ob.x0;
    var tStart = Math.max(1, Math.floor((ox0 + ob.x0 - D.maxX) / ov) - 1);
    var landT = pl.kind === PLAN_JUMP ? tr.n : 0;
    var G = c.GROUND_Y;
    for (var t = tStart; t < 3000; t++) {
      var ox = ox0 - ov * t;
      if (ox + ob.x1 < back) {
        var freeT = Math.max(landT, t);
        return Math.max(D.hitLen, front - (ox0 - ov * freeT + ob.x1));
      }
      var st, y;
      if (pl.kind === PLAN_JUMP && t <= tr.n) { st = tr.st[t]; y = tr.y[t]; }
      else { st = pl.kind === PLAN_DUCK ? ST_DUCK : ST_RUN; y = G; }
      var U = D.union[st];
      if (ox + ob.x1 <= U.x0 || ox + ob.x0 >= U.x1 || y + U.y1 <= ob.y0 || y + U.y0 >= ob.y1) continue;
      if (hitRects(U.r, U.n, y, ob.r, ob.n, ox, 0)) return -1;
    }
    return -1;
  }

  /**
   * Fairness probe for one obstacle at arrival speed v (conservative: all animation frames of each state count).
   * ok: some action has a timing window >= FAIR_MIN_WINDOW_TICKS. xmin: closest distance (dino front -> obstacle)
   * at which some good action can still be started. R: how far past the obstacle's right edge the dino front is
   * when it can act again.
   */
  function probeObstacle(M, c, o, v) {
    var key = o.type + '|' + o.n + '|' + o.vs[0] + ',' + o.vs[1] + ',' + o.vs[2] + '|' + o.oxs[0].toFixed(1) + ',' +
      o.oxs[1].toFixed(1) + ',' + o.oxs[2].toFixed(1) + '|' + o.alt + '|' + o.so.toFixed(3) + '|' + v.toFixed(4);
    var hit = probeCache.get(key);
    if (hit) return hit;
    var ob = obstacleRects(M, c, o);
    var ov = v + o.so, step = v * 0.5, D = M.dino;
    var res = { ok: false, xmin: Infinity, R: Infinity, window: 0, plan: -1 };
    for (var p = 0; p < PLANS.length; p++) {
      var pl = PLANS[p];
      if (pl.kind !== PLAN_JUMP && o.type !== OT.PTERO) continue; // cacti can only be jumped
      var tr = pl.kind === PLAN_JUMP ? trajectory(c, p, v) : null;
      var x, R;
      if (pl.kind !== PLAN_JUMP) {
        for (x = 0; x <= v * 60; x += step) {
          R = probeRun(M, c, pl, tr, ob, ov, x);
          if (R >= 0) {
            res.ok = true;
            if (x < res.xmin) res.xmin = x;
            if (R < res.R) res.R = R;
            res.window = Infinity; if (res.plan < 0) res.plan = p;
            break;
          }
        }
        continue;
      }
      var xmax = v * (tr.n + 4) + (ob.x1 - ob.x0) + D.hitLen;
      var runStart = -1, runLen = 0, runR = Infinity;
      for (var k = 0; ; k++) {
        x = k * step;
        var done = x > xmax;
        R = done ? -1 : probeRun(M, c, pl, tr, ob, ov, x);
        if (R >= 0) {
          if (runStart < 0) { runStart = x; runLen = 0; runR = Infinity; }
          runLen++; if (R < runR) runR = R;
        } else if (runStart >= 0) {
          var win = (runLen - 1) * 0.5;
          if (win >= c.FAIR_MIN_WINDOW_TICKS) {
            res.ok = true;
            if (runStart < res.xmin) res.xmin = runStart;
            if (runR < res.R) res.R = runR;
            if (win > res.window) { res.window = win; res.plan = p; }
          }
          runStart = -1;
        }
        if (done) break;
      }
    }
    if (probeCache.size > 20000) probeCache.clear();
    probeCache.set(key, res);
    return res;
  }

  function dupCheck(sim, t) {
    // Chrome: at most MAX_OBSTACLE_DUPLICATION (2) consecutive obstacles of the same type
    return sim.hist0 === t && sim.hist1 === t;
  }

  function spawnObstacle(sim, prev) {
    var c = sim.cfg, M = sim.M, r = sim.rng, v = sim.speed;
    if (sim.nObs >= sim.obs.length) return null;
    var type = -1, t, i;
    for (var tries = 0; tries < 24; tries++) {
      t = RNG.int(r, 0, 2);
      if (dupCheck(sim, t) || v < c.OBSTACLE_MIN_SPEED[t]) continue;
      type = t; break;
    }
    if (type < 0) type = sim.hist0 === OT.SMALL ? OT.LARGE : OT.SMALL;
    var o = sim.obs[sim.nObs];
    o.type = type; o.serial = ++sim.serial; o.next = false; o.frame = 0; o.phase = 0;
    var size = RNG.int(r, 1, c.MAX_OBSTACLE_LENGTH);
    if (type === OT.PTERO || (size > 1 && v < c.OBSTACLE_MULTIPLE_SPEED[type])) size = 1;
    var list = type === OT.PTERO ? null : M.cactusByType[type];
    for (i = 0; i < 3; i++) {
      var vi = RNG.int(r, 0, 1023);
      if (list) {
        vi = vi % list.length;
        // members of one group use distinct sprites when the list allows: no A-A, and no A-B-A with >= 3 variants
        // (a bounded cycle, no extra RNG draws)
        for (var k = 0; k < list.length && ((i > 0 && vi === o.vs[i - 1]) || (i > 1 && list.length > 2 && vi === o.vs[i - 2])); k++) vi = (vi + 1) % list.length;
      } else vi = 0;
      o.vs[i] = vi;
      o.ovl[i] = Math.round((c.CACTUS_OVERLAP + RNG.next(r) * c.CACTUS_OVERLAP_JITTER) * 100) / 100;
    }
    o.alt = RNG.int(r, 0, 2);
    o.so = type === OT.PTERO ? (RNG.next(r) > 0.5 ? c.PTERO_SPEED_OFFSET : -c.PTERO_SPEED_OFFSET) : 0;
    if (type !== OT.PTERO) RNG.next(r); // keep RNG consumption independent of the type
    var gapRand = RNG.next(r);
    o.n = size;

    // ---- fairness: shrink / re-altitude until clearable with a comfortable timing window ----
    var arrive = Math.max(1, (c.SPAWN_X - M.dino.front) / v);
    var vArr = sim.fixedSpeed ? v : Math.min(c.MAX_SPEED, v + c.ACCELERATION * arrive);
    compose(M, c, o);
    var pr = probeObstacle(M, c, o, vArr);
    while (!pr.ok && o.n > 1) { o.n--; compose(M, c, o); pr = probeObstacle(M, c, o, vArr); }
    if (!pr.ok && o.type === OT.PTERO) {
      var a0 = o.alt;
      for (i = 1; i < 3 && !pr.ok; i++) { o.alt = (a0 + i) % 3; compose(M, c, o); pr = probeObstacle(M, c, o, vArr); }
    }
    if (!pr.ok && o.type !== OT.SMALL) {
      o.type = OT.SMALL; o.n = 1; o.so = 0; o.vs[0] = o.vs[0] % M.cactus.small.length;
      compose(M, c, o); pr = probeObstacle(M, c, o, vArr);
    }
    if (!pr.ok) sim.unfair++;

    // ---- Chrome gap (random in [minGap, 1.5 minGap]) ----
    var minGap = Math.round((o.w * v) / c.K + c.OBSTACLE_MIN_GAP[o.type] * c.GAP_COEFFICIENT);
    o.gap = minGap + gapRand * (minGap * c.MAX_GAP_COEFFICIENT - minGap);
    o.x = c.SPAWN_X;
    var req = 0, gapActual = Infinity;
    if (prev) {
      // physical floor: after clearing prev the dino must be able to start the action for o, with slack
      var closing = Math.max(0, o.so - prev.so) * (c.SPAWN_X * 1.3) / v;
      req = prev.R + pr.xmin + c.FAIR_SLACK_TICKS * vArr + closing;
      var minX = prev.x + prev.hitR + req - o.hitL;
      if (o.x < minX) o.x = minX;
      gapActual = o.x + o.hitL - (prev.x + prev.hitR);
    }
    o.prevX = o.x; o.R = pr.R; o.xmin = pr.xmin;
    sim.hist1 = sim.hist0; sim.hist0 = o.type;
    sim.nObs++;
    pushEv(sim, EV.SPAWN);
    if (sim.log) {
      sim.log.push({
        tick: sim.tick, serial: o.serial, type: o.type, n: o.n, alt: o.alt, so: o.so, x: o.x, speed: v, ok: pr.ok,
        R: pr.R, xmin: pr.xmin, window: pr.window, req: req, gapActual: gapActual, chromeGap: prev ? prev.gap : 0,
        prevType: prev ? prev.type : -1, spriteGap: prev ? o.x - (prev.x + prev.w) : Infinity, runningTime: sim.runningTime
      });
    }
    return o;
  }

  function updateObstacles(sim) {
    var c = sim.cfg, M = sim.M, obs = sim.obs, n = sim.nObs, i;
    var pn = M.ptero.frames.length, pf = c.PTERO_ANIM_FPS / c.FPS;
    for (i = 0; i < n; i++) {
      var o = obs[i];
      o.prevX = o.x;
      o.x -= sim.speed + o.so;
      if (o.type === OT.PTERO) { o.phase += pf; if (o.phase >= pn) o.phase -= pn; o.frame = Math.floor(o.phase) % pn; }
    }
    while (n > 0 && obs[0].x + obs[0].w < -c.REMOVE_MARGIN) {
      var gone = obs[0];
      for (i = 1; i < obs.length; i++) obs[i - 1] = obs[i];
      obs[obs.length - 1] = gone;
      n--;
    }
    sim.nObs = n;
    if (sim.noSpawn || sim.runningTime <= c.CLEAR_TIME) return;
    if (n > 0) {
      var last = obs[n - 1];
      if (!last.next && last.x + last.w + last.gap < c.SPAWN_X) {
        last.next = true;
        spawnObstacle(sim, last);
      }
    } else {
      spawnObstacle(sim, null);
    }
  }

  // --------------------------------------------------------------------------------------------------------------
  // Main step

  var IDLE_INPUT = { jumpPressed: false, jumpHeld: false, duckPressed: false, duckHeld: false };

  function gameOver(sim) {
    var d = sim.dino;
    sim.status = STATUS.CRASHED;
    sim.flashActive = false; sim.flashTimer = 0; sim.flashIter = 0; // Chrome: distanceMeter.acheivement = false
    sim.gameOverTime = 0;
    d.anim = ANIM.DEAD; d.frame = 0; d.ducking = false;
    if (sim.score > sim.hiScore) sim.hiScore = sim.score;
    pushEv(sim, EV.CRASH);
  }

  /** Lowest y the crash pose may settle to (stateless): the ground, or the top of a cactus member under the dead pose.
   * If the pose is already below that top it stays where it hit (Chrome freezes the trex), so a mid-air crash rests
   * on the cactus instead of dropping through it. Pterodactyl hits and ground crashes settle to the ground. */
  function crashRest(sim) {
    var M = sim.M, d = sim.dino, G = sim.cfg.GROUND_Y, rest = G;
    var fr = M.dino.frameList[ANIM.DEAD][0], r = fr.r; // the same rects collides() uses for the dead pose
    for (var i = 0; i < sim.nObs; i++) {
      var o = sim.obs[i];
      if (o.type === OT.PTERO || o.x + o.hitR <= fr.x0 || o.x + o.hitL >= fr.x1) continue;
      var list = M.cactusByType[o.type];
      for (var m = 0; m < o.n; m++) {
        var v = list[o.vs[m]], mx0 = o.x + o.oxs[m] + v.x0, mx1 = o.x + o.oxs[m] + v.x1, top = G + v.y0;
        for (var k = 0; k < fr.n; k++) {
          var k4 = k * 4;
          if (r[k4] >= mx1 || r[k4 + 2] <= mx0) continue;
          if (top - r[k4 + 3] < rest) rest = top - r[k4 + 3];
        }
      }
    }
    return rest < d.y ? d.y : rest;
  }

  function step(sim, inp) {
    var c = sim.cfg, d = sim.dino, i;
    inp = inp || IDLE_INPUT;
    sim.tick++;
    d.prevY = d.y;
    sim.prevDistance = sim.distance;

    if (sim.status === STATUS.IDLE) {
      for (i = 0; i < sim.nObs; i++) sim.obs[i].prevX = sim.obs[i].x;
      if (!inp.jumpPressed) {
        d.anim = ANIM.IDLE;
        var ph = ((sim.tick * c.STEP_MS) / 1000) % c.IDLE_BLINK_PERIOD;
        d.frame = ph > c.IDLE_BLINK_PERIOD - 0.9 && sim.M.dino.frames.idle.length > 1 ? 1 : 0;
        return;
      }
      start(sim);
    }

    if (sim.status === STATUS.CRASHED) {
      sim.gameOverTime += c.STEP_MS;
      for (i = 0; i < sim.nObs; i++) {
        var q = sim.obs[i];
        q.prevX = q.x;
        if (q.type === OT.PTERO) { var pn = sim.M.ptero.frames.length; q.phase += c.PTERO_ANIM_FPS / c.FPS; if (q.phase >= pn) q.phase -= pn; q.frame = Math.floor(q.phase) % pn; }
      }
      var rest = crashRest(sim); // settle in the crash pose: onto the ground, or onto the cactus it hit
      if (d.y < rest) { d.vy = Math.max(d.vy, 0) + c.GRAVITY; d.y = Math.min(rest, d.y + d.vy); }
      return;
    }

    // ---- running ----
    sim.time += c.STEP_MS;
    sim.runningTime += c.STEP_MS;
    var f = dinoControl(d, c, sim.speed, !!inp.jumpPressed, !!inp.jumpHeld, !!inp.duckPressed, !!inp.duckHeld);
    if (f & F_JUMP) pushEv(sim, EV.JUMP);
    if (f & F_DROP) pushEv(sim, EV.FASTDROP);
    if (dinoPhysics(d, c) & F_LAND) pushEv(sim, EV.LAND);
    dinoAnim(sim);
    updateObstacles(sim);
    if (!sim.noCollide && collides(sim)) { gameOver(sim); return; }

    sim.distance += sim.speed;
    var sc = Math.min(c.MAX_SCORE, Math.round(sim.distance * c.SCORE_COEFFICIENT));
    sim.score = sc;
    var ms = Math.floor(sc / c.ACHIEVEMENT_DISTANCE);
    if (ms > sim.milestone) {
      sim.milestone = ms;
      sim.flashActive = true; sim.flashTimer = 0; sim.flashIter = 0; sim.flashValue = ms * c.ACHIEVEMENT_DISTANCE;
      pushEv(sim, EV.MILESTONE);
    } else if (sim.flashActive) {
      sim.flashTimer += c.STEP_MS;
      if (sim.flashTimer >= c.FLASH_DURATION * 2) {
        sim.flashTimer -= c.FLASH_DURATION * 2;
        sim.flashIter++;
        if (sim.flashIter > c.FLASH_ITERATIONS) { sim.flashActive = false; sim.flashIter = 0; sim.flashTimer = 0; }
      }
    }
    var blk = Math.floor(sc / c.NIGHT_DISTANCE);
    if (blk > sim.nightBlock) {
      sim.nightBlock = blk; sim.nightActive = true; sim.nightTimer = 0; pushEv(sim, EV.NIGHT_ON);
    } else if (sim.nightActive) {
      sim.nightTimer += c.STEP_MS;
      if (sim.nightTimer >= c.NIGHT_DURATION) { sim.nightActive = false; pushEv(sim, EV.NIGHT_OFF); }
    }
    var target = sim.nightActive ? 1 : 0, dp = c.STEP_MS / c.NIGHT_FADE;
    if (sim.nightPhase < target) sim.nightPhase = Math.min(target, sim.nightPhase + dp);
    else if (sim.nightPhase > target) sim.nightPhase = Math.max(target, sim.nightPhase - dp);

    if (!sim.fixedSpeed && sim.speed < c.MAX_SPEED) sim.speed = Math.min(c.MAX_SPEED, sim.speed + c.ACCELERATION);
  }

  // --------------------------------------------------------------------------------------------------------------
  // Helpers for UI / tests

  function pad5(n) {
    n = Math.max(0, Math.min(99999, n | 0));
    var s = '' + n;
    while (s.length < 5) s = '0' + s;
    return s;
  }

  /** Score shown on the HUD this tick and whether it's visible (blinks after each 100 milestone; never on GAME OVER).
   * With `out` it is filled in and returned (no allocation); otherwise a new object is returned. */
  function hudScore(sim, out) {
    out = out || { value: 0, visible: true };
    if (sim.status === STATUS.CRASHED || !sim.flashActive) { out.value = sim.score; out.visible = true; }
    else { out.value = sim.flashValue; out.visible = sim.flashTimer >= sim.cfg.FLASH_DURATION; }
    return out;
  }

  /** Place an obstacle by hand (tests / debug). type 0 small, 1 large, 2 ptero. */
  function placeObstacle(sim, type, x, opts) {
    opts = opts || {};
    var o = sim.obs[sim.nObs];
    o.type = type; o.n = opts.n || 1; o.alt = opts.alt || 0; o.so = opts.so || 0; o.serial = ++sim.serial;
    o.vs[0] = opts.v0 || 0; o.vs[1] = opts.v1 || 0; o.vs[2] = opts.v2 || 0;
    o.ovl[0] = o.ovl[1] = o.ovl[2] = sim.cfg.CACTUS_OVERLAP;
    o.next = true; o.gap = 0; o.frame = opts.frame || 0; o.phase = o.frame;
    compose(sim.M, sim.cfg, o);
    o.x = o.prevX = x;
    o.R = 0; o.xmin = 0;
    sim.nObs++;
    return o;
  }

  function isFiniteState(sim) {
    var d = sim.dino;
    var vals = [sim.speed, sim.distance, sim.score, sim.time, sim.nightPhase, d.y, d.vy, d.phase];
    for (var i = 0; i < sim.nObs; i++) {
      var o = sim.obs[i];
      vals.push(o.x, o.y, o.w, o.h, o.hitL, o.hitR, o.gap, o.R, o.xmin, o.phase);
    }
    for (var j = 0; j < vals.length; j++) if (typeof vals[j] !== 'number' || !isFinite(vals[j])) return false;
    return true;
  }

  function stateHash(sim) {
    var h = 2166136261 >>> 0;
    function mix(v) {
      var s = typeof v === 'number' ? v.toFixed(6) : String(v);
      for (var i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    }
    mix(sim.tick); mix(sim.status); mix(sim.speed); mix(sim.distance); mix(sim.score); mix(sim.rng.s);
    mix(sim.dino.y); mix(sim.dino.vy); mix(sim.dino.anim); mix(sim.dino.frame);
    for (var i = 0; i < sim.nObs; i++) { var o = sim.obs[i]; mix(o.serial); mix(o.type); mix(o.n); mix(o.x); mix(o.y); }
    return h >>> 0;
  }

  // --------------------------------------------------------------------------------------------------------------
  // Bot: look-ahead search on cloned simulation states.
  // At a decision point it simulates "do nothing" forward; if that crashes it searches (start delay x action plan)
  // on clones, requiring that after the plan the following danger(s) are solvable too (depth-limited recursion).

  var BOT_SAFE = 1, BOT_FOUND = 2, BOT_FAIL = 0;
  var ORDER_CACTUS = [0, 1, 2, 3, 4];
  var ORDER_PTERO = [5, 0, 1, 2, 3, 4];

  function planInput(p, start, sim, out) {
    out.jumpPressed = false; out.jumpHeld = false; out.duckPressed = false; out.duckHeld = false;
    var t = sim.tick - start;
    if (t < 0) return;
    var pl = PLANS[p], d = sim.dino;
    if (pl.kind === PLAN_JUMP) {
      out.jumpPressed = t === 0;
      out.jumpHeld = t < pl.hold || (d.jumping && !d.reachedMin);
      if (pl.ff && d.jumping && d.vy >= 0) { out.duckHeld = true; out.duckPressed = !d.speedDrop; }
    } else if (pl.kind === PLAN_DUCK) {
      out.duckHeld = true;
    }
  }
  function findObstacle(sim, serial) {
    for (var i = 0; i < sim.nObs; i++) if (sim.obs[i].serial === serial) return sim.obs[i];
    return null;
  }
  /** 0 running, 1 done, -1 done-but-useless (jump landed before reaching the target). */
  function planStatus(p, start, target, sim) {
    var t = sim.tick - start;
    if (t < 1) return 0;
    var pl = PLANS[p];
    if (pl.kind === PLAN_JUMP) {
      if (sim.dino.jumping) return 0;
      var o = findObstacle(sim, target);
      if (o && o.x + o.hitL > sim.M.dino.front) return -1;
      return 1;
    }
    if (pl.kind === PLAN_DUCK) {
      var q = findObstacle(sim, target);
      return !q || q.x + q.hitR < sim.M.dino.back - 1 ? 1 : 0;
    }
    return 1;
  }

  function Bot(opts) {
    opts = opts || {};
    this.depth = opts.depth || 3;
    this.H = opts.horizon || 110;
    this.lead = opts.lead || 72;
    this.levels = null;
    this.plan = { active: false, p: 0, start: 0, target: -1 };
    this.res = { s: 0, p: 0, target: -1 };
    this.nextCheck = 0;
    this.decisions = 0; this.degraded = 0; this.fails = 0; this.stepsSimulated = 0;
    this.inp = { jumpPressed: false, jumpHeld: false, duckPressed: false, duckHeld: false };
    this.top = 0;
  }

  Bot.prototype._ensure = function (sim) {
    if (this.levels && this.levels.M === sim.M) return;
    var lv = [null];
    for (var L = 1; L <= this.depth; L++) {
      var snaps = [];
      for (var i = 0; i <= this.H; i++) snaps.push(clone(sim));
      lv.push({ scan: clone(sim), trial: clone(sim), snaps: snaps, feas: new Int32Array(this.H + 2), order: new Int32Array(this.H + 2) });
    }
    lv.M = sim.M;
    this.levels = lv;
  };

  Bot.prototype._simPlan = function (s, p, target) {
    var start = s.tick, inp = this.inp;
    for (var k = 0; k < 900; k++) {
      if (k > 0) {
        var ps = planStatus(p, start, target, s);
        if (ps !== 0) return ps;
      }
      planInput(p, start, s, inp);
      step(s, inp);
      this.stepsSimulated++;
      if (s.status !== STATUS.RUNNING) return 0;
    }
    return 1;
  };

  Bot.prototype._solve = function (L, base) {
    var P = this.levels[L], k, s, i;
    var scan = copyState(P.scan, base);
    var c = -1;
    for (k = 1; k <= this.H; k++) {
      step(scan, IDLE_INPUT); this.stepsSimulated++;
      if (scan.status !== STATUS.RUNNING) { c = k; break; }
    }
    if (c < 0) return BOT_SAFE;
    var target = scan.crashSerial, order = scan.crashType === OT.PTERO ? ORDER_PTERO : ORDER_CACTUS;
    // snapshots of idling 0..c-1 ticks
    copyState(P.snaps[0], base);
    for (s = 1; s < c; s++) { copyState(P.snaps[s], P.snaps[s - 1]); step(P.snaps[s], IDLE_INPUT); this.stepsSimulated++; }
    for (var oi = 0; oi < order.length; oi++) {
      var p = order[oi], pl = PLANS[p];
      var s0 = pl.kind === PLAN_DUCK ? Math.max(0, c - 16) : Math.max(0, c - this.lead);
      var nF = 0, seen = false;
      for (s = c - 1; s >= s0; s--) { // latest first: late jumps fail fast; stop once jumps land too early
        var tr = copyState(P.trial, P.snaps[s]);
        var r = this._simPlan(tr, p, target);
        if (r === 1) { P.feas[nF++] = s; seen = true; }
        else if (r === -1 && seen) break;
      }
      if (!nF) continue;
      // candidate order: centre of the widest contiguous window first (max margins), then outward
      var nO = orderCandidates(P.feas, nF, P.order, pl.kind === PLAN_DUCK);
      for (i = 0; i < nO; i++) {
        s = P.order[i];
        var trial = copyState(P.trial, P.snaps[s]);
        if (this._simPlan(trial, p, target) !== 1) continue;
        if (L === 1 || this._solve(L - 1, trial) !== BOT_FAIL) {
          if (L === this.top) { this.res.s = s; this.res.p = p; this.res.target = target; }
          return BOT_FOUND;
        }
      }
    }
    return BOT_FAIL;
  };

  function orderCandidates(feas, n, out, duck) {
    // feas is descending. Find the longest run of consecutive values.
    var bestA = 0, bestLen = 1, a = 0, i;
    for (i = 1; i <= n; i++) {
      if (i < n && feas[i] === feas[i - 1] - 1) continue;
      var len = i - a;
      if (len > bestLen) { bestLen = len; bestA = a; }
      a = i;
    }
    var centre = duck ? feas[bestA] - Math.min(4, bestLen - 1) : feas[bestA] - ((bestLen - 1) >> 1);
    // selection by distance to centre (n is small)
    var k = 0;
    for (var d = 0; k < n && d <= 400; d++) {
      for (i = 0; i < n; i++) {
        var dd = feas[i] - centre;
        if (dd === d || (d > 0 && dd === -d)) out[k++] = feas[i];
      }
    }
    return k;
  }

  Bot.prototype.decide = function (sim) {
    this._ensure(sim);
    for (var depth = this.depth; depth >= 1; depth--) {
      this.top = depth;
      var r = this._solve(depth, sim);
      if (r === BOT_SAFE) { this.nextCheck = sim.tick + Math.max(1, this.H - this.lead - 4); return; }
      if (r === BOT_FOUND) {
        this.plan.active = true; this.plan.p = this.res.p; this.plan.start = sim.tick + this.res.s; this.plan.target = this.res.target;
        this.decisions++;
        if (depth < this.depth) this.degraded++;
        return;
      }
    }
    this.fails++;
    this.plan.active = true; this.plan.p = 0; this.plan.start = sim.tick; this.plan.target = -1;
  };

  /** Fill `out` with the bot's input for the next tick of `sim`. */
  Bot.prototype.update = function (sim, out) {
    out.jumpPressed = false; out.jumpHeld = false; out.duckPressed = false; out.duckHeld = false;
    if (sim.status !== STATUS.RUNNING) { this.plan.active = false; this.nextCheck = 0; return out; }
    if (this.plan.active && planStatus(this.plan.p, this.plan.start, this.plan.target, sim) !== 0) this.plan.active = false;
    if (!this.plan.active && sim.tick >= this.nextCheck) this.decide(sim);
    if (this.plan.active) planInput(this.plan.p, this.plan.start, sim, out);
    return out;
  };

  function createBot(opts) { return new Bot(opts); }

  RDG.Sim = {
    STATUS: STATUS, ANIM: ANIM, ANIM_KEYS: ANIM_KEYS, OT: OT, OT_NAMES: OT_NAMES, EV: EV, PLANS: PLANS,
    DEFAULT_SPRITES: DEFAULT_SPRITES,
    buildMetrics: buildMetrics, create: create, resetRun: resetRun, start: start, step: step,
    copyState: copyState, clone: clone, collides: collides, compose: compose, probeObstacle: probeObstacle,
    trajectory: trajectory, placeObstacle: placeObstacle, pad5: pad5, hudScore: hudScore,
    isFiniteState: isFiniteState, stateHash: stateHash, dinoFrameRects: dinoFrameRects, IDLE_INPUT: IDLE_INPUT,
    clearCaches: function () { trajCache.clear(); probeCache.clear(); }
  };
  RDG.Bot = { create: createBot, Bot: Bot };
});
