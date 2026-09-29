/* All canvas drawing. World units (H = 540) are mapped to backing pixels by `bs`. Images are pre-scaled into
 * offscreen canvases on resize; the per-frame path does no allocations. Render positions are interpolated between
 * fixed simulation steps (alpha in [0,1]). */
(function (root) {
  'use strict';
  var RDG = (root.RDG = root.RDG || {});
  var Sim = RDG.Sim;
  var hash = RDG.rng.hash;
  var STATUS = Sim.STATUS, OT = Sim.OT, EV = Sim.EV, ANIM_KEYS = Sim.ANIM_KEYS;
  var cfg0 = RDG.config || {};
  function cv(k, d) { return cfg0[k] != null ? cfg0[k] : d; }

  /** Render-local tunables (a config key, when one exists, is read first). */
  var RC = {
    // viewport fit: never less road ahead than Chrome (506 px ahead of the trex ~ 1113u -> W >= 1350u) while the dino
    // stays >= 44 CSS px tall; taller viewports extend the sky above / the ground below instead of letterboxing
    VIEW_MIN_W: 1350,
    DINO_MIN_CSS_H: 44,
    SKY_EXT_SHARE: 0.45, // share of the extra height given to the sky (the rest extends the ground)
    HUD_PIN_T: 60, // u of extra sky above the playfield beyond which the HUD pins to the top of the screen
    COARSE_DPR_CAP: 2, // touch screens: backing store at most 2x CSS px
    SKY_CAP_FEATHER: 90, // u: the zenith cap fades into the sky image over its top rows
    SKY_CAP_FINE: 40, // u above the image: the per-column cap profile fades into the coarse profile
    SKY_CAP_COARSE: 240, // u above the image: the coarse profile fades into the uniform zenith colour
    SKY_ZENITH_DARK: 0.07, // darkening at the zenith (reached ~600u above the sky image)
    GROUND_EXT_BLUR: [0.6, 1.1], // extension blur (device px per bs) of band 0 and the increment per band (5 bands)
    GROUND_EXT_DARK: 0.2, // darkening at the bottom of the ground extension
    GROUND_F_CAP: 1.5, // ground factors beyond GROUND_FACTOR_BOTTOM approach this multiple of it (softF)
    // night actors: GRADE_NIGHT's hue, ~1.33x brighter so they stay readable; soft moon-side rim (with the
    // nightNow * 0.9 draw alpha ~0.4 effective)
    ACTOR_GRADE_NIGHT: [118, 132, 178],
    MOON_RIM: 'rgba(214,226,255,0.45)',
    // night clouds: moonlit copies (nightCloudCopy), crossfaded on the nightW curve, cores nearly opaque
    CLOUD_NIGHT_TINT: [172, 182, 212],
    CLOUD_NIGHT_ALPHA: 0.88,
    // decor: a dense dark pebble band at the running line, darker / denser foreground rocks, lighter plain shade
    DECOR_PEBBLE_COUNT: 130, // layer 3, y in [G-6, G+16]
    DECOR_PEBBLE_SIZE: 0.33,
    DECOR_PEBBLE_BIAS: 2, // depth distribution exponent (> 1: concentrated at the running line)
    DECOR_PEBBLE_SHADOW: 0.3, // contact shadow opacity under each pebble
    DECOR_PEBBLE_TINT: [150, 140, 128],
    DECOR_FG_COUNT: 20, // layer 2 (0.88H .. H-4)
    DECOR_EXT_COUNT: 7, // layer 2 below H on tall screens: this many per 110u of extension (bigger, sparser rocks;
                        // 11 let the near rocks dominate portrait / 4:3 screens)
    DECOR_FG_ROCK_GRADE: [160, 150, 138],
    GROUND_SHADE: 0.05, // multiply darkening of the plain, peaking at the running line
    CAST_SLOPE: 0.045, // long cast shadows fall slightly toward the camera as they run right
    // the dusk sky image's sun (fractions of the image; the manifest's sky.dusk.sun wins when present)
    DUSK_SUN: { x: 0.1203, y: 0.6676, r: 0.0165, glow: [247, 224, 152] },
    // loading frame (before the assets are in): the page's day colours
    PAGE_SKY_DAY: cv('PAGE_SKY_DAY', '#c2c4c7'),
    PAGE_GROUND_DAY: cv('PAGE_GROUND_DAY', '#9c8773'),

    // ---- GAME OVER composition (see _layoutGameOver / getGameOverLayout) ----
    GO_TITLE_MIN_CSS: 20, // the title never below this many CSS px (phones)
    GO_ICON_MIN_CSS: 30, // nor the restart icon's side
    GO_JA_SCALE: 0.8, // ゲームオーバー's font size x the English one (kana fill the em box: similar visual height)
    GO_JA_TRACK: 0.08, // its letter spacing (em), echoing the spaced-out English title
    SHARE_SLOT: [150, 44], // CSS px kept clear below the restart icon for the HTML share button (scale 1)
    SHARE_REF_CSS: 1.17, // CSS px per world unit at which the slot has scale 1 (1600 x 632); larger scenes scale it up
    SHARE_MAX_SCALE: 1.6,
    GO_PEAK_CLEAR: 4, // world units the slot's bottom stays above the mountain tops (MOUNTAIN_PEAK_Y): on small
                      // screens the whole group moves up instead (never above the HUD line)

    // ---- dust (sprite particles, see FX). Sizes are x the sprite's manifest worldW; lives in seconds ----
    DUST_MAX: 40, // live sprite particles (fixed pool; the most faded one is recycled when full)
    // airborne dust moves at this fraction of the ground speed: DUST_FOLLOW[0] when raised (the dino's wake carries
    // it along behind the foot), DUST_FOLLOW[1] at the end of its life (left behind as the wake dies down); 1 = glued
    // to the ground. Sprays (heavy grains) keep nearly the ground's speed (DUST_SPRAY.follow).
    DUST_FOLLOW: [0.45, 0.85],
    DUST_DRAG: 0.35, // per tick: how fast raised fine dust takes the air's speed (it starts at the ground's)
    DUST_ROT: 0.05, // max tilt (rad) about the anchor on the ground
    DUST_SPEED_GROW: 0.3, // puffs / sprays this much larger at MAX_SPEED
    DUST_THIN: [0.2, 0.7], // life fraction over which a fresh puff crossfades into its thin, settling version
    DUST_DUCK_SQUASH: [1.25, 0.62], // ducking run: puffs / sprays x wider, y lower
    DUST_PUFF: { size: [0.85, 1.05], grow: [1.4, 2.0], life: [0.6, 1.0], alpha: [0.75, 0.92], dx: [-4, -14],
                 second: 0.45, land: [0.5, 0.35], sy: 0.85 }, // second: odds of a 2nd puff (+0.4 at MAX_SPEED);
                 // land: odds, alpha of the small puff under the landing foot; sy: height factor (low, wide dust)
    DUST_LEAN: [0.12, 0.35], // toe-off puffs lean back (shear) by this much at SPEED .. MAX_SPEED
    DUST_SPRAY: { size: [1.0, 1.25], grow: [1.15, 1.35], life: [0.3, 0.45], alpha: [0.9, 1], dx: 0, follow: 0.9 },
    DUST_PLUME: { chance: [0.45, 1], size: [0.7, 0.9], grow: [1.3, 1.7], life: [0.5, 0.8], alpha: [0.4, 0.7], dx: 2 },
    DUST_LAND: { size: 0.85, grow: [1.5, 1.35], life: 0.85, alpha: 0.88, hold: 0.15, dx: 0 },
    DUST_CRASH: { size: 1.05, grow: [1.45, 1.4], life: 2.1, alpha: 0.88, hold: 0.3, dx: 0 },
    DUST_GRAINS: 4, // procedural flying grains per toe-off (x2 at MAX_SPEED)
    DUST_CACHE_SCALE: [3, 2.2, 1.9, 1.7], // largest drawn width per kind (puff, spray, plume, burst), x worldW
    DUST_GRADE_NIGHT: [104, 116, 158] // night dust: the actors' night hue, a little dimmer (pale dust must not glow)
  };

  function mkCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  /** High-quality downscale into a canvas of (tw, th) px. Returns the source itself when no downscale is needed. */
  function scaleImage(img, tw, th) {
    if (!img) return null;
    tw = Math.max(1, Math.round(tw)); th = Math.max(1, Math.round(th));
    var sw = img.width, sh = img.height;
    if (!sw || !sh) return img;
    if (tw >= sw * 0.92 && th >= sh * 0.92) return img;
    var src = img;
    while (sw / 2 >= tw * 1.5 && sh / 2 >= th * 1.5) {
      var hw = Math.max(1, Math.round(sw / 2)), hh = Math.max(1, Math.round(sh / 2));
      var hc = mkCanvas(hw, hh), hx = hc.getContext('2d');
      hx.imageSmoothingEnabled = true; hx.imageSmoothingQuality = 'high';
      hx.drawImage(src, 0, 0, hw, hh);
      src = hc; sw = hw; sh = hh;
    }
    var c = mkCanvas(tw, th), x = c.getContext('2d');
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high';
    x.drawImage(src, 0, 0, tw, th);
    return c;
  }

  /** Smoothing for the per-frame contexts. 'high' means bicubic filtering on every upscaled per-frame draw (sky
   * <img>, sprites, vignette at DPR 2), which is GPU-bound; 'medium' keeps mipmapped downscaling and looks identical.
   * The build-time helpers (scaleImage, cache builders) keep 'high'. */
  function setFrameSmoothing(x) { x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'medium'; }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function smooth(t) { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); }
  function mod(a, n) { var r = a % n; return r < 0 ? r + n : r; }
  function hiCtx(cn) { var x = cn.getContext('2d'); x.imageSmoothingEnabled = true; x.imageSmoothingQuality = 'high'; return x; }

  /** Box-average downscale to (tw, th) by repeated 2:1 halving (build time; used for colour profiles). */
  function avgDown(src, tw, th) {
    var cur = src, w = src.width, h = src.height;
    while (w > tw * 2 || h > th * 2) {
      var nw = w > tw * 2 ? Math.ceil(w / 2) : w, nh = h > th * 2 ? Math.ceil(h / 2) : h;
      var cn = mkCanvas(nw, nh);
      hiCtx(cn).drawImage(cur, 0, 0, w, h, 0, 0, nw, nh);
      cur = cn; w = nw; h = nh;
    }
    var out = mkCanvas(tw, th);
    hiCtx(out).drawImage(cur, 0, 0, w, h, 0, 0, tw, th);
    return out;
  }

  /** Draw `src` stretched over (0, 0, w, h) of x, faded in along y by a vertical alpha ramp (a0 at ya -> a1 at yb). */
  function drawRampV(x, src, w, h, ya, a0, yb, a1) {
    if (yb - ya < 1) yb = ya + 1;
    var t = mkCanvas(w, h), tx = hiCtx(t);
    tx.drawImage(src, 0, 0, w, h);
    var g = tx.createLinearGradient(0, ya, 0, yb);
    g.addColorStop(0, 'rgba(0,0,0,' + a0 + ')');
    g.addColorStop(1, 'rgba(0,0,0,' + a1 + ')');
    tx.globalCompositeOperation = 'destination-in';
    tx.fillStyle = g;
    tx.fillRect(0, 0, w, h);
    x.drawImage(t, 0, 0);
  }

  // =================================================================================================================
  // Particles (dust). Deterministic: own seeded RNG, stepped with the simulation (main.js: fx.step / fx.onEvent).
  //
  // Sprite dust (the photoreal ASSET_MANIFEST.fx.dust sprites): at every toe-off (a run-frame change that plants the
  // other foot) 1-2 fresh puffs and a grain spray rise behind the lifting rear foot, plus a trailing plume whose odds and
  // opacity grow with the speed; a burst on landing, a big burst + spray on the crash; a ducking run raises lower,
  // flatter puffs. Particles live in world space on the running line: every sprite's anchor (the bottom of its dense
  // base) sits exactly on GROUND_Y. They start glued to the ground where they were raised (they scroll with it) and
  // settle to DUST_FOLLOW x the ground speed (the dino's wake carries the airborne dust a little), grow and fade;
  // fresh puffs crossfade into 'thin' puffs as they age. A fixed pool (DUST_MAX) and typed arrays: no allocation per
  // tick. Small dark ballistic grains (procedural) add motion to the sprays. When no puff sprite loaded (no fx group,
  // or its images failed), the original procedural puffs are used instead (this.sprites false).

  var DK = { puff: 0, spray: 1, plume: 2, burst: 3 };
  var DUST_DEF = [[0.5, 0.88, 46], [0.9, 0.88, 56], [0.9, 0.81, 125], [0.5, 0.82, 160]]; // per kind: anchor x, y, worldW

  /** Dust sprite metadata from the manifest, one entry per fx.dust[] index (null when malformed): kind, stage,
   * aspect h/w, anchor (ax, ay) and the suggested world width ww. */
  function dustLibrary(man) {
    var src = man && man.fx && Array.isArray(man.fx.dust) ? man.fx.dust : [], items = [];
    for (var i = 0; i < src.length; i++) {
      var e = src[i], k = e && Object.prototype.hasOwnProperty.call(DK, e.kind) ? DK[e.kind] : null;
      if (k == null || typeof e.src !== 'string' || !(e.w > 0) || !(e.h > 0)) { items.push(null); continue; }
      var an = e.anchor, ok = Array.isArray(an) && isFinite(an[0]) && isFinite(an[1]), df = DUST_DEF[k];
      items.push({
        kind: k, thin: e.stage === 'thin', ar: e.h / e.w,
        ax: ok ? clamp(+an[0], 0, 1) : df[0], ay: ok ? clamp(+an[1], 0, 1) : df[1],
        ww: e.worldW > 0 && isFinite(e.worldW) ? +e.worldW : df[2]
      });
    }
    return items;
  }

  /** Per animation frame: `plant` = centre of the rearmost rect touching the ground (the planted foot), `rear` =
   * centre of the rearmost low rect (the rear foot, lifted just off the ground in a stride frame). World units. */
  function footInfo(frames, D) {
    return frames.map(function (f) {
      var p = Infinity, px = 0, q = Infinity, qx = 0, gs = 0, gn = 0;
      for (var i = 0; i < f.n; i++) {
        var x0 = f.r[i * 4], x1 = f.r[i * 4 + 2], y1 = f.r[i * 4 + 3];
        if (y1 > -4) { gs += (x0 + x1) / 2; gn++; if (x0 < p) { p = x0; px = (x0 + x1) / 2; } }
        if (y1 > -16 && x0 < q) { q = x0; qx = (x0 + x1) / 2; }
      }
      var mid = (D.back + D.front) / 2;
      return { plant: p < Infinity ? px : mid, rear: q < Infinity ? qx : D.back + 0.2 * D.hitLen, mid: gn ? gs / gn : mid };
    });
  }

  function FX(cfg, M) {
    this.cfg = cfg; this.M = M;
    // procedural particles: soft puffs (fallback) and dark ballistic grains
    var N = (this.N = 320);
    this.x = new Float64Array(N); this.y = new Float64Array(N); this.vx = new Float64Array(N); this.vy = new Float64Array(N);
    this.life = new Float64Array(N); this.max = new Float64Array(N); this.size = new Float64Array(N);
    this.grow = new Float64Array(N); this.a = new Float64Array(N); this.front = new Uint8Array(N); this.on = new Uint8Array(N);
    this.grain = new Uint8Array(N); // 0 = soft dust puff, 1 = kicked-up grain (small, dark, ballistic)
    this.cursor = 0;
    this.lastFrame = -1; this.lastAnim = -1; // run / duck frame seen on the previous tick (footfall detection)
    this.rng = RDG.rng.create(9001);
    var D = M.dino;
    this.runFeet = footInfo(D.frames.run, D);
    this.duckFeet = footInfo(D.frames.duck, D);
    this.deadFeet = footInfo(D.frames.dead, D)[0];
    this.feet = this.runFeet.map(function (f) { return f.plant; }); // (procedural) planted-foot x per run frame
    var ts = 0, tn = 0; // mean rear-toe x of the stride frames (rear foot well behind the planted one): jump push-off
    this.runFeet.forEach(function (f) { if (f.rear < f.plant - 20) { ts += f.rear; tn++; } });
    this.toeX = tn ? ts / tn : D.back + 0.2 * D.hitLen;
    // sprite dust
    this.lib = dustLibrary(root.ASSET_MANIFEST);
    this.sprites = false; // set by the renderer (useSprites) once it has the images
    this.pick = { fresh: [], thin: [], spray: [], plume: [], burst: [] };
    var S = (this.SN = Math.max(8, RC.DUST_MAX | 0));
    this.sOn = new Uint8Array(S); this.sKind = new Uint8Array(S); this.sFront = new Uint8Array(S);
    this.sA = new Int16Array(S); this.sB = new Int16Array(S); this.sFlip = new Int8Array(S);
    this.sX = new Float64Array(S); this.sPx = new Float64Array(S); this.sVx = new Float64Array(S);
    this.sFol = new Float64Array(S); this.sFol2 = new Float64Array(S); this.sDrag = new Float64Array(S);
    this.sAge = new Float64Array(S); this.sLife = new Float64Array(S); this.sIn = new Float64Array(S); this.sHold = new Float64Array(S);
    this.sW = new Float64Array(S); this.sGx = new Float64Array(S); this.sGy = new Float64Array(S); this.sSy = new Float64Array(S);
    this.sRot = new Float64Array(S); this.sSk = new Float64Array(S); this.sAl = new Float64Array(S);
    this.live = 0; // live sprite particles after the last step
    this.crashPending = false; // crashed in the air: the crash dust rises when the dino comes down on the ground
  }

  /** Which fx.dust entries have images (renderer, after each cache build): sprite dust on when a puff is available. */
  FX.prototype.useSprites = function (avail) {
    var P = { fresh: [], thin: [], spray: [], plume: [], burst: [] }, L = this.lib;
    for (var i = 0; i < L.length; i++) {
      var it = L[i];
      if (!it || !avail[i]) continue;
      if (it.kind === DK.puff) (it.thin ? P.thin : P.fresh).push(i);
      else if (it.kind === DK.spray) P.spray.push(i);
      else if (it.kind === DK.plume) P.plume.push(i);
      else P.burst.push(i);
    }
    if (!P.fresh.length) P.fresh = P.thin;
    if (!P.thin.length) P.thin = P.fresh;
    this.pick = P;
    var on = P.fresh.length > 0;
    if (on !== this.sprites) { this.sOn.fill(0); this.on.fill(0); this.live = 0; }
    this.sprites = on;
  };

  FX.prototype.reset = function (seed) {
    this.on.fill(0);
    this.sOn.fill(0);
    this.live = 0;
    this.lastFrame = -1; this.lastAnim = -1;
    this.crashPending = false;
    this.rng = RDG.rng.create((seed | 0) ^ 0x5eed);
  };
  FX.prototype.emit = function (x, y, vx, vy, size, grow, life, alpha, front) {
    var i = this.cursor;
    this.cursor = (i + 1) % this.N;
    this.on[i] = 1; this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy; this.size[i] = size;
    this.grow[i] = grow; this.life[i] = 0; this.max[i] = life; this.a[i] = alpha; this.front[i] = front ? 1 : 0;
    this.grain[i] = 0;
    return i;
  };
  FX.prototype.kick = function (x, vx, vy, size, life, front) {
    var i = this.emit(x, this.cfg.GROUND_Y - 0.5, vx, vy, size, 0, life, 0.75, front);
    this.grain[i] = 1;
  };
  /** n dark grains kicked up and back from around footX (sprite mode: the sprays' flying grains). */
  FX.prototype.grains = function (sim, n, footX, spread, power, frontShare) {
    var r = this.rng, nx = RDG.rng.next, v = sim.status === STATUS.RUNNING ? sim.speed : 0;
    for (var k = 0; k < n; k++) {
      this.kick(footX - nx(r) * spread, -v * (0.1 + nx(r) * 0.25) - (0.8 + nx(r) * 2.2) * power, -(1.3 + nx(r) * 2.6) * power,
        1.1 + nx(r) * 1.3, 18 + nx(r) * 14, nx(r) < frontShare);
    }
  };
  FX.prototype.burst = function (sim, count, x0, x1, power, big, front) {
    var r = this.rng, nx = RDG.rng.next, G = this.cfg.GROUND_Y;
    var drift = sim.status === STATUS.RUNNING ? -sim.speed * 0.6 : 0;
    for (var k = 0; k < count; k++) {
      var x = lerp(x0, x1, nx(r));
      this.emit(x, G - nx(r) * 3, drift + (nx(r) - 0.5) * 3 * power, -(0.4 + nx(r) * 1.4) * power,
        (big ? 8 : 4) + nx(r) * 6, (big ? 0.45 : 0.28) + nx(r) * 0.2, 34 + nx(r) * 30, (big ? 0.5 : 0.38) + nx(r) * 0.15, front && nx(r) < 0.5);
    }
  };

  /** A free sprite slot (or the most faded one when the pool is full). */
  FX.prototype._slot = function () {
    var best = 0, bt = -1;
    for (var i = 0; i < this.SN; i++) {
      if (!this.sOn[i]) return i;
      var t = this.sAge[i] / this.sLife[i];
      if (t > bt) { bt = t; best = i; }
    }
    return best;
  };
  /** Spawn a sprite particle: library item a (b: the item it crossfades into, -1 none), anchor at world x on the
   * running line, initial width w0 (u), end scale gx / gy, life (ticks), peak alpha. Returns the slot; callers adjust
   * the optional fields (squash, rotation, mirror, fade-in, hold, follow, drag, front). */
  FX.prototype._spawn = function (sim, kind, a, b, x, w0, gx, gy, life, alpha) {
    var i = this._slot(), running = sim.status === STATUS.RUNNING, nx = RDG.rng.next, r = this.rng;
    if (!this.sOn[i]) this.live++;
    this.sOn[i] = 1; this.sKind[i] = kind; this.sA[i] = a; this.sB[i] = b;
    this.sX[i] = x; this.sPx[i] = x; this.sVx[i] = running ? -sim.speed : 0; // raised where the foot is: glued to the ground
    this.sFol[i] = RC.DUST_FOLLOW[0]; this.sFol2[i] = RC.DUST_FOLLOW[1]; this.sDrag[i] = RC.DUST_DRAG;
    this.sAge[i] = 0; this.sLife[i] = Math.max(2, life); this.sIn[i] = 3; this.sHold[i] = 0.1;
    this.sW[i] = w0; this.sGx[i] = gx; this.sGy[i] = gy; this.sSy[i] = 1; this.sAl[i] = alpha;
    this.sRot[i] = (nx(r) - 0.5) * 2 * RC.DUST_ROT; // small tilt about the anchor (on the ground)
    this.sSk[i] = 0; // backward lean (shear: x -= lean * height), the base stays put
    this.sFlip[i] = kind === DK.puff || kind === DK.burst ? (nx(r) < 0.5 ? -1 : 1) : 1; // sprays / plumes point back
    this.sFront[i] = 0;
    return i;
  };
  function rr(r, span) { return span[0] + (span[1] - span[0]) * RDG.rng.next(r); }
  function pickOne(r, list) { return list[Math.min(list.length - 1, Math.floor(RDG.rng.next(r) * list.length))]; }

  /** Sprite toe-off at the start of a stride frame f ({plant, rear}): spray + 1-2 fresh puffs behind the lifting rear
   * foot, a small puff under the landing front foot, and a trailing plume at speed. duck: lower, flatter, lighter. */
  FX.prototype._kickSprites = function (sim, f, duck) {
    var r = this.rng, nx = RDG.rng.next, c = this.cfg, P = this.pick, v = sim.speed, i, k;
    var I = clamp((v - c.SPEED) / Math.max(1e-6, c.MAX_SPEED - c.SPEED), 0, 1), big = 1 + RC.DUST_SPEED_GROW * I;
    var toe = f.rear, sy = duck ? RC.DUST_DUCK_SQUASH[1] : 1, sx = duck ? RC.DUST_DUCK_SQUASH[0] : 1, ka = duck ? 0.95 : 1;
    var L = this.lib, Q;
    // 1. spray: grains + fine dust flung up and back from under the lifting toe
    if (P.spray.length) {
      Q = RC.DUST_SPRAY;
      k = pickOne(r, P.spray);
      i = this._spawn(sim, DK.spray, k, -1, toe + Q.dx, L[k].ww * rr(r, Q.size) * big * sx, rr(r, Q.grow), rr(r, Q.grow),
        rr(r, Q.life) * 60, rr(r, Q.alpha) * ka);
      this.sFol[i] = this.sFol2[i] = Q.follow; this.sIn[i] = 1.5; this.sHold[i] = 0; this.sSy[i] = sy;
    }
    // 2. fresh puffs just behind the toe (they thin out as they age)
    Q = RC.DUST_PUFF;
    var n = nx(r) < Q.second + 0.4 * I ? 2 : 1;
    for (var j = 0; j < n; j++) {
      k = pickOne(r, P.fresh);
      i = this._spawn(sim, DK.puff, k, pickOne(r, P.thin), toe + Q.dx[0] + (Q.dx[1] - Q.dx[0]) * nx(r) - j * 10,
        L[k].ww * rr(r, Q.size) * big * sx, rr(r, Q.grow), 0, rr(r, Q.life) * 60, rr(r, Q.alpha) * ka * (j ? 0.8 : 1));
      this.sGy[i] = this.sGx[i] * (duck ? 0.85 : 1); this.sSy[i] = sy * RC.DUST_PUFF.sy;
      this.sSk[i] = RC.DUST_LEAN[0] + (RC.DUST_LEAN[1] - RC.DUST_LEAN[0]) * I + 0.08 * nx(r); // swept back by the run
    }
    // 3. a faint low puff where the front foot lands
    if (!duck && nx(r) < Q.land[0]) {
      k = pickOne(r, P.thin);
      i = this._spawn(sim, DK.puff, k, -1, f.plant - 4 - nx(r) * 8, L[k].ww * 0.42, 1.5, 1.2, rr(r, Q.life) * 50, Q.land[1]);
      this.sSy[i] = 0.6;
    }
    // 4. trailing plume: more likely and denser with speed
    if (P.plume.length) {
      Q = RC.DUST_PLUME;
      if (nx(r) < lerp(Q.chance[0], Q.chance[1], I)) {
        k = pickOne(r, P.plume);
        i = this._spawn(sim, DK.plume, k, -1, toe + Q.dx, L[k].ww * rr(r, Q.size) * (0.85 + 0.3 * I) * sx, rr(r, Q.grow), 1.15,
          rr(r, Q.life) * 60, lerp(Q.alpha[0], Q.alpha[1], I) * ka);
        this.sSy[i] = sy; this.sIn[i] = 5; this.sHold[i] = 0.05;
      }
    }
    // 5. a few flying grains (the sprays are stills; these move)
    this.grains(sim, Math.round(RC.DUST_GRAINS * (duck ? 0.5 : 1) * (1 + I)), toe + 2, 10, 1, 0.15);
  };

  /** Landing / crash / push-off bursts (sprite mode). */
  FX.prototype._burstSprites = function (sim, kind) {
    var r = this.rng, nx = RDG.rng.next, P = this.pick, L = this.lib, D = this.M.dino, i, k, Q, j;
    if (kind === EV.JUMP) { // push-off: a light spray and a small puff behind the rear foot
      if (P.spray.length) {
        Q = RC.DUST_SPRAY; k = pickOne(r, P.spray);
        i = this._spawn(sim, DK.spray, k, -1, this.toeX + Q.dx, L[k].ww * rr(r, Q.size) * 0.85, 1.25, 1.25, rr(r, Q.life) * 60, 0.75);
        this.sFol[i] = this.sFol2[i] = Q.follow; this.sIn[i] = 1.5; this.sHold[i] = 0;
      }
      k = pickOne(r, P.fresh);
      this._spawn(sim, DK.puff, k, pickOne(r, P.thin), this.toeX - 8, L[k].ww * 0.5, 1.8, 1.8, 36, 0.5);
      return;
    }
    var land = kind === EV.LAND;
    Q = land ? RC.DUST_LAND : RC.DUST_CRASH;
    var f0 = this.runFeet[0], cx = land ? (f0.plant + f0.rear) / 2 : this.deadFeet.mid;
    if (P.burst.length) {
      k = land ? P.burst[0] : P.burst[P.burst.length - 1]; // the rolling burst for landings, the flat wide one for the crash
      i = this._spawn(sim, DK.burst, k, -1, cx + Q.dx, L[k].ww * Q.size * (0.9 + 0.2 * nx(r)), Q.grow[0], Q.grow[1], Q.life * 60, Q.alpha);
      this.sIn[i] = land ? 1 : 2; this.sHold[i] = Q.hold;
      if (!land) this.sDrag[i] = 0.1;
      else this.sFol2[i] = 0.95; // a landing burst is left behind on the ground
    }
    // puffs under the feet (all the dust when there is no burst sprite)
    var np = P.burst.length ? 2 : 3;
    for (j = 0; j < np; j++) {
      k = pickOne(r, P.fresh);
      i = this._spawn(sim, DK.puff, k, pickOne(r, P.thin), cx + (j - (np - 1) / 2) * 34 + (nx(r) - 0.5) * 12,
        L[k].ww * (land ? 0.7 : 0.8), land ? 1.8 : 1.9, land ? 1.5 : 1.7, Q.life * 60 * (0.7 + 0.3 * nx(r)), Q.alpha * 0.8);
      this.sHold[i] = Q.hold * 0.8; this.sIn[i] = 1;
    }
    if (!land) {
      // the crash also throws grains back from the feet, and a thin veil drifts in front of them
      if (P.spray.length) {
        k = pickOne(r, P.spray);
        i = this._spawn(sim, DK.spray, k, -1, this.deadFeet.rear + RC.DUST_SPRAY.dx, L[k].ww * 1.15, 1.35, 1.35, 30, 0.9);
        this.sIn[i] = 1.5; this.sHold[i] = 0; this.sDrag[i] = 0.1;
      }
      k = pickOne(r, P.thin);
      i = this._spawn(sim, DK.puff, k, -1, cx + 10, L[k].ww * 0.9, 1.6, 1.3, Q.life * 60, 0.28);
      this.sFront[i] = 1; this.sSy[i] = 0.7; this.sHold[i] = 0.25; this.sIn[i] = 8;
      this.grains(sim, 14, D.front - 30, 60, 1.4, 0.4);
    } else this.grains(sim, 6, cx, 40, 0.9, 0.2);
  };

  FX.prototype.onEvent = function (e, sim) {
    var D = this.M.dino, i;
    if (e === EV.START) { this.reset(sim.seed + sim.runs * 7919); return; }
    if (!this.sprites) { // procedural fallback (the original look)
      if (e === EV.LAND) this.burst(sim, 9, D.back + D.hitLen * 0.25, D.back + D.hitLen * 0.75, 0.9, false, false);
      else if (e === EV.JUMP) this.burst(sim, 5, D.back + D.hitLen * 0.3, D.back + D.hitLen * 0.6, 0.6, false, false);
      else if (e === EV.CRASH) this.burst(sim, 26, D.back + D.hitLen * 0.2, D.front + 10, 1.6, true, true);
      return;
    }
    if (e === EV.LAND || e === EV.JUMP) this._burstSprites(sim, e);
    else if (e === EV.CRASH) {
      // the ground stops: dust in the air keeps its ground-relative drift (the wake), then settles
      for (i = 0; i < this.SN; i++) if (this.sOn[i]) this.sVx[i] += sim.speed;
      for (i = 0; i < this.N; i++) if (this.on[i]) this.vx[i] += sim.speed * 0.5;
      if (this.cfg.GROUND_Y - sim.dino.y < 24) this._burstSprites(sim, EV.CRASH);
      else this.crashPending = true; // hit in the air: the dust rises if / when it comes down on the ground
    }
  };

  FX.prototype.step = function (sim) {
    var N = this.N, running = sim.status === STATUS.RUNNING, d = sim.dino, i;
    var G = this.cfg.GROUND_Y, v = sim.speed;
    for (i = 0; i < N; i++) {
      if (!this.on[i]) continue;
      this.life[i] += 1;
      if (this.life[i] >= this.max[i]) { this.on[i] = 0; continue; }
      this.x[i] += this.vx[i]; this.y[i] += this.vy[i];
      if (this.grain[i]) { // ballistic grain: falls back and dies on the ground
        this.vy[i] += 0.16;
        this.vx[i] = running ? this.vx[i] * 0.985 - v * 0.012 : this.vx[i] * 0.95;
        if (this.y[i] > G || this.x[i] < -10) this.on[i] = 0;
        continue;
      }
      this.vy[i] = this.vy[i] * 0.94 + 0.012;
      // the plume drifts back at ~0.55x the ground speed, so it stays near the foot that raised it
      this.vx[i] = running ? this.vx[i] * 0.94 - v * 0.06 * 0.55 : this.vx[i] * 0.9;
      this.size[i] += this.grow[i];
    }
    // sprite dust: ground-glued at first, relaxing to the wake speed (DUST_FOLLOW x the ground speed; 0 once crashed)
    var live = 0;
    for (i = 0; i < this.SN; i++) {
      if (!this.sOn[i]) continue;
      this.sAge[i] += 1;
      this.sPx[i] = this.sX[i];
      var tf = this.sFol[i] + (this.sFol2[i] - this.sFol[i]) * (this.sAge[i] / this.sLife[i]);
      var tgt = running ? -v * tf : 0, dr = running ? this.sDrag[i] : 0.1;
      this.sVx[i] += (tgt - this.sVx[i]) * dr;
      this.sX[i] += this.sVx[i];
      if (this.sAge[i] >= this.sLife[i] || this.sX[i] + this.sW[i] * this.sGx[i] < -8) { this.sOn[i] = 0; continue; }
      live++;
    }
    this.live = live;
    // footfalls: a newly planted foot means the old rear foot is toeing off (duck: every frame change)
    var run = running && !d.jumping && d.anim === Sim.ANIM.RUN, duck = running && !d.jumping && d.anim === Sim.ANIM.DUCK;
    if ((run || duck) && this.lastAnim === d.anim && this.lastFrame >= 0 && d.frame !== this.lastFrame) {
      var F = run ? this.runFeet : this.duckFeet, nf = F.length, fNew = F[d.frame % nf], fOld = F[this.lastFrame % nf];
      if (this.sprites) { if (duck || fNew.plant > fOld.plant + 10) this._kickSprites(sim, fNew, duck); }
      else if (run && fNew.plant > fOld.plant + 10) this.kickoff(sim, fOld.plant);
    }
    this.lastFrame = run || duck ? d.frame : -1;
    this.lastAnim = d.anim;
    if (running && !d.jumping) {
      // a light continuous trail from the rear foot plus the odd grain kicked up and back (the reference's spray)
      var r = this.rng, nx = RDG.rng.next, sp = v / this.cfg.SPEED;
      var fx = this.feet[d.anim === Sim.ANIM.RUN ? d.frame % this.feet.length : 0];
      if (d.ducking) fx = this.M.dino.back + this.M.dino.hitLen * 0.35;
      if (!this.sprites) {
        if (nx(r) < 0.5) {
          this.emit(fx + (nx(r) - 0.5) * 8, G + 1.5, -v * (0.35 + nx(r) * 0.3), -(0.25 + nx(r) * 0.7),
            5 + nx(r) * 5, 0.4 + nx(r) * 0.3 * sp, 16 + nx(r) * 12, 0.45 + nx(r) * 0.2, false);
        }
        if (nx(r) < 0.7) this.kick(fx + (nx(r) - 0.5) * 8, -v * (0.15 + nx(r) * 0.3) - 1, -(1.1 + nx(r) * 2.0), 1.3 + nx(r) * 1.4, 16 + nx(r) * 12);
      } else if (nx(r) < 0.25) this.kick(fx + (nx(r) - 0.5) * 8, -v * (0.15 + nx(r) * 0.3) - 1, -(1.1 + nx(r) * 2.0), 1.2 + nx(r) * 1.2, 16 + nx(r) * 12);
    }
    // a crash in the air: the crash dust rises once the dino comes down on the ground
    if (this.crashPending && sim.status === STATUS.CRASHED && d.y >= G - 0.5) {
      this.crashPending = false;
      if (this.sprites) this._burstSprites(sim, EV.CRASH);
    }
  };
  /** (Procedural fallback) toe-off burst behind the rear foot at footX: a few big soft puffs and a spray of grains. */
  FX.prototype.kickoff = function (sim, footX) {
    var r = this.rng, nx = RDG.rng.next, G = this.cfg.GROUND_Y, v = sim.speed, k;
    var puffs = 3 + (nx(r) < 0.5 ? 1 : 0);
    for (k = 0; k < puffs; k++) {
      this.emit(footX - 4 - nx(r) * 16, G + 1, -v * (0.2 + nx(r) * 0.25), -(0.6 + nx(r) * 1.3), 12 + nx(r) * 10, 0.9 + nx(r) * 0.6,
        24 + nx(r) * 14, 0.7 + nx(r) * 0.2, false);
    }
    var grains = 10 + Math.floor((nx(r) * 6 * v) / this.cfg.SPEED);
    for (k = 0; k < grains; k++) this.kick(footX - nx(r) * 12, -v * (0.1 + nx(r) * 0.25) - (1 + nx(r) * 2.5), -(1.4 + nx(r) * 3), 1.1 + nx(r) * 1.4, 20 + nx(r) * 14);
  };

  // =================================================================================================================
  function Renderer(canvas, cfg, M) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.cfg = cfg;
    this.M = M;
    this.A = null;
    this.fx = new FX(cfg, M);
    this.W = Math.round(cfg.H * 2.5); this.bs = 1; this.cw = 1; this.ch = 1;
    this.T = 0; this.B = 0; this.VH = cfg.H; this.tpx = 0; this.cssScale = 1; this.horizonCss = cfg.HORIZON_Y;
    this.dprEff = 1; this.hudY = cfg.HUD_TOP; this.hudDy = 0;
    this.layer = null; this.lctx = null;
    // prefers-reduced-motion, followed live: no camera shake, no hint pulse, no star twinkle (the scene's own
    // parallax motion stays: it is the game). needsRedraw tells the host to re-render.
    this.reducedMotion = false; this.needsRedraw = false;
    try {
      var mq = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)'), self = this;
      if (mq) {
        this.reducedMotion = !!mq.matches;
        var onMq = function (e) { self.reducedMotion = !!(e && typeof e.matches === 'boolean' ? e.matches : mq.matches); self.needsRedraw = true; };
        if (mq.addEventListener) mq.addEventListener('change', onMq);
        else if (mq.addListener) mq.addListener(onMq);
      }
    } catch (e) { /* no matchMedia: full motion */ }
    this.lang = 'en';
    this.touch = false;
    this.pageColors = { skyDay: cfg.PAGE_SKY_DAY, groundDay: cfg.PAGE_GROUND_DAY };
    this.gf = null; // ground slice factors
    // renderer-owned cosmetic scroll: the landscape continues across restarts (sim distance / time reset per run)
    this._sceneBase = 0; this._windBase = 0; this._runsSeen = null; this._lastScroll = 0; this._lastWind = 0;
    this.gradeStyles = null; this.liftStyles = null;
    this.cache = null;
  }

  Renderer.prototype.setAssets = function (A) {
    this.A = A;
    if (this.cw > 1) this._build();
  };

  /**
   * Fit the canvas to the viewport. The world is W x H units (H = 540); W never shows less road ahead than Chrome
   * (VIEW_MIN_W) as long as the dino stays DINO_MIN_CSS_H CSS px tall. A viewport taller than that is filled by
   * extending the sky above (T units) and the ground below (B units): VH = H + T + B. Wider than ASPECT_MAX is
   * pillarboxed. World y is offset by T (this.tpx device px) in every world-space transform.
   */
  Renderer.prototype.resize = function (vw, vh, dpr, safeTop) {
    var c = this.cfg, H = c.H;
    vw = Math.max(1, vw); vh = Math.max(1, vh); dpr = dpr || 1;
    var wMin = Math.min(RC.VIEW_MIN_W, Math.max(Math.round(H * c.ASPECT_MIN), Math.floor((c.DINO_HEIGHT * vw) / RC.DINO_MIN_CSS_H)));
    var W = Math.min(Math.round(H * c.ASPECT_MAX), Math.max(Math.round((H * vw) / vh), wMin));
    var css = Math.min(vw / W, vh / H);
    var extra = vh / css - H;
    if (extra < 1) extra = 0; // exact fits and pillarboxing
    var T = Math.round(extra * RC.SKY_EXT_SHARE), B = Math.round(extra) - T, VH = H + T + B;
    if (root.matchMedia && root.matchMedia('(pointer: coarse)').matches) dpr = Math.min(dpr, RC.COARSE_DPR_CAP);
    var bs = css * dpr;
    if (W * VH * bs * bs > c.MAX_BACKING_PIXELS) bs = Math.sqrt(c.MAX_BACKING_PIXELS / (W * VH));
    var cw = Math.max(1, Math.round(W * bs)), ch = Math.max(1, Math.round(VH * bs));
    this.canvas.width = cw; this.canvas.height = ch;
    this.canvas.style.width = W * css + 'px';
    this.canvas.style.height = VH * css + 'px';
    // world -> device scale, exact along the binding dimension (width on tall screens, else height: unchanged frames)
    this.W = W; this.bs = extra > 0 ? cw / W : ch / VH; this.cw = cw; this.ch = ch; this.cssScale = css;
    this.dprEff = cw / Math.max(1, W * css); // device px per CSS px (touch UI sizes are in CSS px)
    this.T = T; this.B = B; this.VH = VH; this.tpx = Math.round(T * this.bs);
    // HUD centre line (device px): on the playfield, except on tall screens (more than HUD_PIN_T of extra sky), where
    // a score floating mid-sky reads as a label: there it pins to the top of the screen, below the top safe-area inset
    // (hudDy: device px added to the playfield HUD line; 0 unless pinned)
    var hudY = this.tpx + c.HUD_TOP * this.bs, pinY = Math.max(0, safeTop || 0) * this.dprEff + c.HUD_TOP * this.bs;
    this.hudDy = T > RC.HUD_PIN_T && pinY < hudY ? Math.round(pinY - hudY) : 0;
    this.hudY = hudY + this.hudDy;
    this.horizonCss = (T + c.HORIZON_Y) * css; // main.js splits the page bands here
    this._pcTab = null;
    setFrameSmoothing(this.ctx);
    // assigning a canvas size resets its 2D state (smoothing quality drops back to 'low'): restore it
    if (this.layer) { this.layer.width = cw; this.layer.height = this._bandHeight(); setFrameSmoothing(this.lctx); }
    if (this.A) this._build();
    else this.drawLoading(); // never a raw black canvas before the assets are in
  };

  /**
   * Loading frame (no assets needed; never throws): the page's day sky colour above the horizon row, the ground
   * colour below it, and, for a finite frac in [0, 1), a thin low-contrast progress bar centred on the horizon
   * (30 % of the width, 2 CSS px tall). main.js may call it every frame until the assets are ready.
   */
  Renderer.prototype.drawLoading = function (frac) {
    try {
      var ctx = this.ctx, c = this.cfg, cw = this.cw, ch = this.ch;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      var hz = clamp(Math.round(((this.T || 0) + c.HORIZON_Y) * this.bs), 0, ch);
      ctx.fillStyle = RC.PAGE_SKY_DAY;
      ctx.fillRect(0, 0, cw, hz);
      ctx.fillStyle = RC.PAGE_GROUND_DAY;
      ctx.fillRect(0, hz, cw, ch - hz);
      if (typeof frac === 'number' && isFinite(frac) && frac >= 0 && frac < 1) {
        var dprEff = cw / Math.max(1, this.W * (this.cssScale || 1));
        var bw = Math.round(cw * 0.3), bh = Math.max(1, Math.round(2 * dprEff)), x0 = Math.round((cw - bw) / 2), y0 = Math.round(hz - bh / 2);
        ctx.fillStyle = '#535353';
        ctx.globalAlpha = 0.12; // track
        ctx.fillRect(x0, y0, bw, bh);
        ctx.globalAlpha = 0.35;
        ctx.fillRect(x0, y0, Math.round(bw * frac), bh);
        ctx.globalAlpha = 1;
      }
    } catch (e) { /* never throw from the loading screen */ }
  };

  /** Height (device px) of the dusk / night grading layer: only the sky-side terrain band (mountains, haze, decor
   * tips) from MOUNTAIN_PEAK_Y - 60 down to the horizon row, plus room for the camera shake. */
  Renderer.prototype._bandHeight = function () {
    var c = this.cfg;
    return Math.max(1, Math.ceil((c.HORIZON_Y - (c.MOUNTAIN_PEAK_Y - 60) + 2 * c.SHAKE_AMPLITUDE + 4) * this.bs) + 2);
  };
  Renderer.prototype._layerCtx = function () {
    var h = this._bandHeight();
    if (!this.layer) {
      this.layer = mkCanvas(this.cw, h);
      this.lctx = this.layer.getContext('2d');
      setFrameSmoothing(this.lctx);
    } else if (this.layer.width !== this.cw || this.layer.height !== h) {
      this.layer.width = this.cw; this.layer.height = h;
      setFrameSmoothing(this.lctx);
    }
    return this.lctx;
  };

  Renderer.prototype.groundFactor = function (y) {
    var c = this.cfg, HOR = c.HORIZON_Y, H = c.H;
    var t = (y - HOR) / (H - HOR);
    if (t <= 0) return c.GROUND_FACTOR_HORIZON;
    var tg = (c.GROUND_Y - HOR) / (H - HOR), A = c.GROUND_FACTOR_BOTTOM - c.GROUND_FACTOR_HORIZON;
    var p = Math.log((1 - c.GROUND_FACTOR_HORIZON) / A) / Math.log(tg);
    return c.GROUND_FACTOR_HORIZON + A * Math.pow(t, p);
  };
  /** Ground factor with a soft cap below H (ground extension on tall screens): unchanged up to
   * GROUND_FACTOR_BOTTOM (y <= H), then asymptotic to GROUND_F_CAP x that. */
  Renderer.prototype.groundFactorSoft = function (y) {
    var f = this.groundFactor(y), F0 = this.cfg.GROUND_FACTOR_BOTTOM, F1 = F0 * RC.GROUND_F_CAP;
    return f <= F0 ? f : F0 + (F1 - F0) * (1 - Math.exp(-(f - F0) / (F1 - F0)));
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Cache building (on resize / asset load)

  Renderer.prototype._build = function () {
    var c = this.cfg, A = this.A, M = this.M, bs = this.bs, W = this.W, H = c.H;
    var C = (this.cache = {});
    var D = M.dino, k, i;
    // dino frames
    C.dino = [];
    for (k = 0; k < ANIM_KEYS.length; k++) {
      var key = ANIM_KEYS[k], list = A.dino[key] || [], out = [];
      for (i = 0; i < list.length; i++) {
        var img = list[i];
        if (key === 'duck' && A.dino.duckSquash) img = this._squash(img, D);
        out.push(this._actorSet(scaleImage(img, D.frameW * bs, D.frameH * bs)));
      }
      C.dino.push(out);
    }
    // cacti
    C.cactus = [[], []];
    for (k = 0; k < 2; k++) {
      var vars = M.cactusByType[k], imgs = k === 0 ? A.cactus.small : A.cactus.large;
      for (i = 0; i < vars.length; i++) C.cactus[k].push(this._actorSet(scaleImage(imgs[i], vars[i].w * bs, vars[i].h * bs)));
    }
    // ptero
    C.ptero = [];
    for (i = 0; i < A.ptero.length; i++) C.ptero.push(this._actorSet(scaleImage(A.ptero[i], M.ptero.frameW * bs, M.ptero.frameH * bs)));
    // dust sprites: [day, dusk, night] copies at their largest drawn size, graded like the actors (unpremultiplied,
    // no halo); entries without an image stay null and the FX falls back to its procedural puffs without any puff
    C.dustSpr = [];
    var dl = this.fx.lib, ad = (A.fx && A.fx.dust) || [], avail = [];
    for (i = 0; i < dl.length; i++) {
      var di = dl[i], dimg = di && ad[i] ? ad[i].img : null;
      if (!di || !dimg || !(dimg.width > 0)) { C.dustSpr.push(null); avail.push(false); continue; }
      var dU = di.ww * RC.DUST_CACHE_SCALE[di.kind], dsc = scaleImage(dimg, dU * bs, dU * di.ar * bs);
      C.dustSpr.push([dsc, gradeCopy(dsc, c.ACTOR_GRADE_DUSK), gradeCopy(dsc, RC.DUST_GRADE_NIGHT)]);
      avail.push(true);
    }
    this.fx.useSprites(avail);
    // sky (cover-fit so horizonY lands on HORIZON_Y; left-anchored to keep the sun glare in the corner). On tall
    // screens the sky continues above the image (world y down to -T) with a zenith cap composed at build time.
    C.sky = {};
    var over = c.SHAKE_AMPLITUDE + 2, capTop = -(this.T || 0) - 12;
    ['day', 'dusk', 'night'].forEach(function (kd) {
      var s = A.sky[kd];
      var sc = Math.max((W + over * 2) / s.w, (c.HORIZON_Y + over) / (s.horizonY * s.h));
      var dw = s.w * sc, dh = s.h * sc, sy = c.HORIZON_Y - s.horizonY * dh;
      if (this.T > 0 && sy > capTop) C.sky[kd] = skyWithCap(s.img, -over, sy, dw, dh, capTop, bs, kd === 'day');
      else C.sky[kd] = { img: scaleImage(s.img, dw * bs, dh * bs), x: -over, y: sy, w: dw, h: dh, iy: sy, ih: dh };
    }, this);
    // the dusk sky's low sun (world units; image fractions from the manifest or the measured default)
    var sun = (A.sky.dusk && A.sky.dusk.sun) || {}, S0 = RC.DUSK_SUN, ds = C.sky.dusk;
    function num(v, d) { return typeof v === 'number' && isFinite(v) ? v : d; }
    var glow = Array.isArray(sun.glow) && sun.glow.length >= 3 ? sun.glow : S0.glow;
    C.duskSun = {
      x: ds.x + num(sun.x, S0.x) * ds.w, y: ds.iy + num(sun.y, S0.y) * ds.ih, r: num(sun.r, S0.r) * ds.w,
      rgb: Math.round(glow[0]) + ',' + Math.round(glow[1]) + ',' + Math.round(glow[2])
    };
    C.sunPatch = sunPatch(C, bs);
    var moon = A.sky.moon, moonU = 46;
    C.moon = { img: scaleImage(moon.img, moonU * bs, (moonU * moon.h / moon.w) * bs), w: moonU, h: moonU * moon.h / moon.w };
    // clouds
    C.clouds = [];
    var cloudMaxU = 200;
    var scW = 1, scH = 1;
    for (i = 0; i < A.sky.clouds.length; i++) {
      var cl = A.sky.clouds[i], cimg = scaleImage(cl.img, cloudMaxU * bs, (cloudMaxU * cl.h / cl.w) * bs);
      // day sprite, dusk-graded copy and the moonlit night copy with the terrain's night grade + lift baked in
      // (clouds are drawn straight onto the frame, outside the grading layer)
      C.clouds.push({
        img: cimg, k: gradeCopy(cimg, c.GRADE_DUSK),
        n: gradeCopy(nightCloudCopy(cimg, RC.CLOUD_NIGHT_TINT), c.GRADE_NIGHT, c.NIGHT_LIFT), ar: cl.h / cl.w
      });
      scW = Math.max(scW, cimg.width); scH = Math.max(scH, cimg.height);
    }
    C.cloudScratch = mkCanvas(scW, scH); // crossfades between the graded copies (exact, premultiplied 'lighter' sum)
    // mountains: peakPx..baselinePx maps to MOUNTAIN_PEAK_Y..HORIZON_Y
    var mt = A.terrain.mountains;
    var ms = (c.HORIZON_Y - c.MOUNTAIN_PEAK_Y) / Math.max(1, mt.baselinePx - (mt.peakPx || 0));
    // near range; a strip narrower than the view is stretched horizontally so it never shows twice in one frame
    var mwU = Math.max(mt.w * ms, W + 20);
    C.mount = { img: scaleImage(mt.img, mwU * bs, mt.h * ms * bs), w: mwU, h: mt.h * ms, base: mt.baselinePx * ms };
    // far range: the same strip smaller and horizontally mirrored (every tile the same way), so it never echoes the
    // near range's silhouette
    var fs = c.MOUNTAIN_FAR_SCALE, far = scaleImage(mt.img, mt.w * ms * fs * bs, mt.h * ms * fs * bs);
    var farM = mkCanvas(far.width, far.height), fmx = farM.getContext('2d');
    fmx.translate(farM.width, 0);
    fmx.scale(-1, 1);
    fmx.drawImage(far, 0, 0, farM.width, farM.height);
    C.mountFar = { img: farM, src: far, w: mt.w * ms * fs, h: mt.h * ms * fs, base: mt.baselinePx * ms * fs };
    // ground: texture rows map to HORIZON_Y..H, pre-scaled 1:1 to device pixels (rows relative to world y 0; the
    // T offset is added when drawing). Tall screens continue it down to H + B (groundExtension).
    var gr = A.terrain.ground;
    var rowTop = Math.round(c.HORIZON_Y * bs);
    var gpx = Math.max(1, this.ch - this.tpx - rowTop);
    var texRows = this.B > 0 ? clamp(Math.round(H * bs) - rowTop, 1, gpx) : gpx;
    var gu = (H - c.HORIZON_Y) / gr.h;
    var tileWu = gr.w * gu;
    var tilePx = Math.max(1, Math.round(tileWu * bs));
    var gcan = mkCanvas(tilePx, gpx), gx = hiCtx(gcan);
    var gsrc = scaleImage(gr.img, tilePx, texRows);
    gx.drawImage(gsrc, 0, 0, tilePx, texRows);
    if (gpx > texRows) {
      var self = this, F0 = c.GROUND_FACTOR_BOTTOM;
      groundExtension(gx, gsrc, tilePx, texRows, gpx - texRows, bs, function (e) {
        var r = self.groundFactorSoft((rowTop + texRows + e) / bs) / F0;
        return r * r;
      });
    }
    // ground slices (device px) with their scroll factors
    var sh = Math.max(1, Math.ceil(gpx / c.GROUND_SLICES_MAX));
    // thinner slices close to the horizon where the factor changes fastest
    var slices = [], py = 0;
    var HOR = c.HORIZON_Y, bandEnd = HOR + c.GROUND_BAND_END * (c.GROUND_Y - HOR);
    var bandF = this.groundFactor(HOR + 0.5 * (bandEnd - HOR));
    while (py < gpx) {
      var yWorld = (rowTop + py) / bs;
      var h = yWorld < c.GROUND_Y + 6 ? Math.max(1, Math.ceil(sh / 2)) : sh;
      h = Math.min(h, gpx - py);
      var gy = c.GROUND_Y * bs - rowTop; // the slice containing the running line scrolls exactly with the obstacles
      var yc = (rowTop + py + h / 2) / bs, f;
      if (gy >= py && gy < py + h) f = 1;
      else if (yc < bandEnd) f = bandF; // distant plain + baked scrub: one rigid band (no shearing)
      else if (yc < c.GROUND_Y) f = lerp(bandF, 1, (yc - bandEnd) / (c.GROUND_Y - bandEnd));
      else f = this.groundFactorSoft(yc);
      slices.push(py, h, f);
      py += h;
    }
    C.slices = new Float64Array(slices);
    // wrap padding: GPAD columns repeating the tile's first columns (tilePx stays the period), so every row piece can
    // start and end on an integer device column with its source rect running past the tile end (no 1 px seams)
    var maxF = 1;
    for (i = 2; i < slices.length; i += 3) maxF = Math.max(maxF, slices[i]);
    var GPAD = Math.ceil(maxF) + 2, gpad = mkCanvas(tilePx + GPAD, gpx), gpx2 = gpad.getContext('2d');
    gpx2.drawImage(gcan, 0, 0);
    gpx2.drawImage(gcan, 0, 0, Math.min(GPAD, tilePx), gpx, tilePx, 0, Math.min(GPAD, tilePx), gpx);
    if (GPAD > tilePx) gpx2.drawImage(gcan, 0, 0, GPAD - tilePx, gpx, tilePx * 2, 0, GPAD - tilePx, gpx);
    C.ground = { img: gpad, tilePx: tilePx, tileWu: tilePx / bs, rowTop: rowTop, rows: gpx, pad: GPAD };
    // decor: cache levels (sharp at factor 0.5 / 1 / 2, blurred at 3)
    C.decor = [];
    for (i = 0; i < A.terrain.decor.length; i++) {
      var dc = A.terrain.decor[i], u = c.DECOR_PX_TO_U * bs;
      var lb = null, lift = (c.DECOR_BLUR_LIFT && c.DECOR_BLUR_LIFT[dc.kind]) || 0;
      if (dc.kind === 'grass') {
        // the pre-blurred grass loses its thin blades (it turns into a fuzzy ball): defocus the sharp tuft lightly
        // instead, so it still reads as a clump of dry grass like the reference's foreground tufts
        lb = softCopy(scaleImage(dc.img, dc.w * u * 3, dc.h * u * 3), Math.max(0.8, 1.1 * bs));
        if (lb) lift = 0;
      }
      if (!lb) lb = scaleImage(dc.blur || dc.img, dc.w * u * 3, dc.h * u * 3);
      var rock = dc.kind === 'rock', l0 = scaleImage(dc.img, dc.w * u * 0.5, dc.h * u * 0.5), l1 = scaleImage(dc.img, dc.w * u, dc.h * u);
      C.decor.push({
        w: dc.w, h: dc.h, kind: dc.kind, fg: dc.fg !== false,
        l0: l0, l1: l1,
        l2: scaleImage(dc.img, dc.w * u * 2, dc.h * u * 2),
        // foreground rocks are darker (the reference's near stones read ~L 80-95 on the sand)
        lb: rock ? gradeCopy(lb, RC.DECOR_FG_ROCK_GRADE) : lb,
        // darkened pebble copies for the band at the running line (rocks only)
        p0: rock ? gradeCopy(l0, RC.DECOR_PEBBLE_TINT) : null,
        p1: rock ? gradeCopy(l1, RC.DECOR_PEBBLE_TINT) : null,
        lift: lift,
        shadow: (c.DECOR_SHADOW && c.DECOR_SHADOW[dc.kind]) || 0
      });
    }
    // candidate lists: the foreground layer skips entries flagged fg:false (wispy tufts), pebbles are rocks only
    // (chosen by kind, never by index: the manifest's rock count changes)
    C.decorFg = []; C.decorRock = [];
    for (i = 0; i < C.decor.length; i++) {
      if (C.decor[i].fg) C.decorFg.push(i);
      if (C.decor[i].kind === 'rock') C.decorRock.push(i);
    }
    if (!C.decorFg.length) for (i = 0; i < C.decor.length; i++) C.decorFg.push(i);
    if (!C.decorRock.length) for (i = 0; i < C.decor.length; i++) C.decorRock.push(i);
    this._layout();
    this._layerCtx(); // pre-create the grading layer so the first dusk frame does not hitch
    if (!this.gradeStyles) this._gradeTables();
    this._layoutGameOver(); // before the sprites: the restart icon is built at its size
    this._rev = (this._rev || 0) + 1;
    this._buildSprites();
    this._buildHud();
    this._sampleColors();
  };

  /**
   * Sky image (world rect x0, y0, w, h) plus a zenith cap that continues it up to world y `top` (tall screens), as
   * one cached canvas. The cap is built from the image's top ~2 % rows averaged down to a 48x1 profile (stars and
   * noise average out): per column right above the image, fading into a 6-column profile, then into one uniform
   * colour (so neither the sun glare column nor the Milky Way continues upward as a streak), slightly darker toward
   * the zenith, and alpha-feathered into the image over its top SKY_CAP_FEATHER units. `glare`: the day image's
   * top-left sun glare now sits well below the screen corner, where the bloom is drawn: fade it into the surrounding
   * sky first (one sun, no second glare mid-screen). Build time only; file:// safe (no pixel readback).
   */
  function skyWithCap(img, x0, y0, w, h, top, bs, glare) {
    var k = Math.min(bs, img.width / w); // px per unit: never above the image's own resolution
    var cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round((y0 + h - top) * k));
    var iy = (y0 - top) * k, fe = RC.SKY_CAP_FEATHER * k, ih = Math.max(1, Math.round(h * k));
    var base = mkCanvas(cw, ih), bx = hiCtx(base);
    bx.drawImage(scaleImage(img, cw, ih), 0, 0, cw, ih);
    var gA = glare ? clamp((y0 - top) / 150, 0, 1) : 0;
    if (gA > 0.01) {
      // the sky's own vertical profile away from the glare (columns 30..45 %), blended in radially over the corner
      var cx0 = Math.round(cw * 0.3), cwid = Math.max(1, Math.round(cw * 0.15));
      var col = mkCanvas(cwid, ih);
      hiCtx(col).drawImage(base, cx0, 0, cwid, ih, 0, 0, cwid, ih);
      var prof = avgDown(col, 1, Math.max(8, Math.round(ih / 8)));
      var patch = mkCanvas(cw, ih), px = hiCtx(patch);
      px.drawImage(prof, 0, 0, cw, ih);
      var Rg = cw * 0.45, rg = px.createRadialGradient(0, 0, 0, 0, 0, Rg);
      rg.addColorStop(0, 'rgba(0,0,0,' + gA + ')');
      rg.addColorStop(0.3, 'rgba(0,0,0,' + (gA * 0.9).toFixed(3) + ')');
      rg.addColorStop(0.6, 'rgba(0,0,0,' + (gA * 0.6).toFixed(3) + ')');
      rg.addColorStop(1, 'rgba(0,0,0,0)');
      px.globalCompositeOperation = 'destination-in';
      px.fillStyle = rg;
      px.fillRect(0, 0, cw, ih);
      bx.drawImage(patch, 0, 0);
    }
    var capH = Math.min(ch, Math.ceil(iy + fe) + 1);
    var rows = Math.max(2, Math.round(ih * 0.02));
    var strip = mkCanvas(cw, rows);
    hiCtx(strip).drawImage(base, 0, 0, cw, rows, 0, 0, cw, rows);
    var fine = avgDown(avgDown(strip, 48, 1), 16, 1), coarse = avgDown(fine, 6, 1), one = avgDown(coarse, 1, 1);
    var cap = mkCanvas(cw, capH), x = hiCtx(cap);
    x.drawImage(one, 0, 0, 1, 1, 0, 0, cw, capH);
    drawRampV(x, coarse, cw, capH, iy - RC.SKY_CAP_COARSE * k, 0, iy - RC.SKY_CAP_FINE * k, 1);
    drawRampV(x, fine, cw, capH, iy - RC.SKY_CAP_FINE * k, 0, iy, 1);
    var dark = RC.SKY_ZENITH_DARK * Math.min(1, (y0 - top) / 600);
    if (dark > 0.002) {
      var zg = x.createLinearGradient(0, 0, 0, Math.max(1, iy));
      zg.addColorStop(0, 'rgba(0,0,0,' + dark.toFixed(4) + ')');
      zg.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = zg;
      x.fillRect(0, 0, cw, Math.ceil(iy));
    }
    var out = mkCanvas(cw, ch), ox = hiCtx(out);
    ox.drawImage(base, 0, iy, cw, ih);
    drawRampV(ox, cap, cw, capH, iy, 1, iy + fe, 0);
    return { img: out, x: x0, y: top, w: w, h: y0 + h - top, iy: y0, ih: h };
  }

  /**
   * Ground below H (tall screens): the texture's lowest ~50 % band, mirrored vertically at the joint (the joint row
   * matches) and stretched progressively with depth, s = (f / GROUND_FACTOR_BOTTOM)^2 (1 at the joint; the band is
   * reflected back and forth where the extension is longer than the stretched band, instead of one extreme stretch
   * that turns grains into vertical streaks). Built 3 tiles wide so the horizontal wrap stays seamless, blurred
   * progressively in 5 bands (skipped where ctx.filter is unsupported) and darkened slightly toward the bottom.
   * stretch(e): stretch factor at extension row e.
   */
  function groundExtension(gx, gsrc, tilePx, texRows, ext, bs, stretch) {
    var hb = Math.max(2, Math.round(texRows * 0.5));
    var band = mkCanvas(tilePx, hb), sh = (gsrc.height * hb) / texRows;
    hiCtx(band).drawImage(gsrc, 0, gsrc.height - sh, gsrc.width, sh, 0, 0, tilePx, hb);
    var one = mkCanvas(tilePx, ext), ox = hiCtx(one), v = 0;
    for (var e = 0; e < ext; e++) {
      var dv = 1 / Math.max(1, stretch(e)); // band rows per extension row
      var u = mod(v + dv / 2, 2 * hb), d = u < hb ? u : 2 * hb - u; // triangle wave: distance up from the band bottom
      var s0 = clamp(hb - d - dv / 2, 0, hb - dv), s1 = s0 + dv;
      ox.drawImage(band, 0, s0, tilePx, s1 - s0, 0, e, tilePx, 1);
      v += dv;
    }
    var tmp = mkCanvas(tilePx * 3, ext), tx = hiCtx(tmp);
    for (var rep = 0; rep < 3; rep++) tx.drawImage(one, rep * tilePx, 0);
    gx.drawImage(one, 0, texRows); // sharp underlay (no translucent blur edges)
    var canBlur = 'filter' in gx;
    if (canBlur) { gx.filter = 'blur(1px)'; canBlur = gx.filter !== 'none'; gx.filter = 'none'; }
    if (canBlur) {
      var nb = 5, b0 = RC.GROUND_EXT_BLUR[0], db = RC.GROUND_EXT_BLUR[1];
      for (var bi = 0; bi < nb; bi++) {
        var y0 = Math.floor((ext * bi) / nb), y1 = Math.ceil((ext * (bi + 1)) / nb);
        gx.save();
        gx.beginPath(); gx.rect(0, texRows + y0, tilePx, y1 - y0); gx.clip();
        gx.filter = 'blur(' + ((b0 + bi * db) * bs).toFixed(2) + 'px)';
        gx.drawImage(tmp, -tilePx, texRows);
        gx.restore();
      }
    }
    var dg = gx.createLinearGradient(0, texRows, 0, texRows + ext);
    dg.addColorStop(0, 'rgba(60,48,36,0)');
    dg.addColorStop(1, 'rgba(60,48,36,' + RC.GROUND_EXT_DARK + ')');
    gx.fillStyle = dg;
    gx.fillRect(0, texRows, tilePx, ext);
  }

  /** Crop of a sky around the dusk sun (world square of side 8 sun radii) into an n x n canvas; `smooth` averages
   * it down to 6x6 and back up (a star-free night sky). null when the square is not inside the sky image. */
  function sunCrop(sky, sn, n, smoothIt) {
    var R = 4 * sn.r, img = sky.img, kx = img.width / sky.w, ky = img.height / sky.h;
    var sx = (sn.x - R - sky.x) * kx, sy = (sn.y - R - sky.y) * ky, sw = 2 * R * kx, sh = 2 * R * ky;
    if (sx < 0 || sy < 0 || sx + sw > img.width || sy + sh > img.height) return null;
    var out = mkCanvas(n, n), x = hiCtx(out);
    if (smoothIt) {
      var crop = mkCanvas(sw, sh);
      hiCtx(crop).drawImage(img, sx, sy, sw, sh, 0, 0, crop.width, crop.height);
      x.drawImage(avgDown(crop, 6, 6), 0, 0, n, n);
    } else x.drawImage(img, sx, sy, sw, sh, 0, 0, n, n);
    return out;
  }
  /** Buffers that keep the night sky's stars out of the sunset glow while it shows: the dusk sky and a star-free
   * night sky around the dusk sun, a radial mask (1 within 3 sun radii, 0 at 4) and a scratch canvas. */
  function sunPatch(C, bs) {
    var sn = C.duskSun;
    if (!sn || !(sn.r > 0)) return null;
    var R = 4 * sn.r, n = clamp(Math.round(2 * R * bs), 8, 256);
    var dusk = sunCrop(C.sky.dusk, sn, n, false), night = dusk ? sunCrop(C.sky.night, sn, n, true) : null;
    if (!night) return null;
    var mask = mkCanvas(n, n), mx = mask.getContext('2d'), g = mx.createRadialGradient(n / 2, n / 2, 0, n / 2, n / 2, n / 2);
    g.addColorStop(0, 'rgba(0,0,0,1)');
    g.addColorStop(0.75, 'rgba(0,0,0,1)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    mx.fillStyle = g;
    mx.fillRect(0, 0, n, n);
    return { dusk: dusk, night: night, mask: mask, scratch: mkCanvas(n, n), n: n, x: sn.x - R, y: sn.y - R, s: 2 * R };
  }

  /** Gaussian-blurred copy (canvas filter); null where ctx.filter is unsupported (caller falls back). */
  function softCopy(img, r) {
    if (!img || !img.width) return null;
    var cn = mkCanvas(img.width, img.height), x = cn.getContext('2d');
    if (!('filter' in x)) return null;
    x.filter = 'blur(' + r.toFixed(2) + 'px)';
    if (x.filter === 'none') return null;
    x.drawImage(img, 0, 0);
    x.filter = 'none';
    return cn;
  }

  /**
   * SVG colour-matrix filter (created at runtime, cached by colour) that multiplies RGB by rgb/255 and adds lift/255,
   * in unpremultiplied sRGB, alpha untouched. Returns its id, or null without a DOM.
   */
  var gradeFilters = {};
  function gradeFilter(rgb, lift) {
    var L = lift || [0, 0, 0];
    var key = 'rdg-grade-' + rgb.join('-') + (lift ? '-l' + L.join('-') : '');
    if (gradeFilters[key]) return key;
    var doc = root.document;
    if (!doc || !doc.createElementNS) return null;
    try {
      var NS = 'http://www.w3.org/2000/svg';
      var defs = doc.getElementById('rdg-grade-defs');
      if (!defs) {
        defs = doc.createElementNS(NS, 'svg');
        defs.setAttribute('id', 'rdg-grade-defs');
        defs.setAttribute('aria-hidden', 'true');
        defs.setAttribute('width', '0');
        defs.setAttribute('height', '0');
        defs.setAttribute('style', 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none');
        (doc.body || doc.documentElement).appendChild(defs);
      }
      var f = doc.createElementNS(NS, 'filter');
      f.setAttribute('id', key);
      f.setAttribute('color-interpolation-filters', 'sRGB'); // required: multiply the stored sRGB values
      var m = doc.createElementNS(NS, 'feColorMatrix');
      function v(i) { return (rgb[i] / 255).toFixed(5); }
      function o(i) { return (L[i] / 255).toFixed(5); }
      m.setAttribute('type', 'matrix');
      m.setAttribute('values', v(0) + ' 0 0 0 ' + o(0) + '  0 ' + v(1) + ' 0 0 ' + o(1) + '  0 0 ' + v(2) + ' 0 ' + o(2) + '  0 0 0 1 0');
      f.appendChild(m);
      defs.appendChild(f);
      gradeFilters[key] = true;
      return key;
    } catch (e) { return null; }
  }

  /**
   * Graded copy of a sprite: RGB x rgb/255 (+ lift) in unpremultiplied space, alpha unchanged, so soft edges keep
   * their colour (a multiply over transparent pixels would give every dusk / night sprite a pale halo). Uses the SVG
   * colour-matrix filter where canvas filters work; otherwise an alpha-exact fallback that never touches transparent
   * pixels ('source-atop': darken by the grade's luminance, then a 12 % tint of the grade colour, then the lift).
   */
  function gradeCopy(img, rgb, lift) {
    var cn = mkCanvas(img.width, img.height), x = cn.getContext('2d');
    var id = gradeFilter(rgb, lift), ok = false;
    if (id && 'filter' in x) {
      x.filter = 'url(#' + id + ')';
      ok = x.filter !== 'none' && x.filter !== '';
    }
    if (ok) {
      x.drawImage(img, 0, 0);
      x.filter = 'none';
      return cn;
    }
    if ('filter' in x) x.filter = 'none';
    var lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
    var lt = lift ? 0.1 : 0; // the lift mixes toward lift / lt (source-atop has no additive mode that keeps alpha)
    x.drawImage(img, 0, 0);
    x.globalCompositeOperation = 'source-atop';
    x.fillStyle = '#000';
    x.globalAlpha = clamp(1 - lum / 255 / (1 - lt), 0, 1);
    x.fillRect(0, 0, cn.width, cn.height);
    x.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
    x.globalAlpha = 0.12;
    x.fillRect(0, 0, cn.width, cn.height);
    if (lt > 0) {
      x.fillStyle = 'rgb(' + Math.min(255, Math.round(lift[0] / lt)) + ',' + Math.min(255, Math.round(lift[1] / lt)) + ',' + Math.min(255, Math.round(lift[2] / lt)) + ')';
      x.globalAlpha = lt;
      x.fillRect(0, 0, cn.width, cn.height);
    }
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'source-over';
    return cn;
  }
  /**
   * Moonlit copy of a cloud (composite operations only, works on file://): an opaque cloud-coloured backdrop, the
   * cloud, its own shading cubed (drawn onto itself twice with 'multiply': tops stay light, bases drop), multiplied
   * by the night tint, then the cloud's alpha restored (soft translucent edges, no bright halo).
   */
  function nightCloudCopy(img, rgb) {
    var cn = mkCanvas(img.width, img.height), x = cn.getContext('2d');
    x.fillStyle = '#e6e2da';
    x.fillRect(0, 0, cn.width, cn.height);
    x.drawImage(img, 0, 0, cn.width, cn.height);
    x.globalCompositeOperation = 'multiply';
    x.drawImage(cn, 0, 0);
    x.drawImage(cn, 0, 0);
    x.fillStyle = 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')';
    x.fillRect(0, 0, cn.width, cn.height);
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(img, 0, 0, cn.width, cn.height);
    x.globalCompositeOperation = 'source-over';
    return cn;
  }

  /** Moonlight rim: the sprite's top-right edge band (light from the moon, upper right), feathered so it reads as a
   * soft moon-side rim rather than a sticker outline (the unblurred band where ctx.filter is unsupported). */
  function rimCopy(img, color, d) {
    var cn = mkCanvas(img.width, img.height), x = cn.getContext('2d');
    x.drawImage(img, 0, 0);
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = color;
    x.fillRect(0, 0, cn.width, cn.height);
    x.globalCompositeOperation = 'destination-out';
    x.drawImage(img, -d, d);
    var soft = softCopy(cn, d * 0.75);
    if (soft) {
      x.globalCompositeOperation = 'copy';
      x.drawImage(soft, 0, 0);
      x.globalCompositeOperation = 'destination-in';
      x.drawImage(img, 0, 0);
    }
    x.globalCompositeOperation = 'source-over';
    return cn;
  }
  /** Day / dusk / night versions of an actor sprite plus its night rim (graded at build time, crossfaded per frame).
   * The night copy has the terrain grade's hue (RC.ACTOR_GRADE_NIGHT; no NIGHT_LIFT: it would lift the dark hide above
   * the dino : ground luminance ratio of the day look). */
  Renderer.prototype._actorSet = function (img) {
    var c = this.cfg;
    var d = Math.max(1, (img.width / Math.max(1, img.width)) * 1.3 * Math.min(this.bs, 3));
    return { d: img, k: gradeCopy(img, c.ACTOR_GRADE_DUSK), n: gradeCopy(img, RC.ACTOR_GRADE_NIGHT), r: rimCopy(img, RC.MOON_RIM, d) };
  };
  Renderer.prototype._drawActor = function (w, set, x, y, ww, hh) {
    var p = this.phaseNow;
    if (p <= 0.004) { w.drawImage(set.d, x, y, ww, hh); return; }
    if (p <= 0.5) {
      w.drawImage(set.d, x, y, ww, hh);
      w.globalAlpha = smooth(p * 2);
      w.drawImage(set.k, x, y, ww, hh);
    } else {
      w.drawImage(set.k, x, y, ww, hh);
      w.globalAlpha = smooth(p * 2 - 1);
      w.drawImage(set.n, x, y, ww, hh);
      w.globalAlpha = this.nightNow * 0.9;
      w.drawImage(set.r, x, y, ww, hh);
    }
    w.globalAlpha = 1;
  };

  Renderer.prototype._squash = function (img, D) {
    // duck fallback art: run frame squashed vertically toward the baseline
    var s = D.frameW / D.frameH, cnv = mkCanvas(img.width, img.width / s), x = cnv.getContext('2d');
    var base = (D.baseline / D.frameH) * cnv.height;
    x.drawImage(img, 0, base - base * 0.58, cnv.width, cnv.height * 0.58);
    return cnv;
  };

  Renderer.prototype._layout = function () {
    var c = this.cfg, W = this.W, H = c.H, i;
    // clouds: far (small, low, slow) -> near
    var nC = c.CLOUD_COUNT, cw = c.CLOUD_WIDTH || [70, 150], maxW = cw[1] * 1.15 * 1.3;
    this.clouds = [];
    for (i = 0; i < nC; i++) {
      var d = (i + 0.5) / nC;
      var dj = clamp(d + (hash(i, 17) - 0.5) * 0.12, 0, 1);
      this.clouds.push({
        depth: dj, y: lerp(0.45 * H, 0.27 * H, dj) + (hash(i, 23) - 0.5) * 0.05 * H, wU: lerp(cw[0], cw[1], dj),
        f: lerp(0.05, 0.2, dj), wind: lerp(0.35, 1, dj), alpha: lerp(0.72, 1, dj),
        P: W + maxW * 2 + 160, phase: hash(i, 29) * (W + maxW * 2), J: 160, margin: maxW, idx: i
      });
    }
    // decor rows
    var items = [];
    var G = c.GROUND_Y, HOR = c.HORIZON_Y, self = this;
    function add(n, y0, y1, layer, sizeMul, salt) {
      var L = layer + (salt || 0) * 10; // hash key (salt: a second item set in the same layer)
      for (var j = 0; j < n; j++) {
        var t = (j + hash(j, L * 31 + 5)) / n;
        var y = lerp(y0, y1, t);
        var f = self.groundFactorSoft(y);
        var maxWu = 300 * c.DECOR_PX_TO_U * f * sizeMul * 1.4;
        items.push({ y: y, f: f, layer: layer, sizeMul: sizeMul * (0.6 + hash(j, L * 13 + 7) * 0.8), P: W + maxWu * 2 + 120, J: 120, margin: maxWu, phase: hash(j, L * 7 + 3) * 5000, idx: j + L * 1000 });
      }
    }
    var ds = c.DECOR_SIZE || [0.9, 0.75, 0.95];
    add(c.DECOR_BG_COUNT, HOR + 0.6, G - 0.4, 0, ds[0]);
    add(c.DECOR_MID_COUNT, G + 7, 0.87 * H, 1, ds[1]);
    // foreground: every base stays in frame (y <= H - 4)
    add(RC.DECOR_FG_COUNT, 0.88 * H, H - 4, 2, ds[2]);
    // tall screens: foreground decor continues into the ground extension below H (bases in frame too)
    var B = this.B || 0;
    if (B > 34) add(Math.round((RC.DECOR_EXT_COUNT * B) / 110), H + 30, H + B - 4, 2, ds[2], 3);
    // pebble band at the running line (layer 3): small dark rocks, depth biased toward G
    for (var pj = 0; pj < RC.DECOR_PEBBLE_COUNT; pj++) {
      var v = hash(pj, 211) * 2 - 1, py = G + (v >= 0 ? 16 : -6) * Math.pow(Math.abs(v), RC.DECOR_PEBBLE_BIAS);
      var pf = this.groundFactorSoft(py), pm = 300 * c.DECOR_PX_TO_U * pf * RC.DECOR_PEBBLE_SIZE * 1.4;
      items.push({ y: py, f: pf, layer: 3, sizeMul: RC.DECOR_PEBBLE_SIZE * (0.6 + hash(pj, 223) * 0.8), P: W + pm * 2 + 120, J: 120, margin: pm, phase: hash(pj, 227) * 5000, idx: pj + 40000 });
    }
    items.sort(function (a, b) { return a.y - b.y; });
    this.decorItems = items;
    this.nBg = 0; this.nMidStart = 0;
    for (i = 0; i < items.length; i++) if (items[i].layer === 0) this.nBg = i + 1;
    // stars (twinkle overlay), spread over world y -T..0.6H (the extended sky on tall screens, same density)
    var T = this.T || 0, sy0 = 0.6 * H;
    var n = Math.round((90 * (sy0 + T)) / sy0);
    this.stars = new Float64Array(n * 5);
    for (i = 0; i < n; i++) {
      this.stars[i * 5] = hash(i, 101) * W;
      this.stars[i * 5 + 1] = Math.pow(hash(i, 103), 1.4) * (sy0 + T) - T;
      this.stars[i * 5 + 2] = 0.7 + hash(i, 107) * 1.3;
      this.stars[i * 5 + 3] = 0.6 + hash(i, 109) * 2.8; // twinkle speed
      this.stars[i * 5 + 4] = hash(i, 113) * 6.283;
    }
    // stars near the dusk sun stay hidden while the sunset glow is still visible (none within 3 sun radii)
    var sn = this.cache && this.cache.duskSun;
    this.starSunFade = new Float64Array(n);
    for (i = 0; i < n; i++) {
      var dd = sn ? Math.sqrt(Math.pow(this.stars[i * 5] - sn.x, 2) + Math.pow(this.stars[i * 5 + 1] - sn.y, 2)) : Infinity;
      this.starSunFade[i] = sn ? clamp((dd - 3 * sn.r) / (3 * sn.r), 0, 1) : 1;
    }
  };

  Renderer.prototype._buildSprites = function () {
    var bs = this.bs, c = this.cfg, C = this.cache;
    // soft contact shadow (radial; stretched into an ellipse when drawn)
    var sw = 128, s = mkCanvas(sw, sw), x = s.getContext('2d');
    var g = x.createRadialGradient(sw / 2, sw / 2, 0, sw / 2, sw / 2, sw / 2);
    g.addColorStop(0, 'rgba(58,48,36,0.9)');
    g.addColorStop(0.45, 'rgba(58,48,36,0.5)');
    g.addColorStop(1, 'rgba(58,48,36,0)');
    x.fillStyle = g;
    x.fillRect(0, 0, sw, sw);
    C.shadow = s;
    // long cast shadow (thin, sharp at the contact end, fading along its length), stretched when drawn
    var cst = mkCanvas(256, 16), cx0 = cst.getContext('2d'), cid = cx0.createImageData(256, 16), cdd = cid.data;
    for (var cy = 0; cy < 16; cy++) {
      var vy = ((cy + 0.5) / 16) * 2 - 1, va = Math.exp(-vy * vy * 7);
      for (var cxx = 0; cxx < 256; cxx++) {
        var uu = (cxx + 0.5) / 256, ha = Math.min(1, uu / 0.03) * Math.pow(1 - uu, 0.8), o4 = (cy * 256 + cxx) * 4;
        cdd[o4] = 52; cdd[o4 + 1] = 44; cdd[o4 + 2] = 34; cdd[o4 + 3] = Math.round(255 * va * ha);
      }
    }
    cx0.putImageData(cid, 0, 0);
    C.cast = cst;
    // dust puff
    var ds = 64, dcan = mkCanvas(ds, ds), dx = dcan.getContext('2d');
    var dg = dx.createRadialGradient(ds / 2, ds / 2, 0, ds / 2, ds / 2, ds / 2);
    dg.addColorStop(0, 'rgba(236,224,204,1)');
    dg.addColorStop(0.45, 'rgba(230,216,194,0.7)');
    dg.addColorStop(1, 'rgba(224,208,184,0)');
    dx.fillStyle = dg;
    dx.fillRect(0, 0, ds, ds);
    C.dust = { d: dcan, k: gradeCopy(dcan, c.ACTOR_GRADE_DUSK), n: gradeCopy(dcan, RC.ACTOR_GRADE_NIGHT) };
    // kicked-up grain (small dark soft dot)
    var gsz = 16, gcan = mkCanvas(gsz, gsz), gcx = gcan.getContext('2d');
    var grg = gcx.createRadialGradient(gsz / 2, gsz / 2, 0, gsz / 2, gsz / 2, gsz / 2);
    grg.addColorStop(0, 'rgba(100,84,66,1)');
    grg.addColorStop(0.55, 'rgba(110,94,76,0.85)');
    grg.addColorStop(1, 'rgba(110,94,76,0)');
    gcx.fillStyle = grg;
    gcx.fillRect(0, 0, gsz, gsz);
    C.grain = { d: gcan, k: gradeCopy(gcan, c.ACTOR_GRADE_DUSK), n: gradeCopy(gcan, RC.ACTOR_GRADE_NIGHT) };
    // horizon haze strip (vertical gradient, stretched horizontally)
    var hh = 256, hz = mkCanvas(4, hh), hx = hz.getContext('2d');
    var y0 = c.MOUNTAIN_PEAK_Y - 30, y1 = c.GROUND_Y + 22;
    var hg = hx.createLinearGradient(0, 0, 0, hh);
    var tH = (c.HORIZON_Y - y0) / (y1 - y0);
    // light touch: the reference keeps a fairly crisp horizon (scrub line + pebbles), only the far range is hazy
    hg.addColorStop(0, 'rgba(236,233,228,0)');
    hg.addColorStop(tH * 0.7, 'rgba(236,233,228,0.1)');
    hg.addColorStop(tH, 'rgba(238,235,229,0.2)');
    hg.addColorStop(Math.min(1, tH + (1 - tH) * 0.35), 'rgba(236,232,226,0.06)');
    hg.addColorStop(1, 'rgba(236,232,226,0)');
    hx.fillStyle = hg;
    hx.fillRect(0, 0, 4, hh);
    C.haze = { img: hz, y0: y0, y1: y1 };
    // near-horizon ground shade (multiply): the reference's plain just below the horizon is darker and warmer than the
    // open sand (scrub, pebbles, their shadows); this band restores that tone without adding texture
    var gs0 = c.HORIZON_Y - 1, gs1 = 0.85 * c.H, gsh = mkCanvas(4, 256), gsx = gsh.getContext('2d');
    var gsg = gsx.createLinearGradient(0, 0, 0, 256), gA = RC.GROUND_SHADE;
    function gsStop(y, a) {
      var m = 1 - a * gA; // multiply factor
      gsg.addColorStop(clamp((y - gs0) / (gs1 - gs0), 0, 1), 'rgb(' + Math.round(255 * m) + ',' + Math.round(255 * m * 0.985) + ',' + Math.round(255 * m * 0.97) + ')');
    }
    gsStop(gs0, 0); gsStop(c.HORIZON_Y + 2, 0.6); gsStop(c.GROUND_Y + 3, 1); gsStop(0.8 * c.H, 0.4); gsStop(gs1, 0);
    gsx.fillStyle = gsg;
    gsx.fillRect(0, 0, 4, 256);
    C.groundShade = gA > 0 ? { img: gsh, y0: gs0, y1: gs1 } : null;
    // vignette (quarter resolution, stretched)
    var vw = Math.max(8, Math.round(this.cw / 4)), vh = Math.max(8, Math.round(this.ch / 4));
    var v = mkCanvas(vw, vh), vx = v.getContext('2d');
    var rad = Math.sqrt(vw * vw + vh * vh) / 2;
    var vg = vx.createRadialGradient(vw / 2, vh * 0.45, rad * 0.5, vw / 2, vh * 0.45, rad);
    vg.addColorStop(0, 'rgba(20,16,12,0)');
    vg.addColorStop(1, 'rgba(20,16,12,' + (c.VIGNETTE != null ? c.VIGNETTE : 0.32) + ')');
    vx.fillStyle = vg;
    vx.fillRect(0, 0, vw, vh);
    // no darkening where the sun glare is (top-left)
    var vr = vh * 0.9, vo = vx.createRadialGradient(0, 0, 0, 0, 0, vr);
    vo.addColorStop(0, 'rgba(0,0,0,1)');
    vo.addColorStop(0.5, 'rgba(0,0,0,0.75)');
    vo.addColorStop(1, 'rgba(0,0,0,0)');
    vx.globalCompositeOperation = 'destination-out';
    vx.fillStyle = vo;
    vx.fillRect(0, 0, vr, vr);
    vx.globalCompositeOperation = 'source-over';
    C.vignette = v;
    // sun bloom (top-left, day only): radial falloff measured on the reference photo's glare (screen-blended)
    var bsz = 256, bl = mkCanvas(bsz, bsz), bx = bl.getContext('2d');
    var bgr = bx.createRadialGradient(0, 0, 0, 0, 0, bsz);
    var bp = [[0, 1], [0.05, 0.97], [0.12, 0.86], [0.22, 0.62], [0.34, 0.38], [0.5, 0.18], [0.7, 0.06], [1, 0]];
    for (var bi = 0; bi < bp.length; bi++) bgr.addColorStop(bp[bi][0], 'rgba(255,243,219,' + bp[bi][1] + ')');
    bx.fillStyle = bgr;
    bx.fillRect(0, 0, bsz, bsz);
    C.bloom = bl;
    // dusk sun setting: glow-coloured disc, opaque to 0.5 R, fading out at R
    var ssz = 64, ss = mkCanvas(ssz, ssz), ssx = ss.getContext('2d'), rgb = C.duskSun ? C.duskSun.rgb : '247,224,152';
    var sg = ssx.createRadialGradient(ssz / 2, ssz / 2, 0, ssz / 2, ssz / 2, ssz / 2);
    sg.addColorStop(0, 'rgba(' + rgb + ',1)');
    sg.addColorStop(0.5, 'rgba(' + rgb + ',1)');
    sg.addColorStop(1, 'rgba(' + rgb + ',0)');
    ssx.fillStyle = sg;
    ssx.fillRect(0, 0, ssz, ssz);
    C.sunSet = ss;
    // restart icon (Chrome-like circular arrow in a rounded square), light and dark
    C.restart = [this._restartIcon('#535353', 'rgba(255,255,255,0.35)'), this._restartIcon('#e8ebf2', 'rgba(10,14,28,0.35)')];
  };

  Renderer.prototype._restartIcon = function (fg, bg) {
    var s = Math.max(8, this._go ? this._go.iconS : Math.round(46 * this.bs)), cn = mkCanvas(s, s), x = cn.getContext('2d');
    var r = s * 0.2;
    x.fillStyle = bg;
    x.beginPath();
    x.moveTo(r, 0); x.arcTo(s, 0, s, s, r); x.arcTo(s, s, 0, s, r); x.arcTo(0, s, 0, 0, r); x.arcTo(0, 0, s, 0, r);
    x.fill();
    x.strokeStyle = fg; x.fillStyle = fg;
    x.lineWidth = s * 0.11; x.lineCap = 'butt';
    x.beginPath();
    x.arc(s / 2, s / 2, s * 0.26, -Math.PI * 0.35, Math.PI * 1.45);
    x.stroke();
    // arrow head at the start of the arc
    var a = -Math.PI * 0.35, ax = s / 2 + Math.cos(a) * s * 0.26, ay = s / 2 + Math.sin(a) * s * 0.26;
    x.beginPath();
    x.moveTo(ax + s * 0.14, ay - s * 0.02);
    x.lineTo(ax - s * 0.06, ay - s * 0.15);
    x.lineTo(ax - s * 0.04, ay + s * 0.1);
    x.closePath();
    x.fill();
    return cn;
  };

  Renderer.prototype._buildHud = function () {
    var c = this.cfg, px = Math.max(6, Math.round(c.HUD_SIZE * this.bs));
    var font = c.HUD_FONT.replace('{px}', px);
    var m = mkCanvas(4, 4).getContext('2d');
    m.font = font;
    var cw = Math.ceil(px * (c.HUD_ADVANCE || 0.6)), ch = Math.ceil(px * 1.3);
    var chars = '0123456789HI';
    function atlas(color) {
      var cn = mkCanvas(cw * chars.length, ch), x = cn.getContext('2d');
      x.font = font; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = color;
      x.strokeStyle = color; x.lineWidth = Math.max(0.5, px * 0.012); x.lineJoin = 'round';
      for (var i = 0; i < chars.length; i++) {
        x.fillText(chars[i], i * cw + cw / 2, ch / 2);
        x.strokeText(chars[i], i * cw + cw / 2, ch / 2); // slightly bolder, like the reference
      }
      return cn;
    }
    this.hud = { cw: cw, ch: ch, px: px, dark: atlas(c.HUD_COLOR_DAY), light: atlas(c.HUD_COLOR_NIGHT) };
    // idle hint / instructions: never below 17 / 13 CSS px (phones), else the usual world-relative sizes
    var dprEff = this.cw / (this.W * (this.cssScale || 1)); // device px per CSS px
    this.hintPx = Math.max(Math.round(22 * this.bs), Math.round(17 * dprEff));
    this.smallPx = Math.max(Math.round(14.5 * this.bs), Math.round(13 * dprEff));
    this.fonts = {
      over: titleFont('en', this._go.titlePx),
      debug: Math.round(12 * this.bs) + 'px ui-monospace, Menlo, Consolas, monospace'
    };
    // per-language, per-message fitted fonts and title layouts (measured once after a resize, not per frame)
    this._fit = { hint: {}, small: {}, duck: {}, title: {} };
    // hint pulse as a colour pulse of opaque text (an alpha pulse would drop the contrast below 4.5:1 at its trough):
    // the HUD colour at the trough, a deeper tone at the peak; 17 cached strings per lighting
    var hd = parseRGB(c.HUD_COLOR_DAY, [83, 83, 83]), hn = parseRGB(c.HUD_COLOR_NIGHT, [226, 230, 238]);
    this._hintCols = [[], []];
    for (var k = 0; k <= 16; k++) {
      var t = k / 16;
      this._hintCols[0].push('rgb(' + Math.round(lerp(hd[0], hd[0] * 0.5, t)) + ',' + Math.round(lerp(hd[1], hd[1] * 0.5, t)) + ',' + Math.round(lerp(hd[2], hd[2] * 0.5, t)) + ')');
      this._hintCols[1].push('rgb(' + Math.round(lerp(hn[0], 255, t)) + ',' + Math.round(lerp(hn[1], 255, t)) + ',' + Math.round(lerp(hn[2], 255, t)) + ')');
    }
  };
  /** Canvas UI font stacks. Japanese: a Japanese face first, so the Latin letters inside ja strings ('M', 'P') match
   * it; English: the system UI face (Japanese faces stay as fallbacks). */
  var UI_FONTS = {
    en: 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Hiragino Sans", "Noto Sans JP", sans-serif',
    ja: '"Hiragino Sans", "Hiragino Kaku Gothic ProN", "Noto Sans JP", "Noto Sans CJK JP", "Yu Gothic UI", "Yu Gothic", Meiryo, system-ui, sans-serif'
  };
  function uiFont(weight, px, lang) { return weight + ' ' + px + 'px ' + (lang === 'ja' ? UI_FONTS.ja : UI_FONTS.en); }
  /** GAME OVER / PAUSED titles: Chrome's bold monospace in English, a heavy Japanese gothic in Japanese. */
  function titleFont(lang, px) {
    return lang === 'ja' ? '800 ' + px + 'px ' + UI_FONTS.ja : 'bold ' + px + 'px "Courier New", Courier, monospace';
  }
  /** 'ja' for any Japanese tag ('ja', 'ja-JP', ...), else 'en'. */
  function langKey(l) { return typeof l === 'string' && /^ja(?:[-_]|$)/i.test(l) ? 'ja' : 'en'; }

  /** Font for `msg` in the hint / small style (lang: 'en' | 'ja'), shrunk proportionally when wider than 92 % of
   * the canvas. Cached per language and message (measureText only on the first use after a resize). */
  Renderer.prototype._fitFont = function (ctx, which, msg, lang) {
    var cache = this._fit[which], key = lang + '|' + msg, e = cache[key];
    if (!e) {
      var px0 = which === 'hint' ? this.hintPx : this.smallPx, wt = which === 'hint' ? 600 : 500, px = px0, max = 0.92 * this.cw;
      ctx.font = uiFont(wt, px, lang);
      var w = ctx.measureText(msg).width;
      if (w > max) { px = Math.max(6, Math.floor((px * max) / w)); w = max; }
      e = cache[key] = { font: uiFont(wt, px, lang), px: px, w: w };
    }
    ctx.font = e.font;
    return e;
  };

  /**
   * GAME OVER title layout for `txt` in `lang` (cached per resize): its font, px and the centre x offset of every
   * character from the title's centre. English: Chrome's monospace letters on a fixed 0.62 em pitch (as before).
   * Japanese: ゲームオーバー in a heavy gothic at GO_JA_SCALE of the English size (similar visual height), advances
   * measured plus GO_JA_TRACK em tracking; shrunk to fit 92 % of the canvas width.
   */
  Renderer.prototype._titleLayout = function (ctx, txt, lang) {
    var key = lang + '|' + txt, e = this._fit.title[key];
    if (e) return e;
    var n = txt.length, xs = new Float64Array(n), px = this._go.titlePx, ja = lang === 'ja', i, tot = 0, k;
    var adv = new Float64Array(n), track = ja ? RC.GO_JA_TRACK : 0;
    if (ja) {
      px = Math.round(px * RC.GO_JA_SCALE);
      ctx.font = titleFont('ja', px);
      for (i = 0; i < n; i++) { adv[i] = ctx.measureText(txt.charAt(i)).width; tot += adv[i] + (i ? track * px : 0); }
    } else {
      for (i = 0; i < n; i++) adv[i] = 0.62 * px; // Chrome-like monospace pitch
      tot = n * 0.62 * px;
    }
    k = tot > 0.92 * this.cw ? (0.92 * this.cw) / tot : 1;
    if (k < 1) { px = Math.max(6, Math.floor(px * k)); for (i = 0; i < n; i++) adv[i] *= k; tot *= k; }
    var x = -tot / 2;
    for (i = 0; i < n; i++) { xs[i] = x + adv[i] / 2; x += adv[i] + track * px; }
    e = this._fit.title[key] = { font: titleFont(lang, px), px: px, xs: xs };
    return e;
  };

  /**
   * GAME OVER composition (device px, per resize): the title centre line, the restart icon square and the share
   * slot (RC.SHARE_SLOT CSS px x scale, centred below the icon; nothing is drawn there: main.js / share.js put the
   * HTML share button in it). Desktop keeps the classic positions (title at 0.34 H, icon top at 0.43 H); on small
   * screens the title / icon keep minimum CSS sizes and the group moves up (never above the HUD line) so the slot
   * stays in the sky, above the mountains and the running line. scale: the button's size factor (1 = 150 x 44 CSS px; grows with the game on
   * big screens, up to SHARE_MAX_SCALE). Sets and returns this._go; capture: the share image's layout instead (only
   * returned): no slot to keep clear (the button is not in the image), so the group only moves up when the icon itself
   * would reach the mountains (captureShareImage calls it with the HUD back on its playfield line, see _shareState).
   */
  Renderer.prototype._layoutGameOver = function (capture) {
    var c = this.cfg, bs = this.bs, d = this.dprEff || 1, ty = this.tpx;
    var titlePx = Math.max(Math.round(36 * bs), Math.round(RC.GO_TITLE_MIN_CSS * d));
    var iconS = Math.max(Math.round(46 * bs), Math.round(RC.GO_ICON_MIN_CSS * d));
    var scale = clamp((this.cssScale || 1) / RC.SHARE_REF_CSS, 1, RC.SHARE_MAX_SCALE);
    var slotW = Math.min(Math.round(RC.SHARE_SLOT[0] * scale * d), Math.round(this.cw * 0.9));
    var slotH = Math.round(RC.SHARE_SLOT[1] * scale * d);
    var gap = Math.max(Math.round(14 * bs), Math.round(12 * d)); // icon -> slot
    var iconDy = Math.round(1.35 * titlePx); // title centre -> icon top (0.43 H - 0.34 H at the classic size)
    var titleY = c.H * 0.34 * bs + ty;
    var yMax = ty + (c.MOUNTAIN_PEAK_Y - RC.GO_PEAK_CLEAR) * bs; // the slot's lowest bottom: in the sky
    var hudPx = Math.round(c.HUD_SIZE * bs), yMin = this.hudY + 0.65 * hudPx + 0.9 * titlePx; // title below the HUD
    var over = titleY + iconDy + iconS + (capture ? 0 : gap + slotH) - yMax;
    if (over > 0) titleY = Math.max(Math.min(yMin, titleY), titleY - over);
    var cx = (this.W / 2) * bs, iconY = Math.round(titleY + iconDy);
    var go = {
      titleY: titleY, titlePx: titlePx, iconS: iconS, iconX: Math.round(cx - iconS / 2), iconY: iconY,
      slotX: Math.round(cx - slotW / 2), slotY: iconY + iconS + gap, slotW: slotW, slotH: slotH, scale: scale
    };
    if (!capture) this._go = go;
    return go;
  };

  /** Text with a soft halo (strokeText underneath) that keeps it readable on any background: a light halo under
   * dark text, a dark one under light text. */
  function haloText(ctx, txt, x, y, px, darkText) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = Math.max(2, px * 0.16);
    ctx.strokeStyle = darkText ? 'rgba(250,250,248,0.6)' : 'rgba(16,20,28,0.5)';
    ctx.strokeText(txt, x, y);
    ctx.fillText(txt, x, y);
  }

  /** Letterbox colours: sample the assets when the canvas is not tainted (http), else config fallbacks. */
  Renderer.prototype._sampleColors = function () {
    var A = this.A, c = this.cfg;
    this.pageColors = { skyDay: c.PAGE_SKY_DAY, groundDay: c.PAGE_GROUND_DAY };
    this._pcTab = null;
    if (!root.location || !/^https?:$/.test(root.location.protocol)) return;
    try {
      var cn = mkCanvas(8, 8), x = cn.getContext('2d', { willReadFrequently: true });
      var s = A.sky.day;
      x.drawImage(s.img, 0, 0, s.img.width, Math.max(1, s.img.height * 0.03), 0, 0, 8, 8);
      var p = x.getImageData(4, 4, 1, 1).data;
      this.pageColors.skyDay = 'rgb(' + p[0] + ',' + p[1] + ',' + p[2] + ')';
      var g = A.terrain.ground;
      x.drawImage(g.img, 0, g.img.height * 0.97, g.img.width, g.img.height * 0.03, 0, 0, 8, 8);
      p = x.getImageData(4, 4, 1, 1).data;
      // x0.92: the rendered bottom edge is a little darker than the raw texture (vignette, near stones)
      this.pageColors.groundDay = 'rgb(' + Math.round(p[0] * 0.92) + ',' + Math.round(p[1] * 0.92) + ',' + Math.round(p[2] * 0.92) + ')';
    } catch (e) { /* tainted canvas: keep fallbacks */ }
  };

  // ---------------------------------------------------------------------------------------------------------------
  // Frame

  /**
   * ui: { phase (-1 = from sim), hint (bool), paused, debug, fps, toast, toastAlpha, touch, lang ('en' | 'ja' | any
   * 'ja-*' tag; followed live), duckGuide, muteBtn, muted, botInfo; capture: set by captureShareImage only }
   */
  Renderer.prototype.render = function (sim, alpha, ui) {
    if (!this.cache) return;
    var ctx = this.ctx, c = this.cfg, bs = this.bs, W = this.W, H = c.H, C = this.cache, M = this.M;
    // what this frame shows (getGameOverLayout / captureShareImage read it; no allocation)
    var fs = this._frame || (this._frame = { sim: null, alpha: 1, ui: null });
    fs.sim = sim; fs.alpha = alpha; fs.ui = ui;
    var ty = this.tpx; // world y 0 in device px (tall screens: the sky continues above it)
    var phase = ui.phase >= 0 ? ui.phase : sim.nightPhase;
    var running = sim.status === STATUS.RUNNING;
    var tCos = (sim.tick - 1 + alpha) * c.STEP_MS; // cosmetic clock
    var tWind = running ? sim.time - c.STEP_MS * (1 - alpha) : sim.time;
    var scroll = sim.prevDistance + (sim.distance - sim.prevDistance) * alpha;
    if (sim.runs !== this._runsSeen) { // a new run: the scenery carries on from where the last frame left it
      if (this._runsSeen !== null) { this._sceneBase += this._lastScroll; this._windBase += this._lastWind; }
      this._runsSeen = sim.runs;
    }
    this._lastScroll = scroll; this._lastWind = tWind;
    var sScroll = this._sceneBase + scroll, sWind = this._windBase + tWind; // scenery only (obstacles: own x)
    var nightW = smooth(phase * 2 - 1);
    var hudLight = smooth((phase - 0.18) / 0.3); // HUD switches to light text once the sky darkens (dusk)
    // camera shake after a crash
    var shx = 0, shy = 0;
    if (sim.status === STATUS.CRASHED && !this.reducedMotion && sim.gameOverTime < c.SHAKE_MS) {
      var st = sim.gameOverTime + alpha * c.STEP_MS, amp = c.SHAKE_AMPLITUDE * Math.pow(1 - st / c.SHAKE_MS, 2);
      shx = amp * Math.sin(st * 0.11 + 0.7);
      shy = amp * 0.6 * Math.sin(st * 0.157 + 2.1);
    }

    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.setTransform(bs, 0, 0, bs, shx * bs * 0.5, shy * bs * 0.5 + ty);
    // 1. sky crossfade day -> dusk -> night
    if (phase <= 0.5) {
      this._sky(ctx, C.sky.day, 1);
      if (phase > 0.001) this._sky(ctx, C.sky.dusk, phase * 2);
    } else {
      this._sky(ctx, C.sky.dusk, 1);
      var set = smooth((phase - 0.5) / 0.2);
      if (set > 0.004) this._sunSet(ctx, set, 1);
      this._sky(ctx, C.sky.night, phase * 2 - 1);
      // no stars in the sunset glow: around the dusk sun the night sky fades in star-free (its averaged colour)
      // until the glow is gone (composed in a scratch canvas, then laid over the sky through a soft radial mask)
      var hide = 1 - smooth((0.1 - (1 - nightW)) / 0.1);
      if (C.sunPatch && hide > 0.004) this._sunPatch(ctx, set, phase * 2 - 1, hide);
    }
    // 2. stars (they come out late, never over the sunset glow) + moon
    var starW = smooth((phase - 0.65) / 0.35);
    if (nightW > 0.01 || starW > 0.004) this._stars(ctx, starW, tCos, tWind, nightW, 1 - nightW);
    // sun bloom in the top-left corner (day only; the dusk sky has its own low sun)
    var dayW = 1 - smooth(phase * 2);
    if (dayW > 0.004 && c.SUN_BLOOM > 0) {
      var R = (c.SUN_BLOOM_RADIUS || 0.6) * H;
      ctx.setTransform(bs, 0, 0, bs, 0, 0);
      ctx.globalCompositeOperation = 'screen';
      ctx.globalAlpha = c.SUN_BLOOM * dayW;
      ctx.drawImage(C.bloom, 0, 0, R, R);
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }

    // 3..6 terrain (clouds, mountains, ground, decor), graded at dusk / night: clouds from pre-graded copies; the
    // opaque ground region with one multiply (+ lift) fill; only the sky-side band (mountains, haze, decor tips)
    // goes through the grading layer, which is just that band tall
    this.phaseNow = phase; this.nightNow = nightW;
    ctx.setTransform(bs, 0, 0, bs, shx * bs, shy * bs + ty);
    this._clouds(ctx, sScroll, sWind, phase);
    if (phase > 0.004) this._terrainGraded(sScroll, shx, shy, phase, nightW);
    else {
      this._mountains(ctx, sScroll, nightW);
      this._ground(ctx, sScroll, shx, shy);
      this._groundShade(ctx);
      this._haze(ctx);
      this._decor(ctx, sScroll, 0, this.decorItems.length, Infinity);
    }
    // 7..9 shadows, obstacles, dino, dust (pre-graded sprite versions + moonlight rim at night)
    ctx.setTransform(bs, 0, 0, bs, shx * bs, shy * bs + ty);
    this._wox = shx * bs; this._woy = shy * bs + ty; // the world transform's offsets (per-particle transforms)
    this._actors(ctx, sim, alpha, tCos);

    // 10. vignette, 11. HUD & overlays (no shake)
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(C.vignette, 0, 0, this.cw, this.ch);
    this._hud(ctx, sim, hudLight);
    this._overlays(ctx, sim, ui, hudLight, tCos);
    if (ui.debug) this._debug(ctx, sim, alpha, ui);
    ctx.globalAlpha = 1;
  };

  Renderer.prototype._sky = function (ctx, s, a) {
    if (a <= 0) return;
    ctx.globalAlpha = a > 1 ? 1 : a;
    ctx.drawImage(s.img, s.x, s.y, s.w, s.h);
    ctx.globalAlpha = 1;
  };

  /** Twinkling stars at alpha a (they come out late: starW), the moon at moonA (nightW). glowVis: how much of the
   * dusk sky still shows; stars near the dusk sun stay hidden while it does. */
  Renderer.prototype._stars = function (ctx, a, t, tWind, moonA, glowVis) {
    var S = this.stars, F = this.starSunFade, n = S.length / 5, W = this.W, H = this.cfg.H;
    var keep = smooth((0.1 - glowVis) / 0.1); // 1 once the sunset glow is gone
    if (a > 0.004) {
      ctx.fillStyle = '#ffffff';
      for (var i = 0; i < n; i++) {
        var f = F ? F[i] + (1 - F[i]) * keep : 1;
        if (f <= 0) continue;
        var tw = this.reducedMotion ? 0.8 : 0.55 + 0.45 * Math.sin(t * 0.001 * S[i * 5 + 3] + S[i * 5 + 4]);
        ctx.globalAlpha = a * tw * 0.9 * f;
        var s = S[i * 5 + 2];
        ctx.fillRect(S[i * 5], S[i * 5 + 1], s, s);
      }
    }
    if (moonA > 0.004) {
      var m = this.cache.moon;
      ctx.globalAlpha = moonA;
      // clear of the HUD: below its line, and left of its column on wide screens (it drifts further left over a run)
      ctx.drawImage(m.img, W * 0.66 - tWind * 0.0012 - m.w / 2, H * 0.19, m.w, m.h);
    }
    ctx.globalAlpha = 1;
  };

  /** No stars in the sunset glow: around the dusk sun, compose (scratch canvas) the dusk sky with its setting sun and
   * the star-free night patch at the night sky's alpha, and lay it over the sky through a soft radial mask at `hide`
   * (1 while the glow shows, 0 once it is gone). Linear in the mask, so no ring at its edge. */
  Renderer.prototype._sunPatch = function (ctx, set, nightA, hide) {
    var P = this.cache.sunPatch, sn = this.cache.duskSun, n = P.n, x = P.scratch.getContext('2d'), k = n / P.s;
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'copy';
    x.drawImage(P.dusk, 0, 0);
    x.globalCompositeOperation = 'source-over';
    if (set > 0.004) {
      var R = 2.4 * sn.r;
      x.globalAlpha = set;
      x.drawImage(this.cache.sunSet, (sn.x - R - P.x) * k, (sn.y - R - P.y) * k, 2 * R * k, 2 * R * k);
    }
    x.globalAlpha = nightA;
    x.drawImage(P.night, 0, 0);
    x.globalAlpha = 1;
    x.globalCompositeOperation = 'destination-in';
    x.drawImage(P.mask, 0, 0);
    x.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = hide;
    ctx.drawImage(P.scratch, P.x, P.y, P.s, P.s);
    ctx.globalAlpha = 1;
  };

  /** The dusk sun sets as the night comes (phase 0.5 -> 0.7): its disc is covered by the surrounding glow colour so
   * no ghost sun shows through the fading night sky (alpha 0 at phase 0.5: ?dusk=1 unchanged; reverses at dawn). */
  Renderer.prototype._sunSet = function (ctx, a, k) {
    var sn = this.cache.duskSun, img = this.cache.sunSet, R = 2.4 * sn.r;
    ctx.globalAlpha = a * k;
    ctx.drawImage(img, sn.x - R, sn.y - R, R * 2, R * 2);
    ctx.globalAlpha = 1;
  };

  /** Clouds, drawn straight onto the frame from the graded copies: day -> dusk (phase 0..0.5), dusk -> moonlit
   * night (0.5..1, on the nightW curve), crossfaded exactly through a scratch canvas; the night alpha makes the cores
   * nearly opaque (the stars stay behind them) while the sprite alpha keeps the edges soft. */
  Renderer.prototype._clouds = function (w, scroll, tWind, phase) {
    var cl = this.clouds, C = this.cache, W = this.W, n = C.clouds.length;
    if (!n) return;
    var nightW = smooth(phase * 2 - 1), t = phase <= 0.5 ? smooth(phase * 2) : nightW;
    for (var i = 0; i < cl.length; i++) {
      var o = cl[i];
      var u = scroll * o.f + tWind * this.cfg.CLOUD_WIND * o.wind + o.phase;
      var k = Math.floor(u / o.P), local = u - k * o.P;
      var x = W + o.margin + o.J * hash(o.idx, k) - local;
      var e = C.clouds[Math.floor(hash(o.idx + 50, k) * n)];
      var wU = o.wU * (0.85 + hash(o.idx + 70, k) * 0.3), hU = wU * e.ar;
      if (x > W || x + wU < 0) continue;
      var a = phase <= 0.5 ? e.img : e.k, b = phase <= 0.5 ? e.k : e.n;
      w.globalAlpha = lerp(o.alpha, RC.CLOUD_NIGHT_ALPHA, nightW);
      if (t <= 0.004 || t >= 0.996) { w.drawImage(t <= 0.004 ? a : b, x, o.y - hU / 2, wU, hU); continue; }
      var sc = C.cloudScratch, sx = sc.getContext('2d'), iw = e.img.width, ih = e.img.height;
      sx.globalCompositeOperation = 'source-over';
      sx.clearRect(0, 0, iw, ih);
      sx.globalAlpha = 1 - t;
      sx.drawImage(a, 0, 0, iw, ih);
      sx.globalCompositeOperation = 'lighter';
      sx.globalAlpha = t;
      sx.drawImage(b, 0, 0, iw, ih);
      sx.globalCompositeOperation = 'source-over';
      sx.globalAlpha = 1;
      w.drawImage(sc, 0, 0, iw, ih, x, o.y - hU / 2, wU, hU);
    }
    w.globalAlpha = 1;
  };

  /**
   * Dusk / night terrain. The ground region (rows from the horizon row down, including the extension) is opaque:
   * drawn straight onto the frame (clipped), then graded with one 'multiply' fill (+ one 'lighter' lift fill past
   * phase 0.52) over that rect, which equals the layer mask math for opaque pixels. Only the band above it
   * (mountains with their source-atop night darkening, haze, decor tips reaching above the horizon) needs a
   * per-pixel alpha mask: it goes through the grading layer, sized to that band.
   */
  Renderer.prototype._terrainGraded = function (scroll, shx, shy, phase, nightW) {
    var c = this.cfg, ctx = this.ctx, bs = this.bs, ty = this.tpx, cw = this.cw, ch = this.ch, C = this.cache;
    if (!this.gradeStyles) this._gradeTables();
    var qi = Math.round(clamp(phase, 0, 1) * 256), nItems = this.decorItems.length;
    var rowTop = C.ground.rowTop + Math.round(shy * bs) + ty; // first ground row on screen
    // sky-side band through the layer
    var l = this._layerCtx(), lh = this.layer.height;
    var bandTop = Math.max(0, Math.floor((c.MOUNTAIN_PEAK_Y - 60 + shy) * bs + ty));
    var bandH = Math.min(lh, rowTop - bandTop);
    if (bandH > 0) {
      l.setTransform(1, 0, 0, 1, 0, 0);
      l.globalAlpha = 1;
      l.globalCompositeOperation = 'source-over';
      l.clearRect(0, 0, cw, lh);
      l.setTransform(bs, 0, 0, bs, shx * bs, shy * bs + ty - bandTop);
      this._mountains(l, scroll, nightW);
      this._haze(l);
      this._decor(l, scroll, 0, nItems, c.HORIZON_Y + 1); // only items reaching above the horizon row
      this._grade(phase, bandTop, bandH);
    }
    // opaque ground region: drawn directly, graded with one fill
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.beginPath();
    ctx.rect(0, rowTop, cw, ch - rowTop);
    ctx.clip();
    ctx.setTransform(bs, 0, 0, bs, shx * bs, shy * bs + ty);
    this._ground(ctx, scroll, shx, shy);
    this._groundShade(ctx);
    this._haze(ctx);
    this._decor(ctx, scroll, 0, nItems, Infinity);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = this.gradeStyles[qi];
    ctx.fillRect(0, rowTop, cw, ch - rowTop);
    if (phase > 0.52) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = this.liftStyles[qi];
      ctx.fillRect(0, rowTop, cw, ch - rowTop);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  };

  Renderer.prototype._groundShade = function (w) {
    var gs = this.cache.groundShade;
    if (!gs) return;
    w.globalCompositeOperation = 'multiply';
    w.drawImage(gs.img, -20, gs.y0, this.W + 40, gs.y1 - gs.y0);
    w.globalCompositeOperation = 'source-over';
  };

  Renderer.prototype._mountains = function (w, scroll, nightW) {
    var c = this.cfg, C = this.cache, W = this.W, m, x0, x;
    // far range: smaller, hazier, slower
    m = C.mountFar;
    x0 = -mod(scroll * c.MOUNTAIN_FAR_SCROLL + m.w * 0.37, m.w);
    w.globalAlpha = 0.5;
    for (x = x0 - 10; x < W + 10; x += m.w) w.drawImage(m.img, x, c.HORIZON_Y + 1 - m.base, m.w, m.h);
    // near range
    m = C.mount;
    x0 = -mod(scroll * c.MOUNTAIN_SCROLL, m.w);
    w.globalAlpha = 1;
    for (x = x0 - 10; x < W + 10; x += m.w) w.drawImage(m.img, x, c.HORIZON_Y + 1.5 - m.base, m.w + 0.5, m.h);
    if (nightW > 0.01) { // distant ranges become dark silhouettes against the night sky
      w.globalCompositeOperation = 'source-atop';
      w.globalAlpha = nightW * c.MOUNTAIN_NIGHT_DARKEN;
      w.fillStyle = '#121a2c';
      w.fillRect(-20, c.MOUNTAIN_PEAK_Y - 60, W + 40, c.HORIZON_Y + 3 - (c.MOUNTAIN_PEAK_Y - 60));
      w.globalCompositeOperation = 'source-over';
    }
    w.globalAlpha = 1;
  };

  /**
   * Ground rows. Rows with f <= 1 (horizon .. running line, including the GROUND_Y slice) map the texture 1:1 and
   * scroll at f x the ground speed, so the running line moves exactly with the obstacles. Rows with f > 1 (closer to
   * the camera, including the extension below H) are magnified horizontally by m = f around the screen centre:
   * texture column u = (x - W/2) / f + scroll + W/2. They still move at f x the ground speed, but every row samples
   * coherent texture (no per-row shear, no horizontal streaks while running).
   */
  Renderer.prototype._ground = function (w, scroll, shx, shy) {
    var G = this.cache.ground, S = this.cache.slices, bs = this.bs;
    var ox = Math.round(shx * bs), oy = Math.round(shy * bs), ty = this.tpx;
    w.setTransform(1, 0, 0, 1, 0, 0);
    var n = S.length / 3, last = 0, lastH = 1, lastF = 1;
    for (var i = 0; i < n; i++) {
      var py = S[i * 3], h = S[i * 3 + 1], f = S[i * 3 + 2];
      this._groundRow(w, scroll, f, py, h, G.rowTop + py + oy + ty, h, ox);
      last = py; lastH = h; lastF = f;
    }
    // overscan below the bottom edge while shaking
    if (oy < 0) this._groundRow(w, scroll, lastF, last, lastH, G.rowTop + last + lastH + oy + ty, -oy + 1, ox);
    w.setTransform(bs, 0, 0, bs, shx * bs, shy * bs + ty);
  };

  /** One ground slice (texture rows sy..sy+sh) drawn to device rows dy..dy+dh: pieces that walk the wrapping tile,
   * each starting and ending on an integer device column (the source rect may be fractional and run into the wrap
   * padding), so no seam lets the previous frame / sky show through at a wrap. */
  Renderer.prototype._groundRow = function (w, scroll, f, sy, sh, dy, dh, ox) {
    var G = this.cache.ground, img = G.img, tilePx = G.tilePx, bs = this.bs, cw = this.cw;
    var m = f > 1 ? f : 1, s;
    if (m > 1) { var Xc = (this.W / 2) * bs; s = mod((-ox - Xc) / m + mod(scroll, G.tileWu) * bs + Xc, tilePx); }
    else s = mod(mod(scroll * f, G.tileWu) * bs - ox, tilePx);
    var X = 0;
    while (X < cw) {
      var Xb = Math.min(cw, X + Math.max(1, Math.ceil((tilePx - s) * m - 1e-7)));
      var sw = (Xb - X) / m;
      w.drawImage(img, s, sy, sw, sh, X, dy, Xb - X, dh);
      s += sw;
      if (s >= tilePx) s -= tilePx;
      X = Xb;
    }
  };

  Renderer.prototype._haze = function (w) {
    var hz = this.cache.haze;
    w.drawImage(hz.img, -20, hz.y0, this.W + 40, hz.y1 - hz.y0);
  };

  /** Decor items from..to (sorted by depth). yTop: skip items whose top edge is at or below this world y (the
   * graded band pass only needs the tips that reach above the horizon row); Infinity draws everything. */
  Renderer.prototype._decor = function (w, scroll, from, to, yTop) {
    var items = this.decorItems, C = this.cache, dec = C.decor, n = dec.length, c = this.cfg, W = this.W;
    if (!n) return;
    var G = c.GROUND_Y, HOR = c.HORIZON_Y, pxu = c.DECOR_PX_TO_U;
    for (var i = from; i < to; i++) {
      var it = items[i];
      var u = scroll * it.f + it.phase;
      var k = Math.floor(u / it.P), local = u - k * it.P;
      var x = W + it.margin + it.J * hash(it.idx, k) - local;
      var list = it.layer === 2 ? C.decorFg : it.layer === 3 ? C.decorRock : null;
      var e = list ? dec[list[Math.floor(hash(it.idx + 3, k) * list.length)]] : dec[Math.floor(hash(it.idx + 3, k) * n)];
      var sc = it.f * it.sizeMul * (0.75 + hash(it.idx + 9, k) * 0.5);
      if (e.kind === 'grass') sc *= 0.8;
      var wU = e.w * pxu * sc, hU = e.h * pxu * sc;
      var maxH = it.layer === 3 ? (it.y > G ? Math.max(0, it.y - G - 1) : Infinity) : it.layer > 0 ? it.y - G - (it.layer === 1 ? 3 : 8) : Infinity;
      if (hU > maxH) { var r = maxH / hU; wU *= r; hU *= r; sc *= r; } // in front of the running line: never over the feet / bases
      if (x - wU / 2 > W || x + wU / 2 < 0 || hU <= 0.3) continue;
      var img = it.layer === 2 ? e.lb : it.layer === 3 ? (sc <= 0.55 ? e.p0 : e.p1) || e.l1 : sc <= 0.55 ? e.l0 : sc <= 1.1 ? e.l1 : e.l2;
      var y0 = it.y - hU;
      if (it.layer === 2) y0 += e.lift * wU; // blurred variant: its base sits a little above the canvas bottom
      if (y0 >= yTop) continue;
      if (e.shadow > 0 && (it.layer > 0 || e.kind === 'rock')) {
        // soft contact shadow, offset away from the sun (upper left); wider + fainter for the out-of-focus layer
        var sw = wU * (it.layer === 2 ? 0.95 : 0.8), shh = Math.max(it.layer === 2 ? 1.2 : 0.8, wU * (it.layer === 2 ? 0.16 : 0.1));
        w.globalAlpha = it.layer === 3 ? RC.DECOR_PEBBLE_SHADOW : e.shadow * (it.layer === 2 ? 0.8 : 1);
        w.drawImage(this.cache.shadow, x - sw / 2 + wU * 0.08, it.y - shh * 0.62, sw, shh);
      }
      w.globalAlpha = it.layer === 0 ? 0.85 + 0.15 * clamp((it.y - HOR) / (G - HOR), 0, 1) : 1;
      w.drawImage(img, x - wU / 2, y0, wU, hU);
    }
    w.globalAlpha = 1;
  };

  Renderer.prototype._actors = function (w, sim, alpha, tCos) {
    var c = this.cfg, C = this.cache, M = this.M, D = M.dino, G = c.GROUND_Y, i, m, o, x;
    var d = sim.dino;
    var dy = d.prevY + (d.y - d.prevY) * alpha;
    var rise = G - dy;
    // --- shadows: long thin cast shadows to the right (sun upper left, like the reference), then contact stamps ---
    var sh = C.shadow, cast = C.cast;
    var ds = 1 / (1 + rise / 140), shA = 1 - 0.45 * this.nightNow;
    var castA = 0.62 * shA * (1 - 0.7 * this.phaseNow), SL = RC.CAST_SLOPE;
    if (cast && castA > 0.004) {
      for (i = 0; i < sim.nObs; i++) {
        o = sim.obs[i];
        if (o.type === OT.PTERO) continue; // flying: no long shadow
        x = o.prevX + (o.x - o.prevX) * alpha;
        if (x > this.W + 20 || x + o.w < -400) continue;
        var cl = M.cactusByType[o.type];
        w.globalAlpha = castA;
        for (m = 0; m < o.n; m++) {
          var cv0 = cl[o.vs[m]], hh = 2.8 + 0.08 * cv0.baseW;
          this._castStamp(w, x + o.oxs[m] + cv0.baseX - 0.3 * cv0.baseW, G + 0.6, SL, 0, -hh / 2, 1.45 * cv0.h, hh);
        }
      }
    }
    // dino: soft contact shadow + its cast shadow (detached and fading while jumping)
    var sw = D.hitLen * 1.08 * (0.55 + 0.45 * ds), dcx = (D.back + D.front) / 2 + 8 + rise * 0.1;
    w.globalAlpha = 0.42 * ds * ds * shA;
    w.drawImage(sh, dcx - sw / 2, G - 4.5, sw, 9);
    if (cast && castA * ds * ds > 0.004) {
      w.globalAlpha = castA * ds * ds;
      this._castStamp(w, D.back + 0.62 * D.hitLen + rise * 0.9, G + 0.6 + rise * SL * 0.9, SL, -4, -1.6, c.DINO_HEIGHT * 1.5 * (0.6 + 0.4 * ds), 3.2);
    }
    for (i = 0; i < sim.nObs; i++) {
      o = sim.obs[i];
      x = o.prevX + (o.x - o.prevX) * alpha;
      if (x > this.W + 20 || x + o.w < -20) continue;
      if (o.type === OT.PTERO) {
        var ph = G - o.y;
        w.globalAlpha = (0.16 / (1 + ph / 120)) * shA;
        var pw = M.ptero.frameW * 0.55;
        w.drawImage(sh, x + M.ptero.frameW * 0.5 - pw / 2 + ph * 0.12, G - 3, pw, 6);
      } else {
        var list = M.cactusByType[o.type];
        w.globalAlpha = 0.32 * shA;
        for (m = 0; m < o.n; m++) {
          var v = list[o.vs[m]], cx = x + o.oxs[m] + v.baseX;
          var bw = Math.max(v.baseW * 2.6, v.w * 0.7);
          w.drawImage(sh, cx - bw * 0.42 + 4, G - 3.5, bw, 7);
        }
      }
    }
    w.globalAlpha = 1;
    // --- obstacles ---
    for (i = 0; i < sim.nObs; i++) {
      o = sim.obs[i];
      x = o.prevX + (o.x - o.prevX) * alpha;
      if (x > this.W + 20 || x + o.w < -20) continue;
      if (o.type === OT.PTERO) {
        var pi = o.frame < C.ptero.length ? o.frame : 0;
        this._drawActor(w, C.ptero[pi], x, o.y - M.ptero.center, M.ptero.frameW, M.ptero.frameH);
      } else {
        var lst = M.cactusByType[o.type], imgs = C.cactus[o.type];
        for (m = 0; m < o.n; m++) {
          var vv = lst[o.vs[m]];
          this._drawActor(w, imgs[o.vs[m]], x + o.oxs[m], G - vv.h, vv.w, vv.h);
        }
      }
    }
    // --- dust behind the dino (the legs stay in front of the dust they raise) ---
    this._dust(w, 0, alpha);
    this._particles(w, false);
    // --- dino ---
    var frames = C.dino[d.anim], fi = d.frame < frames.length ? d.frame : 0, set = frames[fi];
    if (sim.status === STATUS.IDLE) {
      var br = Math.sin(tCos * 0.0024) * 0.007; // breathing bob
      this._drawActor(w, set, D.drawX, dy - D.baseline * (1 + br), D.frameW, D.frameH * (1 + br));
    } else {
      var cs = 0;
      if (d.anim === Sim.ANIM.DEAD && sim.status === STATUS.CRASHED) {
        // placed so the dead pose just touches what it hit; recomputed only while the pose settles (dy changes)
        var ck = Math.round(dy * 4);
        if (this._csSerial !== sim.crashSerial || this._csKey !== ck || this._csRuns !== sim.runs) {
          this._csSerial = sim.crashSerial; this._csKey = ck; this._csRuns = sim.runs;
          this._crashShiftVal = this._crashShift(sim, dy);
        }
        cs = this._crashShiftVal;
      }
      this._drawActor(w, set, D.drawX + cs, dy - D.baseline, D.frameW, D.frameH);
    }
    this._dust(w, 1, alpha);
    this._particles(w, true);
  };

  /**
   * Horizontal shift of the dead pose so it just touches the obstacle it hit (sim.crashSerial): pulled back until
   * its front overlaps the obstacle by only 2u in every height band both occupy, or nudged forward up to the rearing
   * pose's lean (x0.6) when it stops short. 0 when there is nothing to touch or the dino came down on top of it.
   * dy: the dino's current (interpolated) feet y.
   */
  Renderer.prototype._crashShift = function (sim, dy) {
    var c = this.cfg, M = this.M, D = M.dino, dead = D.frames.dead[0], o = null, i, m;
    if (!dead) return 0;
    for (i = 0; i < sim.nObs; i++) if (sim.obs[i].serial === sim.crashSerial) { o = sim.obs[i]; break; }
    if (!o) return 0;
    var gap = Infinity;
    function test(r, n, ox, oy) {
      for (var a = 0; a < dead.n; a++) {
        var ax1 = dead.r[a * 4 + 2], ay0 = dead.r[a * 4 + 1] + dy, ay1 = dead.r[a * 4 + 3] + dy;
        for (var b = 0; b < n; b++) {
          if (r[b * 4 + 3] + oy <= ay0 || r[b * 4 + 1] + oy >= ay1) continue; // no vertical overlap
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
    if (gap === Infinity || gap + 2 < -maxBack) return 0;
    // visual only: never pull the pose back so far that its tail leaves the canvas (the manifest's dead-frame
    // opaqueX0 = leftmost visible column; without it, the frame's own left edge)
    var man = root.ASSET_MANIFEST, md = M.source.dino === 'manifest' && man && man.dino && man.dino.frames && man.dino.frames.dead;
    var ox0 = md && md[0] && isFinite(md[0].opaqueX0) ? md[0].opaqueX0 : 0;
    return Math.max(-(D.drawX + ox0 * D.s), Math.min(gap + 2, Math.max(0, lean * 0.6)));
  };

  /** One long cast-shadow stamp: C.cast drawn at (dx, dy, len, hh) in a frame at (x0, y0) sheared by slope SL. */
  Renderer.prototype._castStamp = function (w, x0, y0, SL, dx, dy, len, hh) {
    w.save();
    w.translate(x0, y0);
    w.transform(1, SL, 0, 1, 0, 0);
    w.drawImage(this.cache.cast, dx, dy, len, hh);
    w.restore();
  };

  /**
   * Sprite dust (FX sprite pool), layer `front` (0 behind the dino, 1 in front). Each particle: its sprite's anchor on
   * the running line at the interpolated x, tilted / mirrored about it, width w0 x (1 + (g - 1) * easeOut(t)); alpha
   * fades in over sIn ticks, holds, then fades out; a fresh puff crossfades into its thin version over DUST_THIN.
   * Graded copies [day, dusk, night] crossfade with the lighting phase (two draws only during a transition).
   */
  Renderer.prototype._dust = function (w, front, alpha) {
    var fx = this.fx, spr = this.cache.dustSpr;
    if (!fx.sprites || !fx.live || !spr) return;
    var lib = fx.lib, bs = this.bs, G = this.cfg.GROUND_Y, W = this.W, ox = this._wox || 0, oy = this._woy || 0;
    var p = this.phaseNow, c0, c1, t2, th0 = RC.DUST_THIN[0], th1 = RC.DUST_THIN[1];
    if (p <= 0.5) { c0 = 0; c1 = 1; t2 = smooth(p * 2); } else { c0 = 1; c1 = 2; t2 = smooth(p * 2 - 1); }
    var drawn = 0;
    for (var i = 0; i < fx.SN; i++) {
      if (!fx.sOn[i] || fx.sFront[i] !== front) continue;
      var age = fx.sAge[i] - 1 + alpha;
      if (age < 0) age = 0;
      var t = age / fx.sLife[i];
      if (t >= 1) continue;
      var e = 1 - (1 - t) * (1 - t), ia = fx.sA[i], it = lib[ia];
      var wu = fx.sW[i] * (1 + (fx.sGx[i] - 1) * e), hk = fx.sW[i] * fx.sSy[i] * (1 + (fx.sGy[i] - 1) * e); // hk x aspect = height
      var x = fx.sPx[i] + (fx.sX[i] - fx.sPx[i]) * alpha;
      if (x + wu < -2 || x - wu > W + 2) continue;
      var a = fx.sAl[i] * Math.min(1, (age + 1) / fx.sIn[i]), hold = fx.sHold[i]; // visible from the tick it is raised
      if (t > hold) a *= 1 - smooth((t - hold) / (1 - hold));
      if (a <= 0.004) continue;
      var m = fx.sB[i] >= 0 ? smooth((t - th0) / (th1 - th0)) : 0;
      // local sprite space: mirror (f), tilt, then the world-space backward lean k (x += k * y, y < 0 above ground)
      var cs = Math.cos(fx.sRot[i]) * bs, sn = Math.sin(fx.sRot[i]) * bs, f = fx.sFlip[i], k = fx.sSk[i];
      w.setTransform((cs + k * sn) * f, sn * f, k * cs - sn, cs, ox + x * bs, oy + G * bs);
      if (m < 0.996) dustImg(w, spr[ia], it, wu, hk * it.ar, a * (1 - m), c0, c1, t2);
      if (m > 0.004) { var ib = fx.sB[i], jt = lib[ib]; dustImg(w, spr[ib], jt, wu, hk * jt.ar, a * m, c0, c1, t2); }
      drawn++;
    }
    if (drawn) w.setTransform(bs, 0, 0, bs, ox, oy);
    w.globalAlpha = 1;
  };
  /** One dust sprite (graded copies cp) with its anchor at the local origin, crossfading copy c0 -> c1 at t2. */
  function dustImg(w, cp, it, wu, hu, a, c0, c1, t2) {
    if (!cp) return;
    var x = -it.ax * wu, y = -it.ay * hu;
    if (t2 < 0.996) { w.globalAlpha = a * (1 - t2); w.drawImage(cp[c0], x, y, wu, hu); }
    if (t2 > 0.004) { w.globalAlpha = a * t2; w.drawImage(cp[c1], x, y, wu, hu); }
  }

  Renderer.prototype._particles = function (w, front) {
    var fx = this.fx, p = this.phaseNow, dc = this.cache.dust, dust = p < 0.25 ? dc.d : p < 0.75 ? dc.k : dc.n;
    var gc = this.cache.grain, grain = p < 0.25 ? gc.d : p < 0.75 ? gc.k : gc.n;
    for (var i = 0; i < fx.N; i++) {
      if (!fx.on[i] || (fx.front[i] === 1) !== front) continue;
      var lt = fx.life[i] / fx.max[i];
      var s = fx.size[i];
      if (fx.grain[i]) {
        w.globalAlpha = fx.a[i] * (1 - lt * lt);
        w.drawImage(grain, fx.x[i] - s / 2, fx.y[i] - s / 2, s, s);
        continue;
      }
      var a = fx.a[i] * (1 - lt) * Math.min(1, fx.life[i] / 3);
      if (a <= 0.004) continue;
      w.globalAlpha = a;
      w.drawImage(dust, fx.x[i] - s / 2, fx.y[i] - s * 0.6, s, s * 0.8);
    }
    w.globalAlpha = 1;
  };

  /** Multiply-grade the world layer (dusk / night) and composite it over the sky. */
  Renderer.prototype._gradeTables = function () {
    // 257 pre-built colour strings per table so grading allocates nothing per frame
    var c = this.cfg, g = [], l = [];
    for (var i = 0; i <= 256; i++) {
      var phase = i / 256, r, gg, b;
      if (phase <= 0.5) {
        var t = smooth(phase * 2);
        r = lerp(255, c.GRADE_DUSK[0], t); gg = lerp(255, c.GRADE_DUSK[1], t); b = lerp(255, c.GRADE_DUSK[2], t);
      } else {
        var t2 = smooth(phase * 2 - 1);
        r = lerp(c.GRADE_DUSK[0], c.GRADE_NIGHT[0], t2); gg = lerp(c.GRADE_DUSK[1], c.GRADE_NIGHT[1], t2); b = lerp(c.GRADE_DUSK[2], c.GRADE_NIGHT[2], t2);
      }
      g.push('rgb(' + Math.round(r) + ',' + Math.round(gg) + ',' + Math.round(b) + ')');
      var nw = smooth(phase * 2 - 1);
      l.push('rgb(' + Math.round(c.NIGHT_LIFT[0] * nw) + ',' + Math.round(c.NIGHT_LIFT[1] * nw) + ',' + Math.round(c.NIGHT_LIFT[2] * nw) + ')');
    }
    this.gradeStyles = g; this.liftStyles = l;
  };

  /** Composite the grading layer's band (layer rows 0..h -> device rows top..top+h) over the frame and
   * multiply-grade it: the layer becomes a tint mask carrying the band's alpha (+ the moonlight lift past 0.52). */
  Renderer.prototype._grade = function (phase, top, h) {
    var ctx = this.ctx, l = this.lctx, cw = this.cw, L = this.layer;
    var qi = Math.round(clamp(phase, 0, 1) * 256);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.drawImage(L, 0, 0, cw, h, 0, top, cw, h);
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalAlpha = 1;
    l.globalCompositeOperation = 'source-in';
    l.fillStyle = this.gradeStyles[qi];
    l.fillRect(0, 0, cw, h);
    l.globalCompositeOperation = 'source-over';
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(L, 0, 0, cw, h, 0, top, cw, h);
    // gentle moonlight lift (terrain pixels only) so the night stays readable
    if (phase > 0.52) {
      l.globalCompositeOperation = 'source-in';
      l.fillStyle = this.liftStyles[qi];
      l.fillRect(0, 0, cw, h);
      l.globalCompositeOperation = 'source-over';
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(L, 0, 0, cw, h, 0, top, cw, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  };

  Renderer.prototype._glyph = function (ctx, atlas, idx, x, y) {
    var h = this.hud;
    ctx.drawImage(atlas, idx * h.cw, 0, h.cw, h.ch, x, y, h.cw, h.ch);
  };

  Renderer.prototype._number = function (ctx, atlas, n, x, y) {
    var h = this.hud;
    n = Math.max(0, Math.min(99999, n | 0));
    for (var i = 4; i >= 0; i--) {
      this._glyph(ctx, atlas, n % 10, x + i * h.cw, y);
      n = (n / 10) | 0;
    }
  };

  Renderer.prototype._hud = function (ctx, sim, nightW) {
    var h = this.hud, c = this.cfg, bs = this.bs;
    var hi = sim.hiScore, nChars = hi > 0 ? 14 : 5;
    var right = Math.round((this.W - c.HUD_RIGHT) * bs), top = Math.round(c.HUD_TOP * bs - h.ch / 2) + this.tpx + this.hudDy;
    var x0 = right - nChars * h.cw;
    // the sim owns the milestone blink (the updated sim.js fills `out`; the current one returns a new object)
    var hs = Sim.hudScore(sim, this._hs || (this._hs = { value: 0, visible: true }));
    var value = hs.value, visible = hs.visible;
    if (sim.status === STATUS.IDLE) visible = false; // like Chrome: no distance meter before the first run
    for (var pass = 0; pass < 2; pass++) {
      var a = pass === 0 ? 1 - nightW : nightW;
      if (a <= 0.003) continue;
      var atlas = pass === 0 ? h.dark : h.light;
      ctx.globalAlpha = a;
      var xs = x0;
      if (hi > 0) {
        this._glyph(ctx, atlas, 10, xs, top);
        this._glyph(ctx, atlas, 11, xs + h.cw, top);
        this._number(ctx, atlas, hi, xs + 3 * h.cw, top);
        xs += 9 * h.cw;
      }
      if (visible) this._number(ctx, atlas, value, xs, top);
    }
    ctx.globalAlpha = 1;
  };

  /** Every string the canvas draws, in English and Japanese (ui.lang picks; any 'ja-*' tag is Japanese). The HUD's
   * "HI" and the debug overlay stay as they are (like Chrome). The loading frame draws no text. */
  var TEXT = {
    en: {
      start: 'Press Space to play', tap: 'Tap to play',
      keys: 'Space / ↑ jump   ↓ duck   P pause   M mute', touch: 'Tap to jump · hold the bottom-left to duck',
      duckZone: '↓ Hold to duck', over: 'GAME OVER', paused: 'PAUSED',
      resume: 'Press any key or tap to resume', resumeTouch: 'Tap to resume', sound: 'SOUND ON', mute: 'SOUND OFF'
    },
    ja: {
      start: 'スペースキーでスタート', tap: 'タップでスタート',
      keys: 'スペース / ↑ ジャンプ　↓ しゃがむ　P 一時停止　M 消音', touch: 'タップでジャンプ・左下を長押しでしゃがむ',
      duckZone: '↓ 長押しでしゃがむ', over: 'ゲームオーバー', paused: '一時停止',
      resume: 'キーを押すかタップで再開', resumeTouch: 'タップで再開', sound: 'サウンド オン', mute: 'サウンド オフ'
    }
  };
  RDG.TEXT = TEXT;

  Renderer.prototype._overlays = function (ctx, sim, ui, nightW, tCos) {
    var c = this.cfg, bs = this.bs, W = this.W, H = c.H, lang = langKey(ui.lang), T = TEXT[lang], ty = this.tpx, go = this._go;
    var col = nightW > 0.5 ? c.HUD_COLOR_NIGHT : c.HUD_COLOR_DAY;
    var cx = (W / 2) * bs;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (sim.status === STATUS.CRASHED) {
      // GAME OVER + restart icon; the share slot below the icon stays empty (the HTML share button goes there)
      var a = ui.capture ? 1 : clamp(sim.gameOverTime / 250, 0, 1);
      ctx.globalAlpha = a;
      ctx.fillStyle = col;
      var tl = this._titleLayout(ctx, T.over, lang), n = T.over.length;
      ctx.font = tl.font;
      for (var i = 0; i < n; i++) ctx.fillText(T.over.charAt(i), cx + tl.xs[i], go.titleY);
      var ic = this.cache.restart[nightW > 0.5 ? 1 : 0];
      ctx.globalAlpha = a * (ui.capture || sim.gameOverTime >= c.GAMEOVER_CLEAR_TIME ? 1 : 0.45);
      ctx.drawImage(ic, go.iconX, go.iconY);
    } else if (ui.hint && sim.status === STATUS.IDLE) {
      var dark = !(nightW > 0.5);
      var yHint = H * 0.4 * bs, ySmall = Math.max(H * 0.46 * bs, yHint + 0.7 * (this.hintPx + this.smallPx));
      var pulse = this.reducedMotion ? 1 : 0.85 + 0.15 * Math.sin(tCos * 0.0035); // 0.7 .. 1
      this.hintPulse = pulse;
      ctx.globalAlpha = 1;
      ctx.fillStyle = this._hintCols[dark ? 0 : 1][Math.round(clamp((pulse - 0.7) / 0.3, 0, 1) * 16)];
      var msg = ui.touch ? T.tap : T.start, fh = this._fitFont(ctx, 'hint', msg, lang);
      haloText(ctx, msg, cx, yHint + ty, fh.px, dark);
      ctx.fillStyle = col;
      var msg2 = ui.touch ? T.touch : T.keys, fs2 = this._fitFont(ctx, 'small', msg2, lang);
      haloText(ctx, msg2, cx, ySmall + ty, fs2.px, dark);
    }
    if (ui.paused) {
      // a darker scrim than a plain dim, and the title on a dark halo: readable on the pale day sky too
      ctx.globalAlpha = 0.4;
      ctx.fillStyle = '#10141c';
      ctx.fillRect(0, 0, this.cw, this.ch);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#f2f2f2';
      var pt = this._titleLayout(ctx, T.paused, lang), yP = Math.max(H * 0.36 * bs + ty, this.hudY + 0.65 * this.hud.px + 0.9 * pt.px);
      ctx.font = pt.font;
      haloText(ctx, T.paused, cx, yP, pt.px, false);
      var rmsg = ui.touch ? T.resumeTouch : T.resume, fr = this._fitFont(ctx, 'small', rmsg, lang);
      haloText(ctx, rmsg, cx, Math.max(H * 0.44 * bs + ty, yP + 0.75 * pt.px + 0.9 * fr.px), fr.px, false);
    }
    // touch: the duck zone marker (drawn over the pause scrim so it stays legible there)
    if (ui.touch && ui.duckGuide > 0) this._duckGuide(ctx, ui.duckGuide, ui.paused ? 1 : nightW, T, lang);
    var mb = ui.muteBtn ? this.muteButtonRect() : null;
    if (mb) this._muteButton(ctx, mb, ui.muted, ui.paused ? 1 : nightW);
    if (ui.toastAlpha > 0) {
      var tLight = ui.paused || nightW > 0.5; // light text on the pause scrim / at night
      ctx.globalAlpha = ui.toastAlpha;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = tLight ? c.HUD_COLOR_NIGHT : c.HUD_COLOR_DAY;
      var tmsg = ui.muted ? T.mute : T.sound, ft = this._fitFont(ctx, 'small', tmsg, lang), tx = 22 * bs, tyy = this.hudY;
      if (mb) tx = mb.x + mb.s + 4 * this.dprEff; // right of the speaker button
      // keep clear of the score HUD (top right): drop below it when the two would meet (narrow screens)
      var hudLeft = Math.round((W - c.HUD_RIGHT) * bs) - (sim.hiScore > 0 ? 14 : 5) * this.hud.cw;
      if (tx + ft.w + 12 * bs > hudLeft) tyy += this.hud.ch * 0.5 + ft.px;
      haloText(ctx, tmsg, tx, tyy, ft.px, !tLight);
    }
    ctx.globalAlpha = 1;
  };

  function roundRectPath(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /** Touch: the duck zone (config TOUCH_DUCK_ZONE: left of x1, below y0, fractions of the canvas; the same geometry
   * input.js hit-tests) as a faint dashed panel with a label, at opacity a. */
  Renderer.prototype._duckGuide = function (ctx, a, nightW, T, lang) {
    var c = this.cfg, z = c.TOUCH_DUCK_ZONE;
    if (!z || a <= 0.003) return;
    var d = this.dprEff || 1, pad = Math.round(8 * d);
    var x0 = pad, x1 = Math.round(this.cw * z.x1) - pad, y0 = Math.round(this.ch * z.y0) + pad, y1 = this.ch - pad;
    if (x1 - x0 < 40 * d || y1 - y0 < 30 * d) return;
    var night = nightW > 0.5;
    ctx.globalAlpha = a;
    ctx.beginPath();
    roundRectPath(ctx, x0, y0, x1 - x0, y1 - y0, 16 * d);
    ctx.fillStyle = night ? 'rgba(200,214,245,0.12)' : 'rgba(46,38,30,0.13)';
    ctx.fill();
    if (ctx.setLineDash) ctx.setLineDash([9 * d, 6 * d]);
    ctx.lineWidth = Math.max(1, 2 * d);
    ctx.strokeStyle = night ? 'rgba(226,230,238,0.7)' : 'rgba(64,58,52,0.7)';
    ctx.stroke();
    if (ctx.setLineDash) ctx.setLineDash([]);
    // label centred between the running line (or the zone top, if lower) and the zone bottom, clear of the dino's feet
    var yG = this.tpx + c.GROUND_Y * this.bs, ly = (Math.max(y0, yG) + y1) / 2;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = night ? c.HUD_COLOR_NIGHT : c.HUD_COLOR_DAY;
    // the hint's small size, semibold; shrunk to the zone's width when needed (measured once per resize)
    var dk = lang + '|' + T.duckZone, e = this._fit.duck[dk];
    if (!e) {
      var px = this.smallPx, room = x1 - x0 - 12 * d;
      ctx.font = uiFont(600, px, lang);
      var tw = ctx.measureText(T.duckZone).width;
      if (tw > room) px = Math.max(6, Math.floor((px * room) / tw));
      e = this._fit.duck[dk] = { px: px, font: uiFont(600, px, lang) };
    }
    ctx.font = e.font;
    haloText(ctx, T.duckZone, (x0 + x1) / 2, ly, e.px, !night);
    ctx.globalAlpha = 1;
  };

  /** Touch speaker button: a device-px square {x, y, s} (config MUTE_BUTTON CSS px) at the top left, centred on the
   * HUD line. main.js hit-tests the same square. */
  Renderer.prototype.muteButtonRect = function () {
    var c = this.cfg, d = this.dprEff || 1, s = Math.round((c.MUTE_BUTTON || 44) * d);
    var x = Math.round(Math.max(4 * d, 22 * this.bs - 0.2 * s));
    var y = Math.round(Math.max(4 * d, this.hudY - s / 2));
    return { x: x, y: y, s: s };
  };

  /** Speaker glyph (waves, or a cross when muted) on a soft round backdrop, in the HUD colour. */
  Renderer.prototype._muteButton = function (ctx, r, muted, nightW) {
    var c = this.cfg, s = r.s, cx = r.x + s / 2, cy = r.y + s / 2, u = s / 44, night = nightW > 0.5;
    var col = night ? c.HUD_COLOR_NIGHT : c.HUD_COLOR_DAY;
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, s * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = night ? 'rgba(16,20,28,0.4)' : 'rgba(250,250,248,0.5)';
    ctx.fill();
    var gx = cx - 7.5 * u;
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(gx - 3 * u, cy - 3.5 * u);
    ctx.lineTo(gx + 1.5 * u, cy - 3.5 * u);
    ctx.lineTo(gx + 7 * u, cy - 8.5 * u);
    ctx.lineTo(gx + 7 * u, cy + 8.5 * u);
    ctx.lineTo(gx + 1.5 * u, cy + 3.5 * u);
    ctx.lineTo(gx - 3 * u, cy + 3.5 * u);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 2.2 * u;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (muted) {
      ctx.moveTo(gx + 11 * u, cy - 4.5 * u); ctx.lineTo(gx + 20 * u, cy + 4.5 * u);
      ctx.moveTo(gx + 20 * u, cy - 4.5 * u); ctx.lineTo(gx + 11 * u, cy + 4.5 * u);
    } else {
      ctx.arc(gx + 7 * u, cy, 6 * u, -0.8, 0.8);
      ctx.moveTo(gx + 7 * u + 11 * u * Math.cos(-0.85), cy + 11 * u * Math.sin(-0.85));
      ctx.arc(gx + 7 * u, cy, 11 * u, -0.85, 0.85);
    }
    ctx.stroke();
    ctx.lineCap = 'butt';
  };

  Renderer.prototype._debug = function (ctx, sim, alpha, ui) {
    var c = this.cfg, bs = this.bs, M = this.M, i, j, o, x;
    ctx.setTransform(bs, 0, 0, bs, 0, this.tpx);
    ctx.lineWidth = 1 / bs;
    ctx.strokeStyle = 'rgba(0,120,255,0.9)';
    ctx.beginPath(); ctx.moveTo(0, c.HORIZON_Y); ctx.lineTo(this.W, c.HORIZON_Y); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,40,40,0.9)';
    ctx.beginPath(); ctx.moveTo(0, c.GROUND_Y); ctx.lineTo(this.W, c.GROUND_Y); ctx.stroke();
    var d = sim.dino, dy = d.prevY + (d.y - d.prevY) * alpha, fr = Sim.dinoFrameRects(sim);
    ctx.strokeStyle = '#00d05a';
    for (i = 0; i < fr.n; i++) ctx.strokeRect(fr.r[i * 4], fr.r[i * 4 + 1] + dy, fr.r[i * 4 + 2] - fr.r[i * 4], fr.r[i * 4 + 3] - fr.r[i * 4 + 1]);
    ctx.strokeStyle = '#ff2a2a';
    for (i = 0; i < sim.nObs; i++) {
      o = sim.obs[i];
      x = o.prevX + (o.x - o.prevX) * alpha;
      if (o.type === OT.PTERO) {
        var pf = M.ptero.frames[o.frame];
        for (j = 0; j < pf.n; j++) ctx.strokeRect(x + pf.r[j * 4], o.y + pf.r[j * 4 + 1], pf.r[j * 4 + 2] - pf.r[j * 4], pf.r[j * 4 + 3] - pf.r[j * 4 + 1]);
      } else {
        var list = M.cactusByType[o.type];
        for (var m = 0; m < o.n; m++) {
          var v = list[o.vs[m]], ox = x + o.oxs[m];
          for (j = 0; j < v.n; j++) ctx.strokeRect(ox + v.r[j * 4], c.GROUND_Y + v.r[j * 4 + 1], v.r[j * 4 + 2] - v.r[j * 4], v.r[j * 4 + 3] - v.r[j * 4 + 1]);
        }
      }
    }
    ctx.strokeStyle = 'rgba(255,160,0,0.8)';
    for (i = 0; i < 3; i++) {
      ctx.beginPath(); ctx.moveTo(this.W - 40, M.pteroY[i]); ctx.lineTo(this.W, M.pteroY[i]); ctx.stroke();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = this.fonts.debug;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(8 * bs, 8 * bs, 430 * bs, 78 * bs);
    ctx.fillStyle = '#9dff9d';
    var lh = 14 * bs, y0 = 12 * bs, xx = 14 * bs;
    ctx.fillText('fps ' + (ui.fps || 0).toFixed(0) + '  tick ' + sim.tick + '  seed ' + sim.seed, xx, y0);
    ctx.fillText('speed ' + (sim.speed / c.K).toFixed(2) + ' (' + sim.speed.toFixed(1) + ' u/t)  score ' + sim.score, xx, y0 + lh);
    ctx.fillText('obstacles ' + sim.nObs + '  spawned ' + sim.serial + '  unfair ' + sim.unfair, xx, y0 + lh * 2);
    ctx.fillText('night ' + sim.nightPhase.toFixed(2) + '  W ' + this.W + '  bs ' + bs.toFixed(2) + (ui.botInfo ? '  ' + ui.botInfo : ''), xx, y0 + lh * 3);
    ctx.fillText('assets: dino ' + M.source.dino + ', cactus ' + M.source.cactus + ', ptero ' + M.source.ptero, xx, y0 + lh * 4);
  };

  /** '#rgb' / '#rrggbb' / 'rgb(r,g,b)' -> [r, g, b] (d when unparsable). */
  function parseRGB(s, d) {
    if (typeof s !== 'string') return d;
    if (s.charAt(0) === '#') {
      var h = s.slice(1);
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      var n = parseInt(h, 16);
      return h.length === 6 && isFinite(n) ? [(n >> 16) & 255, (n >> 8) & 255, n & 255] : d;
    }
    var m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
    return m ? [+m[1], +m[2], +m[3]] : d;
  }

  /**
   * Page colours [sky, ground] for a lighting phase (pillarbox side bands, first paint), continuous: a lazily built
   * 257-entry table of cached strings (no per-frame allocation). Sky: the sky layers' linear crossfade (sampled day
   * colour -> PAGE_SKY_DUSK -> PAGE_SKY_NIGHT). Ground: the day ground colour x the terrain grade multiplier plus
   * the night lift, i.e. exactly what the grading does to the ground.
   */
  Renderer.prototype.pageColorsFor = function (phase) {
    if (!this._pcTab) this._pcTab = this._pageTable();
    return this._pcTab[Math.round(clamp(phase || 0, 0, 1) * 256)];
  };
  Renderer.prototype._pageTable = function () {
    var c = this.cfg, pc = this.pageColors || {}, out = [], i, k;
    var sd = parseRGB(pc.skyDay, parseRGB(c.PAGE_SKY_DAY, [194, 196, 199]));
    var sk = parseRGB(c.PAGE_SKY_DUSK, [108, 117, 144]), sn = parseRGB(c.PAGE_SKY_NIGHT, [10, 16, 28]);
    var gd = parseRGB(pc.groundDay, parseRGB(c.PAGE_GROUND_DAY, [156, 135, 115]));
    var GD = c.GRADE_DUSK, GN = c.GRADE_NIGHT, L = c.NIGHT_LIFT || [0, 0, 0];
    function css(v) { return 'rgb(' + Math.round(clamp(v[0], 0, 255)) + ',' + Math.round(clamp(v[1], 0, 255)) + ',' + Math.round(clamp(v[2], 0, 255)) + ')'; }
    for (i = 0; i <= 256; i++) {
      var p = i / 256, sky = [0, 0, 0], gr = [0, 0, 0];
      var t = smooth(p * 2), t2 = smooth(p * 2 - 1);
      for (k = 0; k < 3; k++) {
        sky[k] = p <= 0.5 ? lerp(sd[k], sk[k], p * 2) : lerp(sk[k], sn[k], p * 2 - 1);
        var m = Math.round(p <= 0.5 ? lerp(255, GD[k], t) : lerp(GD[k], GN[k], t2)); // as in _gradeTables
        gr[k] = (gd[k] * m) / 255 + L[k] * t2;
      }
      out.push([css(sky), css(gr)]);
    }
    return out;
  };


  // ---------------------------------------------------------------------------------------------------------------
  // GAME OVER share support (used by main.js / share.js)
  //
  // renderer.getGameOverLayout() -> null | {
  //     restart:   { x, y, w, h }  the restart icon's square
  //     shareSlot: { x, y, w, h }  the empty slot below it, reserved for the HTML share button (nothing is drawn
  //                                there); nominally 150 x 44 CSS px, times `scale`
  //     scale:     number          the button's size factor: 1 = the 150 x 44 CSS px design; > 1 on big screens where
  //                                the whole GAME OVER composition is larger (up to RC.SHARE_MAX_SCALE); never < 1
  //     unit:      number          CSS px per world unit (the canvas scale)
  //     alpha:     0..1            the GAME OVER fade-in (0 -> 1 over the first 250 ms)
  //     ready:     boolean         the restart delay has passed (the icon is at full opacity from then on)
  //     night:     boolean         the overlay uses its light-on-dark colours (dusk / night: the HUD's light curve,
  //                                smooth((phase - 0.18) / 0.3) > 0.5, i.e. night phase > ~0.33; share.js follows it)
  //     rev:       number          changes whenever the layout may have moved (resize / DPR / asset rebuild)
  //   }
  //   All rects are CSS px relative to the canvas element's top-left corner (the extended sky / ground of tall screens,
  //   the device-pixel ratio and the world scale are already accounted for; add canvas.getBoundingClientRect() for
  //   viewport coordinates). null unless the last rendered frame shows the GAME OVER screen. The returned object is
  //   reused between calls (copy what you keep); it only changes when a frame is rendered or the canvas is resized.
  //
  // renderer.captureShareImage(maxW = 1200) -> HTMLCanvasElement | null
  //   A copy of the current frame for sharing: the playfield (the extended sky / ground of tall screens cropped off,
  //   the score HUD kept on its playfield line), GAME OVER and the restart icon at full opacity, laid out for the image
  //   (below that HUD line, no share slot to keep clear: on phones they sit lower than on screen), without the touch UI
  //   (speaker button, duck-zone frame), toasts or the debug overlay, scaled to at most maxW device px wide. The HTML
  //   share button is not part of the canvas, so it never appears. null when nothing has been rendered yet, or when the canvas is
  //   tainted and cannot be read (pages opened from file://). Re-renders the frame twice (clean, then as it was):
  //   call it on demand (e.g. once when the share button appears), not every frame.

  Renderer.prototype.getGameOverLayout = function () {
    var f = this._frame, go = this._go;
    if (!this.cache || !go || !f || !f.sim || f.sim.status !== STATUS.CRASHED) return null;
    var sim = f.sim, k = 1 / (this.dprEff || 1), L = this._goOut;
    if (!L) L = this._goOut = { restart: { x: 0, y: 0, w: 0, h: 0 }, shareSlot: { x: 0, y: 0, w: 0, h: 0 }, scale: 1, unit: 1, alpha: 1, ready: false, night: false, rev: 0 };
    L.restart.x = go.iconX * k; L.restart.y = go.iconY * k; L.restart.w = L.restart.h = go.iconS * k;
    L.shareSlot.x = go.slotX * k; L.shareSlot.y = go.slotY * k; L.shareSlot.w = go.slotW * k; L.shareSlot.h = go.slotH * k;
    L.scale = go.scale; L.unit = this.cssScale || 1;
    L.alpha = clamp(sim.gameOverTime / 250, 0, 1);
    L.ready = sim.gameOverTime >= this.cfg.GAMEOVER_CLEAR_TIME;
    var ph = f.ui && f.ui.phase >= 0 ? f.ui.phase : sim.nightPhase;
    L.night = smooth((ph - 0.18) / 0.3) > 0.5; // render() passes this curve (hudLight) to _overlays: its colour switch
    L.rev = this._rev || 0;
    return L;
  };

  /** The share image's frame state on (true) / back off (false): the score HUD on its playfield line (tall screens pin
   * it to the top of the screen, outside the image's crop) and GAME OVER laid out against that line without the
   * share slot (_layoutGameOver(true)), so the title can never sit under the HUD in the image. */
  Renderer.prototype._shareState = function (on) {
    var s = this._shareSaved || (this._shareSaved = { on: false, hudY: 0, hudDy: 0, go: null });
    if (on && !s.on) {
      s.on = true; s.hudY = this.hudY; s.hudDy = this.hudDy; s.go = this._go;
      this.hudY -= this.hudDy; this.hudDy = 0;
      this._go = this._layoutGameOver(true);
    } else if (!on && s.on) {
      s.on = false;
      this.hudY = s.hudY; this.hudDy = s.hudDy; this._go = s.go; s.go = null;
    }
  };

  Renderer.prototype.captureShareImage = function (maxW) {
    var f = this._frame;
    if (!this.cache || !f || !f.sim || !f.ui) return null;
    maxW = maxW > 0 ? maxW : 1200;
    var sim = f.sim, alpha = f.alpha, ui = f.ui, out = null;
    var clean = this._shareUi || (this._shareUi = {});
    for (var key in ui) if (Object.prototype.hasOwnProperty.call(ui, key)) clean[key] = ui[key];
    clean.paused = false; clean.debug = false; clean.toastAlpha = 0; clean.duckGuide = 0; clean.muteBtn = false;
    clean.hint = false; clean.capture = true;
    try {
      this._shareState(true);
      this.render(sim, alpha, clean);
      var sy = clamp(Math.round(this.tpx), 0, this.ch), sh = clamp(Math.round(this.cfg.H * this.bs), 1, this.ch - sy);
      var k = Math.min(1, maxW / this.cw), tw = Math.max(1, Math.round(this.cw * k)), th = Math.max(1, Math.round(sh * k));
      var band = mkCanvas(this.cw, sh);
      band.getContext('2d').drawImage(this.canvas, 0, sy, this.cw, sh, 0, 0, this.cw, sh);
      var small = scaleImage(band, tw, th);
      out = small === band ? band : small;
      if (out.width !== tw || out.height !== th) { // scaleImage kept the band (no real downscale): exact size copy
        var o2 = mkCanvas(tw, th);
        hiCtx(o2).drawImage(band, 0, 0, tw, th);
        out = o2;
      }
      out.getContext('2d').getImageData(0, 0, 1, 1); // throws on a tainted canvas (file://)
    } catch (e) {
      out = null;
    } finally {
      this._shareState(false);
      this.render(sim, alpha, ui); // the frame as it was
    }
    return out;
  };

  Renderer.gradeCopy = gradeCopy; // test hooks
  Renderer.RC = RC;
  RDG.Renderer = Renderer;
  RDG.FX = FX;
})(typeof globalThis !== 'undefined' ? globalThis : this);
