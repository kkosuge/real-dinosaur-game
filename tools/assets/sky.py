#!/usr/bin/env python3
"""Sky asset group: day / dusk / night backgrounds, moon, clouds.

Reads the untouched Codex outputs in assets/raw/ (sky_*, moon_*, cloud_*), writes the game-ready files to
assets/scenery/, the manifest fragment assets/manifest/sky.json (SPEC §4) and QA previews assets/previews/sky*.png.

Deterministic: fixed seeds for grain/dither, no randomness otherwise. Run:
    python tools/assets/sky.py

Raw provenance (all generated with Codex's built-in image tool, reference/screen.webp attached):
    sky_day2.png   opaque ~21:9 midday sky, compact sun glare top-left            -> sky_day.webp
    sky_day.png    1st day attempt (3:1, glare far too large)                      -> unused, kept for provenance
    sky_dusk.png   opaque ~21:9 sunset sky (sky_day.png attached for framing)      -> sky_dusk.webp
    sky_night.png  opaque ~21:9 starry sky + faint Milky Way, no moon              -> sky_night.webp
    moon_b.png     transparent full moon (real near-side geography)               -> moon.webp
    moon_full.png  1st moon attempt (invented surface)                             -> unused
    cloud_1..5.png transparent single cumulus clouds                               -> cloud_1..5.webp
Horizon: all skies are exported at 2560x1080 with the horizon at horizonY=0.80 (>= SPEC HORIZON_Y 0.74, so a
plain cover-fit + horizon alignment never leaves a gap at the top). The sun/glare side is the LEFT edge: anchor
the sky horizontally at x=0 when the viewport is narrower than the image.
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import *  # noqa: E402,F401,F403
from common import ROOT, RAW, PREVIEW_DIR, REFERENCE, rel, load_rgba, trim, save_webp, write_fragment, \
    clean_alpha, on_background, contact_sheet  # noqa: E402

import numpy as np  # noqa: E402
from PIL import Image, ImageDraw, ImageFilter  # noqa: E402
from scipy import ndimage  # noqa: E402

OUT = ROOT / "assets" / "scenery"
SKY_W, SKY_H = 2560, 1080
HORIZON = 0.80                      # normalized y of the horizon in every exported sky
HZ_PX = round(HORIZON * SKY_H)      # 864

# Per-sky mapping raw -> export. `horizon_raw` = raw row (fraction of raw height) that becomes the horizon;
# `width_frac` = fraction of the raw width used (anchored at the left edge, where the sun is).
# The vertical scale follows from the horizontal one (uniform scaling, no stretching).
SKIES = {
    # sky_day2 = regeneration with a compact sun glare like the reference (sky_day.png's glare was too large)
    "day":   dict(raw="sky_day2.png",  horizon_raw=0.76, x0=0.0, width_frac=None, grade="reference",
                  grain=1.3, sat=1.0, denoise=2.5),
    "dusk":  dict(raw="sky_dusk.png",  horizon_raw=0.87, x0=0.0, width_frac=None, grade="dusk",
                  grain=1.3, sat=0.80),
    "night": dict(raw="sky_night.png", horizon_raw=0.94, x0=0.0, width_frac=None, grade="night",
                  grain=0.9, sat=0.90),
}

MOON_RAW = "moon_b.png"            # moon_full.png (1st try) had a made-up lunar face; moon_b matches the real near side
MOON_SIZE = 384
MOON_GAMMA = 0.72
MOON_GAIN = 1.06

# Clouds: raw file -> export width (px). Keep 700-1000 px (never upscale).
CLOUDS = [
    ("cloud_1.png", 900),
    ("cloud_2.png", 960),
    ("cloud_3.png", 760),
    ("cloud_4.png", 820),
    ("cloud_5.png", 880),
]


# ----------------------------------------------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------------------------------------------
def map_raw_to_sky(raw: Image.Image, horizon_raw: float, x0: float, width_frac: float | None) -> np.ndarray:
    """Uniformly scale + crop the raw sky so that raw row `horizon_raw` lands at HZ_PX and the image fills
    SKY_W x SKY_H. Rows needed below the raw bottom are a smooth continuation of the last raw rows (they are
    below the horizon, i.e. always covered by mountains/ground)."""
    a = np.asarray(raw.convert("RGB")).astype(np.float32)
    H, W = a.shape[:2]
    use_w = W * (1.0 - x0) if width_frac is None else W * width_frac
    # never crop above the raw top: if the raw is wider than needed, keep its left part (the sun side)
    use_w = min(use_w, SKY_W * horizon_raw * H / HZ_PX)
    s = SKY_W / use_w                             # uniform scale raw->export
    need_h = SKY_H / s
    top = max(0.0, horizon_raw * H - HZ_PX / s)
    left = x0 * W
    # pad bottom by replication if the crop runs past the raw bottom
    bottom = top + need_h
    pad = int(np.ceil(max(0.0, bottom - H))) + 2
    if pad:
        # smooth, horizontally blurred continuation of the last raw rows (hidden below the horizon anyway)
        tail = ndimage.gaussian_filter(a[-12:].mean(axis=0), (40, 0))
        a = np.concatenate([a, np.repeat(tail[None], pad, axis=0)], axis=0)
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB")
    box = (left, top, left + use_w, top + need_h)
    out = img.resize((SKY_W, SKY_H), Image.LANCZOS, box=box)
    return np.asarray(out).astype(np.float32)


def reference_sky_field() -> np.ndarray:
    """Smooth low-frequency colour field of the reference photo's sky (clouds, HUD text, dino, cactus and
    mountains masked out and filled by normalised convolution), mapped onto export pixels: reference rows
    0..585 (its horizon) -> export rows 0..HZ_PX with uniform scale, left-anchored (the sun side).
    Returns (SKY_H, SKY_W, 3) float32."""
    ref = np.asarray(Image.open(REFERENCE).convert("RGB")).astype(np.float32)
    rh, rw = ref.shape[:2]
    ref_hz, sky_bottom = 585, 506
    lum = ref.mean(axis=2)
    local = ndimage.median_filter(lum, size=(61, 61))
    valid = np.zeros((rh, rw), bool)
    valid[:sky_bottom] = True
    valid &= np.abs(lum - local) < 3.5                       # drop clouds (brighter) / objects (darker)
    valid[40:110, 1400:1910] = False                         # HUD "HI 00043 00029"
    valid[430:, 80:380] = False                              # dino
    valid[385:, 1650:1775] = False                           # cactus
    valid = ndimage.binary_erosion(valid, iterations=4)
    w = valid.astype(np.float32)
    field = np.empty_like(ref)
    for c in range(3):
        num = ndimage.gaussian_filter(ref[..., c] * w, 18)
        den = ndimage.gaussian_filter(w, 18)
        field[..., c] = num / np.maximum(den, 1e-4)
        # second, wider pass fills big holes (cloud interiors, below the mountain tops)
        num2 = ndimage.gaussian_filter(ref[..., c] * w, 60)
        den2 = ndimage.gaussian_filter(w, 60)
        wide = num2 / np.maximum(den2, 1e-4)
        field[..., c] = np.where(den > 0.25, field[..., c], wide)
    # below the reference's sky rows: continue each column's trend smoothly (hidden by mountains anyway)
    top = field[sky_bottom - 40:sky_bottom - 4].mean(axis=0)
    slope = (field[sky_bottom - 8] - field[sky_bottom - 48]) / 40.0
    for y in range(sky_bottom - 4, rh):
        field[y] = np.clip(top + slope * (y - (sky_bottom - 22)) * 0.6, 0, 250)
    field = ndimage.gaussian_filter(field, (6, 6, 0))
    s = HZ_PX / ref_hz
    img = Image.fromarray(np.clip(field[:ref_hz + 20], 0, 255).astype(np.uint8), "RGB")
    img = img.resize((round(rw * s), round((ref_hz + 20) * s)), Image.BILINEAR)
    f = np.asarray(img).astype(np.float32)[:, :SKY_W]
    if f.shape[1] < SKY_W:
        f = np.concatenate([f, np.repeat(f[:, -1:], SKY_W - f.shape[1], axis=1)], axis=1)
    f = f[:HZ_PX + 1]
    f = np.concatenate([f, np.repeat(f[-1:], SKY_H - f.shape[0], axis=0)], axis=0)
    return f


def grade_reference(a: np.ndarray, strength: float = 0.9, sigma: float = 50.0) -> np.ndarray:
    """Transfer the reference sky's large-scale colour (gradient + glare warmth/size) onto the generated day sky
    with a smooth 2-D per-channel gain map; the generation's fine structure/grain is kept."""
    target = reference_sky_field()
    ours = ndimage.gaussian_filter(a, (sigma, sigma, 0))
    tgt = ndimage.gaussian_filter(target, (sigma, sigma, 0))
    gain = tgt / np.maximum(ours, 1.0)
    out = a * (1.0 + strength * (gain - 1.0))
    # keep the sun's hot core: the wide gain blur would otherwise grey the near-white corner a little
    lum = a.mean(axis=2, keepdims=True)
    core = np.clip((lum - 236.0) / 14.0, 0, 1)
    return out * (1 - core) + np.maximum(out, a) * core


