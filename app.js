/* Anti-Perspective — perspective rectification + free-form mesh warp */
(function () {
'use strict';

// ------------------------------------------------------------------ State

var S = {
  img: null,            // HTMLImageElement
  srcData: null,        // ImageData of the source
  srcW: 0, srcH: 0,

  method: 'quad',       // 'quad' = 4 corner points, 'guided' = guide lines
  pts: [],              // up to 4 source points {x,y} in image coordinates
  ordered: false,       // order TL,TR,BR,BL already normalised

  lines: [],            // guided mode: [{a:{x,y}, b:{x,y}, dir:'v'|'h'}] in image coordinates
  hDst: null,           // guided mode: homography rectified -> source (9 values)
  gInfo: null,          // guided mode: {method, f} of the most recent solution

  rectW: 0, rectH: 0,   // size of the rectified image
  rect: null,           // canvas holding the rectified image (full resolution)
  rectScale: 1,         // resolution of the current rect canvas (preview < 1)
  rectDirty: false,     // preview active -> recompute once the drag ends

  warp: null,           // {c: [4 corners], m: [4 edge midpoints]} in rect coordinates
  warpHandles: false,
  mode: 'scale',        // 'scale' = squash at the edges, 'warp' = free-form mesh warp
  aspectMode: 'edges',  // 'edges' | 'auto' | number as string (fixed ratio)
  name: '',             // source file name without extension, used for the export
  f35: null,            // focal length (35 mm equivalent) from EXIF
  est: null,            // result of the most recent estimate

  showGrid: false
};

var MAXPX = 4096;       // upper bound for the rectified image's edge length
var PREVIEW = 900;      // preview resolution while dragging

var GMAX = 4;           // guided mode: maximum number of guide lines
var GMAG = 9;           // guided mode: how much the correction may magnify vs. the centre
var GCOL = { v: '#29d17c', h: '#4da3ff' };
var GCOLF = { v: 'rgba(41,209,124,.35)', h: 'rgba(77,163,255,.35)' };

// ------------------------------------------------------------ DOM & Views

var cvL = document.getElementById('cvL'), ctxL = cvL.getContext('2d');
var cvR = document.getElementById('cvR'), ctxR = cvR.getContext('2d');
var hintL = document.getElementById('hintL'), hintR = document.getElementById('hintR');
var info = document.getElementById('info');
var expBtn = document.getElementById('export');

var viewL = { s: 1, ox: 0, oy: 0 };
var viewR = { s: 1, ox: 0, oy: 0 };

var P = {
  L: { cv: cvL, ctx: ctxL, view: viewL, zoom: document.getElementById('zL') },
  R: { cv: cvR, ctx: ctxR, view: viewR, zoom: document.getElementById('zR') }
};

// -------------------------------------------------------------- Math: 2D

function len(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

/* Solves A·x = b (n×n) by Gaussian elimination with partial pivoting. */
function solve(A, b) {
  var n = b.length, i, j, k, p, t;
  for (i = 0; i < n; i++) {
    p = i;
    for (j = i + 1; j < n; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
    t = A[i]; A[i] = A[p]; A[p] = t;
    t = b[i]; b[i] = b[p]; b[p] = t;
    if (Math.abs(A[i][i]) < 1e-12) return null;
    for (j = i + 1; j < n; j++) {
      var f = A[j][i] / A[i][i];
      if (!f) continue;
      for (k = i; k < n; k++) A[j][k] -= f * A[i][k];
      b[j] -= f * b[i];
    }
  }
  var x = new Array(n);
  for (i = n - 1; i >= 0; i--) {
    var s = b[i];
    for (j = i + 1; j < n; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

/* Homography mapping src[0..3] onto dst[0..3]. */
function homography(src, dst) {
  var A = [], b = [];
  for (var i = 0; i < 4; i++) {
    var u = src[i].x, v = src[i].y, x = dst[i].x, y = dst[i].y;
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  var h = solve(A, b);
  return h ? h.concat([1]) : null;
}

function applyH(h, x, y) {
  var w = h[6] * x + h[7] * y + h[8];
  return { x: (h[0] * x + h[1] * y + h[2]) / w, y: (h[3] * x + h[4] * y + h[5]) / w };
}

// -------------------------------------------------- Order points (TL..BL)

function orderQuad(p) {
  var cx = 0, cy = 0, i;
  for (i = 0; i < 4; i++) { cx += p[i].x / 4; cy += p[i].y / 4; }
  var a = p.slice().sort(function (u, v) {
    return Math.atan2(u.y - cy, u.x - cx) - Math.atan2(v.y - cy, v.x - cx);
  });
  // clockwise (canvas Y points down); start at the top-left-most point
  var best = 0, bd = Infinity;
  for (i = 0; i < 4; i++) {
    var d = (a[i].x - cx) + (a[i].y - cy);
    if (d < bd) { bd = d; best = i; }
  }
  return [a[best], a[(best + 1) % 4], a[(best + 2) % 4], a[(best + 3) % 4]];
}

// ------------------------------------------------- EXIF: read focal length

/* Reads FocalLengthIn35mmFilm (0xA405) from a JPEG. null when absent. */
function exifFocal35(buf) {
  try {
    var dv = new DataView(buf);
    if (dv.getUint16(0) !== 0xFFD8) return null;          // not a JPEG
    var off = 2, n = dv.byteLength;
    while (off + 4 <= n) {
      var marker = dv.getUint16(off);
      if ((marker & 0xFF00) !== 0xFF00) return null;
      if (marker === 0xFFDA || marker === 0xFFD9) return null;
      var size = dv.getUint16(off + 2);
      if (marker === 0xFFE1 && dv.getUint32(off + 4) === 0x45786966) {
        return readTiff(dv, off + 10);
      }
      off += 2 + size;
    }
  } catch (e) { /* malformed EXIF -> ignore */ }
  return null;
}

function readTiff(dv, base) {
  var le = dv.getUint16(base) === 0x4949;
  if (dv.getUint16(base + 2, le) !== 42) return null;

  function entryValue(e) {
    var type = dv.getUint16(e + 2, le);
    if (type === 3) return dv.getUint16(e + 8, le);       // SHORT
    if (type === 4) return dv.getUint32(e + 8, le);       // LONG
    if (type === 5) {                                     // RATIONAL
      var p = base + dv.getUint32(e + 8, le);
      return dv.getUint32(p, le) / dv.getUint32(p + 4, le);
    }
    return null;
  }
  function findTag(ifd, tag) {
    var cnt = dv.getUint16(ifd, le);
    for (var i = 0; i < cnt; i++) {
      var e = ifd + 2 + i * 12;
      if (dv.getUint16(e, le) === tag) return entryValue(e);
    }
    return null;
  }

  var ifd0 = base + dv.getUint32(base + 4, le);
  var exifPtr = findTag(ifd0, 0x8769);
  if (exifPtr == null) return null;
  var f35 = findTag(base + exifPtr, 0xA405);              // FocalLengthIn35mmFilm
  return (f35 && isFinite(f35) && f35 > 0) ? f35 : null;
}

// ----------------------------------- Estimate aspect ratio (Zhang & He 2003)

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

/* Estimates width/height of the real rectangle from its perspective image.
   Assumptions: the object is a rectangle, square pixels, principal point at the
   image centre. fPx (focal length in pixels, e.g. from EXIF) is optional; without
   it the focal length is estimated as well.
   Returns {ratio, f, method} or null. */
function estimateAspect(pts, imgW, imgH, fPx) {
  // Zhang & He number row-wise: m1 top-left, m2 top-right,
  // m3 BOTTOM-LEFT, m4 bottom-right. Our points run cyclically.
  var cx = imgW / 2, cy = imgH / 2;
  function h(p) { return [p.x - cx, p.y - cy, 1]; }
  var m1 = h(pts[0]), m2 = h(pts[1]), m3 = h(pts[3]), m4 = h(pts[2]);

  var d2 = dot(cross(m2, m4), m3), d3 = dot(cross(m3, m4), m2);
  if (!d2 || !d3) return null;
  var k2 = dot(cross(m1, m4), m3) / d2;
  var k3 = dot(cross(m1, m4), m2) / d3;

  var n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 - 1];
  var n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 - 1];

  var method, f2;
  if (fPx) {
    f2 = fPx * fPx;
    method = 'EXIF';
  } else if (Math.abs(n2[2]) < 1e-3 || Math.abs(n3[2]) < 1e-3) {
    // Both vanishing points (nearly) at infinity -> parallelogram, no
    // perspective information at all. Purely affine fallback.
    var ra = Math.hypot(n2[0], n2[1]) / Math.hypot(n3[0], n3[1]);
    return ra > 0.05 && ra < 20 ? { ratio: ra, f: null, method: 'affine' } : null;
  } else {
    f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / (n2[2] * n3[2]);
    method = 'estimated';
    if (!isFinite(f2) || f2 <= 0) return null;            // incompatible with a rectangle
  }

  var num = (n2[0] * n2[0] + n2[1] * n2[1]) / f2 + n2[2] * n2[2];
  var den = (n3[0] * n3[0] + n3[1] * n3[1]) / f2 + n3[2] * n3[2];
  if (!(den > 0)) return null;
  var ratio = Math.sqrt(num / den);
  if (!isFinite(ratio) || ratio < 0.05 || ratio > 20) return null;
  return { ratio: ratio, f: Math.sqrt(f2), method: method };
}

// ------------------------------------------------- Guided mode: line based

function unit3(a) {
  var m = Math.hypot(a[0], a[1], a[2]);
  return m > 1e-12 ? [a[0] / m, a[1] / m, a[2] / m] : null;
}
function mul3(A, B) {
  var C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++)
    C[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
  return C;
}
function inv3(m) {
  var a = m[0][0], b = m[0][1], c = m[0][2];
  var d = m[1][0], e = m[1][1], f = m[1][2];
  var g = m[2][0], h = m[2][1], i = m[2][2];
  var A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
  var det = a * A + b * B + c * C;
  if (!det || !isFinite(det)) return null;
  return [[A / det, (c * h - b * i) / det, (b * f - c * e) / det],
          [B / det, (a * i - c * g) / det, (c * d - a * f) / det],
          [C / det, (b * g - a * h) / det, (a * e - b * d) / det]];
}
function applyM(M, x, y) {
  var w = M[2][0] * x + M[2][1] * y + M[2][2];
  if (!w || !isFinite(w)) return null;
  return { x: (M[0][0] * x + M[0][1] * y + M[0][2]) / w,
           y: (M[1][0] * x + M[1][1] * y + M[1][2]) / w };
}
/* Local linearisation of M at (x,y) — tells us scale, rotation and mirroring. */
function jacAt(M, x, y, eps) {
  var p = applyM(M, x, y), px = applyM(M, x + eps, y), py = applyM(M, x, y + eps);
  if (!p || !px || !py) return null;
  var a00 = (px.x - p.x) / eps, a10 = (px.y - p.y) / eps;
  var a01 = (py.x - p.x) / eps, a11 = (py.y - p.y) / eps;
  return { a00: a00, a01: a01, a10: a10, a11: a11, det: a00 * a11 - a01 * a10 };
}

/* Smallest eigenvector of a symmetric 3x3 matrix (closed form). */
function eigMinVec(M) {
  var i, j;
  var p1 = M[0][1] * M[0][1] + M[0][2] * M[0][2] + M[1][2] * M[1][2];
  var q = (M[0][0] + M[1][1] + M[2][2]) / 3, lam;
  if (p1 < 1e-24) {
    lam = Math.min(M[0][0], M[1][1], M[2][2]);
  } else {
    var p2 = (M[0][0] - q) * (M[0][0] - q) + (M[1][1] - q) * (M[1][1] - q) +
             (M[2][2] - q) * (M[2][2] - q) + 2 * p1;
    var pp = Math.sqrt(p2 / 6);
    var B = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) B[i][j] = (M[i][j] - (i === j ? q : 0)) / pp;
    var r = (B[0][0] * (B[1][1] * B[2][2] - B[1][2] * B[2][1]) -
             B[0][1] * (B[1][0] * B[2][2] - B[1][2] * B[2][0]) +
             B[0][2] * (B[1][0] * B[2][1] - B[1][1] * B[2][0])) / 2;
    r = Math.max(-1, Math.min(1, r));
    lam = q + 2 * pp * Math.cos(Math.acos(r) / 3 + 2 * Math.PI / 3);   // smallest
  }
  var A = [[M[0][0] - lam, M[0][1], M[0][2]],
           [M[1][0], M[1][1] - lam, M[1][2]],
           [M[2][0], M[2][1], M[2][2] - lam]];
  var best = null, bn = 0;
  var cand = [cross(A[0], A[1]), cross(A[0], A[2]), cross(A[1], A[2])];
  for (i = 0; i < 3; i++) {
    var n = Math.hypot(cand[i][0], cand[i][1], cand[i][2]);
    if (n > bn) { bn = n; best = cand[i]; }
  }
  return bn > 1e-18 ? unit3(best) : null;
}

/* Vanishing point of a bundle of lines: the point closest to all of them
   (exact for two lines, least squares for more). */
function vpFromLines(ls) {
  if (ls.length < 2) return null;
  if (ls.length === 2) return unit3(cross(ls[0], ls[1]));
  var M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], i, j;
  ls.forEach(function (l) {
    for (i = 0; i < 3; i++) for (j = 0; j < 3; j++) M[i][j] += l[i] * l[j];
  });
  return eigMinVec(M);
}

/* Clips a polygon against the half plane w(p) >= wmin, with w the third
   (homogeneous) row of M — everything beyond it is behind the horizon. */
function clipHalf(poly, M, wmin) {
  var out = [], n = poly.length;
  function f(p) { return M[2][0] * p.x + M[2][1] * p.y + M[2][2] - wmin; }
  for (var i = 0; i < n; i++) {
    var a = poly[i], b = poly[(i + 1) % n], fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      var t = fa / (fa - fb);
      out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
    }
  }
  return out;
}

/* Builds the rectification from the guide lines.

   Lines that ought to be vertical meet in the vertical vanishing point, the
   horizontal ones in the horizontal vanishing point. If both are known and
   compatible with a right angle, the orthogonality of the two directions
   yields the focal length (Zhang & He, same idea as the aspect estimate) and
   with it a full metric rectification — angles and the aspect ratio come out
   right. Otherwise the vanishing line is mapped to infinity (that alone makes
   the edges parallel) and an affine step turns the measured directions into
   the vertical and the horizontal; the aspect ratio is then not recoverable.

   Returns {W, H, h, info} — h maps rectified -> source. */
function guidedRect() {
  var i;
  if (!S.img || S.lines.length < 2) return null;
  var sc = Math.max(S.srcW, S.srcH) / 2, cx = S.srcW / 2, cy = S.srcH / 2;
  var N = [[1 / sc, 0, -cx / sc], [0, 1 / sc, -cy / sc], [0, 0, 1]];   // px -> normalised

  var lv = [], lh = [], pv = [], ph = [];
  S.lines.forEach(function (L) {
    var a = [(L.a.x - cx) / sc, (L.a.y - cy) / sc, 1];
    var b = [(L.b.x - cx) / sc, (L.b.y - cy) / sc, 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6) return;
    var l = unit3(cross(a, b));
    if (!l) return;
    if (L.dir === 'v') { lv.push(l); pv.push([a, b]); } else { lh.push(l); ph.push([a, b]); }
  });
  if (lv.length + lh.length < 2) return null;

  var Vv = vpFromLines(lv), Vh = vpFromLines(lh);
  // a vanishing point at infinity means that bundle is already parallel in the
  // picture — there is simply no perspective to undo in that direction
  var finV = !!Vv && Math.abs(Vv[2]) > 1e-9, finH = !!Vh && Math.abs(Vh[2]) > 1e-9;
  var Hn = null, info = null;

  // 1) both vanishing points finite -> focal length -> metric rectification
  if (finV && finH) {
    var vx = Vv[0] / Vv[2], vy = Vv[1] / Vv[2];
    var hx = Vh[0] / Vh[2], hy = Vh[1] / Vh[2];
    var f2 = -(vx * hx + vy * hy);          // orthogonality, principal point at the centre
    if (f2 > 1e-6) {
      var f = Math.sqrt(f2);
      var r1 = unit3([hx / f, hy / f, 1]);
      var r2 = unit3([vx / f, vy / f, 1]);
      var r3 = r1 && r2 ? unit3(cross(r1, r2)) : null;
      if (r3) {
        Hn = [[r1[0] / f, r1[1] / f, r1[2]],
              [r2[0] / f, r2[1] / f, r2[2]],
              [r3[0] / f, r3[1] / f, r3[2]]];       // R^T · K^-1
        info = { method: 'metric', f: f * sc };
      }
    }
  }

  // 2) fallback: vanishing line to infinity, then align the directions
  if (!Hn) {
    var l;
    if (Vv && Vh) l = cross(Vv, Vh);
    else if (Vv) l = cross(Vv, [1, 0, 0]);          // assume horizontals already level
    else if (Vh) l = cross(Vh, [0, 1, 0]);          // assume verticals already upright
    else l = [0, 0, 1];
    var ln = Math.hypot(l[0], l[1]);
    if (ln > 1e-12 && Math.abs(l[2]) / ln < 0.05) return null;   // horizon through the centre
    var Hp = Math.abs(l[2]) < 1e-12
      ? [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
      : [[1, 0, 0], [0, 1, 0], [l[0] / l[2], l[1] / l[2], 1]];

    var dir = function (pairs, want) {
      var sx = 0, sy = 0;
      pairs.forEach(function (pr) {
        var p = applyM(Hp, pr[0][0], pr[0][1]), q = applyM(Hp, pr[1][0], pr[1][1]);
        if (!p || !q) return;
        var dx = q.x - p.x, dy = q.y - p.y, m = Math.hypot(dx, dy);
        if (m < 1e-12) return;
        dx /= m; dy /= m;
        if (want === 'v' ? dy < 0 : dx < 0) { dx = -dx; dy = -dy; }
        sx += dx; sy += dy;
      });
      var m2 = Math.hypot(sx, sy);
      return m2 > 1e-9 ? [sx / m2, sy / m2] : null;
    };
    var dv = dir(pv, 'v'), dh = dir(ph, 'h');
    if (!dv && !dh) return null;
    if (!dh) dh = [dv[1], -dv[0]];
    if (!dv) dv = [-dh[1], dh[0]];
    var det = dh[0] * dv[1] - dv[0] * dh[1];
    if (Math.abs(det) < 1e-4) return null;          // the two bundles are parallel
    var g = Math.sqrt(Math.abs(det));               // keep the affine step area neutral
    var A = [[dv[1] / det * g, -dv[0] / det * g, 0],
             [-dh[1] / det * g, dh[0] / det * g, 0],
             [0, 0, 1]];
    Hn = mul3(A, Hp);
    info = { method: (finV && finH) ? 'skew' : (finV || finH) ? 'keystone' : 'affine', f: null };
  }

  var M = mul3(Hn, N);                              // source px -> rectified (up to a similarity)

  // normalise so the image centre has w = +1
  var wc = M[2][0] * cx + M[2][1] * cy + M[2][2];
  if (!isFinite(wc) || Math.abs(wc) < 1e-12) return null;
  for (i = 0; i < 3; i++) for (var j = 0; j < 3; j++) M[i][j] /= wc;

  // upright and unmirrored: the sign of the vanishing points is ambiguous
  var eps = Math.max(S.srcW, S.srcH) / 1000;
  var J = jacAt(M, cx, cy, eps);
  if (!J || !J.det || !isFinite(J.det)) return null;
  if (J.det < 0) { M = mul3([[-1, 0, 0], [0, 1, 0], [0, 0, 1]], M); J = jacAt(M, cx, cy, eps); }
  if (!J) return null;
  if (Math.abs(Math.atan2(J.a10, J.a00)) > Math.PI / 2) {
    M = mul3([[-1, 0, 0], [0, -1, 0], [0, 0, 1]], M);
    J = jacAt(M, cx, cy, eps);
    if (!J) return null;
  }

  // the visible part: everything the correction does not blow up beyond GMAG
  var poly = clipHalf([{ x: 0, y: 0 }, { x: S.srcW, y: 0 },
                       { x: S.srcW, y: S.srcH }, { x: 0, y: S.srcH }],
                      M, 1 / Math.sqrt(GMAG));
  if (poly.length < 3) return null;
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (i = 0; i < poly.length; i++) {
    var q2 = applyM(M, poly[i].x, poly[i].y);
    if (!q2) return null;
    x0 = Math.min(x0, q2.x); y0 = Math.min(y0, q2.y);
    x1 = Math.max(x1, q2.x); y1 = Math.max(y1, q2.y);
  }
  var bw = x1 - x0, bh = y1 - y0;
  if (!(bw > 0) || !(bh > 0) || !isFinite(bw) || !isFinite(bh)) return null;

  // keep the resolution at the image centre, then cap the overall size
  var k = 1 / Math.sqrt(Math.abs(J.det));
  k *= Math.min(1, MAXPX / Math.max(bw * k, bh * k, 1));
  var W = Math.max(1, Math.round(bw * k)), H = Math.max(1, Math.round(bh * k));

  var F = mul3([[k, 0, -x0 * k], [0, k, -y0 * k], [0, 0, 1]], M);
  var iv = inv3(F);
  if (!iv) return null;
  return {
    W: W, H: H, info: info,
    h: [iv[0][0], iv[0][1], iv[0][2], iv[1][0], iv[1][1], iv[1][2],
        iv[2][0], iv[2][1], iv[2][2]]
  };
}

// ------------------------------------------------------------------ Rectify

/* Determines the size of the rectified image (and, in guided mode, the
   mapping itself). false = the current input does not yield a rectification. */
function calcRectSize() {
  if (S.method === 'guided') {
    var g = guidedRect();
    S.est = null;
    S.gInfo = g ? g.info : null;
    S.hDst = g ? g.h : null;
    if (!g) return false;
    S.rectW = g.W; S.rectH = g.H;
    return true;
  }
  S.hDst = null; S.gInfo = null;
  if (S.pts.length !== 4) return false;
  var p = S.pts;
  var w = (len(p[0], p[1]) + len(p[3], p[2])) / 2;
  var h = (len(p[0], p[3]) + len(p[1], p[2])) / 2;

  S.est = null;
  var mode = S.aspectMode, ratio = null;

  if (mode === 'auto') {
    // Prefer the EXIF focal length: that drops the unstable estimation step.
    var fPx = null;
    if (S.f35) fPx = S.f35 / 36 * Math.max(S.srcW, S.srcH);
    S.est = estimateAspect(p, S.srcW, S.srcH, fPx) ||
            (fPx ? estimateAspect(p, S.srcW, S.srcH, null) : null);
    if (S.est) ratio = S.est.ratio;
  } else if (mode !== 'edges') {
    ratio = parseFloat(mode);
  }

  if (ratio && isFinite(ratio) && ratio > 0) {
    // Preserve area so the size does not jump when switching modes
    var area = Math.max(w * h, 1);
    w = Math.sqrt(area * ratio);
    h = Math.sqrt(area / ratio);
  }

  var k = Math.min(1, MAXPX / Math.max(w, h, 1));
  S.rectW = Math.max(1, Math.round(w * k));
  S.rectH = Math.max(1, Math.round(h * k));
  return true;
}

/* Builds the rectified canvas. scale<1 => fast preview. */
function rectify(scale) {
  if (!S.srcData) return false;
  var W = Math.max(1, Math.round(S.rectW * scale));
  var H = Math.max(1, Math.round(S.rectH * scale));

  var h, r;
  if (S.method === 'guided') {
    if (!S.hDst) return false;
    // the guided mapping is built for the full size: rescale its input axes
    var kx = W / S.rectW, ky = H / S.rectH;
    h = S.hDst.slice();
    for (r = 0; r < 3; r++) { h[r * 3] /= kx; h[r * 3 + 1] /= ky; }
  } else {
    if (S.pts.length !== 4) return false;
    var dstRect = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
    h = homography(dstRect, S.pts);         // target -> source (inverse mapping)
  }
  if (!h) return false;

  var out = document.createElement('canvas');
  out.width = W; out.height = H;
  var oc = out.getContext('2d');
  var od = oc.createImageData(W, H);
  var o = od.data, sd = S.srcData.data, sw = S.srcW, sh = S.srcH;

  for (var y = 0; y < H; y++) {
    for (var x = 0; x < W; x++) {
      var px = x + 0.5, py = y + 0.5;
      var w0 = h[6] * px + h[7] * py + h[8];
      var sx = (h[0] * px + h[1] * py + h[2]) / w0 - 0.5;
      var sy = (h[3] * px + h[4] * py + h[5]) / w0 - 0.5;
      var di = (y * W + x) * 4;
      if (sx < -1 || sy < -1 || sx > sw || sy > sh) continue;

      var x0 = Math.floor(sx), y0 = Math.floor(sy);
      var fx = sx - x0, fy = sy - y0;
      var x1 = x0 + 1, y1 = y0 + 1;
      if (x0 < 0) x0 = 0; if (y0 < 0) y0 = 0;
      if (x1 > sw - 1) x1 = sw - 1; if (y1 > sh - 1) y1 = sh - 1;
      if (x0 > sw - 1) x0 = sw - 1; if (y0 > sh - 1) y0 = sh - 1;

      var i00 = (y0 * sw + x0) * 4, i10 = (y0 * sw + x1) * 4;
      var i01 = (y1 * sw + x0) * 4, i11 = (y1 * sw + x1) * 4;
      var w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy);
      var w01 = (1 - fx) * fy, w11 = fx * fy;

      for (var c = 0; c < 4; c++) {
        o[di + c] = sd[i00 + c] * w00 + sd[i10 + c] * w10 + sd[i01 + c] * w01 + sd[i11 + c] * w11;
      }
    }
  }
  oc.putImageData(od, 0, 0);
  S.rect = out;
  S.rectScale = W / S.rectW;
  return true;
}

/* Carry the warp points along proportionally when the target size changes. */
function rescaleWarp(oldW, oldH) {
  if (!S.warp || !oldW || !oldH) return;
  var fx = S.rectW / oldW, fy = S.rectH / oldH;
  if (fx === 1 && fy === 1) return;
  S.warp.c.concat(S.warp.m).forEach(function (q) { q.x *= fx; q.y *= fy; });
}

function rebuildRect(preview) {
  var oldW = S.rectW, oldH = S.rectH;
  if (!calcRectSize()) { S.rect = null; S.rectDirty = false; return false; }
  rescaleWarp(oldW, oldH);
  var sc = 1;
  if (preview) sc = Math.min(1, PREVIEW / Math.max(S.rectW, S.rectH));
  if (!rectify(sc)) { S.rect = null; S.rectDirty = false; return false; }
  S.rectDirty = sc < 1;
  return true;
}

/* Enough input for a rectification? (Whether it actually works out is
   decided by calcRectSize.) */
function sourceReady() {
  return S.method === 'guided' ? S.lines.length >= 2 : S.pts.length === 4;
}

// ---------------------------------------------------------- Warp (Coons patch)

function resetWarp() {
  var W = S.rectW, H = S.rectH;
  var c = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }];
  S.warp = {
    c: c,
    m: [mid(c[0], c[1]), mid(c[1], c[2]), mid(c[3], c[2]), mid(c[0], c[3])] // top, right, bottom, left
  };
}

/* Control point of a quadratic Bézier passing through m (at t=0.5). */
function ctrl(a, b, m) {
  return { x: 2 * m.x - (a.x + b.x) / 2, y: 2 * m.y - (a.y + b.y) / 2 };
}
function bez(a, k, b, t) {
  var s = 1 - t;
  return {
    x: s * s * a.x + 2 * s * t * k.x + t * t * b.x,
    y: s * s * a.y + 2 * s * t * k.y + t * t * b.y
  };
}

function warpEdges() {
  var c = S.warp.c, m = S.warp.m;
  return {
    top: ctrl(c[0], c[1], m[0]),
    right: ctrl(c[1], c[2], m[1]),
    bottom: ctrl(c[3], c[2], m[2]),
    left: ctrl(c[0], c[3], m[3])
  };
}

/* Coons patch: (u,v) in [0,1]² -> point in warp space. */
function warpPoint(u, v, e) {
  var c = S.warp.c;
  var T = bez(c[0], e.top, c[1], u);
  var B = bez(c[3], e.bottom, c[2], u);
  var L = bez(c[0], e.left, c[3], v);
  var R = bez(c[1], e.right, c[2], v);
  var bx = (1 - u) * (1 - v) * c[0].x + u * (1 - v) * c[1].x + (1 - u) * v * c[3].x + u * v * c[2].x;
  var by = (1 - u) * (1 - v) * c[0].y + u * (1 - v) * c[1].y + (1 - u) * v * c[3].y + u * v * c[2].y;
  return {
    x: (1 - v) * T.x + v * B.x + (1 - u) * L.x + u * R.x - bx,
    y: (1 - v) * T.y + v * B.y + (1 - u) * L.y + u * R.y - by
  };
}

function warpBBox() {
  var e = warpEdges(), N = 40;
  var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (var i = 0; i <= N; i++) {
    var t = i / N;
    var ps = [warpPoint(t, 0, e), warpPoint(t, 1, e), warpPoint(0, t, e), warpPoint(1, t, e)];
    for (var k = 0; k < 4; k++) {
      x0 = Math.min(x0, ps[k].x); y0 = Math.min(y0, ps[k].y);
      x1 = Math.max(x1, ps[k].x); y1 = Math.max(y1, ps[k].y);
    }
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// --------------------------------------------------------- Squashing (scale)

/* The 8 handles in scale mode: corners + edge midpoints of the bounding box.
   Order: 0..3 corners TL,TR,BR,BL — 4..7 edges top,right,bottom,left. */
function scaleHandles(bb) {
  bb = bb || warpBBox();
  var x0 = bb.x, y0 = bb.y, x1 = bb.x + bb.w, y1 = bb.y + bb.h;
  var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  return [
    { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
    { x: cx, y: y0 }, { x: x1, y: cy }, { x: cx, y: y1 }, { x: x0, y: cy }
  ];
}

/* Scales the whole shape (all control points) about the anchor point.
   Any mesh warp is preserved and simply squashed along with it. */
function applyScale(snap, anchor, fx, fy) {
  var all = S.warp.c.concat(S.warp.m);
  for (var i = 0; i < 8; i++) {
    all[i].x = anchor.x + (snap[i].x - anchor.x) * fx;
    all[i].y = anchor.y + (snap[i].y - anchor.y) * fy;
  }
}

function scaleFactors(idx, bb, world) {
  var x0 = bb.x, y0 = bb.y, x1 = bb.x + bb.w, y1 = bb.y + bb.h;
  var w = bb.w || 1, h = bb.h || 1;
  switch (idx) {
    case 0: return { a: { x: x1, y: y1 }, fx: (x1 - world.x) / w, fy: (y1 - world.y) / h };
    case 1: return { a: { x: x0, y: y1 }, fx: (world.x - x0) / w, fy: (y1 - world.y) / h };
    case 2: return { a: { x: x0, y: y0 }, fx: (world.x - x0) / w, fy: (world.y - y0) / h };
    case 3: return { a: { x: x1, y: y0 }, fx: (x1 - world.x) / w, fy: (world.y - y0) / h };
    case 4: return { a: { x: x0, y: y1 }, fx: 1, fy: (y1 - world.y) / h };
    case 5: return { a: { x: x0, y: y0 }, fx: (world.x - x0) / w, fy: 1 };
    case 6: return { a: { x: x0, y: y0 }, fx: 1, fy: (world.y - y0) / h };
    case 7: return { a: { x: x1, y: y0 }, fx: (x1 - world.x) / w, fy: 1 };
  }
  return null;
}

// ------------------------------------------------------- Draw textured mesh

function drawTri(ctx, img, s, d, pad) {
  var sx0 = s[0], sy0 = s[1], sx1 = s[2], sy1 = s[3], sx2 = s[4], sy2 = s[5];
  var dx0 = d[0], dy0 = d[1], dx1 = d[2], dy1 = d[3], dx2 = d[4], dy2 = d[5];

  var det = sx0 * (sy1 - sy2) + sx1 * (sy2 - sy0) + sx2 * (sy0 - sy1);
  if (Math.abs(det) < 1e-9) return;

  var a = (dx0 * (sy1 - sy2) + dx1 * (sy2 - sy0) + dx2 * (sy0 - sy1)) / det;
  var c = (dx0 * (sx2 - sx1) + dx1 * (sx0 - sx2) + dx2 * (sx1 - sx0)) / det;
  var e = (dx0 * (sx1 * sy2 - sx2 * sy1) + dx1 * (sx2 * sy0 - sx0 * sy2) + dx2 * (sx0 * sy1 - sx1 * sy0)) / det;
  var b = (dy0 * (sy1 - sy2) + dy1 * (sy2 - sy0) + dy2 * (sy0 - sy1)) / det;
  var dd = (dy0 * (sx2 - sx1) + dy1 * (sx0 - sx2) + dy2 * (sx1 - sx0)) / det;
  var f = (dy0 * (sx1 * sy2 - sx2 * sy1) + dy1 * (sx2 * sy0 - sx0 * sy2) + dy2 * (sx0 * sy1 - sx1 * sy0)) / det;

  // Widen the clip triangle slightly so no seams remain between the tiles
  var gx = (dx0 + dx1 + dx2) / 3, gy = (dy0 + dy1 + dy2) / 3;
  function ex(px, py) {
    var vx = px - gx, vy = py - gy, l = Math.hypot(vx, vy) || 1;
    return [px + vx / l * pad, py + vy / l * pad];
  }
  var p0 = ex(dx0, dy0), p1 = ex(dx1, dy1), p2 = ex(dx2, dy2);

  ctx.save();
  ctx.beginPath();
  ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c, dd, e, f);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

/* Draws the warped image into the current (already transformed) context.
   Output coordinates = warp space. pad is given in warp units. */
function drawWarped(ctx, N, pad) {
  if (!S.rect) return;
  var e = warpEdges();
  var texW = S.rect.width, texH = S.rect.height;   // texture pixels (possibly preview resolution)

  var grid = [], i, j;
  for (j = 0; j <= N; j++) {
    var row = [];
    for (i = 0; i <= N; i++) row.push(warpPoint(i / N, j / N, e));
    grid.push(row);
  }
  for (j = 0; j < N; j++) {
    for (i = 0; i < N; i++) {
      var u0 = i / N * texW, u1 = (i + 1) / N * texW;
      var v0 = j / N * texH, v1 = (j + 1) / N * texH;
      var A = grid[j][i], B = grid[j][i + 1], C = grid[j + 1][i + 1], D = grid[j + 1][i];
      drawTri(ctx, S.rect, [u0, v0, u1, v0, u1, v1],
        [A.x, A.y, B.x, B.y, C.x, C.y], pad);
      drawTri(ctx, S.rect, [u0, v0, u1, v1, u0, v1],
        [A.x, A.y, C.x, C.y, D.x, D.y], pad);
    }
  }
}

// ----------------------------------------------------------- View helpers

function toWorld(v, sx, sy) { return { x: (sx - v.ox) / v.s, y: (sy - v.oy) / v.s }; }

function fitView(which) {
  var p = P[which], v = p.view;
  var w = which === 'L' ? S.srcW : S.rectW;
  var h = which === 'L' ? S.srcH : S.rectH;
  if (!w || !h) return;
  var cw = p.cv.clientWidth, ch = p.cv.clientHeight;
  v.s = Math.min(cw / w, ch / h) * 0.88;
  v.ox = (cw - w * v.s) / 2;
  v.oy = (ch - h * v.s) / 2;
}

function zoomAt(v, sx, sy, factor) {
  var w = toWorld(v, sx, sy);
  v.s = Math.max(0.02, Math.min(60, v.s * factor));
  v.ox = sx - w.x * v.s;
  v.oy = sy - w.y * v.s;
}

/* Match the backing store to the actual CSS size. Driven by a ResizeObserver
   rather than window.resize alone — otherwise the drawn image and the click
   coordinates drift apart as soon as the layout changes. */
function resize() {
  var changed = false;
  ['L', 'R'].forEach(function (k) {
    var p = P[k], dpr = window.devicePixelRatio || 1;
    var w = Math.round(p.cv.clientWidth * dpr), h = Math.round(p.cv.clientHeight * dpr);
    if (!w || !h) return;
    if (p.cv.width !== w || p.cv.height !== h || p.dpr !== dpr) {
      p.cv.width = w; p.cv.height = h; p.dpr = dpr;
      changed = true;
    }
  });
  if (changed) draw();
  return changed;
}

// ----------------------------------------------------------------- Drawing

function clearPane(p) {
  var ctx = p.ctx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, p.cv.width, p.cv.height);
  return ctx;
}

function checkerboard(ctx, w, h, dpr) {
  var s = 10 * dpr;
  ctx.fillStyle = '#22252c'; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#272b33';
  for (var y = 0; y < h; y += s) {
    for (var x = ((y / s) % 2) * s; x < w; x += s * 2) ctx.fillRect(x, y, s, s);
  }
}

function handle(ctx, x, y, r, fill, stroke) {
  ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = stroke; ctx.stroke();
}

function drawLeft() {
  var p = P.L, ctx = clearPane(p), dpr = p.dpr, v = p.view;
  if (!S.img) return;
  var t = v.s * dpr;
  ctx.setTransform(t, 0, 0, t, v.ox * dpr, v.oy * dpr);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(S.img, 0, 0);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (S.method === 'guided') { drawGuides(ctx, dpr, t, v); return; }

  var sp = S.pts.map(function (q) { return { x: q.x * t + v.ox * dpr, y: q.y * t + v.oy * dpr }; });

  if (sp.length > 1) {
    ctx.beginPath();
    ctx.moveTo(sp[0].x, sp[0].y);
    for (var i = 1; i < sp.length; i++) ctx.lineTo(sp[i].x, sp[i].y);
    if (sp.length === 4) {
      ctx.closePath();
      ctx.fillStyle = 'rgba(41,209,124,.10)';
      ctx.fill();
    }
    ctx.lineWidth = 2 * dpr;
    ctx.strokeStyle = '#29d17c';
    ctx.stroke();
  }
  sp.forEach(function (q, i) {
    handle(ctx, q.x, q.y, 6 * dpr, '#29d17c', '#0d1912');
    ctx.fillStyle = '#0d1912';
    ctx.font = (9 * dpr) + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1), q.x, q.y + 0.5 * dpr);
  });
}

/* Guide lines: the drawn segment, its infinite extension as a sighting aid,
   two end handles and a midpoint badge that carries the orientation. */
function drawGuides(ctx, dpr, t, v) {
  var far = Math.hypot(P.L.cv.width, P.L.cv.height) * 1.2;
  S.lines.forEach(function (L) {
    var a = { x: L.a.x * t + v.ox * dpr, y: L.a.y * t + v.oy * dpr };
    var b = { x: L.b.x * t + v.ox * dpr, y: L.b.y * t + v.oy * dpr };
    var col = GCOL[L.dir];
    var dx = b.x - a.x, dy = b.y - a.y, m = Math.hypot(dx, dy) || 1;
    dx /= m; dy /= m;

    ctx.save();
    ctx.setLineDash([5 * dpr, 5 * dpr]);
    ctx.lineWidth = 1 * dpr;
    ctx.strokeStyle = GCOLF[L.dir];
    ctx.beginPath();
    ctx.moveTo(a.x - dx * far, a.y - dy * far);
    ctx.lineTo(b.x + dx * far, b.y + dy * far);
    ctx.stroke();
    ctx.restore();

    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = col;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();

    handle(ctx, a.x, a.y, 5.5 * dpr, col, '#0d1912');
    handle(ctx, b.x, b.y, 5.5 * dpr, col, '#0d1912');

    var mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, r = 7 * dpr;
    ctx.fillStyle = col; ctx.strokeStyle = '#0d1912'; ctx.lineWidth = 2 * dpr;
    ctx.beginPath(); ctx.rect(mx - r, my - r, r * 2, r * 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#0d1912';
    ctx.font = 'bold ' + (10 * dpr) + 'px sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(L.dir === 'v' ? 'V' : 'H', mx, my + 0.5 * dpr);
  });
}

/* Flat lists for the hit test: both end points of every line, plus the
   midpoints (index = line index). */
function guideHandles() {
  var ends = [], mids = [];
  S.lines.forEach(function (L) { ends.push(L.a, L.b); mids.push(mid(L.a, L.b)); });
  return { ends: ends, mids: mids };
}

function drawRight() {
  var p = P.R, ctx = clearPane(p), dpr = p.dpr, v = p.view;
  if (!S.rect) return;
  checkerboard(ctx, p.cv.width, p.cv.height, dpr);

  var t = v.s * dpr;
  ctx.setTransform(t, 0, 0, t, v.ox * dpr, v.oy * dpr);
  ctx.imageSmoothingQuality = 'high';
  drawWarped(ctx, dragging && dragging.pane === 'R' ? 14 : 26, 0.7 / t);

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  var e = warpEdges();
  function sc(q) { return { x: q.x * t + v.ox * dpr, y: q.y * t + v.oy * dpr }; }

  if (S.showGrid) {
    ctx.strokeStyle = 'rgba(41,209,124,.25)';
    ctx.lineWidth = 1 * dpr;
    var N = 8, i, j, q;
    for (i = 1; i < N; i++) {
      ctx.beginPath();
      for (j = 0; j <= 24; j++) { q = sc(warpPoint(i / N, j / 24, e)); j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }
      ctx.stroke();
      ctx.beginPath();
      for (j = 0; j <= 24; j++) { q = sc(warpPoint(j / 24, i / N, e)); j ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y); }
      ctx.stroke();
    }
  }

  if (S.warpHandles) {
    var c = S.warp.c;
    ctx.beginPath();
    var start = sc(c[0]); ctx.moveTo(start.x, start.y);
    // Bézier is symmetric: bottom/left edges run backwards, same control point
    drawBez(ctx, sc, c[0], e.top, c[1]);
    drawBez(ctx, sc, c[1], e.right, c[2]);
    drawBez(ctx, sc, c[2], e.bottom, c[3]);
    drawBez(ctx, sc, c[3], e.left, c[0]);
    ctx.lineWidth = (S.mode === 'warp' ? 2 : 1) * dpr;
    ctx.strokeStyle = S.mode === 'warp' ? '#29d17c' : 'rgba(41,209,124,.45)';
    ctx.stroke();

    if (S.mode === 'warp') {
      S.warp.c.forEach(function (q) { var s = sc(q); handle(ctx, s.x, s.y, 6 * dpr, '#29d17c', '#0d1912'); });
      S.warp.m.forEach(function (q) { var s = sc(q); handle(ctx, s.x, s.y, 5 * dpr, '#0d1912', '#29d17c'); });
    } else {
      var hs = scaleHandles(), a = sc(hs[0]), b = sc(hs[2]);
      ctx.beginPath();
      ctx.rect(a.x, a.y, b.x - a.x, b.y - a.y);
      ctx.lineWidth = 2 * dpr; ctx.strokeStyle = '#29d17c'; ctx.stroke();
      hs.forEach(function (q, i) {
        var s = sc(q);
        if (i < 4) handle(ctx, s.x, s.y, 6 * dpr, '#29d17c', '#0d1912');
        else {
          ctx.fillStyle = '#29d17c'; ctx.strokeStyle = '#0d1912'; ctx.lineWidth = 2 * dpr;
          var r = 5 * dpr;
          ctx.beginPath(); ctx.rect(s.x - r, s.y - r, r * 2, r * 2);
          ctx.fill(); ctx.stroke();
        }
      });
    }
  }
}

function drawBez(ctx, sc, a, k, b) {
  for (var i = 1; i <= 24; i++) {
    var q = sc(bez(a, k, b, i / 24));
    ctx.lineTo(q.x, q.y);
  }
}

function draw() { drawLeft(); drawRight(); updateChrome(); }

function guidedCounts() {
  var nv = 0;
  S.lines.forEach(function (L) { if (L.dir === 'v') nv++; });
  return { v: nv, h: S.lines.length - nv };
}

function updateChrome() {
  var guided = S.method === 'guided';
  P.L.zoom.textContent = Math.round(viewL.s * 100) + '%';
  P.R.zoom.textContent = Math.round(viewR.s * 100) + '%';
  hintL.classList.toggle('off', !!S.img);
  hintR.classList.toggle('off', !!S.rect);
  if (!S.img) { hintR.textContent = 'No image yet'; }
  else if (guided) {
    hintR.textContent = S.lines.length < 2
      ? 'Draw ' + (2 - S.lines.length) + ' more guide line(s)'
      : 'These lines do not yield a correction';
  } else if (S.pts.length < 4) { hintR.textContent = 'Set ' + (4 - S.pts.length) + ' more point(s)'; }
  expBtn.disabled = !S.rect;
  if (S.img) {
    var txt = S.srcW + '×' + S.srcH + ' px';
    if (S.rect) txt += '  →  ' + S.rectW + '×' + S.rectH + ' px';
    if (guided) {
      var c = guidedCounts();
      txt += '  ·  ' + c.v + ' vertical, ' + c.h + ' horizontal';
    } else if (S.pts.length < 4) txt += '  ·  ' + S.pts.length + '/4 points';
    info.textContent = txt;
  } else info.textContent = 'No image loaded';

  var est = document.getElementById('est');
  if (guided) { guidedStatus(est); return; }
  if (!S.rect || S.aspectMode !== 'auto') {
    est.textContent = ''; est.title = ''; est.classList.remove('warn'); return;
  }
  if (!S.est) {
    est.textContent = '⚠︎ Estimate failed → edge averages';
    est.classList.add('warn');
    est.title = 'The four points are not compatible with a real rectangle ' +
                '(placed too imprecisely, or the object is not a rectangle).';
  } else {
    var t = 'Ratio ' + S.est.ratio.toFixed(3) + ' (' + S.est.method + ')';
    var shaky = false;
    if (S.est.f) {
      var mm = S.srcW ? S.est.f / Math.max(S.srcW, S.srcH) * 36 : 0;
      t += ' · f ≈ ' + Math.round(S.est.f) + ' px';
      if (mm) t += ' ≙ ' + Math.round(mm) + ' mm';
      // A focal length outside the usual range almost always means the points
      // are placed imprecisely, or the object simply is not a rectangle.
      shaky = S.est.method === 'estimated' && mm && (mm < 12 || mm > 200);
      if (shaky) t = '⚠︎ ' + t + ' — implausible';
    }
    est.textContent = t;
    est.classList.toggle('warn', shaky);
    est.title = S.est.method === 'EXIF'
      ? 'Focal length taken from the EXIF data — the most reliable variant.'
      : S.est.method === 'affine'
        ? 'Near-parallel edges: no perspective information, estimated purely affinely.'
        : 'Focal length estimated from the four points. Unreliable for near-frontal shots.';
  }
}

/* What the guided solution is actually based on — the difference between a
   true metric rectification and a mere straightening matters for the result. */
function guidedStatus(est) {
  est.classList.remove('warn'); est.title = '';
  if (!S.img || !S.lines.length) { est.textContent = ''; return; }
  if (!S.rect) {
    if (S.lines.length < 2) { est.textContent = 'At least two guide lines needed'; return; }
    est.textContent = '⚠︎ These lines cannot be resolved';
    est.classList.add('warn');
    est.title = 'Two lines of the same orientation are (nearly) parallel or ' +
                'meet inside the picture, so no usable correction follows from them.';
    return;
  }
  var g = S.gInfo || {};
  if (g.method === 'metric') {
    var t = 'Guided · metric — both vanishing points';
    if (g.f) {
      var mm = S.srcW ? g.f / Math.max(S.srcW, S.srcH) * 36 : 0;
      t += ' · f ≈ ' + Math.round(g.f) + ' px';
      if (mm) t += ' ≙ ' + Math.round(mm) + ' mm';
    }
    est.textContent = t;
    est.title = 'Vertical and horizontal vanishing points are compatible with a ' +
                'right angle: angles and the aspect ratio are recovered.';
  } else if (g.method === 'keystone') {
    est.textContent = 'Guided · one direction — aspect ratio not recoverable';
    est.title = 'Only one bundle of lines converges. The edges become parallel and ' +
                'upright, but the second axis is assumed to be undistorted already. ' +
                'Add two lines of the other orientation for a full correction.';
  } else if (g.method === 'skew') {
    est.textContent = '⚠︎ Guided · vanishing points not compatible with a right angle';
    est.classList.add('warn');
    est.title = 'The lines converge, but not the way a rectangular corner would. ' +
                'Edges are straightened, the aspect ratio stays arbitrary.';
  } else {
    est.textContent = 'Guided · affine — rotation and shear only';
    est.title = 'No bundle of two like-oriented lines: the picture is only rotated ' +
                'and sheared so the drawn lines run vertically and horizontally.';
  }
}

// ------------------------------------------------------------- Image loading

/* Strips the extension and anything a file name must not carry into a
   download attribute (path separators, control characters). */
function baseName(name) {
  var b = String(name || '').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  b = b.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
  return b || 'anti-perspective';
}

function loadFile(file) {
  S.f35 = null;
  S.name = baseName(file.name);
  if (/jpe?g/i.test(file.type)) {
    var fr = new FileReader();
    fr.onload = function () {
      S.f35 = exifFocal35(fr.result);
      loadImage(URL.createObjectURL(file));
    };
    fr.onerror = function () { loadImage(URL.createObjectURL(file)); };
    fr.readAsArrayBuffer(file);
  } else {
    loadImage(URL.createObjectURL(file));
  }
}

function loadImage(src) {
  var img = new Image();
  img.onload = function () {
    S.img = img; S.srcW = img.naturalWidth; S.srcH = img.naturalHeight;
    var c = document.createElement('canvas');
    c.width = S.srcW; c.height = S.srcH;
    var cc = c.getContext('2d', { willReadFrequently: true });
    cc.drawImage(img, 0, 0);
    S.srcData = cc.getImageData(0, 0, S.srcW, S.srcH);
    S.pts = []; S.lines = [];
    S.rect = null; S.warp = null; S.warpHandles = false;
    S.hDst = null; S.gInfo = null;
    fitView('L');
    draw();
  };
  img.src = src;
}

document.getElementById('file').addEventListener('change', function (ev) {
  var f = ev.target.files[0];
  if (f) loadFile(f);
  ev.target.value = '';
});

['dragenter', 'dragover'].forEach(function (t) {
  document.getElementById('paneL').addEventListener(t, function (e) {
    e.preventDefault(); this.classList.add('drop');
  });
});
['dragleave', 'drop'].forEach(function (t) {
  document.getElementById('paneL').addEventListener(t, function (e) {
    e.preventDefault(); this.classList.remove('drop');
  });
});
document.getElementById('paneL').addEventListener('drop', function (e) {
  var f = e.dataTransfer.files[0];
  if (f && /^image\//.test(f.type)) loadFile(f);
});

// -------------------------------------------------------------- Interaction

var dragging = null;   // {pane, type:'pt'|'corner'|'mid'|'pan'|'scale', idx, ...}

/* Recompute the rectification at most once per frame — otherwise fast mouse
   movement piles up a backlog of full per-pixel passes. */
var rebuildPending = 0;
function scheduleRebuild() {
  if (rebuildPending) return;
  rebuildPending = requestAnimationFrame(function () {
    rebuildPending = 0;
    var had = !!S.rect;
    if (rebuildRect(true) && !S.warp) resetWarp();
    if (!had && S.rect) fitView('R');       // first result: bring it into view
    draw();
  });
}

function hit(list, world, v, r) {
  r = (r || 9) / v.s;
  for (var i = 0; i < list.length; i++) if (len(list[i], world) <= r) return i;
  return -1;
}

function localPos(cv, e) {
  var b = cv.getBoundingClientRect();
  return { x: e.clientX - b.left, y: e.clientY - b.top };
}

function pointInWarp(world) {
  var e = warpEdges(), N = 32, poly = [], i, j;
  for (i = 0; i < N; i++) poly.push(warpPoint(i / N, 0, e));
  for (i = 0; i < N; i++) poly.push(warpPoint(1, i / N, e));
  for (i = 0; i < N; i++) poly.push(warpPoint(1 - i / N, 1, e));
  for (i = 0; i < N; i++) poly.push(warpPoint(0, 1 - i / N, e));
  var inside = false;
  for (i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    var a = poly[i], b = poly[j];
    if ((a.y > world.y) !== (b.y > world.y) &&
        world.x < (b.x - a.x) * (world.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

function onDown(which, e) {
  // Before any hit test, make sure backing store and CSS size agree —
  // otherwise the click does not land where things were actually drawn.
  resize();
  var p = P[which], v = p.view, pos = localPos(p.cv, e);
  var world = toWorld(v, pos.x, pos.y);
  try { p.cv.setPointerCapture(e.pointerId); } catch (err) { /* not critical */ }

  if (e.button === 1 || e.button === 2 || e.altKey) {
    dragging = { pane: which, type: 'pan', sx: pos.x, sy: pos.y, ox: v.ox, oy: v.oy };
    e.preventDefault();
    return;
  }
  if (e.button !== 0) return;

  if (which === 'L') {
    if (!S.img) return;
    if (S.method === 'guided') { downGuided(pos, world, v); return; }
    var i = hit(S.pts, world, v);
    if (i >= 0) { dragging = { pane: 'L', type: 'pt', idx: i }; return; }
    if (S.pts.length < 4) {
      S.pts.push(world);
      if (S.pts.length === 4) {
        S.pts = orderQuad(S.pts);
        rebuildRect(false);
        resetWarp();
        fitView('R');
      }
      draw();
      return;
    }
    dragging = { pane: 'L', type: 'pan', sx: pos.x, sy: pos.y, ox: v.ox, oy: v.oy };
    return;
  }

  // right-hand pane
  if (!S.rect) return;
  if (S.warpHandles) {
    if (S.mode === 'warp') {
      var ci = hit(S.warp.c, world, v);
      if (ci >= 0) { dragging = { pane: 'R', type: 'corner', idx: ci, last: world }; return; }
      var mi = hit(S.warp.m, world, v);
      if (mi >= 0) { dragging = { pane: 'R', type: 'mid', idx: mi }; return; }
    } else {
      var bb = warpBBox();
      var si = hit(scaleHandles(bb), world, v);
      if (si >= 0) {
        dragging = {
          pane: 'R', type: 'scale', idx: si, bb: bb,
          snap: S.warp.c.concat(S.warp.m).map(function (q) { return { x: q.x, y: q.y }; })
        };
        return;
      }
    }
  }
  if (pointInWarp(world)) {
    S.warpHandles = true;
    dragging = { pane: 'R', type: 'maybePan', sx: pos.x, sy: pos.y, ox: v.ox, oy: v.oy };
    draw();
    return;
  }
  S.warpHandles = false;
  dragging = { pane: 'R', type: 'pan', sx: pos.x, sy: pos.y, ox: v.ox, oy: v.oy };
  draw();
}

/* Guided mode on the source pane: grab an end point, grab the midpoint
   (move the line, or toggle its orientation on a plain click), otherwise
   pull a new line open. */
function downGuided(pos, world, v) {
  var gh = guideHandles();
  var ei = hit(gh.ends, world, v);
  if (ei >= 0) { dragging = { pane: 'L', type: 'lend', li: ei >> 1, pi: ei & 1 }; return; }
  var mi = hit(gh.mids, world, v);
  if (mi >= 0) { dragging = { pane: 'L', type: 'lmid', li: mi, last: world, start: world, moved: false }; return; }
  if (S.lines.length < GMAX) {
    S.lines.push({ a: { x: world.x, y: world.y }, b: { x: world.x, y: world.y }, dir: 'v' });
    dragging = { pane: 'L', type: 'lnew', li: S.lines.length - 1 };
    draw();
    return;
  }
  dragging = { pane: 'L', type: 'pan', sx: pos.x, sy: pos.y, ox: v.ox, oy: v.oy };
}

function onMove(which, e) {
  var p = P[which], v = p.view, pos = localPos(p.cv, e);
  var world = toWorld(v, pos.x, pos.y);

  if (!dragging || dragging.pane !== which) {
    // cursor feedback
    var over = false;
    if (which === 'L' && S.img) {
      if (S.method === 'guided') {
        var gh = guideHandles();
        over = hit(gh.ends, world, v) >= 0 || hit(gh.mids, world, v) >= 0;
      } else over = hit(S.pts, world, v) >= 0;
    }
    if (which === 'R' && S.rect && S.warpHandles) {
      over = S.mode === 'warp'
        ? (hit(S.warp.c, world, v) >= 0 || hit(S.warp.m, world, v) >= 0)
        : hit(scaleHandles(), world, v) >= 0;
    }
    var free = which === 'L' && S.img &&
      (S.method === 'guided' ? S.lines.length < GMAX : S.pts.length < 4);
    p.cv.style.cursor = over ? 'grab' : (free ? 'crosshair' : 'default');
    return;
  }

  if (dragging.type === 'maybePan') dragging.type = 'pan';

  if (dragging.type === 'pan') {
    v.ox = dragging.ox + (pos.x - dragging.sx);
    v.oy = dragging.oy + (pos.y - dragging.sy);
    draw();
    return;
  }

  if (dragging.type === 'pt') {
    S.pts[dragging.idx] = { x: world.x, y: world.y };
    scheduleRebuild();
    return;
  }

  if (dragging.type === 'lnew' || dragging.type === 'lend') {
    var gl = S.lines[dragging.li];
    if (dragging.type === 'lnew') {
      gl.b = { x: world.x, y: world.y };
      // the drag direction decides what the line stands for
      gl.dir = Math.abs(gl.b.y - gl.a.y) >= Math.abs(gl.b.x - gl.a.x) ? 'v' : 'h';
    } else {
      gl[dragging.pi ? 'b' : 'a'] = { x: world.x, y: world.y };
    }
    scheduleRebuild();
    return;
  }

  if (dragging.type === 'lmid') {
    var gm = S.lines[dragging.li];
    var dm = { x: world.x - dragging.last.x, y: world.y - dragging.last.y };
    dragging.last = world;
    if (len(world, dragging.start) * v.s > 3) dragging.moved = true;
    gm.a.x += dm.x; gm.a.y += dm.y; gm.b.x += dm.x; gm.b.y += dm.y;
    scheduleRebuild();
    return;
  }

  if (dragging.type === 'corner') {
    var i = dragging.idx, d = { x: world.x - dragging.last.x, y: world.y - dragging.last.y };
    dragging.last = world;
    S.warp.c[i].x += d.x; S.warp.c[i].y += d.y;
    // drag the adjacent edge midpoints along -> straight edges stay straight
    var adj = [[0, 3], [0, 1], [1, 2], [2, 3]][i];
    adj.forEach(function (k) { S.warp.m[k].x += d.x / 2; S.warp.m[k].y += d.y / 2; });
    draw();
    return;
  }

  if (dragging.type === 'mid') {
    S.warp.m[dragging.idx] = { x: world.x, y: world.y };
    draw();
    return;
  }

  if (dragging.type === 'scale') {
    var f = scaleFactors(dragging.idx, dragging.bb, world);
    if (!f || !isFinite(f.fx) || !isFinite(f.fy)) return;
    if (e.shiftKey) {                       // uniform
      var u = dragging.idx < 4 ? (f.fx + f.fy) / 2 : (dragging.idx % 2 ? f.fx : f.fy);
      f.fx = u; f.fy = u;
    }
    var MIN = 0.02;                         // never let it collapse completely
    if (Math.abs(f.fx) < MIN) f.fx = MIN * (f.fx < 0 ? -1 : 1);
    if (Math.abs(f.fy) < MIN) f.fy = MIN * (f.fy < 0 ? -1 : 1);
    applyScale(dragging.snap, f.a, f.fx, f.fy);
    draw();
  }
}

function onUp(which) {
  if (!dragging) return;
  var d = dragging, t = d.type;
  dragging = null;

  if (t === 'lnew' && len(S.lines[d.li].a, S.lines[d.li].b) * viewL.s < 10) {
    S.lines.splice(d.li, 1);                // a stray click, not a line
  }
  if (t === 'lmid' && !d.moved) {           // plain click toggles the orientation
    var L = S.lines[d.li];
    L.dir = L.dir === 'v' ? 'h' : 'v';
  }

  if (t === 'pt' || t === 'lnew' || t === 'lend' || t === 'lmid') {
    if (rebuildPending) { cancelAnimationFrame(rebuildPending); rebuildPending = 0; }
    // a new line changes the framing completely — merely dragging one does not
    refreshResult(!S.rect || t === 'lnew');   // full resolution once released
  }
  if (t === 'maybePan') { /* plain click: handles stay visible */ }
  draw();
}

/* Rebuilds the right-hand pane from the current source input. */
function refreshResult(refit) {
  if (sourceReady() && rebuildRect(false)) {
    if (!S.warp) resetWarp();
    if (refit) fitView('R');
  } else {
    S.rect = null; S.warp = null; S.warpHandles = false;
  }
}

['L', 'R'].forEach(function (k) {
  var cv = P[k].cv;
  cv.addEventListener('pointerdown', function (e) { onDown(k, e); });
  cv.addEventListener('pointermove', function (e) { onMove(k, e); });
  cv.addEventListener('pointerup', function () { onUp(k); });
  cv.addEventListener('pointercancel', function () { onUp(k); });
  cv.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  cv.addEventListener('wheel', function (e) {
    e.preventDefault();
    var pos = localPos(cv, e);
    zoomAt(P[k].view, pos.x, pos.y, Math.pow(0.999, e.deltaY * (e.deltaMode === 1 ? 20 : 1)));
    draw();
  }, { passive: false });
});

document.querySelectorAll('.zoom button').forEach(function (b) {
  b.addEventListener('click', function () {
    var k = b.dataset.p, v = P[k].view, cv = P[k].cv;
    if (b.dataset.a === 'fit') fitView(k);
    else zoomAt(v, cv.clientWidth / 2, cv.clientHeight / 2, b.dataset.a === 'in' ? 1.25 : 0.8);
    draw();
  });
});

document.getElementById('resetQuad').addEventListener('click', function () {
  if (S.method === 'guided') S.lines = []; else S.pts = [];
  S.rect = null; S.warp = null; S.warpHandles = false;
  S.hDst = null; S.gInfo = null;
  draw();
});
document.getElementById('resetWarp').addEventListener('click', function () {
  if (S.rect) { resetWarp(); fitView('R'); draw(); }
});
document.getElementById('aspect').addEventListener('change', function (e) {
  S.aspectMode = e.target.value;
  if (S.method !== 'guided' && S.pts.length === 4) { rebuildRect(false); fitView('R'); }
  draw();
});
document.getElementById('showGrid').addEventListener('change', function (e) {
  S.showGrid = e.target.checked; draw();
});

/* The two ways to define the correction are entirely separate: each keeps its
   own input, switching only rebuilds the result from the other one. */
function setMethod(m) {
  if (S.method === m) return;
  S.method = m;
  S.rect = null; S.warp = null; S.warpHandles = false;
  S.hDst = null; S.gInfo = null; S.est = null;
  document.querySelectorAll('#method button').forEach(function (b) {
    b.classList.toggle('on', b.dataset.method === m);
  });
  var guided = m === 'guided';
  document.getElementById('aspect').disabled = guided;
  document.getElementById('resetQuad').textContent = guided ? 'Reset lines' : 'Reset polygon';
  document.getElementById('titleL').innerHTML = guided
    ? 'Source &mdash; draw 2&ndash;4 guide lines'
    : 'Source &mdash; set 4 corner points';
  hintL.textContent = S.img
    ? (guided ? 'Drag along an edge that should be vertical or horizontal' : '')
    : 'Load an image or drop it here';
  refreshResult(true);
  draw();
}
document.querySelectorAll('#method button').forEach(function (b) {
  b.addEventListener('click', function () { setMethod(b.dataset.method); });
});

function setMode(m) {
  S.mode = m;
  document.querySelectorAll('#mode button').forEach(function (b) {
    b.classList.toggle('on', b.dataset.mode === m);
  });
  draw();
}
document.querySelectorAll('#mode button').forEach(function (b) {
  b.addEventListener('click', function () { setMode(b.dataset.mode); });
});

window.addEventListener('keydown', function (e) {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') { S.warpHandles = false; draw(); }
  if (e.key === 'm' || e.key === 'M') setMode(S.mode === 'scale' ? 'warp' : 'scale');
  if (e.key === 'g' || e.key === 'G') setMethod(S.method === 'quad' ? 'guided' : 'quad');
  if (S.method === 'guided' && (e.key === 'Backspace' || e.key === 'Delete') && S.lines.length) {
    e.preventDefault();
    S.lines.pop();
    refreshResult(true);
    draw();
  }
});

// ------------------------------------------------------------------ Export

document.getElementById('export').addEventListener('click', function () {
  if (!S.rect) return;
  if (S.rectDirty) rebuildRect(false);

  var k = parseFloat(document.getElementById('expScale').value) || 1;
  var bb = warpBBox();
  var W = Math.max(1, Math.round(bb.w * k)), H = Math.max(1, Math.round(bb.h * k));
  if (W > 12000 || H > 12000) { alert('Output too large (' + W + '×' + H + ').'); return; }

  var out = document.createElement('canvas');
  out.width = W; out.height = H;
  var ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(k, 0, 0, k, -bb.x * k, -bb.y * k);
  drawWarped(ctx, 64, 0.5 / k);

  out.toBlob(function (blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (S.name || 'anti-perspective') + '-AP.png';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }, 'image/png');
});

// ------------------------------------------------------------------ Start

window.addEventListener('resize', resize);
if (window.ResizeObserver) {
  var ro = new ResizeObserver(function () { resize(); });
  ro.observe(cvL); ro.observe(cvR);
}
resize();
draw();

})();
