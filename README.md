# Anti-Perspective

## Website
https://thsnu.github.io/Anti-Perspective/


Anti-Perspective removes perspective distortion from photos of flat surfaces — a poster on a wall, a book cover, a sign, a packaging mockup, a painting shot at an angle — and gives you back a clean, head-on version of it. Mark the four corners, and the straightened image appears next to it. From there you can squash, stretch or bend it to fit your layout, then export a transparent PNG.

Useful whenever you need artwork out of a photo rather than a photo of artwork: rescuing reference shots, lifting textures and label designs, or fitting a flattened surface into a new mockup. It runs entirely in your browser — nothing is uploaded.

Turn a photographed rectangle back into a flat, head-on image — then squash, stretch or bend the
result and export it as a transparent PNG.

Anti-Perspective is a single-page browser tool with no build step, no dependencies and no server
component. Images never leave your machine; everything runs in the canvas of your own browser.

<img width="2668" height="1792" alt="Screenshot1" src="https://github.com/user-attachments/assets/263dedee-c6dd-4281-802e-2236c7b7fc3a" />
<img width="2672" height="1794" alt="Screenshot2" src="https://github.com/user-attachments/assets/f1ed205a-6f7d-46eb-9a76-e12706c150b2" />
<img width="2668" height="1790" alt="Screenshot3" src="https://github.com/user-attachments/assets/5e743f2f-9f63-439d-a05f-d27e37477df1" />

---

## Two ways to define the correction

The `Corners` / `Guided` switch in the toolbar picks how the perspective is derived. Both work
completely independently and keep their own input, so you can switch back and forth without losing
anything — the right-hand pane, the warp modes and the export behave identically either way.

- **Corners** (default) — mark the four corners of a rectangle. Best when you want to *lift a flat
  surface out of* a photo: a poster, a book cover, a label.
- **Guided** — draw lines along edges that ought to be vertical or horizontal. Best when you want
  to *straighten the whole photo*: converging building edges, a tilted horizon, keystoning.

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

**Colour profiles.** If the source carries an embedded RGB colour profile — Display P3 from an
iPhone or Mac, Adobe RGB, ProPhoto from Lightroom — the export keeps it: the PNG contains the
original, unconverted pixel values together with that very profile, so nothing outside sRGB is
clipped. The status bar shows the profile's name. Supported for JPEG, PNG and WebP; images without
a profile, grey or CMYK profiles and other formats (HEIC, AVIF, TIFF) are exported as sRGB, as
before. The panes themselves always show the colour-managed image. Output stays 8 bit per channel.

---

## Guided mode

Drag along an edge that should be straight — a building corner, a door frame, a window sill, the
horizon. The drag direction decides what the line stands for: steeper than 45° makes it a
**vertical** guide (green), flatter makes it **horizontal** (blue). Click the `V`/`H` badge at the
middle of a line to flip it, drag the badge to move the whole line, drag either end to adjust it.
`Backspace` removes the last line, `Reset lines` clears them all. Two to four lines, in any mix.

A dashed extension runs through each line across the whole canvas, which makes it easy to check
that a short segment really is aligned with a long edge.

The result is the *entire* image rectified, not a cut-out rectangle: everything the correction
would blow up beyond nine times the magnification of the image centre is cropped away, so a horizon
inside the frame does not produce an infinitely large canvas. The resolution at the image centre is
preserved, capped at 4096 px per edge.

**What the status bar reports.** How much can be recovered depends on what the lines give away:

| Reported | Situation | Result |
|---|---|---|
| `metric` | Two vertical *and* two horizontal lines, converging like a real rectangular corner | Full correction. The two vanishing points must be orthogonal, which fixes the focal length (reported in px and 35 mm equivalent) and with it angles **and** the aspect ratio. |
| `one direction` | Only one bundle of two like-oriented lines | The edges become parallel and upright, but the other axis is assumed to be undistorted already, so the aspect ratio stays off. Classic keystone correction — add two lines of the other orientation for the full fix. |
| `affine` | Single lines, or edges that are already parallel | No perspective information at all: the picture is only rotated and sheared until the drawn lines run vertically and horizontally. |
| ⚠ `not compatible with a right angle` | Both bundles converge, but not the way a rectangular corner would | Edges are straightened, the aspect ratio stays arbitrary. Usually means a line is misplaced, or the two directions are not actually perpendicular in the world. |

Lines of the same orientation that are (nearly) identical, or that meet inside the picture, carry
no usable information — the status bar says so instead of producing nonsense. More than two lines
of one orientation are combined by least squares, so an imprecise line is averaged out rather than
taken literally. The `Aspect ratio` selector belongs to corner mode and is disabled here: guided
mode derives the geometry itself.

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
| Switch Corners / Guided | `G`, or the toolbar segment |
| Set a corner point | Click the source image (first four clicks) |
| Draw a guide line | Drag along an edge (guided mode, up to four) |
| Flip a line V / H | Click its badge |
| Delete the last line | `Backspace` |
| Move a handle | Drag it |
| Pan the canvas | Scroll-wheel click + drag, or drag an empty area |
| Zoom the stage | Scroll wheel (zooms toward the cursor) |
| Toggle Scale / Mesh warp | `M`, or the toolbar segment |
| Uniform scaling | Hold `Shift` while dragging |
| Hide the result handles | `Esc` |

`Show mesh` overlays the warp grid, which helps when judging a heavy deformation.

---

## Running it locally

No build, no install.
Download and **Opening `index.html` by double-click mostly works too**, but some browsers restrict `getImageData`
on `file://` URLs, which the rectification depends on — serving the folder avoids that entirely.

**Or starting your prefered server:**

```bash
git clone https://github.com/<your-account>/anti-perspective.git
cd anti-perspective
python3 -m http.server 8731
```

Then open <http://localhost:8731>.



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
- **Guided rectification.** Each bundle of like-oriented lines is intersected in its vanishing
  point (least squares via the smallest eigenvector of ∑ llᵀ for more than two lines). If both
  vanishing points are finite, their orthogonality yields the focal length, and the camera rotation
  built from them gives a metric rectification `Rᵀ·K⁻¹`. Otherwise the vanishing line is mapped to
  infinity, which makes the edges parallel, and an affine step turns the measured directions into
  the vertical and the horizontal. The result is normalised to be upright and unmirrored, clipped
  against the horizon and then sampled by the same inverse-mapping loop as corner mode.
- **Export** re-renders the same mesh at a finer subdivision into an offscreen canvas sized to the
  shape's bounding box.
- **Colour profiles.** Browsers colour-manage every decoded image into sRGB. To bypass that, the
  export cuts the ICC profile out of a copy of the source file (JPEG APP2 segments, PNG `iCCP`,
  WebP `ICCP`). The browser takes the untagged copy for sRGB and hands its pixels over unchanged;
  they run through the same rectification and mesh, and the original profile is written back into
  the PNG as an `iCCP` chunk.

---

Created by {ths} Thomas Schostok, [www.ths.works](https://www.ths.works), [www.ths.nu](https://www.ths.nu)
