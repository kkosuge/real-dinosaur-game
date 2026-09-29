#!/usr/bin/env python
"""Cactus obstacles pipeline (reproducible).

    raw codex outputs   assets/raw/cactus_{large,small}_<k>.png   (native RGBA from codex image gen)
 -> game-ready sprites  assets/obstacles/cactus_{large,small}_<n>.webp
 -> manifest fragment   assets/manifest/cactus.json               (SPEC §4 cactus.json)
 -> QA previews         assets/previews/cactus_*.png

Steps per sprite: verify real alpha -> drop specks -> crop so the base (small soil mound) sits on the bottom row ->
colour-match to the saguaro in reference/screen.webp (per-channel gain toward a shared target mean, so all variants
share one palette) -> upper-left form shading -> premultiplied LANCZOS downscale to the class pixel height ->
hitboxes = greedy cover of the solid (alpha>140, spine fuzz removed) body with rectangles lying fully inside it
(see cactus_hitboxes: common.compute_hitboxes' full-width bands would cover the empty arm/trunk gaps).

Run:  <venv>/bin/python tools/assets/cactus.py
"""
from __future__ import annotations

import pathlib
import random
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import *  # noqa: E402,F401,F403
from common import ROOT, RAW, PREVIEW_DIR, REFERENCE  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter, ImageFont  # noqa: E402
from scipy import ndimage  # noqa: E402

OUT_DIR = ROOT / "assets" / "obstacles"

# (raw file stem, per-sprite height scale relative to the class height). Output index n = list position.
VARIANTS = {
    "large": [
        # stocky saguaros matching the reference cactus' proportions (trunk ≈ 0.15 of height)
        ("cactus_large_5", 1.00),  # classic two-arm candelabra (twin of the reference saguaro)
        ("cactus_large_6", 0.97),  # single right arm
        ("cactus_large_7", 1.03),  # three arms, asymmetric
        ("cactus_large_8", 0.99),  # two arms at different heights
        # (raw cactus_large_1..4 are an earlier, too-slender generation kept only for provenance)
    ],
    "small": [
        ("cactus_small_1", 1.00),  # young armless saguaro
        ("cactus_small_2", 1.04),  # young saguaro with one tiny arm
        ("cactus_small_3", 0.90),  # fishhook barrel cactus (wider, so a bit shorter)
        ("cactus_small_4", 0.97),  # young organ-pipe clump
    ],
}
# Pixel height of a sprite whose scale is 1.0. Both classes end up at ~3.9 px per world unit
# (large ≈ 0.23 H = 124u, small ≈ 0.14 H = 76u, H = 540u), so no upscaling at 1440p.
BASE_H = {"large": 480, "small": 300}
HITBOX_MAX_RECTS = {"large": 10, "small": 10}

# Colour target: mean RGB of fully opaque cactus pixels after grading, taken from the saguaro in the reference photo
# (its opaque pixels average ≈ (84, 74, 57)).
TARGET_MEAN = np.array([85.0, 76.0, 58.0])
# Directional form shading (codex renders are rather flat-lit; the reference saguaro is clearly lit from the
# upper-left with a dark right half). Light factor from the gradient of the blurred alpha (a cheap outward normal).
SHADE_SIGMA = 0.2            # blur sigma as a fraction of the typical stem width
SHADE_LIT = 0.12             # max brightening on the lit (left/top) side
SHADE_DARK = 0.32            # max darkening on the shaded (right) side
SHADE_LY = 0.35              # vertical weight of the light direction (tops a little lit)
GRADE_STRENGTH = 0.85        # 1.0 = full per-channel mean match
SAT_SCALE = 0.92             # a touch more muted than the codex output


# ----------------------------------------------------------------------------------------------------------------------
def load_raw(stem: str) -> Image.Image:
    img = load_rgba(RAW / f"{stem}.png")
    a = alpha_of(img)
    if (a < 250).mean() < 0.05:
        # Codex returned an opaque image: fall back to chroma keying (should not happen with transparent_background).
        print(f"  ! {stem}: no native alpha, chroma-keying", file=sys.stderr)
        img = ensure_alpha(img)
    return img


