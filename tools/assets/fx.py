#!/usr/bin/env python
"""Sand-dust FX pipeline (group "fx") — reproducible raw -> game-ready post-processing.

The running T-rex kicks up pale desert dust (reference/screen.webp: a small translucent pale cloud plus dark flying
grains behind the rear foot). This script turns Codex-generated dust elements into particle sprites for the renderer.

    raw codex outputs   assets/raw/fx_dust_*.png   (all generated with Codex image generation, transparent_background)
        fx_dust_puffs_a.png      3x2 sheet of fresh, dense billowing footfall puffs
        fx_dust_puffs_b.png      3x2 sheet of thinner, translucent, settling puffs (older particles)
        fx_dust_plume_a.png      long trailing plume, dense bottom-right head, dissipating to the left
        fx_dust_plume_b.png      shorter rolling trailing cloud
        fx_dust_spray_a.png      long shallow fan of kicked-up grains + fine dust, origin bottom-right
        fx_dust_spray_b.png      compact steep fan of fine grains + dust veil, origin bottom-right
        fx_dust_burst_a.png      wide low landing burst rolling out to both sides
        fx_dust_burst_b.png      flatter, wider crash / impact cloud
      (fx_dust_puffs_k.png / fx_dust_plume_k.png were generated on pure black as a luminance-keying alternative; keyed
       they read flat and peach-tinted next to the native-alpha versions, so they are kept for provenance only.)
 -> game-ready sprites  assets/fx/dust_{puff,plume,spray,burst}_<n>.webp   (<= 400 px wide, RGBA, lossy WebP)
 -> manifest fragment   assets/manifest/fx.json
 -> QA previews         assets/previews/fx_dust_*.png

fx.json fragment:
    { "fx": { "dust": [ {"src": "assets/fx/dust_puff_0.webp", "w": 256, "h": 180, "kind": "puff",
                          "anchor": [ax, ay], "worldW": 46, "stage": "fresh"}, ... ] } }
  kind    puff  — small billow for one footfall (spawn small, expand ~1.5-2.5x while fading out)
          plume — elongated trail, dense at the RIGHT end (emission point), dissipating to the left
          spray — fan of sharp grains + a little fine dust flung up and back (left) at toe-off
          burst — wide low ground-hugging cloud (landing after a jump / the crash)
  anchor  normalized [x, y] point of the image that sits on the emission point: bottom-centre of the dense base for
          puffs / bursts, bottom-right emission end for plumes, the fan's origin (bottom-right) for sprays. For puffs,
          plumes and bursts the y is the ground-contact row of the dense base (only a short soft fade continues below
          it), so the sprite can be drawn with the anchor exactly on GROUND_Y.
  worldW  (optional hint) draw width in world units (H = 540) used for the mock composites in the previews, i.e. the
          size at which the sprite reads as natural dust next to the 104 u tall dino. Engines may vary it (+-40 %).
  stage   (optional, puffs only) "fresh" = dense just-kicked billow, "thin" = translucent settling puff (good for
          older particles or as a second layer).

Processing per sprite: isolate the element (sheet components get a feathered mask, never a hard threshold cut) ->
alpha shaping (dust is translucent: the reference cloud never fully hides the mountains behind it; spray grains stay
crisp while the fine dust between them is thinned) -> soft fade just below the dense base (no hard ground line) ->
colour: slight desaturation + per-channel gain so the dense dust matches the pale greige of the reference dust (grains
become grey-brown gravel instead of orange) + a gentle upper-left light falloff -> trim + generous transparent margin
(alpha is exactly 0 in a wide ring inside the image edge) -> premultiplied LANCZOS downscale -> WebP q88.

Run:  <venv>/bin/python tools/assets/fx.py
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import *  # noqa: E402,F401,F403
from common import ROOT, RAW, PREVIEW_DIR, REFERENCE  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402
from scipy import ndimage  # noqa: E402

OUT_DIR = ROOT / "assets" / "fx"

# Colour target: alpha-weighted mean RGB of the light, dense dust pixels after grading. The dust cloud behind the rear
# foot in the reference averages ~(216, 200, 182) (the ground itself ~(192, 171, 150)).
DUST_TARGET = (213, 199, 181)
SPRAY_DUST_TARGET = (204, 190, 172)      # the fine dust inside a spray sits in the grains' shade: a touch darker
DESAT = {"puff": 0.85, "plume": 0.85, "burst": 0.85, "spray": 0.6}   # chroma kept before the gain

# (kind, raw stem, component index in the sheet (None = single element), options)
#   out = longest side in px (width capped at 400); worldW = size hint (world units); stage = puff flavour
SPRITES = [
    ("puff", "fx_dust_puffs_a", 0, dict(out=256, worldW=46, stage="fresh")),   # round rolling puff
    ("puff", "fx_dust_puffs_a", 1, dict(out=256, worldW=54, stage="fresh")),   # low wide puff
    ("puff", "fx_dust_puffs_a", 2, dict(out=256, worldW=40, stage="fresh")),   # tall wispy puff
    ("puff", "fx_dust_puffs_a", 3, dict(out=256, worldW=50, stage="fresh")),   # lopsided, drifting left
    ("puff", "fx_dust_puffs_a", 4, dict(out=256, worldW=50, stage="fresh")),   # double-lobed
    ("puff", "fx_dust_puffs_a", 5, dict(out=224, worldW=32, stage="fresh")),   # small compact
    ("puff", "fx_dust_puffs_b", 0, dict(out=256, worldW=56, stage="thin")),    # low drifting veil
    ("puff", "fx_dust_puffs_b", 1, dict(out=256, worldW=48, stage="thin")),    # rounded soft puff
    ("puff", "fx_dust_puffs_b", 2, dict(out=256, worldW=50, stage="thin")),    # leaning left
    ("puff", "fx_dust_puffs_b", 3, dict(out=256, worldW=50, stage="thin")),    # two merging puffs
    ("puff", "fx_dust_puffs_b", 4, dict(out=256, worldW=58, stage="thin")),    # flat ground-hugging smear
    ("puff", "fx_dust_puffs_b", 5, dict(out=224, worldW=36, stage="thin")),    # small rising curl
    ("plume", "fx_dust_plume_a", None, dict(out=400, worldW=140)),
    ("plume", "fx_dust_plume_b", None, dict(out=400, worldW=110)),
    ("spray", "fx_dust_spray_a", None, dict(out=360, worldW=64)),
    ("spray", "fx_dust_spray_b", None, dict(out=360, worldW=50)),
    ("burst", "fx_dust_burst_a", None, dict(out=400, worldW=150)),                # landing
    ("burst", "fx_dust_burst_b", None, dict(out=400, worldW=180)),                # crash / heavy impact
]

# alpha shaping a' = min(1, gain * a ** gamma)
ALPHA_SHAPE = {"puff": (1.35, 0.85), "plume": (1.25, 0.85), "burst": (1.3, 0.88)}
THIN_PUFF_SHAPE = (1.3, 0.8)              # puffs_b: settling puffs, rendered thinner
SPRAY_DUST = (1.8, 0.45)                  # spray: fine dust between the grains
SPRAY_GRAIN_L = (95.0, 160.0)             # luminance ramp: <= 95 fully "grain" (kept crisp), >= 160 fully "dust"

MARGIN = 0.07            # transparent margin around the trimmed element, fraction of its larger side
BASE_FADE = 0.035        # soft fade below the dense base, fraction of the element height
MAX_W = 400


# ----------------------------------------------------------------------------------------------------------------------
# helpers

def to_float(img: Image.Image):
    a = np.asarray(img.convert("RGBA")).astype(np.float32)
    return a[..., :3], a[..., 3] / 255.0


def from_float(rgb, alpha) -> Image.Image:
    out = np.dstack([np.clip(rgb, 0, 255), np.clip(alpha, 0, 1) * 255.0])
    return Image.fromarray(np.round(out).astype(np.uint8), "RGBA")


def luma(rgb):
    return rgb[..., 0] * 0.2126 + rgb[..., 1] * 0.7152 + rgb[..., 2] * 0.0722


def soft_components(img: Image.Image, count: int, rows: int = 2, thresh: float = 0.10, dilate: int = 18,
                    feather: float = 10.0):
    """Split a sheet into its `count` largest elements (reading order: rows then columns) with FEATHERED masks:
    the component mask is dilated and blurred before it multiplies alpha, so the faint wisps fade out naturally
    instead of being cut at a threshold contour."""
    rgb, alpha = to_float(img)
    mask = ndimage.binary_dilation(alpha > thresh, iterations=dilate)
    lab, n = ndimage.label(mask)
    sizes = ndimage.sum(np.ones_like(alpha), lab, index=np.arange(1, n + 1))
    order = list(np.argsort(sizes)[::-1][:count] + 1)
    boxes = ndimage.find_objects(lab)
    items = []
    for idx in order:
        sl = boxes[idx - 1]
        soft = ndimage.gaussian_filter((lab == idx).astype(np.float32), feather)
        soft = np.clip(soft * 2.0, 0, 1)
        cy, cx = (sl[0].start + sl[0].stop) / 2, (sl[1].start + sl[1].stop) / 2
        items.append(((int(cy / (img.height / rows)), cx), from_float(rgb, alpha * soft)))
    items.sort(key=lambda t: t[0])
    return [it for _, it in items]


def trim_rgba(img: Image.Image, thresh: float = 1.5 / 255):
    rgb, alpha = to_float(img)
    ys, xs = np.nonzero(alpha > thresh)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    return from_float(rgb[y0:y1, x0:x1], alpha[y0:y1, x0:x1])


def base_row(alpha: np.ndarray) -> int:
    """Ground-contact row of the dense base: lowest row whose dense coverage is >= 30 % of the widest row's."""
    dense = (alpha > 0.45).sum(axis=1).astype(np.float32)
    if dense.max() <= 0:
        return alpha.shape[0] - 1
    rows = np.nonzero(dense >= 0.30 * dense.max())[0]
    return int(rows.max())


