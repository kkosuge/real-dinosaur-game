"""Dino asset pipeline: assets/raw/dino_*.png (Codex generations) -> assets/dino/*.webp + assets/manifest/dino.json.

Reproducible: run with the project venv python from anywhere:
    python tools/assets/dino.py

Inputs (all generated with Codex's built-in image tool, native transparent background):
  dino_master_c.png  the master design (defines the individual; not exported, used as the identity reference)
  SHEETS["run"]      2x2 sheet: four evenly spaced phases of one symmetric run stride (TL, TR, BL, BR):
                     contact (far leg forward), passing (near leg lifted), contact (near leg forward), passing
                     (far leg lifted); TR comes from FRAME_OVERRIDES (dino_run1_near_*.png, an edit of the sheet's
                     TR copy, which lifted the far leg like BR)
  SHEETS["pose"]     2x2 sheet: idle (used), idle breath / jump / crash (unused since fix round 1)
  SHEETS["crash"]    one row: a normal running copy (scale reference) + the crash (recoil) pose
  SHEETS["duck"]     top: a normal running copy (scale reference) / bottom: two duck-run frames
  SHEETS["jump"]     top: a normal running copy (scale reference) / bottom: two tucked-leg jump poses

Consistency strategy:
  * every sheet was generated with the master attached, so identity is shared;
  * one pixel scale for all frames: each sheet's scale is measured by matching the upper-body silhouette
    (head + neck + torso + tail, legs excluded) of an "anchor" copy in that sheet (run frame 0 / idle / the
    duck, jump and crash sheets' reference runner) against run frame 0 over a scale search, then the whole
    sheet is resized by that factor, so poses whose upper body differs (duck, crash) inherit the scale of
    their sheet-mate; then a rigid-body check: the head (skull + jaw) is template-matched (gradient NCC over
    rotation x scale) against run frame 0's head. Duck frames are corrected fully by it (the generator drew
    them ~8% smaller than their anchor); idle/crash/jump split any body-vs-head disagreement (geometric mean);
  * per-channel colour gains per sheet so every sheet matches the run sheet's mean colour, then ONE global
    grade (desaturate, contrast, highlight roll-off, a little haze) whose gain/contrast/knee/channel balance are
    calibrated at build time so run frame 0 at in-game scale matches the reference photo's own T-rex
    (interior mean colour, luminance spread and highlight level);
  * run/idle/jump frames are horizontally aligned by the same upper-body match (no torso jitter);
    ground frames have their lowest opaque pixel exactly on baselinePx; the jump frame keeps the torso
    height of run frame 0 (legs tucked above the baseline, so there is no torso "pop" at take-off).

Hitboxes (SPEC §4/§5 "slightly under-cover, never die to transparent pixels"): fitted per frame on the decoded
WebP by adaptive horizontal bands over a cleaned body mask (thin tail tip cut, claws/fingers/thin toes removed by
a small morphological opening). In each band the body columns form connected x-runs (separate legs get separate
boxes, the gap between them stays open); each run gives a box from the trimmed extent of its body pixels, inset by
HB_INSET px on the sides that face air. A band whose boxes hold more than HB_TMAX air, reach farther than HB_EMAX
px from the body, or leave more than HB_LEFT_OUT of the band's body uncovered is split in half recursively (so
sloping edges such as the throat, back and diagonal legs get a staircase of boxes); neighbours whose union stays
tight are merged, then a soft cap merges the cheapest pairs. Every frame is verified (<= 8% air over all boxes, no
box pixel > 12 px from the body) or the build fails.

Ends by running tools/build_manifest.py so assets/manifest.js always matches this fragment.
"""
from __future__ import annotations

import json
import pathlib
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
from common import *  # noqa: F401,F403  (ROOT, RAW, helpers)
from common import ROOT, RAW, PREVIEW_DIR, REFERENCE  # explicit for linters
from scipy.signal import fftconvolve

OUT_DIR = ROOT / "assets" / "dino"
GROUP = "dino"

# sheet key -> (raw file, number of copies, index of the "anchor" copy used to measure the sheet's scale and
# colour against run frame 0; None = the run sheet itself). Copies are ordered top row first, then by x.
SHEETS = {
    "run": ("dino_run4_c.png", 4, None),   # TL, TR, BL, BR = contact / passing, NEAR leg lifted (TR replaced, see
                                           # FRAME_OVERRIDES) / contact (other leg) / passing, FAR leg lifted
    "pose": ("dino_poses_a.png", 4, 0),    # idle [, idle breath, dangling-leg jump, rearing crash: unused]
    "crash": ("dino_crash_a.png", 2, 0),   # left: reference runner; right: crash (recoil) pose
    "duck": ("dino_duck_c.png", 3, 0),     # top: reference runner; bottom-left / bottom-right: duck frames
    "jump": ("dino_jump_a.png", 3, 0),     # top: reference runner; bottom: two tucked-leg jump variants
}
# single copies replaced by a separate raw holding ONE isolated animal (a Codex image edit of that very copy):
# (sheet key, copy index) -> raw file. The replacement is fitted to the copy it replaces (upper-body scale, mean
# upper-body colour; see fit_override), so the sheet's scale / colour / alignment measurements are unaffected.
# dino_run4_c's TR lifted the FAR leg like its BR, so half of every stride ran backwards; the edit swaps the legs
# (near leg lifted and tucked forward under the belly, far leg planted under the hip). dino_run1_near_a.png (the
# other attempt) is kept for provenance only: its body sits 14 px lower than the other frames (a bob at the passing
# frame) and its planted foot breaks the gait's symmetry (planted-foot steps 125 / 100 px instead of 101 / 100).
FRAME_OVERRIDES = {
    ("run", 1): "dino_run1_near_b.png",
}
ROW_SORT = {"crash": False}  # sheets laid out in a single row: order copies by x only
IDLE_IDX = 0                 # in SHEETS["pose"]
DEAD_IDX = 1                 # in SHEETS["crash"]
DUCK_IDX = (1, 2)
JUMP_IDX = 1

STAND_HEIGHT = 300          # target feet->top-of-head px of the running dino
MARGIN_X = 10               # transparent margin left/right of the union of all frames
MARGIN_TOP = 8
MARGIN_BOTTOM = 8           # rows below the baseline
UPPER_FRAC = 0.55           # rows (from the top of run frame 0) used as the "upper body" for matching
GRADE_SAT = 0.82            # global saturation factor toward the reference's muted palette
GRADE_HAZE = 0.05           # blend toward the scene's haze colour (aerial perspective of the reference)
HAZE_RGB = (207, 201, 192)  # ~#cfc9c0, the reference's hazy distance colour
GRADE_SOFT = 45.0           # highlight roll-off softness (luminance units above the knee)
# calibration targets relative to the reference photo's own T-rex (measured in build): keep the sprite a touch
# crisper than the tiny, hazy reference so it still reads at 1440p, but in the same tonal range
TARGET_STD_RATIO = 1.08     # interior luminance std vs reference
TARGET_P98_RATIO = 1.08     # 98th-percentile interior luminance vs reference
ALPHA_SOLID_FROM = 200      # alpha >= this is remapped linearly so >= ALPHA_SOLID_AT becomes 255 (solid interior)
ALPHA_SOLID_AT = 245
WEBP_Q = 88
# hitbox fitting (sprite px; see module docstring)
HB_TAIL_THICK = 0.17        # tail columns thinner than this x STAND_HEIGHT are not collidable (thin tail)
HB_OPEN_R = 4               # opening radius: removes claws, fingers, thin toes (features thinner than ~8 px)
HB_BANDS = 8                # initial horizontal bands (each is split adaptively)
HB_COVER = 0.35             # a column belongs to a band's run if >= this fraction of the band rows is body
HB_GAP = 4                  # columns further apart than this start a new run (separate legs)
HB_Q = 0.02                 # trimmed x extent of the body pixels in a run (quantile)
HB_INSET = 4                # inset of box sides that face air (~1.3% of standHeight): slight under-cover
HB_TMAX = 0.07              # max air fraction inside one box while fitting
HB_EMAX = 10.0              # max distance (px) of any box pixel from the opaque body while fitting
HB_OVERHANG = 12.0          # max right-edge (per row) / bottom-edge (per column) overhang past the body while fitting
HB_LEFT_OUT = 0.12          # split a band if more than this fraction of its body is outside its boxes
HB_MIN_H = 10               # bands are not split below this height
HB_MIN_AREA = 200           # boxes smaller than this (px^2) are dropped
HB_MAX_BOXES = 12           # soft cap, see _budget()
HB_BUDGET_AIR = 0.075       # budget merges keep the frame's total air fraction below this
HB_BUDGET_DIST = 11.5       # ... and every box pixel within this distance of the body
HB_ACCEPT_AIR = 0.08        # per-frame acceptance: total air fraction of all boxes
HB_ACCEPT_DIST = 12.0       # per-frame acceptance: max distance of any box pixel from the body