def adjust_saturation(a: np.ndarray, sat: float) -> np.ndarray:
    lum = (a * np.array([0.299, 0.587, 0.114], np.float32)).sum(axis=2, keepdims=True)
    return lum + (a - lum) * sat


def grade_dusk(a: np.ndarray) -> np.ndarray:
    # a thin warm atmospheric haze veil toward the horizon (desert dust), strongest at the horizon
    y = np.linspace(0, 1, SKY_H, dtype=np.float32)[:, None, None]
    veil = np.clip((y - 0.35) / (HORIZON - 0.35), 0, 1) ** 1.6 * 0.18
    haze = np.array([236, 196, 160], np.float32)
    return a * (1 - veil) + haze * veil


def grade_night(a: np.ndarray) -> np.ndarray:
    """Split into a smooth background and the star layer; sharpen only the (positive) star layer so the
    upscale does not turn pin-point stars into blobs."""
    bg = ndimage.median_filter(a, size=(7, 7, 1))
    bg = ndimage.gaussian_filter(bg, (2, 2, 0))
    stars = np.clip(a - bg, 0, None)
    soft = ndimage.gaussian_filter(stars, (1.1, 1.1, 0))
    sharp = np.clip(stars + 0.9 * (stars - soft), 0, None)
    return bg + sharp


