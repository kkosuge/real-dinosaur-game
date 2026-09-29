"""Pteranodon (flying obstacle) pipeline: assets/raw/ptero_sheet.png -> assets/obstacles/ptero_<n>.webp + manifest.

Raw provenance: `ptero_sheet.png` is ONE Codex image generation (native transparent background) that contains three
wing-flap frames of the same individual stacked vertically (top = upstroke / wings up, middle = glide / wings level,
bottom = downstroke / wings down). Generating all frames in one image is what keeps head / body identical.
(`ptero_master.png` / `ptero_master_b.png` are single-frame Codex explorations of the same subject, kept as
provenance / reference for future regenerations; they are not used by this script.)

Steps
  1. split the sheet into its three frames (connected alpha blobs, sorted top -> bottom)
  2. align every frame to the middle frame on the NON-wing anatomy (beak, torso, hind legs) with normalized
     cross-correlation, so only the wings move when the engine cycles frames
  3. mild colour grade toward the hazy, desaturated reference palette
  4. scale (premultiplied Lanczos) so the widest frame's span == TARGET_WINGSPAN, place every frame on one identical
     canvas, clean alpha, export WebP
  5. hitboxes = greedy largest axis-aligned rectangles strictly INSIDE the (eroded) opaque silhouette ->
     body + inner wings; never thin wingtips / beak tip / crest tip / claws, never transparent pixels
  6. manifest fragment + QA previews (hitboxes, onion skin, in-scene composite, flap GIF)

Run:  <venv python> tools/assets/ptero.py
"""
from __future__ import annotations

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).parent))
from common import (ROOT, RAW, PREVIEW_DIR, REFERENCE, load_rgba, clean_alpha, save_webp,  # noqa: E402
                    write_fragment, draw_boxes, on_background, rel)

import numpy as np  # noqa: E402
from numpy.lib.stride_tricks import sliding_window_view  # noqa: E402
from PIL import Image, ImageDraw, ImageEnhance  # noqa: E402
from scipy import ndimage  # noqa: E402

RAW_SHEET = RAW / "ptero_sheet.png"
OUT_DIR = ROOT / "assets" / "obstacles"
FRAME_NAMES = ["up", "mid", "down"]          # sheet order, top -> bottom
CYCLE = [0, 1, 2, 1]                          # manifest frame order: up, mid, down, mid (loops smoothly)
REF_FRAME = 1                                 # align everything to the glide frame
TARGET_WINGSPAN = 620                         # px, widest frame's horizontal opaque extent (SPEC: 500-640)
PAD = 8                                       # transparent margin around the union of all frames
BG = (223, 224, 230, 255)

# Alignment templates, in RAW SHEET pixels of the middle (reference) frame: parts that do not move with the wings.
TEMPLATES = {
    "beak": (90, 800, 300, 850),
    "torso": (430, 830, 580, 930),
    "legs": (600, 930, 780, 990),
}
MIN_NCC = 0.45

# Colour grade toward the reference photo (hazy, muted). Tuned by eye with assets/previews/ptero_scene.png.
GRADE_SATURATION = 0.84
GRADE_CONTRAST = 0.97
GRADE_HAZE = (206, 206, 211)                  # hazy midday air colour mixed in
GRADE_HAZE_AMT = 0.04

# Hitbox parameters (final pixels). Body rects are fitted once on the pixels shared by ALL frames (head/neck/torso,
# identical in every frame); wing rects per frame, only inside a zone around the body ("inner wings").
HB_ERODE = 5                                  # square erosion before fitting rectangles -> drops thin parts
HB_GROW = 3                                   # grow rectangles back (< HB_ERODE => still strictly inside)
HB_BODY_MAX = 4
HB_BODY_MIN_AREA_FRAC = 0.03                  # of the shared-body area
HB_WING_MAX = 3
HB_WING_MIN_AREA_FRAC = 0.025                 # of the frame's opaque area
HB_ZONE = (0.10, 0.16, 0.12, 0.10)            # wing zone = body-rects bbox grown by (left, top, right, bottom) x frame
HB_MIN_SIDE = 8
OPAQUE_BOX_ALPHA = 24                         # manifest "opaqueBox" threshold (visible pixels, not faint fringe)