# ----------------------------------------------------------------------------------------------- helpers
def split_grid(sheet: Image.Image, n: int, rows: bool = True):
    """Split a sheet into n blobs ordered by row (top half / bottom half) then by x (or by x only)."""
    crops, boxes = split_components(sheet, n)
    items = list(zip(boxes, crops))
    mid = sheet.height / 2
    items.sort(key=lambda t: ((0 if (t[0][1] + t[0][3]) / 2 < mid else 1) if rows else 0, t[0][0]))
    return [clean_alpha(trim(c), min_alpha=6, keep_largest=1, min_blob_frac=0.0) for _, c in items]


def mask(img: Image.Image, thresh: int = 128) -> np.ndarray:
    return alpha_of(img) > thresh


def resize(img: Image.Image, s: float) -> Image.Image:
    return img.resize((max(1, round(img.width * s)), max(1, round(img.height * s))), Image.LANCZOS)


def upper_match(ref_upper: np.ndarray, target: np.ndarray):
    """Best (dx, dy, iou) so that target[y+dy, x+dx] ~ ref_upper[y, x]."""
    corr = fftconvolve(target.astype(np.float32), ref_upper[::-1, ::-1].astype(np.float32), mode="full")
    iy, ix = np.unravel_index(int(np.argmax(corr)), corr.shape)
    dy, dx = iy - (ref_upper.shape[0] - 1), ix - (ref_upper.shape[1] - 1)
    overlap = float(corr[iy, ix])
    rows = np.nonzero(ref_upper.any(axis=1))[0]
    r0, r1 = max(0, dy + rows.min()), max(0, dy + rows.max() + 1)
    t_count = float(target[r0:r1].sum())
    iou = overlap / (ref_upper.sum() + t_count - overlap + 1e-6)
    return int(dx), int(dy), iou


def best_scale(ref_upper: np.ndarray, target_img: Image.Image, lo=0.80, hi=1.25):
    """Scale search (coarse then fine) maximizing upper-body IoU of target vs reference."""
    def score(s):
        return upper_match(ref_upper, mask(resize(target_img, s)))

    best = (1.0, (0, 0, -1))
    for s in np.arange(lo, hi + 1e-9, 0.02):
        r = score(float(s))
        if r[2] > best[1][2]:
            best = (float(s), r)
    c = best[0]
    for s in np.arange(c - 0.02, c + 0.02 + 1e-9, 0.004):
        r = score(float(s))
        if r[2] > best[1][2]:
            best = (float(s), r)
    return best


def upper_mean(img: Image.Image, frac: float = 0.45):
    """Mean RGB of the fully opaque pixels in the top `frac` of the silhouette (head, neck, back: like-for-like
    skin across poses, unaffected by how much leg/belly is visible)."""
    a = np.asarray(img)
    m = a[..., 3] > 250
    ys = np.nonzero(m.any(axis=1))[0]
    cut = ys.min() + int(frac * (ys.max() - ys.min()))
    return a[:cut, :, :3][m[:cut]].astype(np.float64).mean(axis=0)


def apply_gain(img: Image.Image, gain) -> Image.Image:
    a = np.asarray(img).astype(np.float32)
    a[..., :3] = np.clip(a[..., :3] * np.asarray(gain, np.float32)[None, None, :], 0, 255)
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def fit_override(orig: Image.Image, new: Image.Image):
    """Fit a replacement copy (an image edit of `orig`, generated at another pixel size) to `orig`: coarse scale
    from the silhouette heights, fine scale by the upper-body match (legs excluded, like the sheet scale search),
    then per-channel gains so the upper-body mean colour matches. Returns (fitted image, log entry)."""
    new = clean_alpha(trim(ensure_alpha(new)), min_alpha=6, keep_largest=1, min_blob_frac=0.0)
    om = mask(orig)
    top = int(np.nonzero(om.any(axis=1))[0].min())
    upper = om.copy()
    upper[top + int(UPPER_FRAC * om.shape[0]):] = False
    s0 = orig.height / new.height
    s, (_, _, iou) = best_scale(upper, resize(new, s0), 0.9, 1.1)
    fitted = resize(new, s0 * s)
    gain = upper_mean(orig) / upper_mean(fitted)
    fitted = apply_gain(fitted, gain)
    return fitted, dict(scale=round(s0 * s, 4), upper_iou=round(iou, 3), gain=np.round(gain, 3).tolist())


LUMA = np.array([0.299, 0.587, 0.114], np.float32)


def grade_array(rgb: np.ndarray, p: dict) -> np.ndarray:
    """The global dino grade on a float RGB array: desaturate -> contrast around a fixed pivot -> gain and
    per-channel balance -> soft highlight roll-off above `knee` -> a little haze. `p` comes from calibrate()."""
    lum = (rgb * LUMA).sum(-1, keepdims=True)
    rgb = lum + (rgb - lum) * GRADE_SAT
    rgb = p["pivot"] + (rgb - p["pivot"]) * p["contrast"]
    rgb = rgb * p["gain"] * np.asarray(p["balance"], np.float32)
    L = np.maximum((rgb * LUMA).sum(-1, keepdims=True), 1e-3)
    over = np.maximum(L - p["knee"], 0.0)
    Lr = np.where(over > 0, p["knee"] + over / (1.0 + over / GRADE_SOFT), L)
    rgb = rgb * (Lr / L)
    rgb = rgb * (1 - GRADE_HAZE) + np.asarray(HAZE_RGB, np.float32) * GRADE_HAZE
    return np.clip(rgb, 0, 255)


def grade(img: Image.Image, p: dict) -> Image.Image:
    a = np.asarray(img).astype(np.float32)
    a[..., :3] = grade_array(a[..., :3], p)
    return Image.fromarray(a.astype(np.uint8), "RGBA")