def fade_below_base(alpha, base: int, frac: float):
    """Alpha stays as is down to `base - f`, then eases to 0 at `base + f` (no hard ground line under the dust)."""
    h = alpha.shape[0]
    f = max(3.0, frac * h)
    y = np.arange(h, dtype=np.float32)
    t = np.clip((y - (base - f)) / (2 * f), 0, 1)
    k = 1.0 - (t * t * (3 - 2 * t))
    return alpha * k[:, None]


def grade(rgb, alpha, desat, target=DUST_TARGET, light=0.06):
    """Desaturate, then per-channel gain mapping the light dense dust to DUST_TARGET (grains keep their relative
    darkness), plus a gentle upper-left -> lower-right light falloff."""
    L = luma(rgb)[..., None]
    rgb = L + (rgb - L) * desat
    Lf = luma(rgb)
    m = (alpha > 0.5) & (Lf >= np.percentile(Lf[alpha > 0.5], 45))    # the light dust, not the dark grains
    mean = (rgb[m] * alpha[m][:, None]).sum(0) / alpha[m].sum()
    gain = np.asarray(target, np.float32) / np.maximum(mean, 1.0)
    rgb = rgb * gain
    h, w = alpha.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = (xx / max(w - 1, 1) + yy / max(h - 1, 1)) / 2.0 - 0.5      # -0.5 upper-left .. +0.5 lower-right
    rgb = rgb * (1.0 - light * 2 * d)[..., None]
    # soft shoulder: sunlit tops stay pale sand, never clip to paper white
    mx = rgb.max(axis=-1, keepdims=True)
    knee = 228.0
    over = np.maximum(mx - knee, 0)
    rgb = rgb * np.where(mx > knee, (knee + 16.0 * (1 - np.exp(-over / 16.0))) / np.maximum(mx, 1), 1.0)
    return np.clip(rgb, 0, 255)


