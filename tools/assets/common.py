"""Shared helpers for the asset post-processing scripts (tools/assets/<group>.py).

Usage from a group script:
    import sys, pathlib; sys.path.insert(0, str(pathlib.Path(__file__).parent))
    from common import *
"""
from __future__ import annotations

import json
import pathlib

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

ROOT = pathlib.Path(__file__).resolve().parents[2]
RAW = ROOT / "assets" / "raw"
MANIFEST_DIR = ROOT / "assets" / "manifest"
PREVIEW_DIR = ROOT / "assets" / "previews"
REFERENCE = ROOT / "reference" / "screen.webp"


def rel(path: pathlib.Path | str) -> str:
    """Project-root-relative POSIX path, as used in manifest fragments."""
    return pathlib.Path(path).resolve().relative_to(ROOT).as_posix()


def load_rgba(path) -> Image.Image:
    return Image.open(path).convert("RGBA")


def alpha_of(img: Image.Image) -> np.ndarray:
    return np.asarray(img)[..., 3]


def ensure_alpha(img: Image.Image, key_rgb=None, tol: float = 60.0, soft: float = 40.0) -> Image.Image:
    """Return img unchanged if it already has real transparency; otherwise chroma-key it.

    key_rgb defaults to the median colour of the 1px border. Pixels within `tol` (RGB distance) of the key
    become transparent, fading to opaque over `soft`. Key-colour spill is removed from the semi-transparent rim.
    """
    a = np.asarray(img).astype(np.float32)
    if (a[..., 3] < 250).mean() > 0.02:
        return img
    rgb = a[..., :3]
    if key_rgb is None:
        border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
        key_rgb = np.median(border, axis=0)
    key = np.asarray(key_rgb, dtype=np.float32)
    dist = np.linalg.norm(rgb - key, axis=-1)
    alpha = np.clip((dist - tol) / soft, 0.0, 1.0)
    # despill: remove the key colour's contribution from partially transparent pixels
    k = alpha[..., None]
    safe = np.where(k > 1e-3, k, 1.0)
    unmixed = (rgb - (1.0 - k) * key) / safe
    rgb = np.where(k > 1e-3, np.clip(unmixed, 0, 255), rgb)
    # hue despill on pixels near the transparent edge (thin spines/hair mix with the key colour)
    near_edge = ndimage.binary_dilation(alpha < 0.98, iterations=4)
    r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
    if key[0] > 150 and key[2] > 150 and key[1] < 100:      # magenta key
        spill = np.clip(np.minimum(r, b) - g, 0, None) * near_edge
        rgb = np.dstack([r - spill, g, b - spill])
    elif key[1] > 150 and key[0] < 100 and key[2] < 100:    # green key
        spill = np.clip(g - np.maximum(r, b), 0, None) * near_edge
        rgb = np.dstack([r, g - spill, b])
    elif key[2] > 150 and key[0] < 100 and key[1] < 150:    # blue key
        spill = np.clip(b - np.maximum(r, g), 0, None) * near_edge
        rgb = np.dstack([r, g, b - spill])
    out = np.dstack([np.clip(rgb, 0, 255), alpha * 255.0]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


def clean_alpha(img: Image.Image, min_alpha: int = 6, keep_largest: int = 0, min_blob_frac: float = 0.002) -> Image.Image:
    """Zero out near-invisible noise and (optionally) keep only the N largest connected blobs."""
    a = np.asarray(img).copy()
    alpha = a[..., 3]
    alpha[alpha < min_alpha] = 0
    if keep_largest or min_blob_frac:
        lab, n = ndimage.label(alpha > 24)
        if n > 0:
            sizes = ndimage.sum(np.ones_like(alpha), lab, index=np.arange(1, n + 1))
            order = np.argsort(sizes)[::-1]
            keep = set()
            total = sizes.sum()
            for rank, idx in enumerate(order):
                if keep_largest and rank >= keep_largest:
                    break
                if sizes[idx] / total < min_blob_frac:
                    break
                keep.add(idx + 1)
            mask = np.isin(lab, list(keep))
            # keep soft edges that touch kept blobs
            grown = ndimage.binary_dilation(mask, iterations=3)
            alpha[~grown] = 0
    a[..., 3] = alpha
    return Image.fromarray(a, "RGBA")


def defringe(img: Image.Image, radius: int = 3) -> Image.Image:
    """Colour-decontaminate the semi-transparent rim: pull edge RGB toward the nearest solid pixel's colour."""
    a = np.asarray(img).astype(np.float32)
    alpha = a[..., 3]
    solid = alpha >= 250
    if not solid.any():
        return img
    _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
    nearest = a[iy, ix, :3]
    rim = (alpha > 0) & (alpha < 250)
    w = (1.0 - alpha / 255.0)[..., None] * 0.85
    rgb = a[..., :3]
    rgb = np.where(rim[..., None], rgb * (1 - w) + nearest * w, rgb)
    a[..., :3] = rgb
    return Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGBA")


def bbox(img: Image.Image, thresh: int = 8):
    alpha = alpha_of(img)
    ys, xs = np.nonzero(alpha > thresh)
    if len(xs) == 0:
        return (0, 0, img.width, img.height)
    return (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)


def trim(img: Image.Image, pad: int = 0, thresh: int = 8) -> Image.Image:
    x0, y0, x1, y1 = bbox(img, thresh)
    x0, y0 = max(0, x0 - pad), max(0, y0 - pad)
    x1, y1 = min(img.width, x1 + pad), min(img.height, y1 + pad)
    return img.crop((x0, y0, x1, y1))


def resize_h(img: Image.Image, h: int) -> Image.Image:
    w = max(1, round(img.width * h / img.height))
    return img.resize((w, h), Image.LANCZOS)


def split_components(img: Image.Image, n: int, thresh: int = 24, dilate: int = 6):
    """Split a sprite sheet into its n largest blobs (sorted left→right, then top→bottom). Returns RGBA crops
    (full-res, trimmed) and their bboxes in sheet pixels."""
    alpha = alpha_of(img)
    mask = ndimage.binary_dilation(alpha > thresh, iterations=dilate)
    lab, count = ndimage.label(mask)
    sizes = ndimage.sum(np.ones_like(alpha), lab, index=np.arange(1, count + 1))
    order = np.argsort(sizes)[::-1][:n]
    out = []
    for idx in order:
        sl = ndimage.find_objects((lab == idx + 1).astype(np.int32))[0]
        region = np.asarray(img)[sl].copy()
        region[..., 3] = np.where((lab[sl] == idx + 1), region[..., 3], 0)
        crop = Image.fromarray(region, "RGBA")
        out.append(((sl[1].start, sl[0].start, sl[1].stop, sl[0].stop), crop))
    out.sort(key=lambda t: (round(t[0][1] / max(1, img.height / 4)), t[0][0]))
    return [c for _, c in out], [b for b, _ in out]


def compute_hitboxes(img: Image.Image, bands: int = 5, thresh: int = 128, trim_pct: float = 0.04,
                     shrink: float = 0.04, min_band_px: int = 3):
    """Approximate the opaque silhouette with `bands` horizontal rectangles ([x, y, w, h] in image pixels).

    Each band uses the trimmed (trim_pct quantile) min/max x of opaque pixels so thin protrusions (tail tip,
    spines, wing ragged edges) are excluded; rects are shrunk by `shrink` of the sprite size for fairness.
    Empty bands are skipped; adjacent near-identical bands are merged.
    """
    alpha = alpha_of(img) > thresh
    ys, xs = np.nonzero(alpha)
    if len(xs) == 0:
        return []
    y0, y1 = ys.min(), ys.max() + 1
    H = y1 - y0
    W = xs.max() + 1 - xs.min()
    sx, sy = shrink * W, shrink * H
    rects = []
    edges = np.linspace(y0, y1, bands + 1).round().astype(int)
    for a, b in zip(edges[:-1], edges[1:]):
        if b - a < min_band_px:
            continue
        cols = np.nonzero(alpha[a:b].any(axis=0))[0]
        if len(cols) == 0:
            continue
        band_xs = np.nonzero(alpha[a:b])[1]
        lo = np.quantile(band_xs, trim_pct)
        hi = np.quantile(band_xs, 1 - trim_pct)
        rows = np.nonzero(alpha[a:b].any(axis=1))[0]
        ra, rb = a + rows.min(), a + rows.max() + 1
        r = [lo + sx, ra + sy / bands, (hi - lo) - 2 * sx, (rb - ra) - 2 * sy / bands]
        if r[2] > 2 and r[3] > 2:
            rects.append([round(float(v), 1) for v in r])
    merged = []
    for r in rects:
        if merged:
            p = merged[-1]
            if abs(p[0] - r[0]) < 0.05 * W and abs((p[0] + p[2]) - (r[0] + r[2])) < 0.05 * W:
                x0 = min(p[0], r[0]); x1 = max(p[0] + p[2], r[0] + r[2])
                merged[-1] = [x0, p[1], round(x1 - x0, 1), round(r[1] + r[3] - p[1], 1)]
                continue
        merged.append(r)
    return merged


def offset_boxes(boxes, dx: float, dy: float, scale: float = 1.0):
    return [[round(b[0] * scale + dx, 1), round(b[1] * scale + dy, 1), round(b[2] * scale, 1), round(b[3] * scale, 1)]
            for b in boxes]


def make_seamless_h(img: Image.Image, blend_px: int) -> Image.Image:
    """Crossfade the right `blend_px` columns into the left edge; result width = W - blend_px and tiles seamlessly."""
    a = np.asarray(img).astype(np.float32)
    W = a.shape[1]
    out = a[:, : W - blend_px].copy()
    t = np.linspace(0.0, 1.0, blend_px)[None, :, None]
    left = a[:, :blend_px]
    right = a[:, W - blend_px:]
    out[:, :blend_px] = right * (1 - t) + left * t
    return Image.fromarray(np.clip(out, 0, 255).astype(np.uint8), img.mode)


def seam_error(img: Image.Image) -> float:
    """Mean abs difference between the last and first column (0 = perfect wrap)."""
    a = np.asarray(img).astype(np.float32)
    return float(np.abs(a[:, -1] - a[:, 0]).mean())


def blur_sprite(img: Image.Image, radius: float) -> Image.Image:
    """Depth-of-field blur that also blurs alpha (premultiplied to avoid dark halos). Pads so blur isn't clipped."""
    pad = int(radius * 3) + 2
    big = Image.new("RGBA", (img.width + 2 * pad, img.height + 2 * pad), (0, 0, 0, 0))
    big.paste(img, (pad, pad))
    a = np.asarray(big).astype(np.float32)
    al = a[..., 3:4] / 255.0
    pre = np.dstack([a[..., :3] * al, al * 255.0])
    pre_img = Image.fromarray(np.clip(pre, 0, 255).astype(np.uint8), "RGBA")
    b = np.asarray(pre_img.filter(ImageFilter.GaussianBlur(radius))).astype(np.float32)
    al2 = b[..., 3:4] / 255.0
    rgb = np.where(al2 > 1e-3, b[..., :3] / np.maximum(al2, 1e-3), 0)
    out = np.dstack([np.clip(rgb, 0, 255), b[..., 3:4]]).astype(np.uint8)
    return trim(Image.fromarray(out, "RGBA"), pad=1, thresh=2)


def save_webp(img: Image.Image, path, quality: int = 88, lossless: bool = False):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if img.mode == "RGBA":
        img.save(path, "WEBP", quality=quality, lossless=lossless, method=6, exact=False, alpha_quality=100)
    else:
        img.convert("RGB").save(path, "WEBP", quality=quality, method=6)
    return path


def write_fragment(group: str, data: dict):
    MANIFEST_DIR.mkdir(parents=True, exist_ok=True)
    p = MANIFEST_DIR / f"{group}.json"
    p.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
    return p


def draw_boxes(img: Image.Image, boxes, color=(255, 0, 0, 255), width: int = 2) -> Image.Image:
    out = img.copy()
    d = ImageDraw.Draw(out)
    for x, y, w, h in boxes:
        d.rectangle([x, y, x + w, y + h], outline=color, width=width)
    return out


def on_background(img: Image.Image, color=(223, 224, 230, 255)) -> Image.Image:
    bg = Image.new("RGBA", img.size, color)
    bg.alpha_composite(img)
    return bg


def reference_ground_crop(w: int, h: int) -> Image.Image:
    """A crop of the reference photo around the running line, resized to (w, h), for realism previews."""
    ref = load_rgba(REFERENCE)
    box = (500, 380, 1500, 700)
    return ref.crop(box).resize((w, h), Image.LANCZOS)


def contact_sheet(tiles, cols: int, cell=(420, 300), bg=(223, 224, 230, 255), labels=None) -> Image.Image:
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGBA", (cols * cell[0], rows * (cell[1] + 18)), bg)
    d = ImageDraw.Draw(sheet)
    for i, t in enumerate(tiles):
        t = t.copy()
        t.thumbnail(cell, Image.LANCZOS)
        cx = (i % cols) * cell[0]
        cy = (i // cols) * (cell[1] + 18)
        sheet.alpha_composite(t, (cx + (cell[0] - t.width) // 2, cy + (cell[1] - t.height) // 2))
        if labels:
            d.text((cx + 4, cy + cell[1] + 2), str(labels[i]), fill=(20, 20, 20, 255))
    return sheet