def solidify(img: Image.Image) -> Image.Image:
    """Codex's native transparency leaves the interior at alpha 249-254 (the body would be ~1% see-through).
    Remap alpha >= ALPHA_SOLID_FROM linearly so >= ALPHA_SOLID_AT is fully opaque; the antialiased rim is kept."""
    a = np.asarray(img).copy()
    al = a[..., 3].astype(np.float32)
    hi = al >= ALPHA_SOLID_FROM
    al[hi] = ALPHA_SOLID_FROM + (al[hi] - ALPHA_SOLID_FROM) * (255 - ALPHA_SOLID_FROM) / (ALPHA_SOLID_AT - ALPHA_SOLID_FROM)
    a[..., 3] = np.clip(np.round(al), 0, 255).astype(np.uint8)
    return Image.fromarray(a, "RGBA")


def interior_stats(rgb: np.ndarray, m: np.ndarray) -> dict:
    """Tone statistics of the body interior (2 px in from the outline so edge/background mixing is excluded)."""
    inner = ndimage.binary_erosion(m, iterations=2)
    L = rgb @ LUMA
    return dict(mean=rgb[inner].mean(0), std=float(L[inner].std()), p98=float(np.percentile(L[inner], 98)),
                L=float(L[inner].mean()))


def reference_dino_stats() -> dict:
    """The reference photo's own running T-rex (x 95-370, y 440-575 of screen.webp; dust rows below excluded)."""
    ref = np.asarray(load_rgba(REFERENCE).convert("RGB")).astype(np.float32)
    crop = ref[440:600, 95:370]
    m = crop.mean(-1) < 175
    m[135:] = False
    lab, n = ndimage.label(m)
    m = lab == 1 + int(np.argmax(ndimage.sum(m, lab, range(1, n + 1))))
    st = interior_stats(crop, m)
    st["height"] = 157.0     # feet -> top of head in reference px (measured once by hand)
    return st


def calibrate(frame: Image.Image, stand_px: float) -> dict:
    """Fit the global grade so `frame` (a run frame, graded at in-game scale like the reference) matches the
    reference T-rex: mean luminance, luminance spread x TARGET_STD_RATIO, 98th percentile x TARGET_P98_RATIO,
    and the mean colour balance. Deterministic grid search + closed-form gain/balance refinement."""
    ref = reference_dino_stats()
    s = ref["height"] / stand_px
    small = frame.resize((round(frame.width * s), round(frame.height * s)), Image.LANCZOS)
    a = np.asarray(small).astype(np.float32)
    m = a[..., 3] > 200
    rgb = a[..., :3]
    pivot = float((rgb[m] @ LUMA).mean())
    t_std, t_p98 = ref["std"] * TARGET_STD_RATIO, ref["p98"] * TARGET_P98_RATIO
    best = None
    for contrast in np.arange(0.70, 1.401, 0.02):
        for knee in np.arange(60.0, 160.1, 5.0):
            p = dict(pivot=pivot, contrast=float(contrast), knee=float(knee), gain=1.0, balance=[1.0, 1.0, 1.0])
            for _ in range(4):   # gain so the mean luminance matches (roll-off makes it slightly non-linear)
                st = interior_stats(grade_array(rgb, p), m)
                p["gain"] *= ref["L"] / st["L"]
            st = interior_stats(grade_array(rgb, p), m)
            err = ((st["std"] - t_std) / t_std) ** 2 + ((st["p98"] - t_p98) / t_p98) ** 2
            if best is None or err < best[0]:
                best = (err, p)
    p = best[1]
    for _ in range(4):           # per-channel balance so the mean colour matches too
        st = interior_stats(grade_array(rgb, p), m)
        p["balance"] = (np.asarray(p["balance"]) * ref["mean"] / st["mean"]).tolist()
        st = interior_stats(grade_array(rgb, p), m)
        p["gain"] *= ref["L"] / st["L"]
    st = interior_stats(grade_array(rgb, p), m)
    p = {k: (round(float(v), 4) if not isinstance(v, list) else [round(float(x), 4) for x in v]) for k, v in p.items()}
    report = dict(params=p, ref=dict(mean=np.round(ref["mean"], 1).tolist(), std=round(ref["std"], 1),
                                     p98=round(ref["p98"], 1)),
                  ours=dict(mean=np.round(st["mean"], 1).tolist(), std=round(st["std"], 1), p98=round(st["p98"], 1)))
    return p, report


# --------------------------------------------------------------------------------------------- hitboxes
def _disk(r: int) -> np.ndarray:
    y, x = np.mgrid[-r:r + 1, -r:r + 1]
    return (x * x + y * y) <= r * r


def body_mask(img: Image.Image):
    """(opaque mask, collidable body mask). The collidable body is the alpha>128 silhouette minus the thin tail
    tip (columns left of the first one whose thickness reaches HB_TAIL_THICK x STAND_HEIGHT) and minus anything
    thinner than ~2 x HB_OPEN_R (claws, fingers, thin toes), keeping every sizeable connected part."""
    m = mask(img, 128)
    x_cut = int(np.argmax(m.sum(0) >= HB_TAIL_THICK * STAND_HEIGHT))
    c = m.copy()
    c[:, :x_cut] = False
    c = ndimage.binary_opening(c, structure=_disk(HB_OPEN_R))
    lab, n = ndimage.label(c)
    if n > 1:
        sizes = ndimage.sum(c, lab, range(1, n + 1))
        c = np.isin(lab, [i + 1 for i, s in enumerate(sizes) if s >= 0.01 * sizes.max()])
    return m, c


def _overhang(m, r):
    """Largest horizontal overhang of the box's right edge past the body in any of its rows, and vertical
    overhang of its bottom edge below the body in any of its columns (px). These are what an obstacle meets
    first: a cactus approaching from the right, or a cactus top under a jumping dino."""
    x0, y0, x1, y1 = r
    sub = m[y0:y1, x0:x1]
    w, h = sub.shape[1], sub.shape[0]
    rows = sub.any(1)
    right = np.where(rows, w - 1 - np.argmax(sub[:, ::-1], axis=1), -1)
    cols = sub.any(0)
    low = np.where(cols, h - 1 - np.argmax(sub[::-1, :], axis=0), -1)
    return float((w - 1 - right).max()), float((h - 1 - low).max())


def _rect_eval(m, dist, r):
    """(air fraction, max distance to the body, max right/bottom overhang) of box r = [x0, y0, x1, y1]."""
    x0, y0, x1, y1 = r
    if x1 <= x0 or y1 <= y0:
        return 1.0, 1e9
    t, e = 1.0 - float(m[y0:y1, x0:x1].mean()), float(dist[y0:y1, x0:x1].max())
    return t, max(e, *(v * HB_EMAX / HB_OVERHANG for v in _overhang(m, r)))


def _inset(c, r, k):
    """Inset only the sides that face air (the 3 px strip just outside is mostly not body); sides shared with
    the neighbouring band stay put, so the boxes tile the body without slits."""
    x0, y0, x1, y1 = r
    H, W = c.shape

    def frac(ys, xs):
        a = c[ys, xs]
        return float(a.mean()) if a.size else 0.0
    L = frac(slice(y0, y1), slice(max(0, x0 - 3), x0))
    R = frac(slice(y0, y1), slice(x1, min(W, x1 + 3)))
    T = frac(slice(max(0, y0 - 3), y0), slice(x0, x1))
    B = frac(slice(y1, min(H, y1 + 3)), slice(x0, x1))
    return [x0 + (k if L < 0.5 else 0), y0 + (k if T < 0.5 else 0), x1 - (k if R < 0.5 else 0),
            y1 - (k if B < 0.5 else 0)]