def add_grain(a: np.ndarray, sigma: float, seed: int) -> np.ndarray:
    """Fine luminance grain + dither so the smooth gradients do not band after 8-bit / WebP quantisation."""
    rng = np.random.default_rng(seed)
    n = rng.normal(0.0, sigma, a.shape[:2]).astype(np.float32)
    n = ndimage.gaussian_filter(n, 0.6) * 1.6
    tri = (rng.random(a.shape, dtype=np.float32) - rng.random(a.shape, dtype=np.float32))  # TPDF dither
    return a + n[..., None] + tri


def sun_metadata(a: np.ndarray) -> dict:
    """Sun disc of an exported sky (uint8 RGB as decoded from the WebP): the largest blob of pixels with luma > 240
    in the top 85% of the image -> centroid (x, y as fractions of the width / height) and radius (half the mean of
    its bbox width and height, as a fraction of the width), plus the mean RGB of the ring at 1.6-2x that radius (the
    glow colour around the disc). The renderer reads it (with these values' defaults as its fallback)."""
    h, w = a.shape[:2]
    top = int(round(0.85 * h))
    bright = (a[:top].astype(np.float32) @ np.array([0.299, 0.587, 0.114], np.float32)) > 240
    lab, n = ndimage.label(bright)
    if n == 0:
        raise ValueError("no sun (luma > 240) in the top 85% of the sky")
    blob = lab == 1 + int(np.argmax(ndimage.sum(bright, lab, range(1, n + 1))))
    ys, xs = np.nonzero(blob)
    cx, cy = float(xs.mean()), float(ys.mean())
    r = ((xs.max() - xs.min() + 1) + (ys.max() - ys.min() + 1)) / 4.0
    yy, xx = np.mgrid[0:h, 0:w]
    d = np.hypot(xx - cx, yy - cy)
    glow = a[(d >= 1.6 * r) & (d <= 2.0 * r)].astype(np.float64).mean(axis=0)
    return {"x": round(cx / w, 4), "y": round(cy / h, 4), "r": round(float(r) / w, 4),
            "glow": [int(round(v)) for v in glow]}


