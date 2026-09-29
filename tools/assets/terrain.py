#!/usr/bin/env python3
"""Terrain asset pipeline (group "terrain") — reproducible raw -> game-ready post-processing.

Inputs (all generated with Codex image generation, see assets/raw/):
  terrain_mountains_{b,c,d,e,f}.png  five segments of the same hazy desert range (transparent sky): b, c, d = two
                                  mesas each (similar, so they are interleaved with e / f in MTN_SOURCES), e = rounded
                                  peaks, f = one broad tilted massif
  terrain_ground_{a,b,c}.png      three low-angle photos of the same pale desert floor (opaque)
  terrain_rocks_{b,c}.png         2x2 cut-out sheets of desert stones (transparent; rocks_a = porous, unused)
  terrain_grass_{a,b}.png         2x2 cut-out sheets of dry grass tufts / scrub (transparent)
  (terrain_mountains_a.png is a rejected first attempt — steep "Monument Valley" buttes that do not match
   the reference's broad hazy massifs; kept for provenance only.)

Outputs:
  assets/scenery/mountains.webp            RGBA, seamless L<->R, transparent sky, baselinePx = plain line
  assets/scenery/ground.webp               opaque 4096x560, seamless L<->R, row 0 = horizon
  assets/scenery/decor_{rock,grass}_<n>.webp  + *_blur.webp (same canvas, pre-blurred for foreground DOF)
  assets/manifest/terrain.json             SPEC §4 fragment
  assets/previews/terrain_*.png            QA previews

Run:  <venv>/bin/python tools/assets/terrain.py
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import *  # noqa: E402,F401,F403
from common import ROOT, RAW, PREVIEW_DIR, REFERENCE  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402
from scipy import ndimage  # noqa: E402

OUT = ROOT / "assets" / "scenery"
RNG = np.random.default_rng(20260928)

# Reference photo geometry (reference/screen.webp is 1994x789; horizon at 0.74 H)
REF_H = 789
REF_HORIZON = 584            # row where the plain meets the mountains
SKY_NEAR_HORIZON = (229, 223, 211)
HAZE_PLAIN = (203, 184, 163)  # pale hazy far plain just under the mountains in the reference

# the similar two-mesa segments b / c / d are kept apart by e and f (the strip is circular: f wraps to b)
MTN_SOURCES = ["terrain_mountains_b", "terrain_mountains_c", "terrain_mountains_e", "terrain_mountains_d",
               "terrain_mountains_f"]
MTN_W = 6144                 # near strip ~2150 world units wide: longer than the widest world (1728 u), so no mesa
                             # is ever on screen twice
MTN_CAP_CROP = 26            # px trimmed off each segment end (rounded "end caps" of the cut-out)
MTN_BELOW_BASE = 12          # opaque rows kept below the base line (covered by the ground layer)
MTN_BLUR = 2.8               # haze softness (px, premultiplied, wraps horizontally)

GROUND_SOURCES = ["terrain_ground_a", "terrain_ground_b", "terrain_ground_c"]
GW, GH = 4096, 560
GROUND_LINE_ROW = round((0.760 - 0.740) / 0.260 * GH)   # row of GROUND_Y inside the strip (= 43)

# (sheet, index in 2x2 grid [TL, TR, BL, BR], kind, content width px)
# (rocks_b BR "three pebbles" and rocks_c BR "low pebble pair" were dropped: as repeated cobble clusters they read as
#  copies; six single rocks remain, SPEC asks for >= 4)
DECOR = [
    ("terrain_rocks_b", 0, "rock", 165),    # rounded pale cobble
    ("terrain_rocks_c", 0, "rock", 225),    # low half-buried lump
    ("terrain_rocks_b", 1, "rock", 210),    # flattish angular stone
    ("terrain_rocks_c", 1, "rock", 175),    # knobbly pale stone
    ("terrain_rocks_c", 2, "rock", 190),    # grey stone with a sloping facet
    ("terrain_rocks_b", 2, "rock", 180),    # darker rough rock
    ("terrain_grass_b", 0, "grass", 200),   # sparse short clump
    ("terrain_grass_b", 2, "grass", 185),   # low tussock
    ("terrain_grass_a", 1, "grass", 225),   # dense rounded tuft
    ("terrain_grass_a", 3, "grass", 235),   # low wide spiky clump
    ("terrain_grass_a", 2, "grass", 215),   # twiggy dead shrub
    ("terrain_grass_a", 0, "grass", 205),   # wispy bunchgrass
]
# thin, wispy sprites that fall apart when defocused and enlarged: exported with "fg": false so the renderer keeps
# them out of the large foreground layer (every other entry has no fg key)
NO_FG = {
    ("terrain_grass_b", 0),                 # sparse short clump
    ("terrain_grass_a", 2),                 # twiggy dead shrub
    ("terrain_grass_a", 0),                 # wispy bunchgrass
}
DECOR_BLUR_FRAC = {"rock": 0.035, "grass": 0.03}   # blur radius as a fraction of the content width


# ----------------------------------------------------------------------------------------------- utils
def load_arr(name: str) -> np.ndarray:
    return np.asarray(Image.open(RAW / f"{name}.png").convert("RGBA")).astype(np.float32)


def premul(a: np.ndarray) -> np.ndarray:
    p = a.copy()
    p[..., :3] *= a[..., 3:4] / 255.0
    return p


def unpremul(p: np.ndarray) -> np.ndarray:
    al = p[..., 3:4] / 255.0
    rgb = np.where(al > 1e-4, p[..., :3] / np.maximum(al, 1e-4), 0.0)
    return np.concatenate([rgb, p[..., 3:4]], axis=-1)


def to_img(a: np.ndarray, mode="RGBA") -> Image.Image:
    return Image.fromarray(np.clip(np.round(a), 0, 255).astype(np.uint8), mode)


def smoothstep(t):
    t = np.clip(t, 0.0, 1.0)
    return t * t * (3 - 2 * t)


def resize_wrap(img: Image.Image, w: int, h: int) -> Image.Image:
    """Resize an image that tiles horizontally, keeping it seamless."""
    pad = 32
    a = np.asarray(img)
    ext = np.concatenate([a[:, -pad:], a, a[:, :pad]], axis=1)
    sx = w / img.width
    big = Image.fromarray(ext, img.mode).resize((round(ext.shape[1] * sx), h), Image.LANCZOS)
    p = round(pad * sx)
    return big.crop((p, 0, p + w, h))


def font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


# ------------------------------------------------------------------------------------------- mountains
def mountain_segment(name: str):
    a = load_arr(name)
    solid = a[..., 3] > 128
    base = int(np.median([np.nonzero(solid[:, x])[0].max() for x in range(200, a.shape[1] - 200, 7)]))
    seg = a[:base, MTN_CAP_CROP:a.shape[1] - MTN_CAP_CROP].copy()       # rows above the (antialiased) base row
    fill_solid_below(seg)
    return seg


def fill_solid_below(a: np.ndarray, premultiplied: bool = False):
    """The range is solid down to the base: everything below the first solid pixel of a column becomes fully
    opaque (in place) so no sky can leak through the mountain body."""
    body = ndimage.binary_erosion(a[..., 3] > 200, iterations=2)
    first = np.where(body.any(0), body.argmax(0), a.shape[0])
    fill = np.arange(a.shape[0])[:, None] >= first[None, :]
    if premultiplied:
        rgb = a[..., :3] / np.maximum(a[..., 3:4], 1e-3) * 255.0
        a[..., :3] = np.where(fill[..., None], rgb, a[..., :3])
    a[..., 3] = np.where(fill, 255.0, a[..., 3])


def top_profile(alpha: np.ndarray) -> np.ndarray:
    """Sub-pixel silhouette top per column (columns are solid from the top down to the bottom row)."""
    return alpha.shape[0] - alpha.sum(0) / 255.0


def warp_to_profile(p: np.ndarray, tp: np.ndarray, tt: np.ndarray) -> np.ndarray:
    """Vertically stretch each column (anchored at the bottom) so its top moves from tp to tt."""
    h, w = p.shape[:2]
    d = h - (np.arange(h)[:, None] + 0.5)
    scale = (h - tp) / np.maximum(h - tt, 1e-3)
    ys = h - d * scale[None, :] - 0.5
    xs = np.broadcast_to(np.arange(w, dtype=np.float32)[None, :], (h, w))
    return np.stack([ndimage.map_coordinates(p[..., c], [ys, xs], order=1, mode="nearest")
                     for c in range(4)], axis=-1)


def blend_mountain_junction(P: np.ndarray, N: np.ndarray) -> np.ndarray:
    """Morph the silhouette from P's to N's across the overlap, then crossfade the (premultiplied) colours."""
    w = P.shape[1]
    t = smoothstep(np.linspace(0.0, 1.0, w))
    tp, tn = top_profile(P[..., 3]), top_profile(N[..., 3])
    tt = (1 - t) * tp + t * tn
    Pw, Nw = warp_to_profile(P, tp, tt), warp_to_profile(N, tn, tt)
    return Pw * (1 - t)[None, :, None] + Nw * t[None, :, None]


def reference_mountain_stats():
    ref = np.asarray(Image.open(REFERENCE).convert("RGB")).astype(np.float32)
    reg = ref[515:582][:, np.r_[380:1650, 1770:1994]]
    m = reg.mean(-1) < 212
    return reg[m].mean(0), reg[m].std(0)


def build_mountains():
    segs = [mountain_segment(n) for n in MTN_SOURCES]
    hmax = max(s.shape[0] for s in segs)
    # bottom-align all segments (their base rows coincide)
    segs = [np.concatenate([np.zeros((hmax - s.shape[0], s.shape[1], 4), np.float32), s], 0) for s in segs]
    segs = [premul(s) for s in segs]
    widths = [s.shape[1] for s in segs]
    n = len(segs)
    total_ov = sum(widths) - MTN_W
    ovs = [total_ov // n + (1 if i < total_ov % n else 0) for i in range(n)]
    assert all(80 <= o <= 400 for o in ovs), ovs
    pieces = []
    for i, s in enumerate(segs):
        ov_prev, ov_next = ovs[i - 1], ovs[i]
        nxt = segs[(i + 1) % n]
        pieces.append(s[:, ov_prev:s.shape[1] - ov_next])
        pieces.append(blend_mountain_junction(s[:, s.shape[1] - ov_next:], nxt[:, :ov_next]))
    strip = np.concatenate(pieces, axis=1)          # premultiplied, circular, width MTN_W
    assert strip.shape[1] == MTN_W, strip.shape
    fill_solid_below(strip, premultiplied=True)

    # extend the base downward (hidden behind the ground) so blur never opens a gap at the horizon
    ext = np.repeat(strip[-1:], MTN_BELOW_BASE + 8, axis=0)
    strip = np.concatenate([np.zeros((24, MTN_W, 4), np.float32), strip, ext], 0)
    base_row = 24 + hmax

    # colour grade: match the reference mountains (mean / std per channel) -> hazy, low-contrast, warm grey
    rgba = unpremul(strip)
    solid = rgba[..., 3] > 250
    tgt_mean, tgt_std = reference_mountain_stats()
    lw = np.array([0.299, 0.587, 0.114], np.float32)
    src = rgba[..., :3][solid]
    mean = src.mean(0)
    lum = (rgba[..., :3] * lw).sum(-1, keepdims=True)
    lum_mean, lum_std = float((src * lw).sum(-1).mean()), float((src * lw).sum(-1).std())
    tgt_lum_std = float((tgt_std * lw).sum()) * 0.95     # ref std also contains soft sky-blended edges
    # neutral (luminance) detail scaled to the reference's low contrast; only a little of the source chroma
    # survives (the raw sunlit slopes are too yellow, the shadows too blue for the reference's warm grey)
    chroma = (rgba[..., :3] - lum) - (mean - lum_mean)
    dev = (lum - lum_mean) * (tgt_lum_std / lum_std)
    dev = np.where(dev > 0, 11.0 * np.tanh(dev / 11.0), dev)   # soft-clip bright sunlit slopes (read as snow)
    rgb = tgt_mean + dev + 0.30 * chroma
    # atmospheric perspective: farther (paler, bluer) layers are already lighter; add a touch more haze near
    # the base where the air is densest
    h = rgb.shape[0]
    yy = np.arange(h)[:, None, None]
    haze = 0.18 * smoothstep((yy - (base_row - 45)) / 45.0)
    rgb = rgb * (1 - haze) + np.array(HAZE_PLAIN, np.float32) * haze
    rgba[..., :3] = np.clip(rgb, 0, 255)

    # softness (premultiplied gaussian; horizontal wrap keeps the strip seamless)
    p = premul(rgba)
    p = ndimage.gaussian_filter(p, sigma=(MTN_BLUR, MTN_BLUR, 0), mode=("nearest", "wrap", "nearest"))
    rgba = unpremul(p)
    rgba[base_row - 2:, :, 3] = 255.0
    rgba[base_row - 2:, :, :3] = np.where(rgba[base_row - 2:, :, 3:4] > 0, rgba[base_row - 2:, :, :3],
                                          rgba[base_row - 3:base_row - 2, :, :3])
    rgba[rgba[..., 3] < 2] = 0

    # crop: 6 px above the highest peak, MTN_BELOW_BASE rows below the base
    top = int(np.nonzero((rgba[..., 3] > 2).any(1))[0].min())
    y0 = max(0, top - 6)
    rgba = rgba[y0:base_row + MTN_BELOW_BASE]
    base_px = base_row - y0
    img = to_img(rgba)
    peak_px = int(np.nonzero((rgba[..., 3] > 128).any(1))[0].min())
    return img, base_px, peak_px


# ---------------------------------------------------------------------------------------------- ground
def reference_ground_profile():
    """Robust per-row colour (median) and contrast (IQR-sigma) of the reference ground, mapped to GH rows."""
    ref = np.asarray(Image.open(REFERENCE).convert("RGB")).astype(np.float32)
    rows = REF_HORIZON + (np.arange(GH) + 0.5) * (REF_H - REF_HORIZON) / GH
    med = np.zeros((GH, 3), np.float32)
    sig = np.zeros((GH, 3), np.float32)
    for y in range(GH):
        r = min(REF_H - 1, int(rows[y]))
        line = ref[r, 20:-20]
        med[y] = np.median(line, 0)
        q1, q3 = np.percentile(line, [25, 75], axis=0)
        sig[y] = (q3 - q1) / 1.349
    # rows above ~70 contain the distant scrub band / pebble line: use the clean ground just below for the base
    med[:70] = med[70:90].mean(0)
    sig[:70] = sig[70:90].mean(0)
    # below ~row 340 the reference median is pulled down by big blurred foreground rocks/grass: keep only a
    # part of that darkening, and cap the contrast
    mid = med[120:320].mean(0)
    k = smoothstep((np.arange(GH) - 330) / 120.0)[:, None]
    med = med * (1 - 0.35 * k) + mid * (0.35 * k)
    sig = np.clip(sig, 10.0, 17.0)
    med = ndimage.gaussian_filter1d(med, 14, axis=0, mode="nearest")
    sig = ndimage.gaussian_filter1d(sig, 18, axis=0, mode="nearest")
    return med, sig


def normalize_ground(a: np.ndarray, tgt_med, tgt_sig) -> np.ndarray:
    m = ndimage.gaussian_filter1d(a.mean(1), 8, axis=0, mode="nearest")                  # (GH, 3)
    s = ndimage.gaussian_filter1d(a.std(1).mean(-1), 8, axis=0, mode="nearest")          # (GH,)
    gain = np.clip(tgt_sig.mean(-1) / np.maximum(s, 1e-3), 0.35, 1.2)
    return (a - m[:, None, :]) * gain[:, None, None] + tgt_med[:, None, :]


def min_cut_path(err: np.ndarray, margin: int) -> np.ndarray:
    """Vertical minimum-error boundary (image quilting) through err (h, w); returns x per row."""
    h, w = err.shape
    big = 1e12
    e = err.copy()
    e[:, :margin] = big
    e[:, w - margin:] = big
    cost = e.copy()
    back = np.zeros((h, w), np.int64)
    for y in range(1, h):
        prev = cost[y - 1]
        left = np.r_[big, prev[:-1]]
        right = np.r_[prev[1:], big]
        stack = np.stack([left, prev, right])
        idx = stack.argmin(0)
        cost[y] = e[y] + stack[idx, np.arange(w)]
        back[y] = np.arange(w) + idx - 1
    path = np.zeros(h, np.int64)
    path[-1] = int(cost[-1].argmin())
    for y in range(h - 1, 0, -1):
        path[y - 1] = back[y, path[y]]
    return path


def blend_ground_junction(P: np.ndarray, N: np.ndarray, feather: int = 10) -> np.ndarray:
    err = ((P - N) ** 2).sum(-1)
    err = ndimage.gaussian_filter(err, 2.0)
    path = min_cut_path(err, feather + 2)
    xs = np.arange(P.shape[1])[None, :]
    m = smoothstep((xs - path[:, None]) / (2.0 * feather) + 0.5)[..., None]
    return P * (1 - m) + N * m


def build_distant_scrub(grass_sprites) -> np.ndarray:
    """Band of tiny, hazy dry-grass tufts on the far plain (like the golden line under the reference mountains).
    Built from the Codex grass sprites, scattered with horizontal wrap so it stays seamless. Returns premult RGBA."""
    band_h = 48
    layer = np.zeros((band_h, GW, 4), np.float32)
    small = []
    for spr in grass_sprites:
        a = np.asarray(spr).astype(np.float32)
        small.append(a)
    placements = []
    n = 4200
    for _ in range(n):
        yb = RNG.uniform(10, 32)                                 # base row (depth): farther = smaller
        depth = (yb - 10) / 22.0
        hgt = (2.5 + 7.0 * depth) * RNG.uniform(0.6, 1.4) * (1.8 if RNG.random() < 0.05 else 1.0)
        placements.append((yb, hgt, RNG.uniform(0, GW), int(RNG.integers(len(small)))))
    placements.sort(key=lambda t: t[0])
    for yb, hgt, x, k in placements:
        src = small[k]
        sh, sw = src.shape[:2]
        th = max(2, int(round(hgt)))
        tw = max(2, int(round(sw * th / sh * RNG.uniform(1.0, 2.0))))    # distant tufts read wider/flatter
        spr = np.asarray(Image.fromarray(src.astype(np.uint8), "RGBA").resize((tw, th), Image.LANCZOS)).astype(np.float32)
        rgb = spr[..., :3]
        lum = rgb.mean(-1, keepdims=True)
        tint = np.array([128, 103, 74], np.float32) * RNG.uniform(0.9, 1.1)
        rgb = lum / max(1.0, lum[spr[..., 3] > 64].mean() if (spr[..., 3] > 64).any() else 1.0) * tint
        depth = (yb - 10) / 22.0
        hz = 0.30 - 0.22 * depth + RNG.uniform(-0.04, 0.04)
        rgb = rgb * (1 - hz) + np.array(HAZE_PLAIN, np.float32) * hz
        al = spr[..., 3:4] * RNG.uniform(0.75, 1.0)
        pm = np.concatenate([rgb * al / 255.0, al], -1)
        y0 = int(round(yb)) - th
        x0 = int(x)
        for xo in (x0, x0 - GW):
            xa, xb = max(0, xo), min(GW, xo + tw)
            ya, yb2 = max(0, y0), min(band_h, y0 + th)
            if xb <= xa or yb2 <= ya:
                continue
            piece = pm[ya - y0:yb2 - y0, xa - xo:xb - xo]
            dst = layer[ya:yb2, xa:xb]
            layer[ya:yb2, xa:xb] = piece + dst * (1 - piece[..., 3:4] / 255.0)
    layer = ndimage.gaussian_filter(layer, sigma=(0.6, 0.8, 0), mode=("nearest", "wrap", "nearest"))
    return layer


def build_ground(grass_sprites):
    tgt_med, tgt_sig = reference_ground_profile()
    pieces_src = []
    for n in GROUND_SOURCES:
        im = Image.open(RAW / f"{n}.png").convert("RGB")
        im = im.resize((im.width, GH), Image.LANCZOS)          # perspective squash: 1536x1024 -> 1536x560
        a = np.asarray(im).astype(np.float32)
        pieces_src.append(normalize_ground(a, tgt_med, tgt_sig))
    widths = [p.shape[1] for p in pieces_src]
    total_ov = sum(widths) - GW
    ovs = [total_ov // 3 + (1 if i < total_ov % 3 else 0) for i in range(3)]
    parts = []
    for i, s in enumerate(pieces_src):
        ov_prev, ov_next = ovs[i - 1], ovs[i]
        nxt = pieces_src[(i + 1) % 3]
        parts.append(s[:, ov_prev:s.shape[1] - ov_next])
        parts.append(blend_ground_junction(s[:, s.shape[1] - ov_next:], nxt[:, :ov_next]))
    g = np.concatenate(parts, axis=1)
    assert g.shape[1] == GW, g.shape

    # depth of field: progressively softer toward the bottom (near camera), like the reference foreground. A linear
    # ramp from just below the running line (~row 58) to sig_max at the bottom row; 14 texture px ~ 4 screen px at
    # 632 px tall, similar to the reference's defocused foreground
    sig_max = 14.0
    levels = [0.0, 1.0, 2.0, 4.0, 7.0, 10.0, sig_max]
    blurred = [g if s == 0 else ndimage.gaussian_filter(g, sigma=(s, s, 0), mode=("reflect", "wrap", "nearest"))
               for s in levels]
    ys = np.arange(GH)
    k = np.clip((ys - (GROUND_LINE_ROW + 15)) / (GH - GROUND_LINE_ROW - 15), 0, 1)   # 0..1 depth ramp
    want = sig_max * k
    out = np.zeros_like(g)
    for y in range(GH):
        s = want[y]
        j = int(np.searchsorted(levels, s, side="right") - 1)
        j = min(j, len(levels) - 2)
        t = (s - levels[j]) / (levels[j + 1] - levels[j])
        out[y] = blurred[j][y] * (1 - t) + blurred[j + 1][y] * t
    g = out
    # restore the blotchy large-scale contrast of the blurred near ground (the reference foreground is soft but
    # clearly textured, not flat)
    post_sig = np.clip(tgt_sig, 0, None).copy()
    post_sig[170:] = np.maximum(post_sig[170:], 12.5)
    g = normalize_ground(g, tgt_med, post_sig)
    # ... and more of it with depth: the reference's defocused foreground keeps strong low-frequency blotches (its
    # low-band std is ~7-9 at 0.9-1.0 H, ~2x the normalised strip's); per row, around the row mean
    m = g.mean(1, keepdims=True)
    g = m + (g - m) * (1.0 + 0.9 * k)[:, None, None]

    # far plain: haze near the horizon (paler, lower contrast)
    hz = (0.82 * (1 - smoothstep(ys / 46.0)) + 0.10 * (1 - smoothstep(ys / 120.0)))[:, None, None]
    g = g * (1 - hz) + np.array(HAZE_PLAIN, np.float32) * hz

    # distant dry-scrub band just below the horizon (sits above GROUND_Y, like the golden line in the reference)
    band = build_distant_scrub(grass_sprites)
    bh = band.shape[0]
    g[:bh] = band[..., :3] + g[:bh] * (1 - band[..., 3:4] / 255.0)
    # a hint of the warm scrub tone as a soft continuous band under the tufts
    wb = 0.30 * np.exp(-0.5 * ((ys - 23) / 6.0) ** 2)[:, None, None]
    g = g * (1 - wb) + np.array([150, 124, 94], np.float32) * wb

    # micro-contrast around the running line (rows ~20-110, feathered): a mild unsharp mask that wraps horizontally.
    # No discrete pebbles / stones / cracks are baked below GROUND_LINE_ROW (SPEC §3: the slices scroll at different
    # speeds, so the strip must stay a fine-grained texture; the renderer adds the pebble band as decor)
    soft = ndimage.gaussian_filter(g, sigma=(1.8, 1.8, 0), mode=("reflect", "wrap", "nearest"))
    usm = (smoothstep((ys - 10) / 10.0) * (1 - smoothstep((ys - 106) / 12.0)))[:, None, None]
    g = g + 0.5 * usm * (g - soft)

    # fine film grain so the flattened areas do not look plasticky (wraps implicitly: pure per-pixel noise); it
    # fades with depth so it does not re-sharpen the defocused foreground
    g = g + RNG.normal(0, 1.6, g.shape[:2])[..., None] * (1 - k)[:, None, None]
    return to_img(g, "RGB")


# ----------------------------------------------------------------------------------------------- decor
def grade_sprite(img: Image.Image, kind: str) -> Image.Image:
    """Match the reference palette: its stones are mid grey-beige with dark shaded undersides (median lum ~110
    for the far pebbles), its tufts dull straw/brown. Adds a soft ambient-occlusion darkening toward the base so
    the objects sit on the ground (self-shadow only - no cast shadow is baked in)."""
    a = np.asarray(img).astype(np.float32)
    rgb = a[..., :3]
    lw = np.array([0.299, 0.587, 0.114], np.float32)
    lum = (rgb * lw).sum(-1, keepdims=True)
    solid = a[..., 3] > 200
    med = float(np.median(lum[..., 0][solid])) if solid.any() else 128.0
    if kind == "rock":
        sat, warm, target, ao = 0.70, np.array([1.03, 1.0, 0.95], np.float32), 128.0, 0.42
    else:
        sat, warm, target, ao = 0.62, np.array([1.03, 0.99, 0.93], np.float32), 132.0, 0.30
    gain = target / max(med, 1.0)
    rgb = (lum + (rgb - lum) * sat) * gain * warm
    # occlusion gradient over the lower ~45% of the object
    h = a.shape[0]
    yy = np.arange(h, dtype=np.float32)[:, None, None]
    occ = 1.0 - ao * smoothstep((yy - 0.55 * h) / (0.45 * h)) ** 1.3
    rgb = rgb * occ
    a[..., :3] = np.clip(rgb, 0, 255)
    return to_img(a)


def blur_on_canvas(canvas: Image.Image, radius: float, lift: int) -> Image.Image:
    """blur_sprite() the sharp canvas, re-align it on the SAME canvas by alpha centroid, lift it up by `lift` px
    so the soft bottom halo stays (almost) inside the canvas; the base still meets the ground optically."""
    blurred = blur_sprite(canvas, radius)
    A = np.asarray(canvas)[..., 3].astype(np.float64)
    B = np.asarray(blurred)[..., 3].astype(np.float64)

    def centroid(m):
        ys, xs = np.indices(m.shape)
        s = m.sum()
        return (xs * m).sum() / s, (ys * m).sum() / s

    ax, ay = centroid(A)
    bx, by = centroid(B)
    dx, dy = int(round(ax - bx)), int(round(ay - by)) - lift
    out = np.zeros((canvas.height, canvas.width, 4), np.uint8)
    b = np.asarray(blurred)
    ya, yb = max(0, dy), min(canvas.height, dy + b.shape[0])
    xa, xb = max(0, dx), min(canvas.width, dx + b.shape[1])
    out[ya:yb, xa:xb] = b[ya - dy:yb - dy, xa - dx:xb - dx]
    return Image.fromarray(out, "RGBA")


def build_decor():
    sheets = {}
    entries, previews, grass_for_band = [], [], []
    counters = {"rock": 0, "grass": 0}
    for sheet, idx, kind, cw in DECOR:
        if sheet not in sheets:
            im = ensure_alpha(load_rgba(RAW / f"{sheet}.png"))      # native alpha -> returned unchanged
            crops, boxes = split_components(clean_alpha(im, min_alpha=6), 4, dilate=8)
            # order by grid cell of the bbox centre: [TL, TR, BL, BR]
            cell = [int((b[1] + b[3]) / 2 > im.height / 2) * 2 + int((b[0] + b[2]) / 2 > im.width / 2) for b in boxes]
            assert sorted(cell) == [0, 1, 2, 3], (sheet, cell)
            sheets[sheet] = [c for _, c in sorted(zip(cell, crops), key=lambda t: t[0])]
        spr = sheets[sheet][idx]
        spr = trim(clean_alpha(spr, min_alpha=8, min_blob_frac=0.0005))
        # snap the base: the lowest row with a few solid pixels becomes the bottom row (no floating by an
        # antialiased fringe / stray blade tip below the real base)
        cnt = (np.asarray(spr)[..., 3] > 128).sum(1)
        spr = spr.crop((0, 0, spr.width, int(np.nonzero(cnt >= 3)[0].max()) + 1))
        spr = defringe(spr, 2) if kind == "rock" else spr
        spr = grade_sprite(spr, kind)
        h = max(1, round(spr.height * cw / spr.width))
        spr = spr.resize((cw, h), Image.LANCZOS)
        if kind == "grass":
            grass_for_band.append(spr)
        r = DECOR_BLUR_FRAC[kind] * cw
        margin = int(np.ceil(2.6 * r)) + 2
        lift = int(round(1.6 * r))
        W = cw + 2 * margin
        H = h + margin + lift
        canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))
        canvas.alpha_composite(spr, (margin, H - h))               # base on the bottom row
        blur = blur_on_canvas(canvas, r, lift)
        counters[kind] += 1
        name = f"decor_{kind}_{counters[kind]}"
        p_sharp = save_webp(canvas, OUT / f"{name}.webp", quality=88)
        p_blur = save_webp(blur, OUT / f"{name}_blur.webp", quality=85)
        entry = {"src": rel(p_sharp), "srcBlur": rel(p_blur), "w": W, "h": H, "kind": kind}
        if (sheet, idx) in NO_FG:
            entry["fg"] = False
        entries.append(entry)
        previews.append((name, canvas, blur, (margin, H - h, cw, h)))
    return entries, previews, grass_for_band


# -------------------------------------------------------------------------------------------- previews
def label(d: ImageDraw.ImageDraw, xy, text, size=14, fill=(20, 20, 20, 255)):
    d.text(xy, text, fill=fill, font=font(size))


def preview_decor(previews):
    cell_w, cell_h = 330, 300
    cols = 4
    rows = (len(previews) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell_w, rows * 2 * cell_h), (223, 224, 230, 255))
    d = ImageDraw.Draw(sheet)
    for i, (name, sharp, blur, (bx, by, bw, bh)) in enumerate(previews):
        cx, cy = (i % cols) * cell_w, (i // cols) * 2 * cell_h
        for j, (im, bg, tag) in enumerate([(sharp, (223, 224, 230, 255), ""), (blur, (48, 48, 52, 255), " blur (dark bg)")]):
            ox = cx + (cell_w - im.width) // 2
            oy = cy + j * cell_h + cell_h - 26 - im.height
            if bg != (223, 224, 230, 255):
                d.rectangle([cx, cy + j * cell_h, cx + cell_w - 1, cy + (j + 1) * cell_h - 1], fill=bg)
            sheet.alpha_composite(im, (ox, oy))
            d.rectangle([ox, oy, ox + im.width - 1, oy + im.height - 1], outline=(255, 0, 0, 255), width=1)
            if j == 0:   # object bbox (green) and base line
                d.rectangle([ox + bx, oy + by, ox + bx + bw - 1, oy + by + bh - 1], outline=(0, 150, 0, 255), width=1)
            label(d, (cx + 6, cy + j * cell_h + cell_h - 22), f"{name}{tag}  {im.width}x{im.height}", 13,
                  (20, 20, 20, 255) if j == 0 else (230, 230, 230, 255))
    p = PREVIEW_DIR / "terrain_decor.png"
    sheet.save(p)
    return p


def preview_tiles(mtn: Image.Image, base_px: int, ground: Image.Image):
    # mountains: 3 full tiles over flat sky (scaled so the whole 3-tile run is ~4400 px wide whatever MTN_W is), with
    # seam ticks; the ground strip tiled underneath at the same scale
    s = 4400 / (3 * mtn.width)
    mw, mh = round(mtn.width * s), round(mtn.height * s)
    m_small = mtn.resize((mw, mh), Image.LANCZOS)
    g_small = ground.resize((round(ground.width * s), round(ground.height * s)), Image.LANCZOS)
    W = mw * 3
    H = 40 + mh + g_small.height * 1 + 40
    img = Image.new("RGBA", (W, H), SKY_NEAR_HORIZON + (255,))
    for k in range(3):
        img.alpha_composite(m_small, (k * mw, 40))
    gy = 40 + round(base_px * s)
    ng = -(-W // g_small.width)
    for k in range(ng):
        img.paste(g_small.convert("RGBA"), (k * g_small.width, gy))
    d = ImageDraw.Draw(img)
    for k in range(1, 3):
        d.line([(k * mw, 0), (k * mw, 22)], fill=(255, 0, 0, 255), width=2)
    for k in range(1, ng):
        d.line([(k * g_small.width, H - 22), (k * g_small.width, H)], fill=(255, 0, 0, 255), width=2)
    label(d, (6, 4), f"mountains x3 tiles (seams at red ticks, top), ground x{ng} tiles (seams at red ticks, bottom); "
                     f"scale {s:.3f}", 16)
    p1 = PREVIEW_DIR / "terrain_tiles.png"
    img.save(p1)

    # full-res seam close-ups: last 300 px of the tile + first 300 px
    def seam_closeup(im, bgc):
        a = im.convert("RGBA")
        wrap = Image.new("RGBA", (600, a.height), bgc + (255,))
        wrap.alpha_composite(a.crop((a.width - 300, 0, a.width, a.height)), (0, 0))
        wrap.alpha_composite(a.crop((0, 0, 300, a.height)), (300, 0))
        return wrap
    mc = seam_closeup(mtn, SKY_NEAR_HORIZON)
    gc = seam_closeup(ground, (0, 0, 0))
    out = Image.new("RGBA", (600, mc.height + gc.height + 30), (255, 255, 255, 255))
    out.alpha_composite(mc, (0, 0))
    out.alpha_composite(gc, (0, mc.height + 30))
    d = ImageDraw.Draw(out)
    label(d, (6, mc.height + 6), "seam close-ups at 100% (seam in the middle, x=300)", 14)
    p2 = PREVIEW_DIR / "terrain_seams.png"
    out.save(p2)
    return p1, p2


def paste_scaled(dst: Image.Image, spr: Image.Image, cx: float, base_y: float, height_px: float):
    """Paste sprite scaled to height_px with its bottom-centre at (cx, base_y)."""
    s = height_px / spr.height
    w, h = max(1, round(spr.width * s)), max(1, round(spr.height * s))
    im = spr.resize((w, h), Image.LANCZOS)
    x, y = round(cx - w / 2), round(base_y - h)
    if x + w <= 0 or x >= dst.width or y >= dst.height:
        return
    box = (max(0, -x), max(0, -y), min(w, dst.width - x), min(h, dst.height - y))
    dst.alpha_composite(im.crop(box), (max(0, x), max(0, y)))


def mock_scene(mtn: Image.Image, base_px: int, peak_px: int, ground: Image.Image, previews, W=1994, H=789,
               mtn_offset=0.62, seed=7, fg_ok=None):
    """Synthetic scene laid out like the engine (SPEC §2/§3): flat sky, mountain tiles, ground strip below
    the horizon, decor at several depths (foreground: only the sprites in fg_ok). W/H like the reference photo."""
    rng = np.random.default_rng(seed)
    horizon = round(0.740 * H)
    ground_y = round(0.760 * H)
    scene = Image.new("RGBA", (W, H), SKY_NEAR_HORIZON + (255,))
    # sky: soft vertical gradient from the reference's upper sky to the horizon colour
    sky = np.zeros((H, W, 3), np.float32)
    top_c = np.array([200, 205, 214], np.float32)
    hor_c = np.array(SKY_NEAR_HORIZON, np.float32)
    t = smoothstep(np.arange(H) / horizon)[:, None, None]
    sky[:] = top_c * (1 - t) + hor_c * t
    scene = to_img(np.concatenate([sky, np.full((H, W, 1), 255, np.float32)], -1))
    # mountains: tallest peak = 0.10 H above the horizon
    ms = (0.095 * H) / (base_px - peak_px)
    mw, mh = round(mtn.width * ms), round(mtn.height * ms)
    m = mtn.resize((mw, mh), Image.LANCZOS)
    my = horizon - round(base_px * ms)
    x = -round(mtn_offset * mw)
    while x < W:
        scene.alpha_composite(m, (x, my)) if x >= 0 else scene.alpha_composite(m.crop((-x, 0, mw, mh)), (0, my))
        x += mw
    # ground: row 0 at the horizon, last row at the bottom
    gs = (H - horizon) / ground.height
    gw = round(ground.width * gs)
    g = ground.resize((gw, H - horizon), Image.LANCZOS).convert("RGBA")
    x = -round(0.3 * gw)
    while x < W:
        if x >= 0:
            scene.alpha_composite(g, (x, horizon))
        else:
            scene.alpha_composite(g.crop((-x, 0, gw, g.height)), (0, horizon))
        x += gw
    # decor: background (sharp, small) between horizon and ground line, foreground (blurred, big) below
    sharp = [p[1] for p in previews]
    blurred = [p[2] for p in previews]
    kinds = [p[0].split("_")[1] for p in previews]
    items = []
    for _ in range(26):
        k = int(rng.integers(len(sharp)))
        yb = rng.uniform(horizon + 7, ground_y + 10)
        depth = (yb - horizon) / (ground_y + 10 - horizon)
        hh = (0.012 + 0.03 * depth) * H * (0.7 if kinds[k] == "rock" else 1.0) * rng.uniform(0.7, 1.3)
        items.append((yb, sharp[k], rng.uniform(0, W), hh))
    fg = list(range(len(blurred))) if fg_ok is None else list(fg_ok)
    for _ in range(9):
        k = fg[int(rng.integers(len(fg)))]
        yb = rng.uniform(ground_y + 60, H + 10)
        depth = (yb - ground_y) / (H - ground_y)
        hh = (0.05 + 0.08 * depth) * H * (0.8 if kinds[k] == "rock" else 1.1) * rng.uniform(0.8, 1.2)
        items.append((yb, blurred[k], rng.uniform(0, W), hh))
    items.sort(key=lambda t: t[0])
    for yb, spr, cx, hh in items:
        paste_scaled(scene, spr, cx, yb, hh * spr.height / max(1, spr.height))
    return scene


def preview_scene(mtn, base_px, peak_px, ground, previews, fg_ok=None):
    ref = load_rgba(REFERENCE)
    scene = mock_scene(mtn, base_px, peak_px, ground, previews, ref.width, ref.height, fg_ok=fg_ok)
    out = Image.new("RGBA", (ref.width, ref.height * 2 + 60), (255, 255, 255, 255))
    out.alpha_composite(scene, (0, 30))
    out.alpha_composite(ref, (0, ref.height + 60))
    d = ImageDraw.Draw(out)
    label(d, (8, 6), "MOCK: terrain assets laid out per SPEC (flat sky, mountain tiles, ground strip, decor)", 18)
    label(d, (8, ref.height + 36), "REFERENCE: reference/screen.webp", 18)
    p = PREVIEW_DIR / "terrain_scene.png"
    out.convert("RGB").save(p)
    # half-size crop around the horizon for close comparison
    crop_box = (300, 470, 1500, 789)
    a = scene.crop(crop_box)
    b = ref.crop(crop_box)
    cmp_ = Image.new("RGBA", (a.width, a.height * 2 + 8), (255, 255, 255, 255))
    cmp_.alpha_composite(a, (0, 0))
    cmp_.alpha_composite(b, (0, a.height + 8))
    p2 = PREVIEW_DIR / "terrain_scene_closeup.png"
    cmp_.convert("RGB").save(p2)
    return p, p2


def preview_in_reference(previews, fg_ok):
    """(b) decor composited into the reference photo at in-game relative scale: sharp ones on the far plain next
    to the reference's own pebbles, blurred ones (foreground-eligible only) next to its blurred rocks."""
    ref = load_rgba(REFERENCE)
    H = ref.height
    rng = np.random.default_rng(3)
    img = ref.copy()
    xs_far = np.linspace(430, 1600, len(previews))
    for i, (name, sharp, blur, _) in enumerate(previews):
        kind = name.split("_")[1]
        hh = (0.035 if kind == "rock" else 0.05) * H * sharp.height / max(1, sharp.height)
        paste_scaled(img, sharp, xs_far[i], 600 + rng.uniform(-3, 5), hh)
    xs_near = np.linspace(330, 1900, 6)
    rocks = [i for i in fg_ok if previews[i][0].split("_")[1] == "rock"]
    grass = [i for i in fg_ok if previews[i][0].split("_")[1] == "grass"]
    near = [rocks[0], rocks[3 % len(rocks)], grass[0], grass[1 % len(grass)], rocks[-1], grass[-1]]
    for j, i in enumerate(near):
        name, sharp, blur, _ = previews[i]
        kind = name.split("_")[1]
        hh = (0.11 if kind == "rock" else 0.14) * H
        paste_scaled(img, blur, xs_near[j], 745 + rng.uniform(-10, 25), hh)
    p = PREVIEW_DIR / "terrain_in_reference.png"
    crop = img.crop((250, 420, 1994, 789))
    crop.convert("RGB").save(p)
    return p