def _band_rects(c, y0, y1):
    """Rows y0..y1: columns that are >= HB_COVER body form connected x-runs (separate legs -> separate runs);
    each run -> the trimmed (HB_Q quantile) x extent and the rows that have body in it."""
    band = c[y0:y1]
    cols = np.nonzero(band.mean(0) >= HB_COVER)[0]
    if len(cols) == 0:
        return []
    runs, s, prev = [], cols[0], cols[0]
    for x in cols[1:]:
        if x - prev > HB_GAP:
            runs.append((s, prev + 1))
            s = x
        prev = x
    runs.append((s, prev + 1))
    out = []
    for c0, c1 in runs:
        sub = band[:, c0:c1]
        _, xx = np.nonzero(sub)
        if len(xx) < 20:
            continue
        xa, xb = np.quantile(xx, HB_Q), np.quantile(xx, 1 - HB_Q)
        rows = np.nonzero(sub.mean(1) >= 0.15)[0]
        out.append([c0 + int(np.floor(xa)), y0 + int(rows.min()), c0 + int(np.ceil(xb)) + 1, y0 + int(rows.max()) + 1])
    return out


def _fit_band(c, m, dist, y0, y1, out):
    """Fit one band; split it in half (recursively) while a box is too loose or too much body is left out."""
    rects = _band_rects(c, y0, y1)
    inset = [_inset(c, r, HB_INSET) for r in rects]
    bad = any(t > HB_TMAX or e > HB_EMAX for t, e in (_rect_eval(m, dist, r) for r in inset))
    cov = np.zeros_like(c[y0:y1])
    for r in rects:
        cov[max(0, r[1] - y0):r[3] - y0, r[0]:r[2]] = True
    left_out = (c[y0:y1] & ~cov).sum() / max(int(c[y0:y1].sum()), 1)
    if (bad or left_out > HB_LEFT_OUT) and y1 - y0 >= 2 * HB_MIN_H:
        mid = (y0 + y1) // 2
        _fit_band(c, m, dist, y0, mid, out)
        _fit_band(c, m, dist, mid, y1, out)
        return
    for r in inset:
        for _ in range(400):     # still too loose at the minimum band height: shrink the airiest side
            t, e = _rect_eval(m, dist, r)
            if t <= HB_TMAX and e <= HB_EMAX:
                break
            x0, ya, x1, yb = r
            if x1 - x0 < 6 or yb - ya < 4:
                r = None
                break
            air = {"l": (~m[ya:yb, x0]).mean(), "r": (~m[ya:yb, x1 - 1]).mean(),
                   "t": (~m[ya, x0:x1]).mean(), "b": (~m[yb - 1, x0:x1]).mean()}
            k = max(air, key=air.get)
            r = [x0 + (k == "l"), ya + (k == "t"), x1 - (k == "r"), yb - (k == "b")]
        if r is not None and (r[2] - r[0]) * (r[3] - r[1]) >= HB_MIN_AREA:
            out.append(r)


def _adjacent(a, b, tol):
    return a[1] <= b[3] + tol and b[1] <= a[3] + tol and a[0] <= b[2] + 2 and b[0] <= a[2] + 2


def _merge(rects, m, dist):
    """Merge neighbouring boxes whose union is still tight (<= HB_TMAX air, <= HB_EMAX px), least air first."""
    rects = [list(r) for r in rects]
    while True:
        best = None
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                a, b = rects[i], rects[j]
                if not _adjacent(a, b, 10):
                    continue
                u = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                t, e = _rect_eval(m, dist, u)
                if t <= HB_TMAX - 0.01 and e <= HB_EMAX and (best is None or t < best[0]):
                    best = (t, i, j, u)
        if best is None:
            return rects
        _, i, j, u = best
        rects = [r for k, r in enumerate(rects) if k not in (i, j)] + [u]


def _budget(rects, m, dist):
    """While there are more than HB_MAX_BOXES boxes, merge the touching pair whose union adds the fewest air
    pixels, as long as the union stays within HB_BUDGET_DIST px of the body and the frame's total air fraction
    stays <= HB_BUDGET_AIR. Stops early when no merge qualifies (diagonal legs need a staircase of boxes)."""
    rects = [list(r) for r in rects]

    def air(r):
        return int((~m[r[1]:r[3], r[0]:r[2]]).sum())

    def area(r):
        return (r[2] - r[0]) * (r[3] - r[1])
    while len(rects) > HB_MAX_BOXES:
        tot_air, tot_area = sum(map(air, rects)), sum(map(area, rects))
        best = None
        for i in range(len(rects)):
            for j in range(i + 1, len(rects)):
                a, b = rects[i], rects[j]
                if not _adjacent(a, b, 2):
                    continue
                u = [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]
                if (float(dist[u[1]:u[3], u[0]:u[2]].max()) > HB_BUDGET_DIST
                        or max(_overhang(m, u)) > HB_OVERHANG * HB_BUDGET_DIST / HB_EMAX):
                    continue
                d_air = air(u) - air(a) - air(b)
                if (tot_air + d_air) / (tot_area + area(u) - area(a) - area(b)) > HB_BUDGET_AIR:
                    continue
                if best is None or d_air < best[0]:
                    best = (d_air, i, j, u)
        if best is None:
            break
        _, i, j, u = best
        rects = [r for k, r in enumerate(rects) if k not in (i, j)] + [u]
    return rects


def hitbox_stats(img: Image.Image, boxes) -> dict:
    """air: transparent (alpha<=128) fraction of the total box area; max_dist: farthest box pixel from the opaque
    body (px); body_cover: collidable body covered; rim_cover: collidable body within 10 px of its outline
    covered (the part that decides collisions)."""
    m, c = body_mask(img)
    dist = ndimage.distance_transform_edt(~m)
    U = np.zeros_like(m)
    area = air = 0
    far = 0.0
    for x, y, w, h in boxes:
        x0, y0, x1, y1 = int(np.floor(x)), int(np.floor(y)), int(np.ceil(x + w)), int(np.ceil(y + h))
        U[y0:y1, x0:x1] = True
        area += (x1 - x0) * (y1 - y0)
        air += int((~m[y0:y1, x0:x1]).sum())
        far = max(far, float(dist[y0:y1, x0:x1].max()))
    rim = c & (ndimage.distance_transform_edt(c) <= 10)
    # global profiles: a tall obstacle approaching from the right with its top at row t first meets
    # max(rightmost box px over rows >= t); compare with the body's; same for the bottom profile per column
    H, W = m.shape

    def rightmost(a):
        r = np.full(H, -1)
        rows = a.any(1)
        r[rows] = W - 1 - np.argmax(a[rows][:, ::-1], axis=1)
        return np.maximum.accumulate(r[::-1])[::-1]

    def lowest(a):
        r = np.full(W, -1)
        cols = a.any(0)
        r[cols] = H - 1 - np.argmax(a[::-1][:, cols], axis=0)
        return r
    rb, ro = rightmost(U), rightmost(m)
    ok = (rb >= 0) & (ro >= 0)
    lb, lo = lowest(U), lowest(m)
    okc = (lb >= 0) & (lo >= 0)
    return dict(n=len(boxes), air=round(air / max(area, 1), 3), max_dist=round(far, 1),
                front_slack=int((rb - ro)[ok].max()), bottom_slack=int((lb - lo)[okc].max()),
                body_cover=round(float((U & c).sum() / c.sum()), 3), rim_cover=round(float((U & rim).sum() / rim.sum()), 3))