def pad(img: Image.Image, frac: float) -> Image.Image:
    m = int(round(frac * max(img.size))) + 4
    out = Image.new("RGBA", (img.width + 2 * m, img.height + 2 * m), (0, 0, 0, 0))
    out.paste(img, (m, m))
    return out


def resize_premul(img: Image.Image, size) -> Image.Image:
    rgb, alpha = to_float(img)
    pre = np.dstack([rgb * alpha[..., None], alpha * 255.0])
    # resize each premultiplied channel separately ("L" images) so PIL does not premultiply again
    chans = [Image.fromarray(np.clip(pre[..., i], 0, 255).astype(np.uint8), "L").resize(size, Image.LANCZOS)
             for i in range(4)]
    p = np.dstack([np.asarray(c).astype(np.float32) for c in chans])
    a = p[..., 3] / 255.0
    rgb2 = np.where(a[..., None] > 1e-3, p[..., :3] / np.maximum(a[..., None], 1e-3), 0)
    return from_float(rgb2, a)


def anchor_for(kind: str, alpha: np.ndarray):
    h, w = alpha.shape
    if kind in ("puff", "burst"):
        base = base_row(alpha)
        band = alpha[max(0, base - int(0.2 * h)):base + 1]
        xs = np.arange(w, dtype=np.float32)
        cx = float((band.sum(0) * xs).sum() / max(band.sum(), 1e-3))
        return [cx / w, (base + 0.5) / h]
    if kind == "plume":
        base = base_row(alpha)
        band = alpha[max(0, base - int(0.35 * h)):base + 1] > 0.45
        colsum = band.sum(0)
        cols = np.nonzero(colsum >= max(2, 0.15 * colsum.max()))[0]
        return [(float(cols.max()) + 0.5) / w, (base + 0.5) / h]
    # spray: fan origin = the bottom-right end of the dense stream
    ys, xs = np.nonzero(alpha > 0.5)
    score = xs / w + ys / h
    sel = score >= np.quantile(score, 0.997)
    return [float(xs[sel].mean() + 0.5) / w, float(ys[sel].mean() + 0.5) / h]


