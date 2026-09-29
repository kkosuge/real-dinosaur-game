/* WebAudio-synthesised sound effects (no audio files). The AudioContext is created lazily on the first user
 * gesture. `M` toggles mute (persisted in localStorage). */
(function (root) {
  'use strict';
  var RDG = (root.RDG = root.RDG || {});

  function store(key, val) { try { root.localStorage.setItem(key, val); } catch (e) { /* storage unavailable */ } }
  function read(key) { try { return root.localStorage.getItem(key); } catch (e) { return null; } }

  function create(cfg) {
    var ctx = null, master = null, noiseBuf = null;
    var muted = read(cfg.STORAGE_MUTE) === '1';
    var resumeAt = -1e9; // clock() of the last resume() request

    function clock() { return root.performance && root.performance.now ? root.performance.now() : Date.now(); }

    /** Create / resume the AudioContext. Call from activation-triggering events (keydown, pointerdown, pointerup,
     * touchend). existingOnly: only resume a context that already exists (visibilitychange / pageshow, where there
     * is no user activation to create one). */
    function unlock(existingOnly) {
      if (!ctx) {
        if (existingOnly) return;
        var AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return;
        try { ctx = new AC(); } catch (e) { ctx = null; return; }
        master = ctx.createGain();
        master.gain.value = muted ? 0 : 0.55;
        var comp = ctx.createDynamicsCompressor();
        master.connect(comp);
        comp.connect(ctx.destination);
        noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.6), ctx.sampleRate);
        var d = noiseBuf.getChannelData(0), s = 12345;
        for (var i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) >>> 0; d[i] = (s / 4294967296) * 2 - 1; }
      }
      // any non-running state: 'suspended', and WebKit's 'interrupted' (calls, Siri, backgrounding on iOS)
      if (ctx.state !== 'running' && ctx.state !== 'closed' && ctx.resume) {
        resumeAt = clock();
        try { var pr = ctx.resume(); if (pr && pr.catch) pr.catch(function () {}); } catch (e) { /* ignore */ }
      }
    }

    /** Sounds are scheduled only on a running clock, or during the short window right after a resume() request (so
     * the first tap's jump sound survives); nothing piles up on a context that stays stalled. */
    function ready() {
      return !!(ctx && master && !muted) && (ctx.state === 'running' || (ctx.state !== 'closed' && clock() - resumeAt < 400));
    }

    function tone(type, f0, f1, t0, dur, vol) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(f0, t0);
      if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + dur + 0.02);
    }

    function noise(t0, dur, vol, freq, q) {
      var n = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      n.buffer = noiseBuf;
      f.type = 'lowpass'; f.frequency.setValueAtTime(freq, t0); f.Q.value = q || 0.7;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      n.connect(f); f.connect(g); g.connect(master);
      n.start(t0); n.stop(t0 + dur + 0.02);
    }

    return {
      unlock: unlock,
      isMuted: function () { return muted; },
      toggleMute: function () {
        muted = !muted;
        store(cfg.STORAGE_MUTE, muted ? '1' : '0');
        if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : 0.55, ctx.currentTime, 0.02);
        return muted;
      },
      jump: function () {
        if (!ready()) return;
        var t = ctx.currentTime;
        tone('square', 520, 880, t, 0.075, 0.07);
        noise(t, 0.09, 0.05, 900);
      },
      milestone: function () {
        if (!ready()) return;
        var t = ctx.currentTime;
        tone('square', 1046, 1046, t, 0.09, 0.06);
        tone('square', 1318, 1318, t + 0.11, 0.12, 0.06);
      },
      crash: function () {
        if (!ready()) return;
        var t = ctx.currentTime;
        tone('sine', 140, 38, t, 0.38, 0.5);
        tone('triangle', 90, 45, t, 0.25, 0.25);
        noise(t, 0.35, 0.35, 420, 0.9);
      },
      land: function () {
        if (!ready()) return;
        noise(ctx.currentTime, 0.08, 0.06, 260);
      },
      button: function () {
        if (!ready()) return;
        tone('square', 660, 660, ctx.currentTime, 0.05, 0.05);
      }
    };
  }

  RDG.Audio = { create: create };
})(typeof globalThis !== 'undefined' ? globalThis : this);