def hitboxes(img: Image.Image):
    """Silhouette -> list of [x, y, w, h] boxes that slightly under-cover the collidable body (see docstring)."""
    m, c = body_mask(img)
    dist = ndimage.distance_transform_edt(~m)
    ys = np.nonzero(c.any(1))[0]
    edges = np.linspace(int(ys.min()), int(ys.max()) + 1, HB_BANDS + 1).round().astype(int)
    out = []
    for a, b in zip(edges[:-1], edges[1:]):
        _fit_band(c, m, dist, int(a), int(b), out)
    out = _budget(_merge(out, m, dist), m, dist)
    out.sort(key=lambda r: (r[1], r[0]))
    boxes = [[float(r[0]), float(r[1]), float(r[2] - r[0]), float(r[3] - r[1])] for r in out]
    st = hitbox_stats(img, boxes)
    if st["air"] > HB_ACCEPT_AIR or st["max_dist"] > HB_ACCEPT_DIST:
        raise RuntimeError(f"hitboxes fail acceptance: {st}")
    return boxes, st


def _grad_feature(img: Image.Image):
    """Gradient-magnitude image (texture/edges; insensitive to small exposure differences) inside the body."""
    a = np.asarray(img).astype(np.float32)
    g = ndimage.gaussian_filter(a[..., :3] @ np.array([0.299, 0.587, 0.114], np.float32), 1.0)
    return np.hypot(ndimage.sobel(g, 1), ndimage.sobel(g, 0)) * (a[..., 3] > 242), a[..., 3] / 255.0


def _masked_ncc(I, T, M):
    n = M.sum()
    Tz = (T - (T * M).sum() / n) * M
    Tn2 = float((Tz ** 2).sum())
    A = fftconvolve(I, Tz[::-1, ::-1], mode="valid")
    S1 = fftconvolve(I, M[::-1, ::-1], mode="valid")
    S2 = fftconvolve(I * I, M[::-1, ::-1], mode="valid")
    var = S2 - S1 ** 2 / n
    ncc = A / np.sqrt(Tn2 * np.maximum(var, 1e-3))
    ncc[var < 0.25 * Tn2] = 0.0          # flat regions give meaningless (even >1) scores
    return ncc


def head_template(img: Image.Image) -> Image.Image:
    """Tight crop of the head (skull + jaw) of a right-facing runner: rightmost 21% x top 25% of the silhouette."""
    t = trim(img)
    ys, xs = np.nonzero(mask(t))
    W, H = xs.max() - xs.min(), ys.max() - ys.min()
    return t.crop((int(xs.max() - 0.21 * W), int(ys.min()), int(xs.max()) + 1, int(ys.min() + 0.25 * H)))


def head_scale(tpl: Image.Image, target: Image.Image):
    """Relative size of target's head vs the template head (rigid-body size cue), searching rotation + scale.
    Returns (scale, ncc, angle)."""
    I, _ = _grad_feature(trim(target))

    def search(angles, scales):
        best = (-1.0, 1.0, 0.0)
        for ang in angles:
            rt = tpl.rotate(float(ang), resample=Image.BICUBIC, expand=True)
            for sc in scales:
                t = resize(rt, float(sc))
                T, A = _grad_feature(t)
                M = ndimage.binary_erosion(A > 0.95, iterations=3).astype(np.float32)
                if T.shape[0] >= I.shape[0] or T.shape[1] >= I.shape[1] or M.sum() < 50:
                    continue
                v = float(_masked_ncc(I, T * M, M).max())
                if v > best[0]:
                    best = (v, float(sc), float(ang))
        return best

    v, sc, ang = search(np.arange(-15, 15.1, 3), np.arange(0.84, 1.17, 0.03))
    v, sc, ang = search(np.arange(ang - 2, ang + 2.1, 1), np.arange(sc - 0.03, sc + 0.031, 0.01))
    return sc, v, ang


def com_x(m: np.ndarray) -> float:
    return float(np.nonzero(m)[1].mean())


def lowest_row(img: Image.Image, thresh: int = 128) -> int:
    return int(np.nonzero(mask(img, thresh).any(axis=1))[0].max())


