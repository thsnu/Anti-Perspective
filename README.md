# {ths} Anti-Perspective v1.00

Anti-Perspective takes a photo of anything flat — a poster on a wall, a book cover, a sign, a packaging mockup, a painting shot at an angle — and gives you back a clean, head-on version of it. Mark the four corners, and the straightened image appears next to it. From there you can squash, stretch or bend it to fit your layout, then export a transparent PNG.

Useful whenever you need artwork out of a photo rather than a photo of artwork: rescuing reference shots, lifting textures and label designs, or fitting a flattened surface into a new mockup. It runs entirely in your browser — nothing is uploaded.

Turn a photographed rectangle back into a flat, head-on image — then squash, stretch or bend the
result and export it as a transparent PNG.

Anti-Perspective is a single-page browser tool with no build step, no dependencies and no server
component. Images never leave your machine; everything runs in the canvas of your own browser.

---

## What it does

**Left pane — the source.** Load an image, then click four times to mark the corners of the
rectangle you want to flatten. The polygon is drawn in green with four numbered, freely draggable
handles. Point order is normalised automatically, so it does not matter which corner you click
first.

**Right pane — the result.** As soon as the fourth point is set, the rectified image appears. It
stays in sync while you drag any source handle. Clicking the result reveals eight handles, and what
they do depends on the active mode:

| Mode | Behaviour |
|---|---|
| **Scale** (default) | Edge handles squash or stretch one axis, corner handles both. The opposite edge or corner stays fixed. Hold **Shift** for uniform scaling. Dragging past the opposite side mirrors the image. |
| **Mesh warp** | Corner handles move corners and take the adjacent edge midpoints with them, so straight edges stay straight. Edge-midpoint handles bend that edge into a quadratic Bézier. |

Switching between the modes is non-destructive: a bent shape keeps its curvature when you squash
it, and a squashed shape can still be bent afterwards. In scale mode the handles sit on the actual
visual outline of the shape, curves included.

**Export.** PNG with a transparent background, cropped exactly to the bounding box of the warped
shape, at 50 %, 100 % or 200 % scale.

---

## Aspect ratio

Averaging opposite edge lengths is only a heuristic, and a biased one: the edge further from the
camera is shorter in the image, so the mean underestimates depth and skewed shots come out too wide
or too flat. The `Aspect ratio` selector offers three ways to deal with that:

- **Edge averages** (default) — the simple heuristic described above.
- **Automatic** — recovers the *true* aspect ratio using the closed-form method of
  **Zhang & He (2003)**. Assuming the object really is a rectangle, that the pixels are square and
  that the principal point sits at the image centre, the orthogonality of the rectangle's two
  vanishing points determines the focal length; from there the two edge directions can be measured
  metrically and their ratio is the answer. If the JPEG carries a `FocalLengthIn35mmFilm` EXIF tag,
  that focal length is used directly, which removes the numerically unstable part of the estimate.
- **Fixed presets** — √2 (A4 landscape/portrait), 16:9, 9:16, 4:3, 3:2, 1:1. Often the best choice:
  if you know you photographed an A4 sheet, that beats any estimate.

The status bar reports the ratio, the method used and the focal length in pixels and 35 mm
equivalent, so you can judge whether the estimate is trustworthy.

**Fallbacks and limits.** With near-parallel edges both vanishing points lie at infinity, no
perspective information exists and the tool falls back to a purely affine estimate (labelled
`affine`). If the four points cannot be reconciled with any rectangle, it falls back to edge
averages. A focal length outside roughly 12–200 mm is flagged as implausible — that almost always
means the corners were placed imprecisely or the object simply is not a rectangle. No algorithm can
recover the ratio of a shape that was never rectangular. The absolute size is likewise
unrecoverable without a reference measurement; only the ratio is. The EXIF `Orientation` tag is not
evaluated, and for cropped images the principal point is no longer at the centre — in both cases a
fixed preset is the safer choice.

---

## Controls

| Action | Input |
|---|---|
| Load an image | Toolbar button, or drop the file on the left pane |
| Set a corner point | Click the source image (first four clicks) |
| Move a handle | Drag it |
| Pan the canvas | Scroll-wheel click + drag, or drag an empty area |
| Zoom the stage | Scroll wheel (zooms toward the cursor) |
| Toggle Scale / Mesh warp | `M`, or the toolbar segment |
| Uniform scaling | Hold `Shift` while dragging |
| Hide the result handles | `Esc` |

`Show mesh` overlays the warp grid, which helps when judging a heavy deformation.

---

## Running it

No build, no install:

```bash
git clone https://github.com/<your-account>/anti-perspective.git
cd anti-perspective
python3 -m http.server 8731
```

Then open <http://localhost:8731>.

Opening `index.html` by double-click mostly works too, but some browsers restrict `getImageData`
on `file://` URLs, which the rectification depends on — serving the folder avoids that entirely.

---

## How it works

`app.js` is plain ES5, split into clearly separated sections:

- **Rectification.** A homography is solved from the four source points to the target rectangle
  (8×8 linear system, Gaussian elimination with partial pivoting), then inverse-mapped per pixel
  with bilinear sampling. While dragging, this runs at preview resolution and at most once per
  animation frame; on release it recomputes at full resolution, capped at 4096 px per edge.
- **Warping.** The eight control points define a Coons patch whose boundary curves are quadratic
  Béziers. It is rendered as a textured triangle mesh — each triangle is clipped and drawn under
  its own affine transform, with the clip region slightly widened so no seams show. The transparent
  background comes for free.
- **Export** re-renders the same mesh at a finer subdivision into an offscreen canvas sized to the
  shape's bounding box.

---

Created by {ths} Thomas Schostok, [www.ths.works](https://www.ths.works), [www.ths.nu](https://www.ths.nu)