def build_one(kind, stem, comp, opts, cache):
    if stem not in cache:
        src = load_rgba(RAW / f"{stem}.png")
        assert (alpha_of(src) < 250).mean() > 0.02, f"{stem}: no real alpha"
        cache[stem] = (src, soft_components(src, 6) if comp is not None else None)
    src, comps = cache[stem]
    el = trim_rgba(comps[comp] if comp is not None else src)
    rgb, alpha = to_float(el)
    # colour first, on the untouched alpha (the dust / grain split below would bias the dust mean toward grains)
    rgb = grade(rgb, alpha, DESAT[kind], SPRAY_DUST_TARGET if kind == "spray" else DUST_TARGET)
    if kind == "spray":
        L = luma(rgb)
        w_grain = np.clip((SPRAY_GRAIN_L[1] - L) / (SPRAY_GRAIN_L[1] - SPRAY_GRAIN_L[0]), 0, 1)
        g, k = SPRAY_DUST
        alpha = np.clip(alpha * w_grain + k * alpha ** g * (1 - w_grain), 0, 1)
    else:
        g, k = THIN_PUFF_SHAPE if opts.get("stage") == "thin" else ALPHA_SHAPE[kind]
        alpha = np.clip(k * alpha ** g, 0, 1)
        alpha = fade_below_base(alpha, base_row(alpha), BASE_FADE)
    el = pad(trim_rgba(from_float(rgb, alpha)), MARGIN)
    s = opts["out"] / max(el.size)
    if el.width * s > MAX_W:
        s = MAX_W / el.width
    out = resize_premul(el, (max(8, round(el.width * s)), max(8, round(el.height * s))))
    a = alpha_of(out).astype(np.float32) / 255.0
    anchor = anchor_for(kind, a)
    return out, [round(anchor[0], 3), round(anchor[1], 3)]


