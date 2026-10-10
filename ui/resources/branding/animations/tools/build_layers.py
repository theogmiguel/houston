"""Split the canonical Houston mascot PNG into animatable layers.

Reads houston-mascot.png from the parent branding directory (never modified)
and writes same-canvas RGBA layers to animations/layers/. Paths resolve from
this script. Every layer shares the source canvas so the preview can stack
them at identical offsets.

Run with a Python that has numpy, scipy and Pillow:
    python -I tools/build_layers.py
"""
from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage as nd

ANIMATIONS = Path(__file__).resolve().parent.parent
SRC = ANIMATIONS.parent / "houston-mascot.png"
OUT = ANIMATIONS / "layers"
OUT.mkdir(parents=True, exist_ok=True)
# Layers are exported at half size: 627 px covers a 2x-DPR display up to ~300 px.
SCALE = 0.5

src = np.array(Image.open(SRC).convert("RGBA")).astype(np.float64)
H, W = src.shape[:2]
alpha = src[..., 3]
yy, xx = np.mgrid[0:H, 0:W]

# Connected parts. The left arm touches the ring's lower edge at one point, so
# it is cut from the head component by a hand-picked box below the ring.
lab, _ = nd.label(alpha > 8)
sizes = nd.sum(np.ones_like(alpha), lab, range(1, lab.max() + 1))
ids = np.argsort(-sizes)[:3] + 1
parts = {}
for i in ids:
    sl = nd.find_objects((lab == i).astype(int))[0]
    cx = (sl[1].start + sl[1].stop) / 2
    if sizes[i - 1] > 300000:
        parts["head"] = lab == i
    elif cx > 800:
        parts["arm_r"] = lab == i
    else:
        parts["torso"] = lab == i
left_cut = (xx < 458) & (yy >= 780)
# The ring's 1-3 px lower fringe also falls inside the box; erosion drops it
# so only the arm's solid body is kept.
arm_l = parts["head"] & left_cut
core_lab, _ = nd.label(nd.binary_erosion(arm_l, iterations=3))
biggest = np.argmax(np.bincount(core_lab.ravel())[1:]) + 1
arm_l = nd.binary_dilation(core_lab == biggest, iterations=4) & arm_l
parts["arm_l"] = arm_l
parts["head"] = parts["head"] & ~arm_l
# Soft fringe pixels below the threshold follow their nearest part.
dist_owner = np.zeros((H, W), dtype=int)
stack = np.stack([parts[k] for k in ("head", "arm_l", "arm_r", "torso")])
dists = np.stack([nd.distance_transform_edt(~m) for m in stack])
dist_owner = np.argmin(dists, axis=0)
names = ("head", "arm_l", "arm_r", "torso")
masks = {n: (dist_owner == k) & (alpha > 0) for k, n in enumerate(names)}


def harmonic_fill(rgb, hole, iterations=600):
    """Fill `hole` pixels by repeated neighbour averaging (Laplace inpaint)."""
    known = ~hole
    # Seed with the nearest known colour so the relaxation converges quickly.
    idx = nd.distance_transform_edt(hole, return_distances=False, return_indices=True)
    out = rgb[idx[0], idx[1]].copy()
    kernel = np.array([[0, 1, 0], [1, 0, 1], [0, 1, 0]], dtype=np.float64) / 4
    for _ in range(iterations):
        for c in range(3):
            sm = nd.convolve(out[..., c], kernel, mode="nearest")
            out[..., c] = np.where(known, rgb[..., c], sm)
    return out


def eyeness(region_box):
    x0, y0, x1, y1 = region_box
    box = (xx >= x0) & (xx < x1) & (yy >= y0) & (yy < y1)
    g = src[..., 1]
    # Face navy has G ~20-35; crescent cores reach G > 200.
    return np.clip((g - 30) / 150, 0, 1) * box


eye_boxes = [(415, 450, 590, 550), (695, 450, 870, 550)]
eye_a = np.maximum(eyeness(eye_boxes[0]), eyeness(eye_boxes[1]))

core_c, core_r = (630, 955), 78
core_box = (xx - core_c[0]) ** 2 + (yy - core_c[1]) ** 2 <= core_r**2
core_a = np.clip((src[..., 1] - 45) / 140, 0, 1) * core_box


def save(name, rgb, a):
    arr = np.dstack([np.clip(rgb, 0, 255), np.clip(a, 0, 255)]).astype(np.uint8)
    img = Image.fromarray(arr, "RGBA")
    img = img.resize((round(W * SCALE), round(H * SCALE)), Image.LANCZOS)
    img.save(OUT / f"{name}.png", optimize=True)


rgb = src[..., :3]
# Head base: crescents inpainted with the surrounding face navy.
# The hole uses a lower threshold than the layer so the halo is removed too.
eye_halo = np.maximum(*(np.clip((src[..., 1] - 26) / 60, 0, 1) * ((xx >= x0) & (xx < x1) & (yy >= y0) & (yy < y1)) for x0, y0, x1, y1 in eye_boxes))
eye_hole = nd.binary_dilation(eye_halo > 0.05, iterations=6)
head_rgb = rgb.copy()
crop = (slice(430, 570), slice(400, 890))
head_rgb[crop] = harmonic_fill(rgb[crop], eye_hole[crop])
save("head", head_rgb, alpha * masks["head"])
save("eyes", rgb, 255 * eye_a)
save("arm_l", rgb, alpha * masks["arm_l"])
save("arm_r", rgb, alpha * masks["arm_r"])
# Torso base: the lit core replaced by its dark socket colour.
core_hole = nd.binary_dilation(np.clip((src[..., 1] - 45) / 60, 0, 1) * core_box > 0.05, iterations=3) & core_box
torso_rgb = rgb.copy()
crop = (slice(860, 1050), slice(530, 730))
torso_rgb[crop] = harmonic_fill(rgb[crop], core_hole[crop])
save("torso", torso_rgb, alpha * masks["torso"])
save("core", rgb, 255 * core_a)

# Ring mask for the light sweep: saturated, bright ring pixels on the head layer.
r, g, b = rgb[..., 0], rgb[..., 1], rgb[..., 2]
mx, mn = rgb.max(axis=2), rgb.min(axis=2)
sat = (mx - mn) / np.maximum(mx, 1)
ring = np.clip((mx - 110) / 90, 0, 1) * np.clip((sat - 0.35) / 0.3, 0, 1)
ring *= masks["head"] * (alpha / 255) * (eye_a < 0.04)
save("ring_mask", np.full_like(rgb, 255), 255 * ring)
print("layers written to", OUT)

# CSS masks are CORS-fetched, which file:// pages cannot satisfy, so the ring
# mask is also emitted inline as a data URI.
import base64

data = base64.b64encode((OUT / "ring_mask.png").read_bytes()).decode()
(OUT / "masks.css").write_text(
    ".ring-sweep{-webkit-mask-image:url(data:image/png;base64,%s);"
    "mask-image:url(data:image/png;base64,%s);}\n" % (data, data)
)
