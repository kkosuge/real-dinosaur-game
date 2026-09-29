#!/usr/bin/env node
/* Record the X gameplay video end to end: capture.js (frames) -> audio.js (soundtrack) -> encode.js (MP4 + poster).
 *
 *   FFMPEG=/path/to/ffmpeg node tools/record/record.js [--work DIR] [--candidate N] [--hold MS] [--poster-frame N]
 *
 * Plays tools/record/plan.json (made by plan.js; check it in Chrome with verify_plan.js). When the main segment does
 * not reproduce the plan in Chrome (capture.js exits non-zero), the next planned candidate is tried, unless
 * --candidate pins one. Deliverables: docs/video/real-dinosaur-game-x.mp4 and docs/video/poster.jpg; the frames and
 * the WAV stay in the work dir (default $RDG_VIDEO_WORK or <tmp>/rdg-video, ~2 GB of PNGs). */
'use strict';

var fs = require('fs');
var os = require('os');
var path = require('path');
var cp = require('child_process');

function argv(name, def) {
  var i = process.argv.indexOf('--' + name);
  if (i < 0) return def;
  var v = process.argv[i + 1];
  return v == null || v.slice(0, 2) === '--' ? true : v;
}

// Choices made by eye on top of the plan, per main segment (seed@mainStartMs): the poster (a main-segment frame).
// Without one the plan's own poster frame is used (the night pterodactyl ~0.2 s before it meets the dino).
// 909@54800 (the first, night-ending video), main frame 794: full night, the dino airborne right above the LOW
// pterodactyl, moon and Milky Way behind.
// 1330@54333 (the day-GAME-OVER video), main frame 532 (video 10.97 s): full night, the dino leaving the ground
// toward the LOW pterodactyl (wings spread, same height), full moon and Milky Way above (checked against 530-541).
// 704@57917 (the English, early-dusk video), main frame 312 (video 7.30 s): full night, the dino airborne and the LOW
// pterodactyl gliding in toward it (wings spread, both clear of each other), full moon and Milky Way above (checked
// against 300-333; the plan's own pick, pinned here).
var CHOICES = { '909@54800': { posterFrame: 794 }, '1330@54333': { posterFrame: 532 }, '704@57917': { posterFrame: 312 } };

function step(script, args) {
  console.log('\n$ node tools/record/' + script + ' ' + args.join(' '));
  var r = cp.spawnSync(process.execPath, [path.join(__dirname, script)].concat(args), { stdio: 'inherit' });
  return r.status === 0;
}

function main() {
  var work = path.resolve(argv('work', process.env.RDG_VIDEO_WORK || path.join(os.tmpdir(), 'rdg-video')));
  var plan = JSON.parse(fs.readFileSync(path.join(__dirname, 'plan.json'), 'utf8'));
  var pinned = argv('candidate', null);
  var order = pinned != null ? [Number(pinned)] : plan.candidates.map(function (c, i) { return i; });
  var common = ['--work', work];
  if (argv('hold', null) != null) common.push('--hold', String(argv('hold')));
  var ci = -1;
  for (var k = 0; k < order.length; k++) {
    if (step('capture.js', common.concat(['--candidate', String(order[k])]))) { ci = order[k]; break; }
    console.log('candidate #' + order[k] + ' (seed ' + plan.candidates[order[k]].seed + ') did not reproduce in Chrome' + (k + 1 < order.length ? '; trying the next one' : ''));
  }
  if (ci < 0) { process.exitCode = 1; return; }
  if (!step('audio.js', ['--work', work])) { process.exitCode = 1; return; }
  var enc = ['--work', work];
  var choice = CHOICES[plan.candidates[ci].seed + '@' + plan.candidates[ci].mainStartMs] || {};
  var pf = argv('poster-frame', choice.posterFrame);
  if (pf != null) enc.push('--poster-frame', String(pf));
  if (!step('encode.js', enc)) { process.exitCode = 1; return; }
  console.log('\nrecorded candidate #' + ci + ' (seed ' + plan.candidates[ci].seed + ')');
}

main();