def process_sky(name: str, cfg: dict, seed: int) -> dict:
    raw = Image.open(RAW / cfg["raw"])
    a = map_raw_to_sky(raw, cfg["horizon_raw"], cfg["x0"], cfg["width_frac"])
    if cfg.get("denoise"):
        # remove the blotchy low-amplitude colour noise of the generation (sky is a smooth gradient anyway)
        a = ndimage.gaussian_filter(a, (cfg["denoise"], cfg["denoise"], 0))
    if cfg["grade"] == "reference":
        a = grade_reference(a)
    elif cfg["grade"] == "dusk":
        a = grade_dusk(adjust_saturation(a, cfg["sat"]))
    elif cfg["grade"] == "night":
        a = grade_night(a)
        a = adjust_saturation(a, cfg["sat"])
    a = add_grain(a, cfg["grain"], seed)
    img = Image.fromarray(np.clip(np.round(a), 0, 255).astype(np.uint8), "RGB")
    dst = OUT / f"sky_{name}.webp"
    save_webp(img, dst, quality=85)
    entry = {"src": rel(dst), "w": SKY_W, "h": SKY_H, "horizonY": HORIZON}
    if name == "dusk":      # low sun disc: its position / size / glow colour for the renderer
        entry["sun"] = sun_metadata(np.asarray(Image.open(dst).convert("RGB")))
    return entry


def process_moon() -> dict:
    img = load_rgba(RAW / MOON_RAW)
    a = np.asarray(img).astype(np.float32)
    alpha = a[..., 3]
    solid = alpha > 128
    ys, xs = np.nonzero(solid)
    cy, cx = ys.mean(), xs.mean()
    r = np.sqrt(solid.sum() / np.pi)
    # analytic anti-aliased disc (1px soft edge) intersected with the generated alpha: perfectly round limb,
    # no stray rim pixels
    yy, xx = np.mgrid[0:img.height, 0:img.width]
    d = np.sqrt((yy - cy) ** 2 + (xx - cx) ** 2)
    disc = np.clip(r - 1.0 - d + 0.5, 0, 1) * 255.0
    new_alpha = np.minimum(np.where(d < r - 4, 255.0, alpha), disc)
    # fill any not-quite-opaque pixel inside the disc with its colour (generated alpha tops out at ~253)
    a[..., 3] = np.where(d < r - 3, 255.0, new_alpha)
    # neutralise colour of the rim pixels toward the disc interior colour at the same radius
    moon = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")
    moon = defringe(moon, radius=3)
    half = r + 3
    box = (int(round(cx - half)), int(round(cy - half)), int(round(cx + half)), int(round(cy + half)))
    moon = moon.crop(box).resize((MOON_SIZE, MOON_SIZE), Image.LANCZOS)
    # the generated disc is a mid-grey "exposed for detail" moon; in a night sky the moon reads as a luminous
    # disc, so lift it (gamma + gain) while keeping the maria contrast, and cool it very slightly
    m = np.asarray(moon).astype(np.float32)
    rgb = np.clip(m[..., :3] / 255.0, 0, 1) ** MOON_GAMMA * 255.0 * MOON_GAIN
    rgb = rgb * np.array([0.99, 1.0, 1.02], np.float32)
    m[..., :3] = np.clip(rgb, 0, 255)
    moon = Image.fromarray(m.astype(np.uint8), "RGBA")
    dst = OUT / "moon.webp"
    save_webp(moon, dst, quality=90)
    return {"src": rel(dst), "w": MOON_SIZE, "h": MOON_SIZE}


# Aerial-perspective grade for clouds, calibrated on the reference photo's clouds: they are far away in a hazy
# desert sky, so their shading is lifted and warm instead of the crisp blue-grey shading of a close-up cloud photo,
# but they still keep grey-mauve shaded bodies. Measured on the reference: sky around the clouds ≈ (209,208,208);
# shaded body ≈ (202,197,194), on average 7 levels below the sky and 13-18 at the deepest, covering ~25-35% of the
# cloud (in the body, on the side away from the sun; the base is a pale lit strip, not darkened); lit tops
# ≈ (247,240,231). Detail is kept by compressing (not replacing) luminance.
CLOUD_SHADOW_KEEP = 0.64          # fraction of the original darkness (255-L) that survives. 0.60 leaves the mostly
                                  # lit cloud_1 with only ~14% shaded body; 0.65+ comes out darker than the reference