# ------------------------------------------------------------------------------------------------ main
def main():
    OUT.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)

    decor_entries, decor_previews, grass_for_band = build_decor()

    mtn, base_px, peak_px = build_mountains()
    p_mtn = save_webp(mtn, OUT / "mountains.webp", quality=90)

    ground = build_ground(grass_for_band)
    p_ground = save_webp(ground, OUT / "ground.webp", quality=85)

    frag = {"terrain": {
        "mountains": {"src": rel(p_mtn), "w": mtn.width, "h": mtn.height, "baselinePx": base_px,
                      "peakPx": peak_px},
        "ground": {"src": rel(p_ground), "w": ground.width, "h": ground.height},
        "decor": decor_entries,
    }}
    fp = write_fragment("terrain", frag)

    # QA
    mtn_rt = load_rgba(p_mtn)
    gr_rt = Image.open(p_ground).convert("RGB")
    print(f"mountains {mtn.size} baselinePx={base_px} peakPx={peak_px} seam_error(src)={seam_error(mtn):.2f} "
          f"seam_error(webp)={seam_error(mtn_rt):.2f}  inner-col-diff={np.abs(np.diff(np.asarray(mtn).astype(float), axis=1)).mean():.2f}")
    print(f"ground {ground.size} seam_error(src)={seam_error(ground):.2f} seam_error(webp)={seam_error(gr_rt):.2f} "
          f"inner-col-diff={np.abs(np.diff(np.asarray(ground).astype(float), axis=1)).mean():.2f}")
    p1, p2 = preview_tiles(mtn_rt, base_px, gr_rt)
    p3 = preview_decor(decor_previews)
    fg_ok = [i for i, e in enumerate(decor_entries) if e.get("fg", True)]
    p4, p5 = preview_scene(mtn_rt, base_px, peak_px, gr_rt, decor_previews, fg_ok)
    p6 = preview_in_reference(decor_previews, fg_ok)
    total = sum(pathlib.Path(ROOT / e).stat().st_size for e in
                [frag["terrain"]["mountains"]["src"], frag["terrain"]["ground"]["src"]] +
                [d["src"] for d in decor_entries] + [d["srcBlur"] for d in decor_entries])
    print(f"fragment {rel(fp)}; {len(decor_entries)} decor; total terrain bytes {total/1e6:.2f} MB")
    for p in (p1, p2, p3, p4, p5, p6):
        print("preview", rel(p))


if __name__ == "__main__":
    main()