# ---------------------------------------------------------------------------------------------------- split / align
def split_sheet(sheet: Image.Image, n: int = 3):
    """n full-sheet-sized RGBA arrays (one per frame, other frames' pixels removed), sorted top -> bottom."""
    a = np.asarray(sheet).copy()
    alpha = a[..., 3]
    mask = ndimage.binary_dilation(alpha > 24, iterations=6)
    lab, count = ndimage.label(mask)
    sizes = ndimage.sum(np.ones_like(alpha), lab, index=np.arange(1, count + 1))
    keep = list(np.argsort(sizes)[::-1][:n] + 1)
    objs = ndimage.find_objects(lab)
    keep.sort(key=lambda i: objs[i - 1][0].start)
    frames = []
    for idx in keep:
        f = a.copy()
        f[..., 3] = np.where(lab == idx, alpha, 0)
        frames.append(f)
    return frames


def gray_on_bg(a: np.ndarray) -> np.ndarray:
    al = a[..., 3:4].astype(np.float32) / 255.0
    rgb = a[..., :3].astype(np.float32) * al + np.array(BG[:3], np.float32) * (1 - al)
    return rgb.mean(-1)


def _ncc_map(search: np.ndarray, tpl: np.ndarray) -> np.ndarray:
    t = (tpl - tpl.mean()) / (tpl.std() + 1e-6)
    win = sliding_window_view(search, tpl.shape)
    m = win.mean(axis=(-1, -2), keepdims=True)
    s = win.std(axis=(-1, -2), keepdims=True) + 1e-6
    return (((win - m) / s) * t).mean(axis=(-1, -2))