# ----------------------------------------------------------------------------------------------- pipeline
def build():
    raw = {k: split_grid(load_rgba(RAW / f), n, ROW_SORT.get(k, True)) for k, (f, n, _) in SHEETS.items()}
    override_log = {}
    for (k, i), f in FRAME_OVERRIDES.items():
        raw[k][i], override_log[f"{k}_{i}_override"] = fit_override(raw[k][i], load_rgba(RAW / f))
        override_log[f"{k}_{i}_override"]["raw"] = f
    run_raw = raw["run"]

    # --- colour: per-sheet gains so each sheet's anchor copy matches the run sheet's mean upper-body colour,
    # then a per-frame refinement for frames whose upper body is comparable to the runner (idle, jump)
    target_mean = np.mean([upper_mean(f) for f in run_raw], axis=0)
    gains = {}
    for k, (_, _, anchor) in SHEETS.items():
        if anchor is None:
            continue
        gains[k] = target_mean / upper_mean(raw[k][anchor])
        raw[k] = [apply_gain(i, gains[k]) for i in raw[k]]
    for k, idx in [("pose", IDLE_IDX), ("jump", JUMP_IDX)]:
        raw[k][idx] = apply_gain(raw[k][idx], target_mean / upper_mean(raw[k][idx]))

    # --- scale: reference = run frame 0, upper body only
    ref = run_raw[0]
    ref_m = mask(ref)
    top = int(np.nonzero(ref_m.any(axis=1))[0].min())
    ref_upper = ref_m.copy()
    ref_upper[top + int(UPPER_FRAC * ref_m.shape[0]):] = False
    log = dict(override_log)

    run_scales = []
    for i, f in enumerate(run_raw):
        s, (dx, dy, iou) = best_scale(ref_upper, f, 0.9, 1.1)
        run_scales.append(s)
        log[f"run_{i}"] = dict(scale=round(s, 3), iou=round(iou, 3))
    s_run = float(np.median(run_scales))            # one scale for the whole run sheet
    scales = {"run": s_run}
    for k, (_, _, anchor) in SHEETS.items():
        if anchor is None:
            continue
        s, (_, _, iou) = best_scale(ref_upper, raw[k][anchor])
        scales[k] = s
        log[f"{k}_sheet"] = dict(scale=round(s / s_run, 3), anchor_iou=round(iou, 3),
                                 gain=np.round(gains[k], 3).tolist())

    # heights of the run frames at run-sheet scale -> global factor so the runner is STAND_HEIGHT tall
    heights = []
    for f in run_raw:
        mm = mask(f)
        rows = np.nonzero(mm.any(axis=1))[0]
        heights.append(rows.max() + 1 - rows.min())
    G = STAND_HEIGHT / (float(np.median(heights)) * s_run)

    fin = {k: [resize(f, scales[k] * G) for f in v] for k, v in raw.items()}
    run = fin["run"]

    # --- head-size refinement. The head is rigid, so its size is the most pose-independent size cue.
    #  * duck frames: their body posture can't be compared with the runner's, and the generator drew the
    #    ducking copies slightly smaller than their sheet's anchor -> scale fully by the head match.
    #  * idle/dead (pose sheet) and jump: bodies already match the runner; if the head disagrees, split the
    #    difference (geometric mean) so neither body nor head is off by more than half the discrepancy.
    tpl = head_template(run[0])

    def head_fix(imgs, probe, weight, key):
        sc, ncc, ang = head_scale(tpl, probe)
        if ncc < 0.5:
            log[key] = dict(head_scale=round(sc, 3), head_ncc=round(ncc, 3), applied=1.0)
            return imgs
        f = float(np.clip((1.0 / sc) ** weight, 0.85, 1.15))
        log[key] = dict(head_scale=round(sc, 3), head_ncc=round(ncc, 3), head_angle=ang, applied=round(f, 3))
        return [resize(i, f) for i in imgs]

    d_idx = list(DUCK_IDX)
    fixed = head_fix([fin["duck"][i] for i in d_idx], fin["duck"][d_idx[0]], 1.0, "duck_head")
    for i, im in zip(d_idx, fixed):
        fin["duck"][i] = im
    fin["pose"] = head_fix(fin["pose"], fin["pose"][IDLE_IDX], 0.5, "pose_head")
    fin["jump"] = head_fix(fin["jump"], fin["jump"][JUMP_IDX], 0.5, "jump_head")
    # crash: its head is thrown back with the jaw open, so probe the sheet's reference runner instead (same
    # sheet = same head/body proportion as the crash copy)
    fin["crash"] = head_fix(fin["crash"], fin["crash"][0], 0.5, "crash_head")
    idle = fin["pose"][IDLE_IDX]
    dead = fin["crash"][DEAD_IDX]
    duck0, duck1 = fin["duck"][DUCK_IDX[0]], fin["duck"][DUCK_IDX[1]]
    jump = fin["jump"][JUMP_IDX]

    # --- placement in a common "world" frame whose origin is run frame 0's top-left
    ref_final = run[0]
    rm = mask(ref_final)
    rtop = int(np.nonzero(rm.any(axis=1))[0].min())
    ref_up = rm.copy()
    ref_up[rtop + int(UPPER_FRAC * rm.shape[0]):] = False
    baseline_w = lowest_row(ref_final)

    placed = {}   # name -> (img, ox, oy)

    def torso_place(img, ground=True):
        dx, dy, iou = upper_match(ref_up, mask(img))
        ox, oy = -dx, -dy
        if ground:
            oy = baseline_w - lowest_row(img)
        return ox, oy, iou

    for i, f in enumerate(run):
        ox, oy, iou = torso_place(f)
        placed[f"run_{i}"] = (f, ox, oy)
        log[f"run_{i}"]["align_iou"] = round(iou, 3)
    ox, oy, iou = torso_place(idle)
    placed["idle_0"] = (idle, ox, oy)
    log["idle_0"] = dict(align_iou=round(iou, 3))
    # (a second "breathing" idle frame was dropped in fix round 1: it was a separate render, so swapping it in
    # popped the head and the skin texture; the engine animates breathing by scaling idle_0 at the feet)
    jx, jy, iou = torso_place(jump, ground=False)
    placed["jump_0"] = (jump, jx, jy)
    log["jump_0"] = dict(align_iou=round(iou, 3), feet_above_baseline=int(baseline_w - (jy + lowest_row(jump))))

    # duck: both frames aligned to each other by their upper body; the pair's centre of mass matches run 0's
    run_com = float(np.mean([com_x(mask(placed[f"run_{i}"][0])) + placed[f"run_{i}"][1] for i in range(len(run))]))
    d0m = mask(duck0)
    d0top = int(np.nonzero(d0m.any(axis=1))[0].min())
    d0_up = d0m.copy()
    d0_up[d0top + int(0.6 * d0m.shape[0]):] = False
    ddx, ddy, _ = upper_match(d0_up, mask(duck1))
    d0x = round(run_com - com_x(d0m))
    placed["duck_0"] = (duck0, d0x, baseline_w - lowest_row(duck0))
    placed["duck_1"] = (duck1, d0x - ddx, baseline_w - lowest_row(duck1))
    # dead: centre of mass at run 0's, lowest point on baseline
    placed["dead_0"] = (dead, round(run_com - com_x(mask(dead))), baseline_w - lowest_row(dead))

    # --- canvas = union of all placed frames + margins
    x0 = min(ox for _, ox, _ in placed.values()) - MARGIN_X
    y0 = min(oy for _, _, oy in placed.values()) - MARGIN_TOP
    x1 = max(ox + im.width for im, ox, _ in placed.values()) + MARGIN_X
    frameW = int(x1 - x0)
    baselinePx = int(baseline_w - y0)
    frameH = int(max(max(oy + im.height for im, _, oy in placed.values()) - y0, baselinePx + 1) + MARGIN_BOTTOM)
    frameW += frameW % 2
    frameH += frameH % 2

    frames = {}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, (im, ox, oy) in placed.items():
        canvas = Image.new("RGBA", (frameW, frameH), (0, 0, 0, 0))
        canvas.alpha_composite(solidify(defringe(im)), (int(ox - x0), int(oy - y0)))
        frames[name] = canvas

    # stand height check (feet -> top of head) for run frames
    stand = [baselinePx + 1 - int(np.nonzero(mask(frames[f"run_{i}"]).any(axis=1))[0].min()) for i in range(len(run))]
    standHeightPx = int(round(float(np.median(stand))))

    # one global grade, calibrated on run frame 0 against the reference photo's T-rex, applied to every frame
    gparams, greport = calibrate(frames["run_0"], standHeightPx)
    log["grade"] = greport
    frames = {k: grade(v, gparams) for k, v in frames.items()}

    # the tail tip x (engine: drawX = DINO_TAIL_X - tailTipPx * s): leftmost solid pixel over the run frames
    tail_tip = int(min(np.nonzero(mask(frames[f"run_{i}"]).any(axis=0))[0].min() for i in range(len(run))))

    manifest_frames = {"idle": [], "run": [], "duck": [], "jump": [], "dead": []}
    order = ["idle_0"] + [f"run_{i}" for i in range(len(run))] + ["duck_0", "duck_1", "jump_0", "dead_0"]
    for stale in OUT_DIR.glob("*.webp"):          # frames dropped from the manifest (e.g. idle_1)
        if stale.stem not in order:
            stale.unlink()
    for name in order:
        img = frames[name]
        path = save_webp(img, OUT_DIR / f"{name}.webp", quality=WEBP_Q)
        kind = name.split("_")[0]
        # boxes from the decoded WebP (exactly what the engine will draw)
        decoded = load_rgba(path)
        boxes, hst = hitboxes(decoded)
        log.setdefault(name, {})["hitboxes"] = hst
        entry = {"src": rel(path), "hitboxes": boxes}
        if kind == "dead":
            # leftmost visible column (alpha > 24): the renderer keeps the dead pose's tail on screen when it pulls
            # the pose back against what it hit
            entry["opaqueX0"] = int(np.nonzero(mask(decoded, 24).any(axis=0))[0].min())
        manifest_frames[kind].append(entry)

    data = {"dino": {"frameW": frameW, "frameH": frameH, "baselinePx": baselinePx,
                     "standHeightPx": standHeightPx, "tailTipPx": tail_tip, "frames": manifest_frames}}
    frag = write_fragment(GROUP, data)

    # sanity checks
    for name, img in frames.items():
        low = lowest_row(img)
        log.setdefault(name, {})["lowest_row"] = low
        log[name]["height"] = low + 1 - int(np.nonzero(mask(img).any(axis=1))[0].min())
    duck_h = max(log["duck_0"]["height"], log["duck_1"]["height"])
    log["summary"] = dict(frameW=frameW, frameH=frameH, baselinePx=baselinePx, standHeightPx=standHeightPx,
                          stand_heights=stand, duck_ratio=round(duck_h / standHeightPx, 3))
    return frames, data, frag, log, order


