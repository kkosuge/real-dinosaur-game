/* Seeded PRNG (mulberry32). The generator state is a plain object {s} so simulation state can be cloned cheaply. */
(function (root) {
  'use strict';
  var RDG = (root.RDG = root.RDG || {});

  function create(seed) {
    return { s: seed >>> 0 };
  }

  function next(r) {
    var t = (r.s = (r.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function int(r, lo, hi) {
    return lo + Math.floor(next(r) * (hi - lo + 1));
  }

  function range(r, lo, hi) {
    return lo + next(r) * (hi - lo);
  }

  /** Stateless integer hash -> [0,1). Used for cosmetic, position-derived randomness. */
  function hash(a, b) {
    var h = Math.imul((a | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul((b | 0) + 0x632be5ab, 0xc2b2ae35);
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function randomSeed() {
    var s = (Date.now() ^ Math.floor(Math.random() * 4294967296)) >>> 0;
    return s || 1;
  }

  RDG.rng = { create: create, next: next, int: int, range: range, hash: hash, randomSeed: randomSeed };
})(typeof globalThis !== 'undefined' ? globalThis : this);