def _down(a: np.ndarray, f: int) -> np.ndarray:
    h, w = a.shape[0] // f * f, a.shape[1] // f * f
    return a[:h, :w].reshape(h // f, f, w // f, f).mean((1, 3))


def find_template(G: np.ndarray, T: np.ndarray, search_box):
    """Top-left position of template T inside search_box of G (coarse 1/4 search, then full-res refine)."""
    sx0, sy0, sx1, sy1 = search_box
    f = 4
    cm = _ncc_map(_down(G[sy0:sy1, sx0:sx1], f), _down(T, f))
    cy, cx = np.unravel_index(np.argmax(cm), cm.shape)
    cx, cy = sx0 + cx * f, sy0 + cy * f
    r = 8
    fx0, fy0 = max(0, cx - r), max(0, cy - r)
    region = G[fy0: cy + r + T.shape[0], fx0: cx + r + T.shape[1]]
    fm = _ncc_map(region, T)
    y, x = np.unravel_index(np.argmax(fm), fm.shape)
    return int(fx0 + x), int(fy0 + y), float(fm.max())


def align_offsets(frames):
    """(dx, dy) that moves each frame onto the reference frame (median over the anatomy templates)."""
    Gr = gray_on_bg(frames[REF_FRAME])
    offsets = []
    for i, f in enumerate(frames):
        if i == REF_FRAME:
            offsets.append((0, 0))
            continue
        G = gray_on_bg(f)
        ys, xs = np.nonzero(f[..., 3] > 24)
        box = (max(0, xs.min() - 20), max(0, ys.min() - 20), min(G.shape[1], xs.max() + 20),
               min(G.shape[0], ys.max() + 20))
        dxs, dys = [], []
        for name, (tx0, ty0, tx1, ty1) in TEMPLATES.items():
            x, y, score = find_template(G, Gr[ty0:ty1, tx0:tx1], box)
            print(f"  align {FRAME_NAMES[i]:>4} on {name:>5}: shift=({tx0 - x:+d},{ty0 - y:+d}) ncc={score:.3f}")
            if score >= MIN_NCC:
                dxs.append(tx0 - x)
                dys.append(ty0 - y)
        assert dxs, f"alignment failed for frame {FRAME_NAMES[i]}"
        offsets.append((int(round(np.median(dxs))), int(round(np.median(dys)))))
    return offsets


def shift(a: np.ndarray, dx: int, dy: int) -> np.ndarray:
    out = np.zeros_like(a)
    H, W = a.shape[:2]
    ys, yd = (slice(0, H - dy), slice(dy, H)) if dy >= 0 else (slice(-dy, H), slice(0, H + dy))
    xs, xd = (slice(0, W - dx), slice(dx, W)) if dx >= 0 else (slice(-dx, W), slice(0, W + dx))
    out[yd, xd] = a[ys, xs]
    return out


# ------------------------------------------------------------------------------------------------------------ grade
def grade(img: Image.Image) -> Image.Image:
    alpha = img.getchannel("A")
    rgb = img.convert("RGB")
    rgb = ImageEnhance.Color(rgb).enhance(GRADE_SATURATION)
    rgb = ImageEnhance.Contrast(rgb).enhance(GRADE_CONTRAST)
    a = np.asarray(rgb).astype(np.float32)
    a = a * (1 - GRADE_HAZE_AMT) + np.array(GRADE_HAZE, np.float32) * GRADE_HAZE_AMT
    out = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    out.putalpha(alpha)
    return out


def resize_premul(img: Image.Image, size) -> Image.Image:
    return img.convert("RGBa").resize(size, Image.LANCZOS).convert("RGBA")


# --------------------------------------------------------------------------------------------------------- hitboxes
def largest_rect(mask: np.ndarray):
    """Largest all-True axis-aligned rectangle in a boolean mask (histogram / stack method). (x, y, w, h, area)"""
    H, W = mask.shape
    heights = np.zeros(W, np.int32)
    best = (0, 0, 0, 0, 0)
    for y in range(H):
        heights = np.where(mask[y], heights + 1, 0)
        stack = []  # (start_x, height)
        for x in range(W + 1):
            h = int(heights[x]) if x < W else 0
            start = x
            while stack and stack[-1][1] >= h:
                sx, sh = stack.pop()
                area = sh * (x - sx)
                if area > best[4]:
                    best = (sx, y - sh + 1, x - sx, sh, area)
                start = sx
            stack.append((start, h))
    return best


def erode_sq(mask: np.ndarray, r: int) -> np.ndarray:
    er = ndimage.binary_erosion(mask, structure=np.ones((2 * r + 1, 2 * r + 1), bool))
    return ndimage.binary_opening(er, structure=np.ones((5, 5), bool))  # drop slivers left by erosion


def fit_rects(free: np.ndarray, max_n: int, min_area: float):
    """Greedy: repeatedly take the largest rectangle inside `free` (modified in place), grown by HB_GROW."""
    rects = []
    while len(rects) < max_n:
        x, y, w, h, area = largest_rect(free)
        gw, gh = w + 2 * HB_GROW, h + 2 * HB_GROW
        if area == 0 or gw * gh < min_area or min(gw, gh) < HB_MIN_SIDE:
            break
        free[y:y + h, x:x + w] = False
        rects.append([int(x - HB_GROW), int(y - HB_GROW), int(gw), int(gh)])
    return rects


def body_hitboxes(body: np.ndarray):
    return fit_rects(erode_sq(body, HB_ERODE), HB_BODY_MAX, HB_BODY_MIN_AREA_FRAC * body.sum())


def frame_hitboxes(alpha: np.ndarray, body_rects):
    mask = alpha > 128
    H, W = mask.shape
    free = erode_sq(mask, HB_ERODE)
    for x, y, w, h in body_rects:                                   # already covered
        free[max(0, y + HB_GROW):y + h - HB_GROW, max(0, x + HB_GROW):x + w - HB_GROW] = False
    zl, zt, zr, zb = HB_ZONE
    bx0, by0 = min(r[0] for r in body_rects), min(r[1] for r in body_rects)
    bx1, by1 = max(r[0] + r[2] for r in body_rects), max(r[1] + r[3] for r in body_rects)
    zone = np.zeros_like(free)
    zone[max(0, int(by0 - zt * H)):int(by1 + zb * H), max(0, int(bx0 - zl * W)):int(bx1 + zr * W)] = True
    free &= zone
    rects = [list(r) for r in body_rects] + fit_rects(free, HB_WING_MAX, HB_WING_MIN_AREA_FRAC * mask.sum())
    for x, y, w, h in rects:                                        # never collide on transparent pixels
        inside = mask[max(0, y):y + h, max(0, x):x + w].mean()
        assert inside > 0.995, f"hitbox {x, y, w, h} covers transparent pixels ({inside:.3f})"
    return rects


# ------------------------------------------------------------------------------------------------------------- main
def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    sheet = load_rgba(RAW_SHEET)
    frames = split_sheet(sheet, 3)
    offsets = align_offsets(frames)
    print("  offsets:", dict(zip(FRAME_NAMES, offsets)))
    aligned = [shift(f, dx, dy) for f, (dx, dy) in zip(frames, offsets)]

    # union bbox + widest frame (raw pixels)
    boxes = []
    for a in aligned:
        ys, xs = np.nonzero(a[..., 3] > 8)
        boxes.append((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    ux0 = min(b[0] for b in boxes); uy0 = min(b[1] for b in boxes)
    ux1 = max(b[2] for b in boxes); uy1 = max(b[3] for b in boxes)
    widest = max(b[2] - b[0] for b in boxes)
    s = TARGET_WINGSPAN / widest
    print(f"  union raw bbox {ux0, uy0, ux1, uy1}, widest {widest}px, scale {s:.4f}")

    # crop union (+ margin in raw px) and scale
    m = int(np.ceil(PAD / s)) + 2
    crop_box = (ux0 - m, uy0 - m, ux1 + m, uy1 + m)
    canvas_raw = [np.zeros((crop_box[3] - crop_box[1], crop_box[2] - crop_box[0], 4), np.uint8) for _ in aligned]
    for c, a in zip(canvas_raw, aligned):
        H, W = a.shape[:2]
        sx0, sy0 = max(0, crop_box[0]), max(0, crop_box[1])
        sx1, sy1 = min(W, crop_box[2]), min(H, crop_box[3])
        c[sy0 - crop_box[1]: sy1 - crop_box[1], sx0 - crop_box[0]: sx1 - crop_box[0]] = a[sy0:sy1, sx0:sx1]
    fw = int(round(canvas_raw[0].shape[1] * s)); fh = int(round(canvas_raw[0].shape[0] * s))
    finals = []
    for c in canvas_raw:
        img = resize_premul(Image.fromarray(c, "RGBA"), (fw, fh))
        img = clean_alpha(img, min_alpha=6, keep_largest=1, min_blob_frac=0.0)
        img = grade(img)
        finals.append(img)

    # hitboxes, spans, body centre
    alphas = [np.asarray(f)[..., 3] for f in finals]
    spans = []
    for a in alphas:
        xs = np.nonzero((a > 8).any(0))[0]
        spans.append(int(xs.max() + 1 - xs.min()))
    body = np.logical_and.reduce([a > 128 for a in alphas])            # what all frames share = head/body
    body = ndimage.binary_opening(body, structure=np.ones((5, 5), bool))
    lab, n = ndimage.label(body)
    sizes = ndimage.sum(body, lab, index=np.arange(1, n + 1))
    body = lab == (np.argmax(sizes) + 1)
    by, bx = np.nonzero(body)
    body_cy = int(round(by.mean()))
    body_box = (int(bx.min()), int(by.min()), int(bx.max() + 1), int(by.max() + 1))
    body_rects = body_hitboxes(body)
    hitboxes = [frame_hitboxes(a, body_rects) for a in alphas]
    print(f"  body rects (shared by all frames): {body_rects}")
    print(f"  frame {fw}x{fh}, spans {spans}, bodyCenterY {body_cy}, body bbox {body_box}")

    # export
    srcs = []
    for i, img in enumerate(finals):
        p = OUT_DIR / f"ptero_{i}.webp"
        save_webp(img, p, quality=88)
        srcs.append(rel(p))
        print(f"  wrote {rel(p)} ({p.stat().st_size // 1024} KB) hitboxes={len(hitboxes[i])}")
    # visible extent of every exported frame ([x, y, w, h] of alpha > OPAQUE_BOX_ALPHA in the decoded WebP). The engine
    # uses it to keep the down-stroke wingtips out of the ground (low altitude) and off the dino's head (high).
    opaque = []
    for i in range(len(finals)):
        a = np.asarray(load_rgba(OUT_DIR / f"ptero_{i}.webp"))[..., 3]
        ys, xs = np.nonzero(a > OPAQUE_BOX_ALPHA)
        opaque.append([int(xs.min()), int(ys.min()), int(xs.max() + 1 - xs.min()), int(ys.max() + 1 - ys.min())])
    print(f"  opaque boxes: {opaque}")
    frag = {"ptero": {
        "frameW": fw, "frameH": fh,
        "wingspanPx": max(spans),
        "bodyCenterYPx": body_cy,
        "frames": [{"src": srcs[i], "hitboxes": hitboxes[i], "opaqueBox": opaque[i]} for i in CYCLE],
    }}
    print("  fragment:", rel(write_fragment("ptero", frag)))

    # re-read exported WebP files for previews (what the game will actually load)
    loaded = [load_rgba(OUT_DIR / f"ptero_{i}.webp") for i in range(len(finals))]
    make_previews(loaded, hitboxes, body_cy, body_box, spans)


# --------------------------------------------------------------------------------------------------------- previews
def make_previews(frames, hitboxes, body_cy, body_box, spans):
    fw, fh = frames[0].size
    # (a) frames over #dfe0e6 with hitboxes and labels
    gap, top = 24, 26
    sheet = Image.new("RGBA", (len(frames) * (fw + gap) + gap, fh + top + 30), BG)
    d = ImageDraw.Draw(sheet)
    for i, (f, hb) in enumerate(zip(frames, hitboxes)):
        x0 = gap + i * (fw + gap)
        tile = draw_boxes(on_background(f), hb, color=(230, 0, 0, 255), width=2)
        td = ImageDraw.Draw(tile)
        td.rectangle([0, 0, fw - 1, fh - 1], outline=(120, 120, 140, 255), width=1)
        td.line([(0, body_cy), (fw, body_cy)], fill=(0, 90, 255, 255), width=1)
        sheet.alpha_composite(tile, (x0, top))
        d.text((x0, 6), f"ptero_{i}.webp  [{FRAME_NAMES[i]}]  {fw}x{fh}  span {spans[i]}px  {len(hb)} hitboxes",
               fill=(20, 20, 20, 255))
        d.text((x0, top + fh + 8), "red = hitboxes, blue = bodyCenterYPx, grey = frame canvas", fill=(60, 60, 60, 255))
    sheet.convert("RGB").save(PREVIEW_DIR / "ptero_frames.png")

    # onion skin: all frames at 45 % over each other + tinted outlines; body should be crisp (identical)
    onion = Image.new("RGBA", (fw, fh), BG)
    tints = [(255, 60, 60), (40, 160, 40), (60, 90, 255)]
    for f, tint in zip(frames, tints):
        a = np.asarray(f).astype(np.float32)
        t = a.copy()
        t[..., :3] = a[..., :3] * 0.6 + np.array(tint) * 0.4
        t[..., 3] = a[..., 3] * 0.45
        onion.alpha_composite(Image.fromarray(t.astype(np.uint8), "RGBA"))
    od = ImageDraw.Draw(onion)
    od.rectangle(body_box, outline=(0, 0, 0, 255), width=1)
    od.text((6, 6), "onion skin: red=up green=mid blue=down (body box = pixels shared by all frames)",
            fill=(20, 20, 20, 255))
    # plus a 2x zoom of the head/body region to judge alignment
    bx0, by0, bx1, by1 = body_box
    zoom = onion.crop((bx0 - 10, by0 - 10, bx1 + 10, by1 + 10))
    zoom = zoom.resize((zoom.width * 2, zoom.height * 2), Image.LANCZOS)
    out = Image.new("RGBA", (max(fw, zoom.width), fh + zoom.height + 10), BG)
    out.alpha_composite(onion, (0, 0))
    out.alpha_composite(zoom, (0, fh + 10))
    out.convert("RGB").save(PREVIEW_DIR / "ptero_onion.png")

    # (b) in-scene: reference photo, wingspan ~= 0.3 x image height, three altitudes like the game
    ref = load_rgba(REFERENCE)
    RW, RH = ref.size
    ground = int(0.76 * RH)
    s = 0.30 * RH / max(spans)
    scene = ref.copy()
    dino_h = 0.19 * RH
    placements = [(760, ground - 0.35 * dino_h, 0), (1080, ground - 1.05 * dino_h, 1), (1400, ground - 1.75 * dino_h, 2)]
    for x, body_y, i in placements:
        f = frames[i]
        sf = resize_premul(f, (round(fw * s), round(fh * s)))
        scene.alpha_composite(sf, (int(x), int(body_y - body_cy * s)))
    scene.convert("RGB").save(PREVIEW_DIR / "ptero_scene.png")
    # 1:1 crop of the in-scene composite around the pteros
    scene.crop((620, 150, 1700, 640)).convert("RGB").save(PREVIEW_DIR / "ptero_scene_crop.png")

    # flap GIF over a reference sky crop (up, mid, down, mid)
    gs = 300 / max(spans)
    gw, gh = round(fw * gs), round(fh * gs)
    sky = ref.crop((500, 0, 500 + gw + 80, gh + 40))            # plain sky between the sun glare and the clouds
    gif_frames = []
    for i in CYCLE:
        fr = sky.copy()
        fr.alpha_composite(resize_premul(frames[i], (gw, gh)), (40, 20))
        gif_frames.append(fr.convert("RGB").quantize(colors=255, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE))
    gif_frames[0].save(PREVIEW_DIR / "ptero_flap.gif", save_all=True, append_images=gif_frames[1:], duration=120,
                       loop=0, disposal=1)
    print("  previews: ptero_frames.png ptero_onion.png ptero_scene.png ptero_scene_crop.png ptero_flap.gif")


if __name__ == "__main__":
    main()