def gait(frames, d):
    """Planted-foot x per run frame (centroid of the largest blob within 10 px of the baseline) and the ground
    travel of the planted foot over the two contact->passing steps (frames 0->1 and 2->3), which should be equal
    for a symmetric stride. stride_per_frame is their mean in units of standHeightPx."""
    n = len(d["frames"]["run"])
    xs = []
    for i in range(n):
        m = mask(frames[f"run_{i}"])
        strip = m[d["baselinePx"] - 10:d["baselinePx"] + 1]
        lab, k = ndimage.label(strip)
        big = 1 + int(np.argmax(ndimage.sum(strip, lab, range(1, k + 1))))
        xs.append(float(np.nonzero(lab == big)[1].mean()))
    steps = [xs[0] - xs[1], xs[2] - xs[3]] if n == 4 else [xs[i] - xs[i + 1] for i in range(0, n - 1, 2)]
    return dict(foot_x=[round(x, 1) for x in xs], steps_px=[round(v, 1) for v in steps],
                stride_per_frame=round(float(np.mean(steps)) / d["standHeightPx"], 3))


# ----------------------------------------------------------------------------------------------- previews
def label_draw(img, text, xy=(6, 4), fill=(20, 20, 20, 255)):
    ImageDraw.Draw(img).text(xy, text, fill=fill)


