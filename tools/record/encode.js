#!/usr/bin/env node
/* Encode the captured frames + the rendered soundtrack into the X-ready MP4, and write the poster JPEG.
 *
 *   FFMPEG=/path/to/ffmpeg node tools/record/encode.js [--work DIR] [--out docs/video/real-dinosaur-game-x.mp4]
 *        [--poster docs/video/poster.jpg] [--poster-frame N (main frame)] [--crf 18]
 *
 * Needs ffmpeg with libx264 (and its native AAC encoder); FFMPEG defaults to `ffmpeg` on PATH.
 * Video: intro PNGs, then a linear crossfade (xfade) of xfadeFrames into the main PNGs; 1920x1080, 60 fps constant,
 * RGB -> BT.709 limited-range yuv420p, H.264 High@4.2, CRF 18 (VBV-capped at 20 Mbit/s, well under X's 25),
 * 2 s GOP, tagged BT.709. Audio: DIR/audio.wav, raised evenly so its peak is --audio-peak dBFS (default -1) -> AAC-LC 48 kHz stereo 160 kbit/s (AudioToolbox CBR on macOS). +faststart (moov first) for streaming.
 * Afterwards the file is probed and checked against that spec (duration, frame count, codecs, size < 60 MB). */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');
var lib = require('./lib');

function argv(name, def) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  var v = process.argv[i + 1];
  return v == null || v.slice(0, 2) === '--' ? true : v;
}

var FFMPEG = process.env.FFMPEG || 'ffmpeg';

