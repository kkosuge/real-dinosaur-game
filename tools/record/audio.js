#!/usr/bin/env node
/* Render the video's soundtrack: the game's own synthesized sound effects, placed at the recorded sim events.
 *
 *   node tools/record/audio.js [--work DIR]       # reads DIR/capture.json, writes DIR/audio.wav + DIR/audio.json
 *
 * The sounds are rendered offline in headless Chrome by src/audio.js itself (RDG.Audio: the same oscillator / noise
 * recipes, master gain and compressor), on an OfflineAudioContext whose clock the recorder sets to each event's
 * time: RDG.Audio.create() gets a proxy of the offline context as its AudioContext (currentTime = the event's
 * time, state = 'running'), so its jump() / milestone() / crash() / land() schedule exactly what the game would.
 * Events map to sounds as in main.js handleEvents(): JUMP -> jump, LAND -> land, MILESTONE -> milestone,
 * CRASH -> crash (START from the bot's auto-start plays nothing; no music, nothing else).
 * An event of the tick shown on video frame v sounds at v / fps seconds (the page plays it in the same animation
 * frame that first shows that tick). Output: 48 kHz stereo 32-bit float WAV, exactly as long as the video. */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cdp = require('./cdp');

function argv(name, def) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  var v = process.argv[i + 1];
  return v == null || v.slice(0, 2) === '--' ? true : v;
}

var SOUND = { JUMP: 'jump', LAND: 'land', MILESTONE: 'milestone', CRASH: 'crash' }; // main.js handleEvents()
var SAMPLE_RATE = 48000;

/* in the page: render spec.events ({ t, fn }) with RDG.Audio on an OfflineAudioContext; returns base64 float32 L / R */
var PAGE_RENDER = async function (spec) {
  var off = new OfflineAudioContext({ numberOfChannels: 2, length: spec.length, sampleRate: spec.sampleRate });
  var now = 0;
  var ctx = new Proxy(off, {
    get: function (target, prop) {
      if (prop === 'currentTime') return now; // the recorder's clock: the event's time
      if (prop === 'state') return 'running';
      var v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    }
  });
  var savedAC = window.AudioContext, savedWAC = window.webkitAudioContext;
  window.AudioContext = function () { return ctx; };
  window.webkitAudioContext = undefined;
  var a;
  try {
    a = RDG.Audio.create(__rdg.config);
    if (a.isMuted()) a.toggleMute(); // (a fresh profile is never muted; just in case)
    a.unlock(); // creates the "AudioContext": master gain -> compressor -> destination, the noise buffer
  } finally {
    window.AudioContext = savedAC; window.webkitAudioContext = savedWAC;
  }
  spec.events.forEach(function (e) { now = e.t; a[e.fn](); });
  var buf = await off.startRendering();
  function b64(f32) {
    var u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength), s = '';
    for (var i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }
  return { sampleRate: buf.sampleRate, length: buf.length, channels: buf.numberOfChannels, L: b64(buf.getChannelData(0)), R: b64(buf.getChannelData(1)) };
};

function writeWavF32(file, sampleRate, chans) {
  var n = chans[0].length, nc = chans.length, bytes = n * nc * 4;
  var b = Buffer.alloc(44 + bytes);
  b.write('RIFF', 0); b.writeUInt32LE(36 + bytes, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(nc, 22);
  b.writeUInt32LE(sampleRate, 24); b.writeUInt32LE(sampleRate * nc * 4, 28); b.writeUInt16LE(nc * 4, 32); b.writeUInt16LE(32, 34);
  b.write('data', 36); b.writeUInt32LE(bytes, 40);
  var o = 44;
  for (var i = 0; i < n; i++) for (var c = 0; c < nc; c++) { b.writeFloatLE(chans[c][i], o); o += 4; }
  fs.writeFileSync(file, b);
}

async function main() {
  var work = path.resolve(argv('work', process.env.RDG_VIDEO_WORK || path.join(os.tmpdir(), 'rdg-video')));
  var cap = JSON.parse(fs.readFileSync(path.join(work, 'capture.json'), 'utf8'));
  var tl = cap.timeline, fps = tl.fps;
  if (!cap.intro || !cap.main) throw new Error('capture.json lacks a segment: run capture.js first');
  if (cap.intro.frames.length !== tl.intro.frames || cap.main.frames.length !== tl.main.frames) throw new Error('capture.json is a partial capture (--limit)');

  // the sounding events on the video timeline; an intro event inside the crossfade would be cut off: reported
  var events = [], notes = [];
  cap.intro.events.concat(cap.main.events).forEach(function (e) {
    if (!SOUND[e.ev]) return;
    if (e.video >= tl.mainOffset && cap.intro.events.indexOf(e) >= 0) notes.push('intro ' + e.ev + ' on video frame ' + e.video + ' is inside the crossfade');
    events.push({ t: e.video / fps, fn: SOUND[e.ev], ev: e.ev, video: e.video, seg: cap.intro.events.indexOf(e) >= 0 ? 'intro' : 'main', frame: e.frame, tick: e.tick });
  });
  events.sort(function (a, b) { return a.t - b.t; });
  var length = Math.round((tl.totalFrames / fps) * SAMPLE_RATE);

  var res = await cdp.withSession({ width: 640, height: 360, workDir: work }, async function (s) {
    await s.goto(s.url('index.html?seed=1&freeze=1&lang=' + tl.lang), 'window.__rdg && window.RDG && RDG.Audio && document.readyState === "complete"', 60000);
    var r = await s.eval('(' + PAGE_RENDER.toString() + ')(' + JSON.stringify({ sampleRate: SAMPLE_RATE, length: length, events: events.map(function (e) { return { t: e.t, fn: e.fn }; }) }) + ')');
    r.logs = s.logs.slice();
    return r;
  });
  if (res.sampleRate !== SAMPLE_RATE || res.length !== length) throw new Error('offline render: ' + res.sampleRate + ' Hz, ' + res.length + ' samples');
  var dec = function (b64) { var buf = Buffer.from(b64, 'base64'); return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4); };
  var L = dec(res.L), R = dec(res.R);
  var peak = 0;
  for (var i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  var wav = path.join(work, 'audio.wav');
  writeWavF32(wav, SAMPLE_RATE, [L, R]);
  var info = {
    sampleRate: SAMPLE_RATE, samples: length, seconds: length / SAMPLE_RATE, peak: peak, peakDb: 20 * Math.log10(peak || 1e-9),
    events: events, notes: notes, logs: (res.logs || []).filter(function (l) { return /^(error|exception|warning)/.test(l); })
  };
  fs.writeFileSync(path.join(work, 'audio.json'), JSON.stringify(info, null, 1));
  console.log('audio: ' + events.length + ' sounds (' + Object.keys(SOUND).map(function (k) { return k.toLowerCase() + ' ' + events.filter(function (e) { return e.ev === k; }).length; }).join(', ') +
    '), ' + info.seconds.toFixed(3) + ' s, peak ' + info.peakDb.toFixed(1) + ' dBFS -> ' + wav);
  notes.concat(info.logs).forEach(function (n) { console.log('  ! ' + n); });
  if (peak >= 1) { console.log('  ! clipping'); process.exitCode = 1; }
}

if (require.main === module) main().catch(function (e) { console.error(e && e.stack || e); process.exitCode = 1; });