CLOUD_SHADE_KNEE = 56.0           # soft roll-off of the kept darkness above this (~9 levels below the sky), so the
CLOUD_SHADE_SOFT = 12.0           # deepest shade stays ~18-19 below the sky like the reference's (no storm blobs)
CLOUD_CHROMA_KEEP = 0.30          # fraction of the original chroma that survives
CLOUD_WARM = np.array([4.0, 0.0, -9.0], np.float32)   # warm cream offset (sun-lit haze)
CLOUD_SOFTEN = 1.6                # px blur at export size (the reference clouds are slightly soft)


def grade_cloud(img: Image.Image) -> Image.Image:
    a = np.asarray(img).astype(np.float32)
    rgb, al = a[..., :3], a[..., 3:4] / 255.0
    L = (rgb * np.array([0.299, 0.587, 0.114], np.float32)).sum(axis=2, keepdims=True)
    chroma = rgb - L
    dark = (255.0 - L) * CLOUD_SHADOW_KEEP
    over = np.maximum(dark - CLOUD_SHADE_KNEE, 0.0)
    dark = np.where(over > 0, CLOUD_SHADE_KNEE + over / (1.0 + over / CLOUD_SHADE_SOFT), dark)
    L2 = 255.0 - dark
    # the faint outer wisps (low alpha) carry the grey of the original backdrop; treat them as lit haze
    lift = np.clip(1.0 - al / 0.35, 0, 1)
    L2 = L2 * (1 - lift) + np.maximum(L2, 238.0) * lift
    out = L2 + chroma * CLOUD_CHROMA_KEEP + CLOUD_WARM * (0.6 + 0.4 * (L2 - 200.0) / 55.0).clip(0.4, 1.0)
    # warm-mauve tint that acts only in shade (the reference's shaded bodies are grey-mauve, not blue-grey)
    shade = ((235.0 - L2) / 40.0).clip(0, 1)
    out = out + np.array([3.0, -1.0, -5.0], np.float32) * shade
    a[..., :3] = np.clip(out, 0, 255)
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def process_cloud(idx: int, raw_name: str, width: int) -> tuple[dict, Image.Image]:
    img = load_rgba(RAW / raw_name)
    if (np.asarray(img)[..., 3] < 250).mean() < 0.02:
        raise ValueError(f"{raw_name} has no transparency — regenerate it with transparent_background")
    img = clean_alpha(img, min_alpha=3, min_blob_frac=0.0015)
    img = grade_cloud(img)
    img = trim(img, pad=6, thresh=2)
    width = min(width, img.width)
    h = max(1, round(img.height * width / img.width))
    img = img.resize((width, h), Image.LANCZOS)
    img = blur_sprite(img, CLOUD_SOFTEN)          # premultiplied blur of colour + alpha (no dark halo)
    dst = OUT / f"cloud_{idx}.webp"
    save_webp(img, dst, quality=88)
    return {"src": rel(dst), "w": img.width, "h": img.height}, img


# ----------------------------------------------------------------------------------------------------------
# previews
# ----------------------------------------------------------------------------------------------------------
def _label(d: ImageDraw.ImageDraw, xy, text, fill=(255, 255, 255, 255)):
    x, y = xy
    d.rectangle([x - 2, y - 1, x + 7 * len(text) + 4, y + 13], fill=(0, 0, 0, 150))
    d.text((x, y), text, fill=fill)


def preview_skies(skies: dict, moon: dict | None = None, clouds: list | None = None):
    """All three skies stacked (same scale), red line at horizonY; clouds over the day sky and the moon over the
    night sky at in-game relative scale (clouds ≈ 0.27 of the visible height wide, moon ≈ 0.085 H)."""
    tw, th = 1280, 540
    sheet = Image.new("RGBA", (tw, th * 3 + 12), (223, 224, 230, 255))
    d = ImageDraw.Draw(sheet)
    vis_h = skies["day"]["horizonY"] * th / 0.74       # in-game screen height H at this scale (no top crop)
    for i, name in enumerate(["day", "dusk", "night"]):
        im = Image.open(ROOT / skies[name]["src"]).convert("RGBA").resize((tw, th), Image.LANCZOS)
        if name == "day" and clouds:
            for j, c in enumerate(clouds):
                ci = Image.open(ROOT / c["src"]).convert("RGBA")
                cw = round(0.27 * vis_h)
                ci = ci.resize((cw, round(ci.height * cw / ci.width)), Image.LANCZOS)
                im.alpha_composite(ci, (140 + j * 230, round((0.24 + 0.05 * (j % 3)) * vis_h)))
        if name == "night" and moon:
            mi = Image.open(ROOT / moon["src"]).convert("RGBA")
            ms = round(0.085 * vis_h)
            im.alpha_composite(mi.resize((ms, ms), Image.LANCZOS), (tw - 260, round(0.1 * vis_h)))
        y0 = i * (th + 6)
        sheet.alpha_composite(im, (0, y0))
        hy = y0 + round(skies[name]["horizonY"] * th)
        d.line([0, hy, tw, hy], fill=(255, 0, 0, 255), width=1)
        _label(d, (8, y0 + 8), f"sky_{name}  {skies[name]['w']}x{skies[name]['h']}  horizonY={skies[name]['horizonY']}")
        _label(d, (tw - 150, hy - 18), "horizonY", fill=(255, 120, 120, 255))
    sheet.convert("RGB").save(PREVIEW_DIR / "sky_backgrounds.png")