function run(args, opts) {
  var r = cp.spawnSync(FFMPEG, args, Object.assign({ encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opts || {}));
  if (r.error) throw new Error('cannot run ffmpeg (' + FFMPEG + '): ' + r.error.message + ' - set FFMPEG=/path/to/ffmpeg');
  return r;
}

/** `ffmpeg -i file` summary (no ffprobe needed) + an exact decoded frame count. */
function probe(file) {
  var txt = run(['-hide_banner', '-i', file]).stderr;
  var o = { text: txt };
  var m = /Duration: (\d+):(\d+):([\d.]+), start: ([-\d.]+), bitrate: (\d+) kb\/s/.exec(txt);
  if (m) { o.duration = +m[1] * 3600 + +m[2] * 60 + +m[3]; o.start = +m[4]; o.kbps = +m[5]; }
  var v = /Stream #0:\d+[^:]*: Video: (\w+) \(([^)]+)\)[^,]*, (\w+)\(([^)]*)\), (\d+)x(\d+)[^,]*, (\d+) kb\/s, ([\d.]+) fps/.exec(txt);
  if (v) o.video = { codec: v[1], profile: v[2], pix: v[3], color: v[4], w: +v[5], h: +v[6], kbps: +v[7], fps: +v[8] };
  var a = /Stream #0:\d+[^:]*: Audio: (\w+) \(([^)]+)\)[^,]*, (\d+) Hz, (\w+), \w+, (\d+) kb\/s/.exec(txt);
  if (a) o.audio = { codec: a[1], profile: a[2], hz: +a[3], layout: a[4], kbps: +a[5] };
  var cnt = run(['-hide_banner', '-i', file, '-map', '0:v:0', '-c', 'copy', '-f', 'null', '-']).stderr;
  var fm = cnt.match(/frame=\s*(\d+)/g);
  if (fm) o.frames = +fm[fm.length - 1].replace(/\D/g, '');
  return o;
}

function main() {
  var work = path.resolve(argv('work', process.env.RDG_VIDEO_WORK || path.join(os.tmpdir(), 'rdg-video')));
  var cap = JSON.parse(fs.readFileSync(path.join(work, 'capture.json'), 'utf8'));
  var tl = cap.timeline, fps = tl.fps;
  var out = path.resolve(argv('out', path.join(lib.ROOT, 'docs', 'video', 'real-dinosaur-game-x.mp4')));
  var poster = path.resolve(argv('poster', path.join(lib.ROOT, 'docs', 'video', 'poster.jpg')));
  var posterFrame = Number(argv('poster-frame', tl.main.posterFrame));
  var crf = String(argv('crf', 18));
  var introDir = path.join(work, 'frames', 'intro'), mainDir = path.join(work, 'frames', 'main'), wav = path.join(work, 'audio.wav');
  [introDir, mainDir, wav].forEach(function (p) { if (!fs.existsSync(p)) throw new Error('missing ' + p + ' (run capture.js and audio.js first)'); });
  var nI = fs.readdirSync(introDir).filter(function (f) { return /\.png$/.test(f); }).length;
  var nM = fs.readdirSync(mainDir).filter(function (f) { return /\.png$/.test(f); }).length;
  if (nI !== tl.intro.frames || nM !== tl.main.frames) throw new Error('frames on disk: intro ' + nI + ', main ' + nM + '; the timeline wants ' + tl.intro.frames + ' + ' + tl.main.frames);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.mkdirSync(path.dirname(poster), { recursive: true });

  var xfade = 'xfade=transition=fade:duration=' + (tl.xfadeFrames / fps).toFixed(6) + ':offset=' + (tl.mainOffset / fps).toFixed(6);
  var filter = '[0:v][1:v]' + xfade + ',scale=out_color_matrix=bt709:out_range=tv:flags=lanczos+accurate_rnd+full_chroma_int,format=yuv420p,' +
    'setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[v]';
  // AAC-LC: macOS AudioToolbox in true CBR when this ffmpeg has it (better quality; a mostly silent track stays at
  // the nominal 160 kbit/s), else ffmpeg's native encoder
  // the game's own mix peaks around -8 dBFS (the crash) and the jumps sit near -27 dBFS: far too quiet for a social
  // clip. Raise the whole track evenly so its peak lands on --audio-peak dBFS (default -1); the SFX keep their balance.
  var audioInfo = JSON.parse(fs.readFileSync(path.join(work, 'audio.json'), 'utf8'));
  var gainDb = Math.max(0, Number(argv('audio-peak', -1)) - audioInfo.peakDb);
  var audioFilter = 'volume=' + gainDb.toFixed(2) + 'dB,alimiter=limit=0.891:attack=1:release=50:level=false';
  var hasAt = /\baac_at\b/.test(run(['-hide_banner', '-encoders']).stdout || '');
  var audioArgs = hasAt ? ['-c:a', 'aac_at', '-aac_at_mode', 'cbr', '-profile:a', '0', '-b:a', '160k'] : ['-c:a', 'aac', '-profile:a', 'aac_low', '-b:a', '160k'];
  var args = [
    '-hide_banner', '-y',
    '-framerate', String(fps), '-i', path.join(introDir, '%06d.png'),
    '-framerate', String(fps), '-i', path.join(mainDir, '%06d.png'),
    '-i', wav,
    '-filter_complex', filter,
    '-map', '[v]', '-map', '2:a:0',
    '-c:v', 'libx264', '-preset', 'slow', '-profile:v', 'high', '-level:v', '4.2', '-crf', crf,
    '-maxrate', '20M', '-bufsize', '40M', '-g', String(2 * fps), '-bf', '2', '-pix_fmt', 'yuv420p', '-r', String(fps), '-fps_mode', 'cfr',
    '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
  ].concat(['-af', audioFilter], audioArgs, [
    '-ar', '48000', '-ac', '2',
    '-frames:v', String(tl.totalFrames), '-t', (tl.totalFrames / fps).toFixed(6),
    '-map_metadata', '-1', '-metadata', 'title=Real Dinosaur Game', '-movflags', '+faststart',
    out
  ]);
  console.log('encoding ' + tl.totalFrames + ' frames (' + (tl.totalFrames / fps).toFixed(3) + ' s, audio ' + (hasAt ? 'aac_at CBR' : 'aac') +
    ' +' + gainDb.toFixed(1) + ' dB) -> ' + out);
  var t0 = Date.now();
  var r = run(args, { stdio: ['ignore', 'ignore', 'pipe'] });
  if (r.status !== 0) { console.error(r.stderr.split('\n').slice(-30).join('\n')); throw new Error('ffmpeg failed'); }
  console.log('  done in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

  // poster: a main-segment frame, straight from its lossless PNG
  var pf = path.join(mainDir, String(posterFrame).padStart(6, '0') + '.png');
  var pr = run(['-hide_banner', '-y', '-i', pf, '-frames:v', '1', '-c:v', 'mjpeg', '-q:v', '2', '-pix_fmt', 'yuvj444p', poster]);
  if (pr.status !== 0) throw new Error('poster failed: ' + pr.stderr);
  console.log('poster: main frame ' + posterFrame + ' (video ' + (tl.mainOffset + posterFrame) + ', ' + ((tl.mainOffset + posterFrame) / fps).toFixed(2) + ' s) -> ' + poster);

  // check the result against the X spec
  var p = probe(out), size = fs.statSync(out).size, problems = [];
  var want = tl.totalFrames / fps;
  if (!p.video || p.video.codec !== 'h264' || p.video.profile !== 'High' || p.video.pix !== 'yuv420p' || p.video.w !== 1920 || p.video.h !== 1080 || p.video.fps !== fps) problems.push('video stream: ' + JSON.stringify(p.video));
  if (!p.audio || p.audio.codec !== 'aac' || p.audio.profile !== 'LC' || p.audio.hz !== 48000 || p.audio.layout !== 'stereo') problems.push('audio stream: ' + JSON.stringify(p.audio));
  if (p.frames !== tl.totalFrames) problems.push('frames ' + p.frames + ' != ' + tl.totalFrames);
  if (!(Math.abs(p.duration - want) < 0.05)) problems.push('duration ' + p.duration + ' != ' + want);
  if (!(p.duration >= 18 && p.duration <= 22)) problems.push('duration outside 18-22 s');
  if (size >= 60e6) problems.push('size ' + size);
  if (!(p.kbps < 25000)) problems.push('bitrate ' + p.kbps + ' kb/s');
  var head = Buffer.alloc(64);
  var fd = fs.openSync(out, 'r'); fs.readSync(fd, head, 0, 64, 0); fs.closeSync(fd);
  var faststart = head.indexOf('moov') >= 0 || (function () { var b = fs.readFileSync(out); return b.indexOf('moov') < b.indexOf('mdat'); })();
  if (!faststart) problems.push('moov atom is not before mdat');
  console.log('probe: ' + JSON.stringify({ duration: p.duration, kbps: p.kbps, frames: p.frames, video: p.video, audio: p.audio, sizeMB: +(size / 1e6).toFixed(2), faststart: faststart }));
  problems.forEach(function (x) { console.log('  ! ' + x); });
  if (problems.length) process.exitCode = 1;
  return p;
}

if (require.main === module) {
  try { main(); } catch (e) { console.error(e && e.stack || e); process.exitCode = 1; }
}

module.exports = { probe: probe };
