/* Loads the images listed in window.ASSET_MANIFEST. Anything missing or failing to load is replaced by a simple
 * procedural placeholder (drawn from the same hitboxes the simulation uses), with a console warning — the game is
 * fully playable without any image files. The dust sprites (fx.dust) get no placeholder image: without them the
 * renderer draws its procedural dust. Never uses fetch() (works from file://) and never reads pixels back. */
(function (root) {
  'use strict';
  var RDG = (root.RDG = root.RDG || {});

  function mkCanvas(w, h) {
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Placeholders

  function roundRect(x, px, py, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    x.beginPath();
    x.moveTo(px + r, py);
    x.arcTo(px + w, py, px + w, py + h, r);
    x.arcTo(px + w, py + h, px, py + h, r);
    x.arcTo(px, py + h, px, py, r);
    x.arcTo(px, py, px + w, py, r);
    x.closePath();
  }

  function blobsFromBoxes(w, h, boxes, top, bottom, radius) {
    var c = mkCanvas(w, h), x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    x.fillStyle = g;
    for (var i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      roundRect(x, b[0] - 4, b[1] - 4, b[2] + 8, b[3] + 8, Math.min(b[2], b[3]) * radius);
      x.fill();
    }
    return c;
  }

  function dinoPlaceholder(D, boxes, kind) {
    var c = blobsFromBoxes(D.frameW, D.frameH, boxes, '#8a8074', '#5f574e', 0.45);
    var x = c.getContext('2d');
    // tail wedge from the tail tip to the body
    var body = null, head = null, i;
    for (i = 0; i < boxes.length; i++) {
      var b = boxes[i];
      if (!body || b[2] > body[2]) body = b;
      if (!head || b[0] + b[2] > head[0] + head[2]) head = b;
    }
    var tip = D.tailTipPx != null ? D.tailTipPx : Math.max(0, body[0] - 0.4 * D.standHeightPx);
    if (kind !== 'dead') {
      x.fillStyle = '#7d746a';
      x.beginPath();
      x.moveTo(tip, body[1] + body[3] * 0.35);
      x.lineTo(body[0] + 30, body[1] + 4);
      x.lineTo(body[0] + 30, body[1] + body[3]);
      x.closePath();
      x.fill();
    }
    // eye
    x.fillStyle = '#1d1a17';
    x.beginPath();
    x.arc(head[0] + head[2] * 0.62, head[1] + head[3] * 0.32, Math.max(3, head[3] * 0.08), 0, Math.PI * 2);
    x.fill();
    return c;
  }

  function cactusPlaceholder(v) {
    return blobsFromBoxes(v.w, v.h, v.hitboxes, '#6f7d4f', '#4d5a36', 0.5);
  }

  function pteroPlaceholder(P, f) {
    var c = blobsFromBoxes(P.frameW, P.frameH, f.hitboxes, '#8b7d6d', '#62574b', 0.5);
    return c;
  }

  function skyPlaceholder(kind) {
    var w = 1280, h = 540, c = mkCanvas(w, h), x = c.getContext('2d');
    var g = x.createLinearGradient(0, 0, 0, h * 0.8);
    if (kind === 'day') { g.addColorStop(0, '#c4ccd8'); g.addColorStop(1, '#ebe8e2'); }
    else if (kind === 'dusk') { g.addColorStop(0, '#5b6a8e'); g.addColorStop(0.65, '#d9a184'); g.addColorStop(1, '#f2c49a'); }
    else { g.addColorStop(0, '#060b1a'); g.addColorStop(1, '#1b2742'); }
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    if (kind === 'day') {
      var r = x.createRadialGradient(0, 0, 0, 0, 0, 420);
      r.addColorStop(0, 'rgba(255,252,240,0.95)');
      r.addColorStop(0.25, 'rgba(255,248,230,0.45)');
      r.addColorStop(1, 'rgba(255,248,230,0)');
      x.fillStyle = r;
      x.fillRect(0, 0, w, h);
    }
    if (kind === 'night') {
      var rng = RDG.rng.create(77);
      x.fillStyle = '#ffffff';
      for (var i = 0; i < 260; i++) {
        x.globalAlpha = 0.25 + RDG.rng.next(rng) * 0.6;
        var s = RDG.rng.next(rng) < 0.9 ? 1 : 2;
        x.fillRect(RDG.rng.next(rng) * w, RDG.rng.next(rng) * h * 0.78, s, s);
      }
      x.globalAlpha = 1;
    }
    return { img: c, w: w, h: h, horizonY: 0.8, placeholder: true };
  }

  function moonPlaceholder() {
    var s = 256, c = mkCanvas(s, s), x = c.getContext('2d');
    var g = x.createRadialGradient(s * 0.45, s * 0.42, s * 0.05, s / 2, s / 2, s * 0.36);
    g.addColorStop(0, '#fbfaf2');
    g.addColorStop(1, '#cfd0c8');
    x.fillStyle = g;
    x.beginPath();
    x.arc(s / 2, s / 2, s * 0.36, 0, Math.PI * 2);
    x.fill();
    return { img: c, w: s, h: s, placeholder: true };
  }

  function cloudPlaceholder(seed) {
    var w = 900, h = 300, c = mkCanvas(w, h), x = c.getContext('2d'), rng = RDG.rng.create(seed);
    for (var i = 0; i < 14; i++) {
      var cx = 150 + RDG.rng.next(rng) * 600, cy = 170 + (RDG.rng.next(rng) - 0.5) * 70, r = 50 + RDG.rng.next(rng) * 70;
      var g = x.createRadialGradient(cx, cy - r * 0.3, 0, cx, cy, r);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.7, 'rgba(244,242,238,0.75)');
      g.addColorStop(1, 'rgba(240,238,234,0)');
      x.fillStyle = g;
      x.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    return { img: c, w: w, h: h, placeholder: true };
  }

  function mountainsPlaceholder() {
    var w = 2048, h = 200, base = 190, peak = 20, c = mkCanvas(w, h), x = c.getContext('2d');
    var g = x.createLinearGradient(0, peak, 0, base);
    g.addColorStop(0, '#b9b3b0');
    g.addColorStop(1, '#cfc8c0');
    x.fillStyle = g;
    x.beginPath();
    x.moveTo(0, base);
    for (var px = 0; px <= w; px += 4) {
      var t = (px / w) * Math.PI * 2;
      var y = 0.5 + 0.28 * Math.sin(t * 3 + 1) + 0.14 * Math.sin(t * 7 + 2) + 0.08 * Math.sin(t * 13);
      y = Math.min(0.95, Math.max(0.12, y)); // flat mesa tops
      x.lineTo(px, peak + (1 - y) * (base - peak));
    }
    x.lineTo(w, base);
    x.lineTo(w, h);
    x.lineTo(0, h);
    x.closePath();
    x.fill();
    return { img: c, w: w, h: h, baselinePx: base, peakPx: peak, placeholder: true };
  }

  function groundPlaceholder() {
    var w = 2048, h = 280, c = mkCanvas(w, h), x = c.getContext('2d'), rng = RDG.rng.create(11);
    var g = x.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#d8cdbd');
    g.addColorStop(1, '#bda98f');
    x.fillStyle = g;
    x.fillRect(0, 0, w, h);
    for (var i = 0; i < 9000; i++) {
      var yy = Math.pow(RDG.rng.next(rng), 1.3) * h, s = 0.6 + (yy / h) * 2.6;
      var xx = RDG.rng.next(rng) * w;
      x.fillStyle = RDG.rng.next(rng) < 0.5 ? 'rgba(90,76,60,0.18)' : 'rgba(255,250,240,0.22)';
      x.fillRect(xx, yy, s, s * 0.6);
      if (xx < s) x.fillRect(xx + w, yy, s, s * 0.6); // keep seamless
    }
    return { img: c, w: w, h: h, placeholder: true };
  }

  function decorPlaceholder(kind, seed, blur) {
    var w = 200, h = 120, c = mkCanvas(w, h), x = c.getContext('2d'), rng = RDG.rng.create(seed);
    if (blur && 'filter' in x) x.filter = 'blur(5px)';
    if (kind === 'rock') {
      var g = x.createLinearGradient(0, 30, 0, h);
      g.addColorStop(0, '#b3aca3');
      g.addColorStop(1, '#6f675e');
      x.fillStyle = g;
      x.beginPath();
      x.ellipse(100, 92, 70 + RDG.rng.next(rng) * 20, 26 + RDG.rng.next(rng) * 14, 0, Math.PI, 0);
      x.lineTo(175, 110);
      x.lineTo(25, 110);
      x.closePath();
      x.fill();
    } else {
      x.strokeStyle = '#8f8160';
      x.lineWidth = 3;
      for (var i = 0; i < 26; i++) {
        var bx = 100 + (RDG.rng.next(rng) - 0.5) * 60;
        x.beginPath();
        x.moveTo(bx, 112);
        x.quadraticCurveTo(bx + (RDG.rng.next(rng) - 0.5) * 50, 70, bx + (RDG.rng.next(rng) - 0.5) * 110, 20 + RDG.rng.next(rng) * 50);
        x.stroke();
      }
    }
    return c;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Loader

  function isFin(v) { return typeof v === 'number' && isFinite(v); }

  // entry metadata the placeholder callbacks overwrite (restored when the real image arrives late)
  var META_KEYS = ['w', 'h', 'horizonY', 'baselinePx', 'peakPx', 'sun'];

  /** Request order (lower first; see loadPriority): what the first frames show before what can wait. */
  var LOAD_ORDER = [
    /^sky\.day$|^terrain\.(ground|mountains)$/, // the scene itself
    /^dino\.(idle|run)\[/, // the player
    /^dino\./, // jump / duck / crash poses (the tap that starts a run also jumps)
    /^(cactus|ptero)/, // the first obstacles (no obstacles for CLEAR_TIME after the start)
    /^terrain\.decor\[\d+\]$/, // pebbles and tufts near the running line
    /^sky\.clouds|\.blur$/, // clouds, blurred foreground decor
    /^fx\./, // running dust sprites: needed from the first footfall of a run, never on the start screen
    /^sky\./ // dusk / night / moon: not seen before 700 points
  ];
  function loadPriority(label) {
    for (var i = 0; i < LOAD_ORDER.length; i++) if (LOAD_ORDER[i].test(label)) return i;
    return LOAD_ORDER.length;
  }

  /**
   * load(manifest, metrics, done, onLate): returns the asset table immediately (placeholders first) and calls
   * done(assets) once every requested image has loaded or failed, or on the loader timeout: images still pending
   * then get placeholders (listed in A.missing as "<label> (slow)"). The timeout is LOAD_TIMEOUT_MS without any image
   * arriving (a slow but moving download keeps waiting), and LOAD_TIMEOUT_MAX_MS after the start at the latest. A
   * slow image that arrives later replaces its placeholder in the same table and onLate(assets) is called. Images are
   * requested synchronously, in LOAD_ORDER (the scene and the dino first, the night sky last), so the page's load
   * event waits for them (headless screenshots render the final frame). A.loaded / A.total = progress.
   */
  function load(manifest, metrics, done, onLate) {
    var man = manifest || {};
    var S = RDG.Sim;
    var cfg = RDG.config || {};
    var timeoutMs = cfg.LOAD_TIMEOUT_MS > 0 ? cfg.LOAD_TIMEOUT_MS : 5000;
    var capMs = Math.max(timeoutMs, cfg.LOAD_TIMEOUT_MAX_MS > 0 ? cfg.LOAD_TIMEOUT_MAX_MS : 15000);
    var t0 = Date.now(), queue = [];
    var src = metrics.source;
    var D = src.dino === 'manifest' ? man.dino : S.DEFAULT_SPRITES.dino;
    var CA = src.cactus === 'manifest' ? man.cactus : S.DEFAULT_SPRITES.cactus;
    var P = src.ptero === 'manifest' ? man.ptero : S.DEFAULT_SPRITES.ptero;
    var sky = man.sky || {};
    var ter = man.terrain || {};
    var pending = 0, finished = false, timer = 0, slots = [];
    var A = { dino: {}, cactus: { small: [], large: [] }, ptero: [], sky: {}, terrain: { decor: [] }, missing: [], loaded: 0, total: 0 };

    function finish() {
      if (finished || pending > 0) return;
      finished = true;
      if (timer) { clearTimeout(timer); timer = 0; }
      if (A.missing.length) console.warn('[RDG] using placeholders for ' + A.missing.length + ' image(s): ' + A.missing.slice(0, 8).join(', ') + (A.missing.length > 8 ? ', ...' : ''));
      if (done) done(A);
    }

    /** LOAD_TIMEOUT_MS passed with requests still pending: placeholders for those, then start the game. */
    function expire() {
      timer = 0;
      if (finished) return;
      var i, j, s, late = [];
      for (i = 0; i < slots.length; i++) if (!slots[i].settled) late.push(slots[i]);
      // snapshot every entry's metadata before any placeholder callback overwrites it (entries can share a holder)
      for (i = 0; i < late.length; i++) {
        s = late[i];
        if (Array.isArray(s.holder)) continue;
        s.meta = {};
        for (j = 0; j < META_KEYS.length; j++) if (META_KEYS[j] in s.holder) s.meta[META_KEYS[j]] = s.holder[META_KEYS[j]];
      }
      for (i = 0; i < late.length; i++) {
        s = late[i];
        s.holder[s.key] = s.makePlaceholder();
        A.missing.push(s.label + ' (slow)');
      }
      console.warn('[RDG] ' + late.length + ' image(s) still loading after ' + (Date.now() - t0) + ' ms — placeholders until they arrive');
      pending = 0;
      finish();
    }

    /** (Re)start the loader timeout: LOAD_TIMEOUT_MS from now (an image just arrived), capped at t0 + capMs. */
    function arm() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(expire, Math.max(0, Math.min(timeoutMs, capMs - (Date.now() - t0))));
    }

    /** A slow image arrived after the timeout: restore its entry's metadata and swap it in. */
    function arriveLate(s, img) {
      if (!(img.naturalWidth > 0)) return; // failed late: the placeholder stays
      if (s.meta) for (var k in s.meta) s.holder[k] = s.meta[k];
      s.holder[s.key] = img;
      A.loaded++;
      var i = A.missing.indexOf(s.label + ' (slow)');
      if (i >= 0) A.missing.splice(i, 1);
      if (onLate) onLate(A);
    }

    /** Request `path`; `holder[key]` starts as the placeholder and is swapped for the image on success. */
    function request(path, holder, key, makePlaceholder, label) {
      if (typeof path !== 'string' || !path) {
        holder[key] = makePlaceholder();
        A.missing.push(label);
        return;
      }
      holder[key] = null;
      pending++;
      A.total++;
      var slot = { holder: holder, key: key, makePlaceholder: makePlaceholder, label: label, settled: false, meta: null };
      slots.push(slot);
      var img = new Image();
      img.decoding = 'async';
      img.onload = function () {
        if (slot.settled) return;
        slot.settled = true;
        if (finished) { arriveLate(slot, img); return; }
        if (img.naturalWidth > 0) { holder[key] = img; A.loaded++; }
        else { holder[key] = makePlaceholder(); A.missing.push(label); }
        if (pending > 0) pending--;
        finish();
        if (!finished) arm(); // progress: keep waiting (up to the cap)
      };
      img.onerror = function () {
        if (slot.settled) return;
        slot.settled = true;
        console.warn('[RDG] failed to load ' + path + ' — using a placeholder');
        if (finished) return; // timed out earlier: its placeholder stays
        holder[key] = makePlaceholder();
        A.missing.push(label);
        if (pending > 0) pending--;
        finish();
      };
      queue.push({ img: img, path: path, prio: loadPriority(label) }); // requested below, in LOAD_ORDER
    }

    // dino
    var kinds = ['idle', 'run', 'duck', 'jump', 'dead'];
    kinds.forEach(function (k) {
      var list = D.frames[k];
      var fallbackFrom = null;
      if (!Array.isArray(list) || !list.length || !list[0] || !Array.isArray(list[0].hitboxes)) {
        fallbackFrom = k === 'idle' || k === 'jump' ? 'run' : k === 'dead' ? 'idle' : 'run';
        list = D.frames[fallbackFrom] && D.frames[fallbackFrom].length ? D.frames[fallbackFrom] : D.frames.run;
        if (k === 'dead' && (!D.frames.idle || !D.frames.idle.length)) list = D.frames.run.slice(0, 1);
        if (k !== 'duck') list = list.slice(0, 1);
      }
      A.dino[k] = [];
      A.dino[k + 'Squash'] = k === 'duck' && !!fallbackFrom;
      list.forEach(function (f, i) {
        request(src.dino === 'manifest' ? f.src : null, A.dino[k], i, function () { return dinoPlaceholder(D, f.hitboxes, k); }, 'dino.' + k + '[' + i + ']');
      });
    });
    // cacti
    ['small', 'large'].forEach(function (cls) {
      CA[cls].forEach(function (v, i) {
        request(src.cactus === 'manifest' ? v.src : null, A.cactus[cls], i, function () { return cactusPlaceholder(v); }, 'cactus.' + cls + '[' + i + ']');
      });
    });
    // ptero
    P.frames.forEach(function (f, i) {
      request(src.ptero === 'manifest' ? f.src : null, A.ptero, i, function () { return pteroPlaceholder(P, f); }, 'ptero[' + i + ']');
    });
    // sky
    ['day', 'dusk', 'night'].forEach(function (k) {
      var e = sky[k];
      var meta = e && e.w > 0 && e.h > 0 ? { w: e.w, h: e.h, horizonY: e.horizonY > 0 && e.horizonY <= 1 ? e.horizonY : 0.8 } : null;
      A.sky[k] = meta ? { img: null, w: meta.w, h: meta.h, horizonY: meta.horizonY } : null;
      if (meta) {
        // optional sun block (fractions of the image + glow colour); left undefined when absent or malformed
        var sun = e.sun, g = sun && sun.glow;
        if (sun && isFin(sun.x) && isFin(sun.y) && isFin(sun.r) && Array.isArray(g) && g.length >= 3 && isFin(g[0]) && isFin(g[1]) && isFin(g[2])) {
          A.sky[k].sun = { x: sun.x, y: sun.y, r: sun.r, glow: g.slice(0, 3) };
        }
        request(e.src, A.sky[k], 'img', function () {
          var p = skyPlaceholder(k), s = A.sky[k];
          s.w = p.w; s.h = p.h; s.horizonY = p.horizonY; delete s.sun; // the sun block describes the real image only
          return p.img;
        }, 'sky.' + k);
      } else {
        A.sky[k] = skyPlaceholder(k);
        A.missing.push('sky.' + k);
      }
    });
    if (sky.moon && sky.moon.w > 0) {
      A.sky.moon = { img: null, w: sky.moon.w, h: sky.moon.h };
      request(sky.moon.src, A.sky.moon, 'img', function () { var p = moonPlaceholder(); A.sky.moon.w = p.w; A.sky.moon.h = p.h; return p.img; }, 'sky.moon');
    } else { A.sky.moon = moonPlaceholder(); A.missing.push('sky.moon'); }
    A.sky.clouds = [];
    var clouds = Array.isArray(sky.clouds) && sky.clouds.length ? sky.clouds : null;
    if (clouds) {
      clouds.forEach(function (cl, i) {
        var e = { img: null, w: cl.w || 900, h: cl.h || 300 };
        A.sky.clouds.push(e);
        request(cl.src, e, 'img', function () { var p = cloudPlaceholder(31 + i); e.w = p.w; e.h = p.h; return p.img; }, 'sky.clouds[' + i + ']');
      });
    } else {
      for (var ci = 0; ci < 4; ci++) A.sky.clouds.push(cloudPlaceholder(31 + ci));
      A.missing.push('sky.clouds');
    }
    // terrain
    var mt = ter.mountains;
    if (mt && mt.w > 0 && mt.h > 0) {
      A.terrain.mountains = { img: null, w: mt.w, h: mt.h, baselinePx: mt.baselinePx > 0 ? mt.baselinePx : mt.h, peakPx: mt.peakPx >= 0 ? mt.peakPx : 0 };
      request(mt.src, A.terrain.mountains, 'img', function () {
        var p = mountainsPlaceholder(); var m = A.terrain.mountains;
        m.w = p.w; m.h = p.h; m.baselinePx = p.baselinePx; m.peakPx = p.peakPx; return p.img;
      }, 'terrain.mountains');
    } else { A.terrain.mountains = mountainsPlaceholder(); A.missing.push('terrain.mountains'); }
    var gr = ter.ground;
    if (gr && gr.w > 0 && gr.h > 0) {
      A.terrain.ground = { img: null, w: gr.w, h: gr.h };
      request(gr.src, A.terrain.ground, 'img', function () { var p = groundPlaceholder(); A.terrain.ground.w = p.w; A.terrain.ground.h = p.h; return p.img; }, 'terrain.ground');
    } else { A.terrain.ground = groundPlaceholder(); A.missing.push('terrain.ground'); }
    var decor = Array.isArray(ter.decor) && ter.decor.length ? ter.decor : null;
    if (decor) {
      decor.forEach(function (d, i) {
        var kind = d.kind === 'grass' ? 'grass' : 'rock';
        // fg: false = never used for the large foreground layer (e.g. wispy tufts); default allowed
        var e = { img: null, blur: null, w: d.w || 200, h: d.h || 120, kind: kind, fg: d.fg !== false };
        A.terrain.decor.push(e);
        request(d.src, e, 'img', function () { e.w = 200; e.h = 120; return decorPlaceholder(kind, 50 + i, false); }, 'terrain.decor[' + i + ']');
        if (d.srcBlur) request(d.srcBlur, e, 'blur', function () { return decorPlaceholder(kind, 50 + i, true); }, 'terrain.decor[' + i + '].blur');
      });
    } else {
      for (var di = 0; di < 8; di++) {
        var kd = di < 4 ? 'rock' : 'grass';
        A.terrain.decor.push({ img: decorPlaceholder(kd, 50 + di, false), blur: decorPlaceholder(kd, 50 + di, true), w: 200, h: 120, kind: kd, fg: true });
      }
      A.missing.push('terrain.decor');
    }
    // dust sprites (fx.dust[]): A.fx.dust[i] = { img, w, h, kind } per manifest index (null for a malformed entry).
    // No placeholder image: a missing / failed / slow sprite stays img: null, and the renderer draws the procedural
    // dust instead when no puff sprite is available (a slow one is swapped in when it arrives, as usual).
    A.fx = { dust: [] };
    var fxd = man.fx && Array.isArray(man.fx.dust) ? man.fx.dust : [];
    fxd.forEach(function (d, i) {
      var known = d && (d.kind === 'puff' || d.kind === 'spray' || d.kind === 'plume' || d.kind === 'burst');
      if (!known || typeof d.src !== 'string' || !(d.w > 0) || !(d.h > 0)) { A.fx.dust.push(null); return; }
      var e = { img: null, w: d.w, h: d.h, kind: d.kind };
      A.fx.dust.push(e);
      request(d.src, e, 'img', function () { return null; }, 'fx.dust[' + i + ']');
    });
    // issue the requests in priority order (a stable sort keeps the manifest order within a group)
    queue.sort(function (a, b) { return a.prio - b.prio; });
    for (var qi = 0; qi < queue.length; qi++) queue[qi].img.src = queue[qi].path;
    queue = null;
    if (pending === 0) finish();
    else arm();
    return A;
  }

  RDG.Assets = { load: load, mkCanvas: mkCanvas };
})(typeof globalThis !== 'undefined' ? globalThis : this);