def preview_sprites(moon: dict, clouds: list):
    tiles, labels = [], []
    for c in clouds:
        im = Image.open(ROOT / c["src"]).convert("RGBA")
        t = on_background(im)
        ImageDraw.Draw(t).rectangle([0, 0, t.width - 1, t.height - 1], outline=(255, 0, 0, 255), width=2)
        tiles.append(t); labels.append(f"{pathlib.Path(c['src']).name}  {c['w']}x{c['h']}")
    im = Image.open(ROOT / moon["src"]).convert("RGBA")
    t = on_background(im)
    ImageDraw.Draw(t).rectangle([0, 0, t.width - 1, t.height - 1], outline=(255, 0, 0, 255), width=2)
    tiles.append(t); labels.append(f"moon.webp  {moon['w']}x{moon['h']}")
    sheet = contact_sheet(tiles, cols=3, cell=(520, 300), labels=labels)
    sheet.convert("RGB").save(PREVIEW_DIR / "sky_sprites.png")


def _ref_land_layer(W: int, H: int) -> Image.Image:
    """Reference photo's mountains + ground (below the detected ridge line) plus the dino and cactus that
    stick up into the sky (pixels clearly darker than the local sky), as an RGBA layer resized to (W, H).
    Used only to judge the new sky in context."""
    ref = np.asarray(Image.open(REFERENCE).convert("RGB")).astype(np.float32)
    rh, rw = ref.shape[:2]
    lum = ref.mean(axis=2)
    yy = np.arange(rh)[:, None] * np.ones((1, rw))
    # ridge line: first row (per column) from which the image stays darker than the sky's own downward trend
    ys = np.arange(470, 500)
    A = np.vstack([ys, np.ones_like(ys)]).T
    coef = np.linalg.lstsq(A, lum[470:500], rcond=None)[0]
    coef = ndimage.median_filter(coef, size=(1, 61))
    pred = coef[0][None] * np.arange(rh)[:, None] + coef[1][None]
    dark = (pred - lum) > 6
    top = np.full(rw, 592)
    for x in range(rw):
        col = dark[500:592, x]
        for y in range(92):
            if col[y:].mean() > 0.9:
                top[x] = 500 + y + 3          # +3: skip the faint haze band above the ridge
                break
    top = ndimage.median_filter(top, size=7).astype(np.float32)
    for x0, x1 in [(80, 380), (1640, 1785)]:              # behind the dino / cactus: interpolate the ridge
        top[x0:x1] = np.linspace(top[x0 - 1], top[x1], x1 - x0)
    land = np.clip((yy - top[None, :] + 1.0) / 2.0, 0, 1)
    local = ndimage.median_filter(lum, size=(1, 301))
    fig = (yy >= 380) & (yy < 600) & (lum < local - 14)
    fig = ndimage.binary_closing(fig, iterations=2)
    fig = ndimage.binary_fill_holes(fig)
    m = np.maximum(ndimage.gaussian_filter(fig.astype(np.float32), 0.8), land)
    layer = np.dstack([ref, m * 255.0]).astype(np.uint8)
    return Image.fromarray(layer, "RGBA").resize((W, H), Image.LANCZOS)


def _place_sky(sky: Image.Image, horizonY: float, W: int, H: int, horizon_at: float) -> Image.Image:
    """Engine-like placement: cover-fit, then shift so horizonY lands on horizon_at*H (left anchored)."""
    s = max(W / sky.width, H / sky.height, horizon_at * H / (horizonY * sky.height))
    sw, sh = round(sky.width * s), round(sky.height * s)
    big = sky.resize((sw, sh), Image.LANCZOS)
    oy = round(horizon_at * H - horizonY * sh)
    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 255))
    canvas.alpha_composite(big.convert("RGBA"), (0, 0), (0, -oy) if oy < 0 else (0, 0))
    return canvas