def crop_to_plant(img: Image.Image) -> Image.Image:
    """Tight crop; the bottom edge is the last row that still has solid (alpha>128) pixels, so the base touches it."""
    a = alpha_of(img)
    solid_rows = np.nonzero((a > 128).sum(axis=1) >= 3)[0]
    y_bottom = int(solid_rows.max()) + 1
    img = img.crop((0, 0, img.width, y_bottom))
    x0, y0, x1, _ = bbox(img, thresh=8)
    return img.crop((x0, y0, x1, y_bottom))


def grade(img: Image.Image) -> Image.Image:
    """Per-channel gain toward TARGET_MEAN (measured on solid pixels) + slight desaturation. Keeps texture intact."""
    a = np.asarray(img).astype(np.float32)
    rgb, al = a[..., :3], a[..., 3]
    solid = al > 250
    mean = rgb[solid].mean(axis=0)
    gain = 1.0 + GRADE_STRENGTH * (TARGET_MEAN / mean - 1.0)
    rgb = rgb * gain
    lum = rgb @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    rgb = lum[..., None] + SAT_SCALE * (rgb - lum[..., None])
    a[..., :3] = np.clip(rgb, 0, 255)
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def stem_width(img: Image.Image) -> float:
    """Typical stem width in px: length-weighted median of the horizontal runs of the solid body."""
    body = alpha_of(img) > 128
    widths = []
    for row in body[:: max(1, body.shape[0] // 200)]:
        d = np.diff(np.concatenate([[0], row.astype(np.int8), [0]]))
        starts, stops = np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]
        widths.extend((stops - starts).tolist())
    widths = np.asarray([w for w in widths if w > 2], dtype=float)
    if len(widths) == 0:
        return img.width * 0.5
    order = np.sort(widths)
    cum = np.cumsum(order)
    return float(order[np.searchsorted(cum, cum[-1] / 2)])


def shade(img: Image.Image) -> Image.Image:
    """Left/upper-left key light, darker right side: modulate RGB by the (normalised) x/y gradient of the blurred
    alpha, i.e. an outward-normal estimate that works on every stem and arm alike."""
    a = np.asarray(img).astype(np.float32)
    al = a[..., 3] / 255.0
    body = al > 0.5
    blur = ndimage.gaussian_filter(al, SHADE_SIGMA * stem_width(img))
    gy, gx = np.gradient(blur)
    s = gx + SHADE_LY * gy
    s = np.clip(s / (np.percentile(np.abs(s[body]), 95) + 1e-6), -1.0, 1.0)
    f = np.where(s > 0, 1.0 + SHADE_LIT * s, 1.0 + SHADE_DARK * s)
    a[..., :3] = np.clip(a[..., :3] * f[..., None], 0, 255)
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def resize_premul(img: Image.Image, h: int) -> Image.Image:
    w = max(1, round(img.width * h / img.height))
    return img.convert("RGBa").resize((w, h), Image.LANCZOS).convert("RGBA")


def base_span(img: Image.Image):
    """x-centre and width of the plant where it meets the ground (bottom 3% rows), for contact shadows."""
    a = alpha_of(img)
    rows = a[int(img.height * 0.97):] > 128
    xs = np.nonzero(rows.any(axis=0))[0]
    if len(xs) == 0:
        return img.width / 2, img.width * 0.3
    return (xs.min() + xs.max() + 1) / 2.0, float(xs.max() + 1 - xs.min())


def _maximal_rects(mask: np.ndarray, min_w: int, min_h: int) -> np.ndarray:
    """Every maximal all-True rectangle of `mask` that is at least min_w x min_h, as an (N, 4) array of x, y, w, h.
    (Histogram-stack enumeration: for each bottom row, each maximal-width rectangle of each achievable height.)"""
    H, W = mask.shape
    heights = np.zeros(W + 1, dtype=np.int64)
    out = []
    for y in range(H):
        heights[:W] = np.where(mask[y], heights[:W] + 1, 0)
        hs = heights.tolist()
        stack = []
        for x in range(W + 1):
            h = hs[x]
            start = x
            while stack and stack[-1][1] >= h:
                sx, sh = stack.pop()
                if x - sx >= min_w and sh >= min_h:
                    out.append((sx, y - sh + 1, x - sx, sh))
                start = sx
            stack.append((start, h))
    return np.asarray(out, dtype=np.int64).reshape(-1, 4)


def cactus_hitboxes(img: Image.Image, thresh: int = 140, max_rects: int = 8, min_frac: float = 0.012,
                    erode: int = 1, min_w_frac: float = 0.04, min_h: int = 6):
    """Fair, stem-aware hitboxes: greedy cover of the solid body with rectangles that lie entirely inside it.

    common.compute_hitboxes() takes full-width horizontal bands, which on a saguaro also cover the empty U-gap between
    each arm and the trunk and the empty space beside the trunk above an arm tip (the player would die to transparent
    pixels there). Here instead:  solid body = alpha > thresh, 3x3 opening (drops spine fuzz), eroded by `erode` px
    (slight under-cover)  ->  enumerate every maximal rectangle inside the body  ->  greedily pick the one covering
    the most not-yet-covered body pixels (trunk first, then arms, elbows, dome tops), until `max_rects` or the next
    one would add < `min_frac` of the body. Rects may overlap each other but never cover a transparent pixel; rects
    narrower than `min_w_frac` of the sprite width are ignored (no slivers). Arms are included as their own rects.
    """
    a = alpha_of(img)
    body = ndimage.binary_opening(a > thresh, structure=np.ones((3, 3)))
    if erode:
        body = ndimage.binary_erosion(body, iterations=erode)
    total = int(body.sum())
    cand = _maximal_rects(body, max(4, round(min_w_frac * img.width)), min_h)
    x, y, w, h = cand.T
    free = body.copy()
    rects = []
    while len(rects) < max_rects and len(cand):
        sat = np.zeros((free.shape[0] + 1, free.shape[1] + 1), np.int64)
        sat[1:, 1:] = free.cumsum(0).cumsum(1)
        gain = sat[y + h, x + w] - sat[y, x + w] - sat[y + h, x] + sat[y, x]
        i = int(np.argmax(gain))
        if gain[i] < min_frac * total:
            break
        rx, ry, rw, rh = (int(v) for v in cand[i])
        rects.append([float(rx), float(ry), float(rw), float(rh)])
        free[ry:ry + rh, rx:rx + rw] = False
    covered = 1.0 - free.sum() / max(1, total)
    rects.sort(key=lambda r: (r[1], r[0]))
    return [[round(v, 1) for v in r] for r in rects], covered


def process(stem: str, cls: str, scale: float, idx: int):
    img = load_raw(stem)
    img = clean_alpha(img, min_alpha=6, keep_largest=0, min_blob_frac=0.0005)
    img = crop_to_plant(img)
    img = shade(grade(img))
    h = round(BASE_H[cls] * scale)
    img = resize_premul(img, h)
    img = clean_alpha(img, min_alpha=4, keep_largest=0, min_blob_frac=0.0)
    # re-seat the base on the bottom row after resampling (drops the faint antialias row under it)
    img = crop_to_plant(img)
    boxes, covered = cactus_hitboxes(img, max_rects=HITBOX_MAX_RECTS[cls])
    print(f"  {stem} -> {cls}_{idx}: {len(boxes)} hitboxes cover {covered:.0%} of the solid body")
    out = OUT_DIR / f"cactus_{cls}_{idx}.webp"
    save_webp(img, out, quality=88)
    bx, bw = base_span(img)
    entry = {
        "src": rel(out),
        "w": img.width,
        "h": img.height,
        "hitboxes": boxes,
        "scale": scale,
        "baseX": round(bx, 1),      # extra (optional): centre of the trunk base, for the contact shadow
        "baseW": round(bw, 1),      # extra (optional): width of the base at ground level
    }
    return img, entry


# ----------------------------------------------------------------------------------------------------------------------
# QA previews
def _font(size: int):
    for p in ("/System/Library/Fonts/Menlo.ttc", "/System/Library/Fonts/Helvetica.ttc",
              "/System/Library/Fonts/Supplemental/Arial.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except Exception:
            pass
    return ImageFont.load_default()


def preview_hitboxes(sprites):
    """(a) every final sprite over #dfe0e6 at native resolution, hitboxes as thin red outlines, labels."""
    font = _font(15)
    pad, label_h = 24, 40
    rows = []
    for cls in ("large", "small"):
        items = sprites[cls]
        cells = [max(im.width, 150) for im, _ in items]
        w = sum(cells) + pad * (len(items) + 1)
        h = max(im.height for im, _ in items) + pad * 2 + label_h
        row = Image.new("RGBA", (w, h), (223, 224, 230, 255))
        d = ImageDraw.Draw(row)
        x = pad
        for i, (im, e) in enumerate(items):
            y = h - label_h - im.height
            ox = x + (cells[i] - im.width) // 2
            fill = Image.new("RGBA", im.size, (0, 0, 0, 0))
            fd = ImageDraw.Draw(fill)
            for bx, by, bw, bh in e["hitboxes"]:
                fd.rectangle([bx, by, bx + bw, by + bh], fill=(255, 0, 0, 38))
            tile = im.copy()
            tile.alpha_composite(fill)
            tile = draw_boxes(tile, e["hitboxes"], color=(255, 20, 20, 255), width=1)
            row.alpha_composite(tile, (ox, y))
            d.line([(x, y + im.height), (x + cells[i], y + im.height)], fill=(60, 60, 200, 255), width=1)
            d.text((x, h - label_h + 4), f"{cls}_{i}  {im.width}x{im.height}", fill=(20, 20, 20, 255), font=font)
            d.text((x, h - label_h + 21), f"{len(e['hitboxes'])} boxes  x{e['scale']}", fill=(90, 90, 90, 255), font=font)
            x += cells[i] + pad
        rows.append(row)
    W = max(r.width for r in rows)
    sheet = Image.new("RGBA", (W, sum(r.height for r in rows)), (223, 224, 230, 255))
    y = 0
    for r in rows:
        sheet.alpha_composite(r, (0, y))
        y += r.height
    p = PREVIEW_DIR / "cactus_hitboxes.png"
    sheet.convert("RGB").save(p)
    return p


def _shadow(canvas: Image.Image, cx: float, gy: float, width: float, strength: float = 0.28):
    """Soft elliptical contact shadow (as the engine will draw), multiplied onto the canvas."""
    w = max(8, int(width * 1.9))
    h = max(4, int(width * 0.22))
    m = Image.new("L", (w * 2, h * 4), 0)
    ImageDraw.Draw(m).ellipse([w // 2, h * 3 // 2, w * 3 // 2, h * 5 // 2], fill=int(255 * strength))
    m = m.filter(ImageFilter.GaussianBlur(h * 0.6))
    shade = Image.new("RGBA", m.size, (40, 34, 26, 0))
    shade.putalpha(m)
    canvas.alpha_composite(shade, (int(cx - w + width * 0.15), int(gy - h * 2)))


def _place(canvas: Image.Image, im: Image.Image, e: dict, x: float, gy: float, target_h: float, boxes=False):
    s = target_h / im.height
    sp = im.convert("RGBa").resize((max(1, round(im.width * s)), max(1, round(im.height * s))), Image.LANCZOS).convert("RGBA")
    _shadow(canvas, x + e["baseX"] * s, gy, e["baseW"] * s)
    canvas.alpha_composite(sp, (int(round(x)), int(round(gy - sp.height))))
    if boxes:
        d = ImageDraw.Draw(canvas)
        for bx, by, bw, bh in e["hitboxes"]:
            X, Y = x + bx * s, gy - sp.height + by * s
            d.rectangle([X, Y, X + bw * s, Y + bh * s], outline=(230, 0, 0, 255), width=1)
    return sp.width


def _group(canvas, items, x, gy, class_h, rng, boxes=False):
    """Engine-like group: 1–3 sprites side by side, slight overlap and height jitter."""
    for k, (im, e) in enumerate(items):
        th = class_h * e["scale"] * rng.uniform(0.97, 1.03)
        w = _place(canvas, im, e, x, gy, th, boxes)
        x += w * rng.uniform(0.78, 0.9)
    return x


def preview_groups(sprites):
    """(b) groups of 1–3 of the same class, as the engine places them, on strips of the reference ground."""
    ref = load_rgba(REFERENCE)
    H = ref.height                          # 789 → world H
    gy_ref = round(0.760 * H)               # GROUND_Y
    strip = ref.crop((0, 330, 1620, 700))    # left of the reference cactus, so only our sprites are on the strip
    gy = gy_ref - 330
    panels = []
    for cls, class_h in (("large", 0.22 * H), ("small", 0.14 * H)):
        items = sprites[cls]
        for boxes in (False, True):
            rng = random.Random(7 if cls == "large" else 11)   # same groups in both panels of a class
            pan = strip.copy()
            x = 440
            for count in (1, 2, 3, 2, 3):
                grp = [items[rng.randrange(len(items))] for _ in range(count)]
                x = _group(pan, grp, x, gy, class_h, rng, boxes) + 110
                if x > pan.width - 200:
                    break
            d = ImageDraw.Draw(pan)
            d.text((12, 10), f"{cls} groups 1–3 ({'hitboxes' if boxes else 'as rendered'}), class h = {class_h / H:.2f} H",
                   fill=(40, 40, 40, 255), font=_font(18))
            panels.append(pan)
    sheet = Image.new("RGBA", (strip.width, strip.height * len(panels)))
    for i, p in enumerate(panels):
        sheet.alpha_composite(p, (0, i * strip.height))
    p = PREVIEW_DIR / "cactus_groups.png"
    sheet.convert("RGB").save(p)
    return p


def preview_scene(sprites):
    """(c) composited into the full reference photo at in-game scale, next to the reference saguaro, + 2x detail crop."""
    ref = load_rgba(REFERENCE)
    H = ref.height
    gy = round(0.760 * H) - 2
    scene = ref.copy()
    L, S = 0.22 * H, 0.14 * H
    rng = random.Random(3)
    lg, sm = sprites["large"], sprites["small"]
    x = 560
    x = _group(scene, [sm[0]], x, gy, S, rng) + 120
    x = _group(scene, [lg[1]], x, gy, L, rng) + 150
    x = _group(scene, [sm[2], sm[1]], x, gy, S, rng) + 150
    x = _group(scene, [lg[2], lg[3]], x, gy, L, rng) + 130
    x = _group(scene, [sm[3]], x, gy, S, rng) + 110
    x = _group(scene, [lg[0]], 1480, gy, L, rng)   # right next to the reference cactus (at ~1665)
    scene.convert("RGB").save(PREVIEW_DIR / "cactus_scene.png")
    # 2x detail: our large_0 vs the reference saguaro
    crop = scene.crop((1440, 360, 1820, 620))
    crop = crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS)
    crop.convert("RGB").save(PREVIEW_DIR / "cactus_scene_detail.png")
    return [PREVIEW_DIR / "cactus_scene.png", PREVIEW_DIR / "cactus_scene_detail.png"]


def preview_dark(sprites):
    """Edge check: all sprites over a dark and a mid background (reveals halos / fringes)."""
    tiles = []
    for cls in ("large", "small"):
        for im, _ in sprites[cls]:
            for col in ((24, 24, 28, 255), (150, 150, 150, 255)):
                bg = Image.new("RGBA", im.size, col)
                bg.alpha_composite(im)
                tiles.append(bg)
    sheet = contact_sheet(tiles, cols=8, cell=(220, 480))
    p = PREVIEW_DIR / "cactus_edges.png"
    sheet.convert("RGB").save(p)
    return p


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    sprites = {"large": [], "small": []}
    for cls, variants in VARIANTS.items():
        for i, (stem, scale) in enumerate(variants):
            im, e = process(stem, cls, scale, i)
            sprites[cls].append((im, e))
            print(f"{e['src']}: {e['w']}x{e['h']}  boxes={len(e['hitboxes'])}  "
                  f"{(OUT_DIR / pathlib.Path(e['src']).name).stat().st_size // 1024} KB")
    frag = {"cactus": {cls: [e for _, e in sprites[cls]] for cls in ("large", "small")}}
    print("fragment:", write_fragment("cactus", frag))
    for p in (preview_hitboxes(sprites), preview_groups(sprites), *preview_scene(sprites), preview_dark(sprites)):
        print("preview:", p)


if __name__ == "__main__":
    main()