def edge_report(img: Image.Image) -> tuple[int, int]:
    """(max alpha in the outer 3 px ring, width in px of the fully transparent border band)."""
    a = alpha_of(img)
    ring = np.concatenate([a[:3].ravel(), a[-3:].ravel(), a[:, :3].ravel(), a[:, -3:].ravel()])
    ys, xs = np.nonzero(a > 0)
    gap = min(xs.min(), ys.min(), a.shape[1] - 1 - xs.max(), a.shape[0] - 1 - ys.max())
    return int(ring.max()), int(gap)


# ----------------------------------------------------------------------------------------------------------------------
# previews

def preview_sprites(items):
    """Every sprite over #dfe0e6 and over a crop of the reference ground (red cross = anchor), one sheet per kind."""
    paths = []
    ground_full = load_rgba(REFERENCE)
    for kind in ("puff", "plume", "spray", "burst"):
        sel = [(e, im) for e, im in items if e["kind"] == kind]
        cell = (440, 300) if kind in ("puff", "spray") else (600, 280)
        cols = 2
        sheet = Image.new("RGBA", (cols * cell[0] * 2 + 30, ((len(sel) + 1) // 2) * (cell[1] + 20)), (255, 255, 255, 255))
        d = ImageDraw.Draw(sheet)
        for i, (entry, img) in enumerate(sel):
            gx, gy = (i % 2) * (cell[0] * 2 + 30), (i // 2) * (cell[1] + 20)
            t = img.copy()
            t.thumbnail((cell[0] - 16, cell[1] - 16), Image.LANCZOS)
            ox, oy = (cell[0] - t.width) // 2, (cell[1] - t.height) // 2
            grey = Image.new("RGBA", cell, (223, 224, 230, 255))
            grey.alpha_composite(t, (ox, oy))
            dg = ImageDraw.Draw(grey)
            dg.rectangle([ox, oy, ox + t.width - 1, oy + t.height - 1], outline=(170, 170, 180, 255))
            ax, ay = ox + entry["anchor"][0] * t.width, oy + entry["anchor"][1] * t.height
            dg.line([ax - 8, ay, ax + 8, ay], fill=(220, 30, 30, 255))
            dg.line([ax, ay - 8, ax, ay + 8], fill=(220, 30, 30, 255))
            # reference ground: the sprite's anchor on the reference running line (sky / mountains / ground behind)
            scale = t.width / img.width
            src_w, src_h = round(cell[0] / scale / 2.2), round(cell[1] / scale / 2.2)
            cx0 = 700
            gnd = ground_full.crop((cx0, 600 - src_h * 0.75, cx0 + src_w, 600 + src_h * 0.25)).resize(cell, Image.LANCZOS)
            place(gnd, img, entry["anchor"], (cell[0] / 2 + (entry["anchor"][0] - 0.5) * t.width, cell[1] * 0.75),
                  t.width)
            sheet.alpha_composite(grey, (gx, gy))
            sheet.alpha_composite(gnd, (gx + cell[0], gy))
            d.text((gx + 4, gy + cell[1] + 3),
                   f"{pathlib.Path(entry['src']).name}  {entry['w']}x{entry['h']}  anchor={entry['anchor']}  "
                   f"worldW={entry['worldW']}" + (f"  stage={entry['stage']}" if "stage" in entry else ""),
                   fill=(20, 20, 20, 255))
        p = PREVIEW_DIR / f"fx_dust_sprites_{kind}.png"
        sheet.convert("RGB").save(p)
        paths.append(p)
    return paths


def place(canvas: Image.Image, img: Image.Image, anchor, at, width_px, alpha=1.0):
    """Alpha-composite `img` scaled to `width_px` with its normalized `anchor` on canvas point `at` (clipped)."""
    s = width_px / img.width
    t = resize_premul(img, (max(2, round(img.width * s)), max(2, round(img.height * s))))
    if alpha < 1.0:
        a = np.asarray(t).copy()
        a[..., 3] = np.round(a[..., 3].astype(np.float32) * alpha).astype(np.uint8)
        t = Image.fromarray(a, "RGBA")
    x = round(at[0] - anchor[0] * t.width)
    y = round(at[1] - anchor[1] * t.height)
    cx0, cy0 = max(0, -x), max(0, -y)
    t = t.crop((cx0, cy0, t.width, t.height))
    layer = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    layer.paste(t, (max(0, x), max(0, y)))
    canvas.alpha_composite(layer)


def leg_mask(img: Image.Image, box, ground_y, thr):
    """Soft mask of the dino's (dark) legs inside `box` above `ground_y`, to redraw them over the dust (the engine
    draws running dust BEHIND the dino)."""
    rgb = np.asarray(img.convert("RGB")).astype(np.float32)
    L = luma(rgb)
    m = np.zeros(L.shape, bool)
    x0, y0, x1, y1 = box
    m[y0:min(y1, ground_y + 1), x0:x1] = L[y0:min(y1, ground_y + 1), x0:x1] < thr
    m = ndimage.binary_opening(m, iterations=1)
    lab, n = ndimage.label(m)
    if n:
        sizes = ndimage.sum(m, lab, index=np.arange(1, n + 1))
        m = np.isin(lab, np.nonzero(sizes >= 40)[0] + 1)
    m = ndimage.binary_closing(m, iterations=2)
    m = ndimage.binary_dilation(m, iterations=1)
    return ndimage.gaussian_filter(m.astype(np.float32), 0.7)


def restore(dst: Image.Image, src: Image.Image, mask) -> Image.Image:
    a = np.asarray(dst).astype(np.float32)
    b = np.asarray(src).astype(np.float32)
    k = mask[..., None]
    return Image.fromarray(np.round(a * (1 - k) + b * k).astype(np.uint8), "RGBA")


def clean_plate(ref: Image.Image) -> Image.Image:
    """The reference with its own dust painted out (a feathered patch of the same rows from further right), so the
    composite shows only our sprites."""
    out = ref.copy()
    x0, x1, y0, y1 = 40, 215, 538, 607
    dx = 300
    patch = ref.crop((x0 + dx, y0, x1 + dx, y1))
    h, w = y1 - y0, x1 - x0
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    fx = np.minimum(np.clip(xx / 24, 0, 1), np.clip((w - 1 - xx) / 24, 0, 1))
    fy = np.minimum(np.clip(yy / 10, 0, 1), np.clip((h - 1 - yy) / 5, 0, 1))
    m = (fx * fy)
    base = np.asarray(out.crop((x0, y0, x1, y1))).astype(np.float32)
    pa = np.asarray(patch).astype(np.float32)
    mix = base * (1 - m[..., None]) + pa * m[..., None]
    out.paste(Image.fromarray(np.round(mix).astype(np.uint8), "RGBA"), (x0, y0))
    return out


def dust_scene(base: Image.Image, foot, ground_y, upw, lib, variant=0):
    """Mock running frame: a trailing plume, three puffs of different ages and a toe-off spray behind the rear foot.
    upw = pixels per world unit."""
    by = {k: [(e, im) for e, im in lib if e["kind"] == k] for k in ("puff", "plume", "spray", "burst")}
    fresh = [p for p in by["puff"] if p[0].get("stage") != "thin"]
    thin = [p for p in by["puff"] if p[0].get("stage") == "thin"] or fresh
    out = base.copy()
    fx = foot[0]
    e, im = by["plume"][variant % len(by["plume"])]
    place(out, im, e["anchor"], (fx - 6 * upw, ground_y), e["worldW"] * upw, alpha=0.7)
    # older / thinner puffs further left and larger, the fresh one right behind the foot
    e, im = thin[(variant * 3) % len(thin)]
    place(out, im, e["anchor"], (fx - 46 * upw, ground_y), e["worldW"] * upw * 1.3, alpha=0.55)
    e, im = thin[(variant * 3 + 1) % len(thin)]
    place(out, im, e["anchor"], (fx - 26 * upw, ground_y), e["worldW"] * upw * 1.05, alpha=0.7)
    e, im = fresh[(variant * 4) % len(fresh)]
    place(out, im, e["anchor"], (fx - 12 * upw, ground_y), e["worldW"] * upw * 0.95, alpha=0.8)
    e, im = by["spray"][variant % len(by["spray"])]
    place(out, im, e["anchor"], (fx - 2 * upw, ground_y - 1 * upw), e["worldW"] * upw, alpha=0.9)
    return out


def zoom_stack(images, box, scale=2, gap=10):
    w, h = (box[2] - box[0]) * scale, (box[3] - box[1]) * scale
    out = Image.new("RGBA", (w, len(images) * (h + gap) - gap), (255, 255, 255, 255))
    for i, im in enumerate(images):
        out.alpha_composite(im.crop(box).resize((w, h), Image.LANCZOS), (0, i * (h + gap)))
    return out


def preview_composites(lib):
    paths = []
    ref = load_rgba(REFERENCE)
    upw = ref.height / 540.0              # reference framing ~ in-game framing (dino ~0.19 H)
    foot, gy = (190, 598), 600            # lifted rear (pushing-off) foot of the reference T-rex, running line
    legs = leg_mask(ref, (150, 500, 290, 620), gy - 1, 150)
    plate = clean_plate(ref)
    comps = [restore(dust_scene(plate, foot, gy, upw, lib, v), ref, legs) for v in (0, 1)]
    over_ref = restore(dust_scene(ref, foot, gy, upw, lib, 0), ref, legs)
    p = PREVIEW_DIR / "fx_dust_composite.png"
    comps[0].convert("RGB").save(p)
    paths.append(p)
    # zoom: original reference / clean plate + our dust (2 variants) / reference (own dust kept) + our dust
    p = PREVIEW_DIR / "fx_dust_composite_zoom.png"
    zoom_stack([ref, comps[0], comps[1], over_ref], (0, 440, 480, 640)).convert("RGB").save(p)
    paths.append(p)
    # 4x detail around the feet: reference (its own dust) vs clean plate + our sprites
    p = PREVIEW_DIR / "fx_dust_composite_detail.png"
    zoom_stack([ref, comps[0], comps[1]], (30, 520, 290, 620), scale=4).convert("RGB").save(p)
    paths.append(p)
    # landing / crash bursts
    bursts = [(e, im) for e, im in lib if e["kind"] == "burst"]
    frames = []
    for e, im in bursts:
        b = plate.copy()
        place(b, im, e["anchor"], (215, gy), e["worldW"] * upw, alpha=0.8)
        frames.append(restore(b, ref, legs))
    p = PREVIEW_DIR / "fx_dust_composite_burst.png"
    zoom_stack(frames, (0, 440, 480, 640)).convert("RGB").save(p)
    paths.append(p)
    # current game look (docs/screenshots/hero.png, 1600x632): before / after
    hero_p = ROOT / "docs" / "screenshots" / "hero.png"
    if hero_p.is_file():
        hero = load_rgba(hero_p)
        hu = hero.height / 540.0
        hfoot, hgy = (116, 474), 478
        hlegs = leg_mask(hero, (95, 400, 240, 490), hgy - 1, 125)
        hcs = [restore(dust_scene(hero, hfoot, hgy, hu, lib, v), hero, hlegs) for v in (0, 1)]
        p = PREVIEW_DIR / "fx_dust_composite_game.png"
        zoom_stack([hero, hcs[0]], (0, 330, 460, 530)).convert("RGB").save(p)
        paths.append(p)
        p = PREVIEW_DIR / "fx_dust_composite_game_detail.png"
        zoom_stack([hero] + hcs, (20, 400, 260, 500), scale=4).convert("RGB").save(p)
        paths.append(p)
    return paths


def preview_lifecycle(lib):
    """How a footfall puff reads over time over the reference ground (top row: a fresh puff; bottom row: a thin puff),
    animated the way an engine would: spawn small, expand ~2.3x, drift left, fade out. Scale: 3x the in-game size
    at the reference framing (dino 0.19 H)."""
    ref = load_rgba(REFERENCE)
    upw = ref.height / 540.0 * 3.0
    cell = (300, 220)
    gy = 168                                                   # running line inside a cell
    # background: the reference's running line around x = 1110, 3x
    bg = ref.crop((1080, 600 - gy / 3, 1080 + cell[0] / 3, 600 + (cell[1] - gy) / 3)).resize(cell, Image.LANCZOS)
    fresh = [(e, im) for e, im in lib if e["kind"] == "puff" and e.get("stage") != "thin"]
    thin = [(e, im) for e, im in lib if e["kind"] == "puff" and e.get("stage") == "thin"] or fresh
    ts = [0.04, 0.15, 0.3, 0.5, 0.7, 0.9]
    out = Image.new("RGBA", (cell[0] * len(ts), cell[1] * 2 + 36), (255, 255, 255, 255))
    d = ImageDraw.Draw(out)
    for r, (e, im) in enumerate([fresh[0], thin[1 % len(thin)]]):
        for i, t in enumerate(ts):
            tile = bg.copy()
            a = 0.9 * min(1.0, t / 0.08) * (1 - t) ** 1.2
            w = e["worldW"] * upw * (0.45 + 1.3 * t)
            place(tile, im, e["anchor"], (cell[0] * 0.62 - 26 * upw * t, gy), w, alpha=a)
            out.alpha_composite(tile, (i * cell[0], r * (cell[1] + 18)))
            d.text((i * cell[0] + 4, r * (cell[1] + 18) + cell[1] + 3),
                   f"{pathlib.Path(e['src']).name} t={t:.2f} scale={0.45 + 1.3 * t:.2f} a={a:.2f}", fill=(20, 20, 20, 255))
    p = PREVIEW_DIR / "fx_dust_lifecycle.png"
    out.convert("RGB").save(p)
    return p


# ----------------------------------------------------------------------------------------------------------------------

def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for old in OUT_DIR.glob("dust_*.webp"):
        old.unlink()
    cache, counters, entries, lib = {}, {}, [], []
    total = 0
    for kind, stem, comp, opts in SPRITES:
        img, anchor = build_one(kind, stem, comp, opts, cache)
        n = counters.get(kind, 0)
        counters[kind] = n + 1
        path = OUT_DIR / f"dust_{kind}_{n}.webp"
        save_webp(img, path, quality=88)
        size = path.stat().st_size
        total += size
        entry = {"src": rel(path), "w": img.width, "h": img.height, "kind": kind, "anchor": anchor,
                 "worldW": opts["worldW"]}
        if "stage" in opts:
            entry["stage"] = opts["stage"]
        entries.append(entry)
        game = load_rgba(path)                     # previews show exactly what the game decodes
        lib.append((entry, game))
        ring, gap = edge_report(game)
        assert ring == 0 and gap >= 6, f"{path.name}: alpha reaches the edge (ring max {ring}, clear band {gap}px)"
        print(f"{path.name:20s} {img.width:4d}x{img.height:<4d} {size / 1024:6.1f} KB  anchor={anchor}  "
              f"clear-border={gap}px  src={stem}[{comp}]")
    print(f"total {total / 1024:.1f} KB ({len(entries)} sprites)")
    assert total <= 600 * 1024, "fx budget exceeded"
    frag = write_fragment("fx", {"fx": {"dust": entries}})
    print("fragment:", frag)
    for p in (*preview_sprites(lib), *preview_composites(lib), preview_lifecycle(lib)):
        print("preview:", p)


if __name__ == "__main__":
    main()