def preview_scene(skies: dict, moon: dict, clouds: list):
    """Compose each sky + sprites at in-game relative scale under the reference photo's land layer."""
    W, H = 1994, 789
    HZ = 585 / 789                       # reference horizon (≈ SPEC HORIZON_Y 0.74)
    land = _ref_land_layer(W, H)
    cloud_imgs = [Image.open(ROOT / c["src"]).convert("RGBA") for c in clouds]
    # cloud placements (x, y-center as fraction of H, width as fraction of H) roughly like the reference
    placements = [(530, 0.40, 0.29), (955, 0.345, 0.27), (1280, 0.425, 0.29), (1670, 0.36, 0.27), (180, 0.22, 0.24)]
    out_tiles = []
    for name in ["day", "dusk", "night"]:
        sky = Image.open(ROOT / skies[name]["src"]).convert("RGBA")
        scene = _place_sky(sky, skies[name]["horizonY"], W, H, HZ)
        if name == "night":
            m = Image.open(ROOT / moon["src"]).convert("RGBA")
            ms = round(0.085 * H)          # moon ≈ 8.5% of H
            scene.alpha_composite(m.resize((ms, ms), Image.LANCZOS), (1500, 70))
        for (x, yc, wf), ci in zip(placements, cloud_imgs):
            cw = round(wf * H)
            ch = round(ci.height * cw / ci.width)
            c = ci.resize((cw, ch), Image.LANCZOS)
            if name != "day":
                arr = np.asarray(c).astype(np.float32)
                tint = np.array([1.0, 0.78, 0.66]) if name == "dusk" else np.array([0.22, 0.26, 0.36])
                arr[..., :3] *= tint
                if name == "night":
                    arr[..., 3] *= 0.8
                c = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")
            scene.alpha_composite(c, (x, round(yc * H - ch / 2)))
        l = land
        if name != "day":
            arr = np.asarray(land).astype(np.float32)
            arr[..., :3] *= (np.array([0.95, 0.72, 0.58]) if name == "dusk" else np.array([0.20, 0.24, 0.34]))
            l = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")
        scene.alpha_composite(l)
        d = ImageDraw.Draw(scene)
        _label(d, (10, H - 24), f"{name}: new sky + clouds{' + moon' if name == 'night' else ''} under the reference photo's land"
                           + (" (land + clouds tinted only for this preview)" if name != "day" else ""))
        scene.convert("RGB").save(PREVIEW_DIR / f"sky_scene_{name}.png")
        out_tiles.append(scene)
    # side-by-side with the original reference for the day
    ref = Image.open(REFERENCE).convert("RGB")
    pair = Image.new("RGB", (W, H * 2 + 8), (40, 40, 40))
    pair.paste(ref, (0, 0))
    pair.paste(out_tiles[0].convert("RGB"), (0, H + 8))
    pair.resize((W // 2, (H * 2 + 8) // 2), Image.LANCZOS).save(PREVIEW_DIR / "sky_vs_reference.png")


# ----------------------------------------------------------------------------------------------------------
def main():
    OUT.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    skies = {}
    for i, (name, cfg) in enumerate(SKIES.items()):
        skies[name] = process_sky(name, cfg, seed=1000 + i)
        print("sky", name, skies[name])
    moon = process_moon()
    print("moon", moon)
    clouds = []
    for i, (raw_name, width) in enumerate(CLOUDS, start=1):
        if not (RAW / raw_name).exists():
            print("missing", raw_name)
            continue
        entry, _ = process_cloud(i, raw_name, width)
        clouds.append(entry)
        print("cloud", entry)
    frag = {"sky": dict(skies, moon=moon, clouds=clouds)}
    p = write_fragment("sky", frag)
    print("wrote", rel(p))
    preview_skies(skies, moon, clouds)
    preview_sprites(moon, clouds)
    preview_scene(skies, moon, clouds)
    total = sum((ROOT / e["src"]).stat().st_size for e in [*skies.values(), moon, *clouds])
    print(f"total game-ready bytes: {total / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