def preview_sheet(frames, data, order):
    d = data["dino"]
    tiles = []
    for name in order:
        kind, idx = name.rsplit("_", 1)
        boxes = d["frames"][kind][int(idx)]["hitboxes"]
        t = on_background(frames[name])
        t = draw_boxes(t, boxes, color=(230, 0, 0, 255), width=2)
        dr = ImageDraw.Draw(t)
        dr.line([(0, d["baselinePx"]), (t.width, d["baselinePx"])], fill=(0, 90, 255, 255), width=1)
        dr.line([(0, d["baselinePx"] - d["standHeightPx"]), (t.width, d["baselinePx"] - d["standHeightPx"])],
                fill=(0, 170, 90, 255), width=1)
        dr.rectangle([0, 0, t.width - 1, t.height - 1], outline=(150, 150, 160, 255))
        label_draw(t, f"{name}  ({len(boxes)} boxes)")
        tiles.append(t)
    cols = 3
    fw, fh = d["frameW"], d["frameH"]
    sheet = Image.new("RGBA", (cols * fw, ((len(tiles) + cols - 1) // cols) * fh), (223, 224, 230, 255))
    for i, t in enumerate(tiles):
        sheet.alpha_composite(t, ((i % cols) * fw, (i // cols) * fh))
    p = PREVIEW_DIR / "dino_sheet.png"
    PREVIEW_DIR.mkdir(parents=True, exist_ok=True)
    sheet.convert("RGB").save(p)
    return p


def preview_onion(frames, data):
    d = data["dino"]
    names = [f"run_{i}" for i in range(len(d["frames"]["run"]))]
    cols = [(230, 40, 40), (30, 160, 30), (40, 60, 230), (200, 40, 200), (0, 160, 160), (170, 130, 0)]
    fw, fh = d["frameW"], d["frameH"]
    out = Image.new("RGBA", (fw * 2, fh), (223, 224, 230, 255))
    # left: coloured silhouettes of the run cycle; right: run_0 vs idle / jump / duck / dead outlines
    for i, n in enumerate(names):
        a = (alpha_of(frames[n]).astype(np.float32) * 0.33).astype(np.uint8)
        col = np.zeros((fh, fw, 4), np.uint8)
        col[..., :3] = cols[i % len(cols)]
        col[..., 3] = a
        out.alpha_composite(Image.fromarray(col, "RGBA"))
    right = Image.new("RGBA", (fw, fh), (0, 0, 0, 0))
    for i, n in enumerate(["run_0", "idle_0", "jump_0", "duck_0", "dead_0"]):
        m = mask(frames[n])
        edge = m & ~ndimage.binary_erosion(m, iterations=2)
        col = np.zeros((fh, fw, 4), np.uint8)
        col[..., :3] = cols[i]
        col[..., 3] = edge * 255
        right.alpha_composite(Image.fromarray(col, "RGBA"))
    out.alpha_composite(right, (fw, 0))
    dr = ImageDraw.Draw(out)
    dr.line([(0, d["baselinePx"]), (out.width, d["baselinePx"])], fill=(0, 0, 0, 255))
    label_draw(out, "run cycle onion skin: " + ", ".join(f"{n}={c}" for n, c in zip(names, ["red", "green", "blue", "magenta", "cyan", "olive"])))
    label_draw(out, "outlines: run_0 red, idle green, jump blue, duck magenta, dead cyan", (fw + 6, 4))
    p = PREVIEW_DIR / "dino_onion.png"
    out.convert("RGB").save(p)
    return p


def preview_legs(frames, data):
    """Close-up of the hind legs of the four run frames (2x2, same crop for all): which leg is lifted in each
    passing frame (run_1: the lit near leg, run_3: the shaded far leg) and continuous leg motion 0->1->2->3."""
    d = data["dino"]
    names = [f"run_{i}" for i in range(len(d["frames"]["run"]))]
    y0 = int(d["baselinePx"] - 0.62 * d["standHeightPx"])
    y1 = d["baselinePx"] + 6
    cols = np.nonzero(np.any([mask(frames[n])[y0:y1].any(axis=0) for n in names], axis=0))[0]
    box = (max(0, int(cols.min()) - 20), y0, min(d["frameW"], int(cols.max()) + 21), y1)
    tw = 740
    th = round((box[3] - box[1]) * tw / (box[2] - box[0]))
    gap = 10
    sheet = Image.new("RGB", (2 * tw + gap, 2 * th + gap), (150, 150, 155))
    for i, n in enumerate(names):
        t = on_background(frames[n], (235, 233, 228, 255)).crop(box).resize((tw, th), Image.LANCZOS).convert("RGB")
        label_draw(t, n)
        sheet.paste(t, ((i % 2) * (tw + gap), (i // 2) * (th + gap)))
    p = PREVIEW_DIR / "qa_dino_r2_legs.png"
    sheet.save(p)
    return p


def shadow(size, cx, cy, rx, ry, alpha=0.28):
    w, h = size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    r = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
    a = np.clip(1 - r, 0, 1) ** 1.5 * alpha
    arr = np.zeros((h, w, 4), np.uint8)
    arr[..., :3] = (70, 60, 50)
    arr[..., 3] = (a * 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def preview_ingame(frames, data):
    """Every frame composited into the reference photo at in-game scale (standing height = 0.19 x image height,
    feet on GROUND_Y = 0.76 H), with a soft contact shadow like the engine's. The reference's own dino stays
    visible at the left of each panel for a side-by-side realism check."""
    d = data["dino"]
    ref = load_rgba(REFERENCE)
    Hh = ref.height
    ground_y = round(0.760 * Hh)
    s = 0.19 * Hh / d["standHeightPx"]
    rows = [[("run_0", 0), ("run_1", 0), ("run_2", 0), ("run_3", 0)],
            [("idle_0", 0), ("jump_0", 60), ("dead_0", 0)],
            [("duck_0", 0), ("duck_1", 0)]]
    slots = [[390, 700, 1010, 1320], [390, 800, 1210], [400, 860]]
    panel_box = (0, 330, ref.width, 700)
    panels = []
    for row, xs_slots in zip(rows, slots):
        out = ref.copy()
        for (name, lift), x in zip(row, xs_slots):
            im = frames[name]
            im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
            y = ground_y - round(d["baselinePx"] * s) - lift
            cols = np.nonzero(mask(im).any(axis=0))[0]
            cx = x + (cols.min() + cols.max()) / 2
            out.alpha_composite(shadow(out.size, cx + 6, ground_y + 2, (cols.max() - cols.min()) * 0.36, 7,
                                       0.28 if lift == 0 else 0.12))
            out.alpha_composite(im, (x, y))
            ImageDraw.Draw(out).text((x + 120, ground_y + 30), name, fill=(40, 40, 40, 255))
        panels.append(out.crop(panel_box))
    sheet = Image.new("RGBA", (ref.width, sum(p.height for p in panels)))
    yy = 0
    for pnl in panels:
        sheet.alpha_composite(pnl, (0, yy))
        yy += pnl.height
    p = PREVIEW_DIR / "dino_ingame.png"
    sheet.convert("RGB").save(p)
    # close-up at 2x: the reference's own dino next to run_0 / run_1
    crop = panels[0].crop((60, 70, 1000, 310))
    crop = crop.resize((crop.width * 2, crop.height * 2), Image.LANCZOS)
    p2 = PREVIEW_DIR / "dino_ingame_closeup.png"
    crop.convert("RGB").save(p2)
    return [p, p2]


def preview_gif(frames, data):
    """Animated run loop (~12 fps) over a seamless strip of the reference photo at 2x in-game scale.

    The background scrolls by the gait's measured ground travel per frame (mean planted-foot travel of the two
    contact->passing steps, see gait()) so the planted feet do not slide; the strip is cut between the
    reference's own dino and its cactus and made seamless.
    """
    d = data["dino"]
    names = [f"run_{i}" for i in range(len(d["frames"]["run"]))]
    ref = load_rgba(REFERENCE)
    Hh = ref.height
    k = 2.0                                                 # gif px per reference px
    s = 0.19 * Hh * k / d["standHeightPx"]                  # frame px -> gif px
    speed = round(gait(frames, d)["stride_per_frame"] * d["standHeightPx"] * s)
    loops = 3
    n_frames = len(names) * loops
    strip_w = speed * n_frames
    blend = 300
    bg = ref.resize((round(ref.width * k), round(ref.height * k)), Image.LANCZOS)
    ground_y = round(0.760 * Hh * k)
    gw, gh = 720, 400
    gy0 = ground_y - gh + 70
    x0 = 780                                               # right of the reference's own dino
    strip = make_seamless_h(bg.crop((x0, gy0, x0 + strip_w + blend, gy0 + gh)), blend)
    tiled = Image.new("RGBA", (strip_w * 2, gh))
    tiled.paste(strip, (0, 0))
    tiled.paste(strip, (strip_w, 0))
    fw, fh = round(d["frameW"] * s), round(d["frameH"] * s)
    x_dino = 40
    gyl = ground_y - gy0
    out = []
    for i in range(n_frames):
        n = names[i % len(names)]
        off = (i * speed) % strip_w
        f = tiled.crop((off, 0, off + gw, gh))
        im = frames[n].resize((fw, fh), Image.LANCZOS)
        xs = np.nonzero(mask(im).any(axis=0))[0]
        f.alpha_composite(shadow(f.size, x_dino + (xs.min() + xs.max()) / 2 + 10, gyl + 3,
                                 (xs.max() - xs.min()) * 0.36, 9, 0.3))
        f.alpha_composite(im, (x_dino, gyl - round(d["baselinePx"] * s)))
        out.append(f.convert("RGB"))
    pal = out[0].quantize(colors=255, method=Image.MEDIANCUT)
    out = [f.quantize(palette=pal, dither=Image.FLOYDSTEINBERG) for f in out]
    p = PREVIEW_DIR / "dino_run.gif"
    out[0].save(p, save_all=True, append_images=out[1:], duration=83, loop=0)
    # also a plain loop on the flat preview colour (frame-accurate, no background motion)
    plain = [on_background(frames[n]).convert("RGB") for n in names]
    p2 = PREVIEW_DIR / "dino_run_plain.gif"
    plain[0].save(p2, save_all=True, append_images=plain[1:], duration=83, loop=0)
    return [p, p2]


def preview_hitbox_slack(data, order):
    """Hitbox QA on the exported WebPs: box pixels that are air are tinted orange (<= 12 px from the body) or
    red (> 12 px, must not exist); collidable body not covered by any box is tinted blue (thin tail tip, arms,
    toes and a thin rim are uncovered on purpose)."""
    d = data["dino"]
    tiles = []
    for name in order:
        kind, idx = name.rsplit("_", 1)
        f = d["frames"][kind][int(idx)]
        im = load_rgba(ROOT / f["src"])
        m, body = body_mask(im)
        dist = ndimage.distance_transform_edt(~m)
        U = np.zeros_like(m)
        for x, y, w, h in f["hitboxes"]:
            U[int(y):int(np.ceil(y + h)), int(x):int(np.ceil(x + w))] = True
        ov = np.zeros((*m.shape, 4), np.uint8)
        ov[U & (dist > 0) & (dist <= 12)] = (255, 150, 0, 170)
        ov[U & (dist > 12)] = (255, 0, 0, 220)
        ov[body & ~U] = (0, 90, 255, 120)
        t = on_background(im)
        t.alpha_composite(Image.fromarray(ov, "RGBA"))
        t = draw_boxes(t, f["hitboxes"], color=(200, 0, 0, 255), width=1)
        st = hitbox_stats(im, f["hitboxes"])
        label_draw(t, f"{name}: {st['n']} boxes, air {st['air'] * 100:.1f}%, max dist {st['max_dist']} px, "
                      f"body {st['body_cover'] * 100:.0f}% / outline {st['rim_cover'] * 100:.0f}% covered")
        tiles.append(t)
    cols = 3
    fw, fh = d["frameW"], d["frameH"]
    sheet = Image.new("RGBA", (cols * fw, ((len(tiles) + cols - 1) // cols) * fh), (223, 224, 230, 255))
    for i, t in enumerate(tiles):
        sheet.alpha_composite(t, ((i % cols) * fw, (i // cols) * fh))
    p = PREVIEW_DIR / "dino_hitboxes.png"
    sheet.convert("RGB").save(p)
    return p


def main():
    frames, data, frag, log, order = build()
    log["gait"] = gait(frames, data["dino"])
    previews = [preview_sheet(frames, data, order), preview_hitbox_slack(data, order), preview_onion(frames, data),
                preview_legs(frames, data)]
    previews += preview_ingame(frames, data)
    previews += preview_gif(frames, data)
    print(json.dumps(log, indent=1))
    print("fragment:", rel(frag))
    for p in previews:
        print("preview:", rel(p))
    total = sum(p.stat().st_size for p in OUT_DIR.glob("*.webp"))
    print(f"assets/dino total {total / 1024:.0f} KiB")
    # keep the merged manifest (what the game actually loads) in sync with this fragment
    subprocess.run([sys.executable, str(ROOT / "tools" / "build_manifest.py")], check=True)
    merged = (ROOT / "assets" / "manifest.js").read_text(encoding="utf-8")
    body = json.loads(merged[merged.index("=") + 1:].strip().rstrip(";"))

    def unhash(n):      # build_manifest appends a content hash (?v=...) to every src / srcBlur
        if isinstance(n, dict):
            return {k: (v.split("?v=")[0] if k in ("src", "srcBlur") and isinstance(v, str) else unhash(v))
                    for k, v in n.items()}
        return [unhash(v) for v in n] if isinstance(n, list) else n
    assert unhash(body["dino"]) == data["dino"], "assets/manifest.js dino entry differs from assets/manifest/dino.json"
    print("assets/manifest.js: dino entry matches the fragment")


if __name__ == "__main__":
    main()
