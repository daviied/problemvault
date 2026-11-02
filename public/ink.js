// Ink engine from InkVault (shared/ink.js), extended with pasted images that sit
// under the ink. Rendering, erasing and scribble detection are unchanged.
// The Python server (server/render.py) mirrors radiusAt/alphaAt to rasterise
// pages for Claude.
//
// Drawing model (see docs/PROTOCOL.md):
//   drawing = { v: 1, id, width: 1000, height, strokes: [stroke], images: [image] }
//   image   = { id, z, x, y, w, h }  (pixels live at /api/ws/<ws>/img/<id>)
//   text    = { id, z, x, y, w, md, color, size, by? }  typed text, Markdown + $LaTeX$,
//             drawn as an HTML layer over the canvas (board.js). by: 'claude' when Claude wrote it.
//   stroke.by = 'claude' marks ink Claude drew (arrows, circles, ticks) with the draw tool.
//   stroke  = { id, z, tool: 'pen'|'pencil'|'highlighter', color: '#rrggbb', size, pts: [[x, y, pressure, tilt]] }
// Coordinates are logical page units; the page is always PAGE_WIDTH wide.
// pressure is 0..1, tilt is 0 (pen upright) .. 1 (pen flat on the surface).

export const PAGE_WIDTH = 1000;
export const DEFAULT_HEIGHT = 560;
export const PAPER = '#fbfaf6';
export const TOOLS = ['pen', 'pencil', 'highlighter'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

let uidCounter = 0;
export function uid() {
  uidCounter = (uidCounter + 1) % 1296;
  return Date.now().toString(36) + uidCounter.toString(36).padStart(2, '0') + Math.random().toString(36).slice(2, 6);
}

export function newDrawing(id = uid()) {
  return { v: 1, id, width: PAGE_WIDTH, height: DEFAULT_HEIGHT, strokes: [], images: [], texts: [] };
}

// ---------------------------------------------------------------------------
// Brush model
// ---------------------------------------------------------------------------

export function radiusAt(stroke, p) {
  const pr = p[2];
  const shade = smoothstep(0.3, 0.85, p[3] || 0);
  const s = stroke.size;
  switch (stroke.tool) {
    case 'pencil': // tilting a pencil lays the graphite on its side
      return (s * (0.3 + 0.7 * pr) * (1 + 3 * shade)) / 2;
    case 'highlighter':
      return (s * (0.85 + 0.3 * pr) * (1 + 0.8 * shade)) / 2;
    default:
      return Math.max(0.35, (s * (0.2 + 0.8 * Math.pow(pr, 0.85))) / 2);
  }
}

function alphaAt(stroke, pr, tilt) {
  if (stroke.tool === 'highlighter') return 0.32;
  if (stroke.tool === 'pencil') {
    const shade = smoothstep(0.3, 0.85, tilt || 0);
    const a = (0.35 + 0.6 * pr) * (1 - 0.6 * shade);
    return Math.round(clamp(a, 0.08, 0.95) * 12) / 12; // quantised so segments group
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Curve smoothing. Fast writing reports pen positions far apart; joining them
// with straight lines looks faceted. Instead each reported position is used
// as the control point of a quadratic curve running between the midpoints of
// its neighbours, which rounds every turn like a real pen stroke. Pressure and
// tilt follow the same curve.
// ---------------------------------------------------------------------------

function needsSmoothing(pts, maxGap) {
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]) > maxGap) return true;
  }
  return false;
}

// Returns a dense, smooth version of pts (no two points more than ~step apart).
export function smoothCurve(pts, step) {
  const n = pts.length;
  if (n < 2) return pts;
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2, ((a[3] || 0) + (b[3] || 0)) / 2];
  const out = [pts[0]];
  // quadratic Bezier a -> b with control c, appended without its first point
  const quad = (a, c, b) => {
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]) + Math.hypot(b[0] - c[0], b[1] - c[1]);
    const k = Math.max(1, Math.ceil(len / step));
    for (let j = 1; j <= k; j++) {
      const t = j / k, u = 1 - t, w0 = u * u, w1 = 2 * u * t, w2 = t * t;
      out.push([0, 1, 2, 3].map(d => w0 * (a[d] || 0) + w1 * (c[d] || 0) + w2 * (b[d] || 0)));
    }
  };
  if (n === 2) {
    quad(pts[0], mid(pts[0], pts[1]), pts[1]);
    return out;
  }
  quad(pts[0], pts[1], mid(pts[1], pts[2]));
  for (let i = 2; i < n - 1; i++) quad(mid(pts[i - 1], pts[i]), pts[i], mid(pts[i], pts[i + 1]));
  const m = mid(pts[n - 2], pts[n - 1]);
  quad(m, mid(m, pts[n - 1]), pts[n - 1]);
  return out;
}

// A stroke becomes groups of filled shapes (circles at each point plus a quad
// per segment), all wound the same way so a nonzero fill never double-darkens
// a translucent stroke where it overlaps itself.
function shapes(stroke) {
  const pts = needsSmoothing(stroke.pts, 3) ? smoothCurve(stroke.pts, 1.5) : stroke.pts;
  const groups = [];
  let cur = null;
  const push = (alpha, item) => {
    if (!cur || cur.alpha !== alpha) groups.push((cur = { alpha, items: [] }));
    cur.items.push(item);
  };
  if (!pts.length) return groups;
  if (stroke.dash === 'dot') {
    for (const p of dotPoints(pts, stroke)) push(alphaAt(stroke, p[2], p[3]), ['c', p[0], p[1], radiusAt(stroke, p)]);
    return groups;
  }
  for (const piece of stroke.dash === 'dash' ? dashPieces(pts, stroke) : [pts]) pushPiece(piece, stroke, push);
  return groups;
}

// One continuous run of ink: a circle at each point and a quad per segment.
function pushPiece(pts, stroke, push) {
  let r0 = radiusAt(stroke, pts[0]);
  if (pts.length === 1) {
    push(alphaAt(stroke, pts[0][2], pts[0][3]), ['c', pts[0][0], pts[0][1], r0]);
    return;
  }
  for (let i = 1; i < pts.length; i++) {
    const p0 = pts[i - 1];
    const p1 = pts[i];
    const r1 = radiusAt(stroke, p1);
    const a = alphaAt(stroke, (p0[2] + p1[2]) / 2, ((p0[3] || 0) + (p1[3] || 0)) / 2);
    if (i === 1) push(a, ['c', p0[0], p0[1], r0]);
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy);
    if (len > 1e-3) {
      const nx = -dy / len;
      const ny = dx / len;
      push(a, ['q',
        p0[0] + nx * r0, p0[1] + ny * r0,
        p0[0] - nx * r0, p0[1] - ny * r0,
        p1[0] - nx * r1, p1[1] - ny * r1,
        p1[0] + nx * r1, p1[1] + ny * r1]);
    }
    push(a, ['c', p1[0], p1[1], r1]);
    r0 = r1;
  }
}

// ---------------------------------------------------------------------------
// Dashed and dotted strokes: the pattern is measured along the line and scales
// with the pen size, so it stays even however fast or slow you draw.
// ---------------------------------------------------------------------------

export const DASHES = ['solid', 'dash', 'dot'];

const lerpPt = (a, b, t) => [0, 1, 2, 3].map(d => (a[d] || 0) + ((b[d] || 0) - (a[d] || 0)) * t);

// Walk along pts, calling visit(point, distanceSoFar) at every `step` of length.
function walk(pts, step, visit) {
  let next = 0;
  let dist = 0;
  visit(pts[0], 0);
  next += step;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (len > 0 && dist + len >= next) {
      visit(lerpPt(a, b, (next - dist) / len), next);
      next += step;
    }
    dist += len;
  }
}

function dotPoints(pts, stroke) {
  const out = [];
  walk(pts, Math.max(4, stroke.size * 2.6), p => out.push(p));
  return out;
}

function dashPieces(pts, stroke) {
  const on = Math.max(6, stroke.size * 4);
  const off = Math.max(5, stroke.size * 3) + stroke.size; // + size: round caps eat into the gap
  const pieces = [];
  let piece = [pts[0]];
  let dist = 0;
  let drawing = true;
  let boundary = on;
  for (let i = 1; i < pts.length; i++) {
    let a = pts[i - 1];
    const b = pts[i];
    let len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    while (len > 0 && dist + len >= boundary) {
      const p = lerpPt(a, b, (boundary - dist) / len);
      if (drawing) { piece.push(p); pieces.push(piece); }
      else piece = [p];
      len -= boundary - dist;
      dist = boundary;
      a = p;
      drawing = !drawing;
      boundary += drawing ? on : off;
    }
    dist += len;
    if (drawing) piece.push(b);
  }
  if (drawing && piece.length) pieces.push(piece);
  return pieces;
}

// ---------------------------------------------------------------------------
// Canvas rendering (browser only)
// ---------------------------------------------------------------------------

const pathCache = new WeakMap();

function strokePaths(stroke, cache) {
  if (cache && pathCache.has(stroke)) return pathCache.get(stroke);
  const out = shapes(stroke).map(g => {
    const p = new Path2D();
    for (const it of g.items) {
      if (it[0] === 'c') {
        p.moveTo(it[1] + it[3], it[2]);
        p.arc(it[1], it[2], it[3], 0, Math.PI * 2);
      } else {
        p.moveTo(it[1], it[2]);
        p.lineTo(it[3], it[4]);
        p.lineTo(it[5], it[6]);
        p.lineTo(it[7], it[8]);
        p.closePath();
      }
    }
    return { alpha: g.alpha, path: p };
  });
  if (cache) pathCache.set(stroke, out);
  return out;
}

let scratch = null;

// ---------------------------------------------------------------------------
// Dark canvas: a display option only. Strokes keep their stored colours; dark
// inks are shown light (same hue, mirrored lightness) so black ink becomes
// white on the dark page, like the dark mode of note apps.
// ---------------------------------------------------------------------------

export const PAPER_DARK = '#1b1b1e';
const darkCache = new Map();

export function inkColor(hex, dark) {
  if (!dark) return hex;
  let out = darkCache.get(hex);
  if (out) return out;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let l = (max + min) / 2;
  const lin = v => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  if (luminance >= 0.3) {
    out = hex; // already bright enough to read on dark paper
  } else {
    const d = max - min;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
    let h = 0;
    if (d) {
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    l = Math.max(1 - l * 0.9, 0.66); // black -> near white, dark blue -> light blue, ...
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const [r1, g1, b1] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    out = '#' + [r1, g1, b1].map(v => Math.round((v + m) * 255).toString(16).padStart(2, '0')).join('');
  }
  darkCache.set(hex, out);
  return out;
}

export function drawStroke(ctx, stroke, { cache = true, alphaScale = 1, dark = false } = {}) {
  const groups = strokePaths(stroke, cache);
  const color = stroke.color && inkColor(stroke.color, dark);
  if (dark && stroke.tool === 'highlighter') alphaScale *= 1.5; // translucent colour reads weaker on black
  if (groups.length > 1 && drawLayered(ctx, stroke, groups, alphaScale, color)) return;
  ctx.fillStyle = color;
  for (const g of groups) {
    ctx.globalAlpha = g.alpha * alphaScale;
    ctx.fill(g.path, 'nonzero');
  }
  ctx.globalAlpha = 1;
}

// Strokes whose opacity varies (pencil) are composed on a scratch canvas where
// each group first cuts out what it covers, so the joins between opacity levels
// don't stack into dark beads. Assumes ctx has no rotation.
function drawLayered(ctx, stroke, groups, alphaScale, color) {
  const m = ctx.getTransform();
  const k = Math.hypot(m.a, m.b);
  const b = ptsBBox(stroke.pts); // not cached: live strokes are still growing
  const pad = stroke.size * 4 + 2;
  const x0 = b.minX - pad, y0 = b.minY - pad;
  const w = Math.ceil((b.maxX - b.minX + 2 * pad) * k);
  const h = Math.ceil((b.maxY - b.minY + 2 * pad) * k);
  if (!w || !h || w * h > 16e6 || typeof document === 'undefined') return false;
  scratch ||= document.createElement('canvas');
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  const o = scratch.getContext('2d');
  o.setTransform(1, 0, 0, 1, 0, 0);
  o.clearRect(0, 0, w, h);
  o.setTransform(k, 0, 0, k, -x0 * k, -y0 * k);
  o.fillStyle = color;
  for (const g of groups) {
    o.globalCompositeOperation = 'destination-out';
    o.globalAlpha = 1;
    o.fill(g.path, 'nonzero');
    o.globalCompositeOperation = 'source-over';
    o.globalAlpha = g.alpha;
    o.fill(g.path, 'nonzero');
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = alphaScale;
  ctx.drawImage(scratch, 0, 0, w, h, m.a * x0 + m.c * y0 + m.e, m.b * x0 + m.d * y0 + m.f, w, h);
  ctx.restore();
  return true;
}

// Highlighter sits under the ink, like a real highlighter on a printed page.
const inkOrder = strokes => [...strokes.filter(s => s.tool === 'highlighter'), ...strokes.filter(s => s.tool !== 'highlighter')];

// Draw a whole drawing into ctx, which must already be transformed into page units.
// `skip`: ids of strokes not to draw (e.g. ones being dragged, drawn on another layer)
// `bitmaps`: Map image id -> loaded HTMLImageElement / ImageBitmap
export function drawPage(ctx, drawing, { live = [], dark = false, skip = null, bitmaps = null } = {}) {
  ctx.fillStyle = dark ? PAPER_DARK : PAPER;
  ctx.fillRect(0, 0, drawing.width, drawing.height);
  for (const im of drawing.images || []) {
    if (skip && skip.has(im.id)) continue;
    const bm = bitmaps && bitmaps.get(im.id);
    if (bm) ctx.drawImage(bm, im.x, im.y, im.w, im.h);
    else { ctx.fillStyle = dark ? '#2a2a30' : '#ecebe6'; ctx.fillRect(im.x, im.y, im.w, im.h); }
  }
  for (const s of inkOrder(drawing.strokes)) if (!skip || !skip.has(s.id)) drawStroke(ctx, s, { dark });
  for (const s of live) drawStroke(ctx, s, { cache: false, dark });
}

// ---------------------------------------------------------------------------
// SVG export / import (the SVG file embeds the raw data, so it is both the
// storage format and an image that Obsidian or a browser can display)
// ---------------------------------------------------------------------------

const xmlEsc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function toSVG(d) {
  const f = n => Math.round(n * 10) / 10;
  let body = '';
  for (const s of inkOrder(d.strokes)) {
    const groups = shapes(s);
    // varying-opacity strokes are flattened onto the paper colour so their joins don't bead
    const flatten = groups.length > 1;
    for (const g of groups) {
      let path = '';
      for (const it of g.items) {
        if (it[0] === 'c') {
          const [, x, y, r] = it;
          path += `M${f(x + r)} ${f(y)}A${f(r)} ${f(r)} 0 1 1 ${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 1 ${f(x + r)} ${f(y)}Z`;
        } else {
          path += `M${f(it[1])} ${f(it[2])}L${f(it[3])} ${f(it[4])}L${f(it[5])} ${f(it[6])}L${f(it[7])} ${f(it[8])}Z`;
        }
      }
      if (flatten) body += `<path d="${path}" fill="${mixHex(s.color, PAPER, g.alpha)}"/>\n`;
      else body += `<path d="${path}" fill="${s.color}"${g.alpha < 1 ? ` fill-opacity="${Math.round(g.alpha * 1000) / 1000}"` : ''}/>\n`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${d.width} ${d.height}" width="${d.width}" height="${d.height}">
<metadata id="inkvault-data">${xmlEsc(JSON.stringify(d))}</metadata>
<rect width="${d.width}" height="${d.height}" fill="${PAPER}"/>
${body}</svg>
`;
}

function mixHex(fg, bg, a) {
  const c = (h, i) => parseInt(h.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2].map(i => Math.round(c(fg, i) * a + c(bg, i) * (1 - a)).toString(16).padStart(2, '0')).join('');
}

export function fromSVG(text) {
  const m = /<metadata id="inkvault-data">([\s\S]*?)<\/metadata>/.exec(text);
  if (!m) return null;
  return sanitizeDrawing(JSON.parse(xmlUnesc(m[1])));
}

// ---------------------------------------------------------------------------
// Validation and change application (a "change" is the only mutation)
//   change = { remove?: [strokeId], add?: [stroke], height?: number }
// ---------------------------------------------------------------------------

const num = (v, a, b, dflt) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, a, b) : dflt);
const ID_RE = /^[a-z0-9]{1,40}$/i;

export function sanitizeStroke(s) {
  if (!s || typeof s !== 'object' || !ID_RE.test(s.id) || !Array.isArray(s.pts)) return null;
  const pts = [];
  for (const p of s.pts.slice(0, 20000)) {
    if (!Array.isArray(p)) continue;
    const x = num(p[0], -1e5, 1e5, NaN);
    const y = num(p[1], -1e5, 1e5, NaN);
    if (Number.isNaN(x) || Number.isNaN(y)) continue;
    pts.push([x, y, num(p[2], 0, 1, 0.5), num(p[3], 0, 1, 0)]);
  }
  if (!pts.length) return null;
  const out = {
    id: s.id,
    z: num(s.z, 0, Number.MAX_SAFE_INTEGER, Date.now()),
    tool: TOOLS.includes(s.tool) ? s.tool : 'pen',
    color: /^#[0-9a-f]{6}$/i.test(s.color) ? s.color : '#1f1f1f',
    size: num(s.size, 0.3, 200, 3),
    pts,
  };
  if (s.dash === 'dash' || s.dash === 'dot') out.dash = s.dash; // absent = solid
  return out;
}

export function sanitizeChange(c) {
  if (!c || typeof c !== 'object') return null;
  const out = {};
  if (Array.isArray(c.remove)) out.remove = c.remove.filter(id => typeof id === 'string' && ID_RE.test(id));
  if (Array.isArray(c.add)) out.add = c.add.map(sanitizeStroke).filter(Boolean);
  if (c.height !== undefined) out.height = num(c.height, 100, 40000, undefined);
  return out;
}

export function sanitizeDrawing(d) {
  if (!d || !ID_RE.test(d.id)) return null;
  return {
    v: 1,
    id: d.id,
    width: PAGE_WIDTH,
    height: num(d.height, 100, 40000, DEFAULT_HEIGHT),
    strokes: (Array.isArray(d.strokes) ? d.strokes : []).map(sanitizeStroke).filter(Boolean).sort((a, b) => a.z - b.z),
  };
}

export function applyChange(d, c) {
  if (c.remove?.length) {
    const rm = new Set(c.remove);
    d.strokes = d.strokes.filter(s => !rm.has(s.id));
  }
  if (c.add?.length) {
    const ids = new Set(c.add.map(s => s.id));
    d.strokes = d.strokes.filter(s => !ids.has(s.id)).concat(c.add);
    d.strokes.sort((a, b) => a.z - b.z);
  }
  if (c.imgRemove?.length || c.imgAdd?.length) {
    const rm = new Set([...(c.imgRemove || []), ...(c.imgAdd || []).map(i => i.id)]);
    d.images = (d.images || []).filter(i => !rm.has(i.id)).concat(c.imgAdd || []);
    d.images.sort((a, b) => a.z - b.z);
  }
  if (c.textRemove?.length || c.textAdd?.length) {
    const rm = new Set([...(c.textRemove || []), ...(c.textAdd || []).map(t => t.id)]);
    d.texts = (d.texts || []).filter(t => !rm.has(t.id)).concat(c.textAdd || []);
    d.texts.sort((a, b) => a.z - b.z);
  }
  if (typeof c.height === 'number') d.height = c.height;
  return d;
}

// The change that undoes `c` when applied to `d` (call before applying c).
export function inverseOf(d, c) {
  const byId = new Map(d.strokes.map(s => [s.id, s]));
  const inv = {
    remove: (c.add || []).map(s => s.id),
    add: (c.remove || []).map(id => byId.get(id)).filter(Boolean),
  };
  // strokes that `c.add` overwrites must come back too
  for (const s of c.add || []) if (byId.has(s.id)) inv.add.push(byId.get(s.id));
  if (c.imgAdd?.length || c.imgRemove?.length) {
    const imgs = new Map((d.images || []).map(i => [i.id, i]));
    inv.imgRemove = (c.imgAdd || []).map(i => i.id).filter(id => !imgs.has(id));
    inv.imgAdd = [...(c.imgRemove || []), ...(c.imgAdd || []).map(i => i.id)].map(id => imgs.get(id)).filter(Boolean);
  }
  if (c.textAdd?.length || c.textRemove?.length) {
    const texts = new Map((d.texts || []).map(t => [t.id, t]));
    inv.textRemove = (c.textAdd || []).map(t => t.id).filter(id => !texts.has(id));
    inv.textAdd = [...(c.textRemove || []), ...(c.textAdd || []).map(t => t.id)].map(id => texts.get(id)).filter(Boolean);
  }
  if (typeof c.height === 'number') inv.height = d.height;
  return inv;
}

// ---------------------------------------------------------------------------
// Geometry helpers for input post-processing and erasing
// ---------------------------------------------------------------------------

// Light smoothing plus densification (max spacing `step`) so erasers can work point-wise.
// Light de-jitter, then fill gaps along a smooth curve (max spacing `step`)
// so the stored stroke is smooth everywhere and erasers can work point-wise.
export function finishPoints(raw, step = 2) {
  let pts = raw;
  if (pts.length > 2) {
    const close = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < 6;
    pts = pts.map((p, i) => {
      if (i === 0 || i === raw.length - 1) return p;
      const a = raw[i - 1];
      const b = raw[i + 1];
      // only average dense points (jitter); averaging sparse fast points would flatten real curves
      if (!close(a, p) || !close(p, b)) return p;
      return [(a[0] + 2 * p[0] + b[0]) / 4, (a[1] + 2 * p[1] + b[1]) / 4, p[2], p[3]];
    });
  }
  return smoothCurve(pts, step).map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10, Math.round(p[2] * 100) / 100, Math.round(p[3] * 100) / 100]);
}

function ptsBBox(pts) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const p of pts) {
    if (p[0] < b.minX) b.minX = p[0];
    if (p[1] < b.minY) b.minY = p[1];
    if (p[0] > b.maxX) b.maxX = p[0];
    if (p[1] > b.maxY) b.maxY = p[1];
  }
  return b;
}

const bboxCache = new WeakMap();
export function strokeBBox(s) {
  let b = bboxCache.get(s);
  if (!b) {
    b = ptsBBox(s.pts);
    b.r = s.size * 2;
    bboxCache.set(s, b);
  }
  return b;
}

function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function nearBox(s, ax, ay, bx, by, pad) {
  const b = strokeBBox(s);
  const p = pad + b.r;
  return !(Math.max(ax, bx) < b.minX - p || Math.min(ax, bx) > b.maxX + p || Math.max(ay, by) < b.minY - p || Math.min(ay, by) > b.maxY + p);
}

function splitByMask(s, keep) {
  const pieces = [];
  let run = [];
  for (let i = 0; i < s.pts.length; i++) {
    if (keep[i]) run.push(s.pts[i]);
    else {
      if (run.length > 1) pieces.push(run);
      run = [];
    }
  }
  if (run.length > 1) pieces.push(run);
  return pieces.map(pts => ({ ...s, id: uid(), pts }));
}

// Eraser that moved from (ax,ay) to (bx,by) with radius rad.
// mode 'stroke' deletes whole strokes; 'precise' cuts away only what it touches.
export function eraseAlong(strokes, ax, ay, bx, by, rad, mode) {
  const change = { remove: [], add: [] };
  for (const s of strokes) {
    if (!nearBox(s, ax, ay, bx, by, rad)) continue;
    const keep = s.pts.map(p => distToSeg(p[0], p[1], ax, ay, bx, by) > rad + radiusAt(s, p) * 0.5);
    if (keep.every(Boolean)) continue;
    change.remove.push(s.id);
    if (mode === 'precise') change.add.push(...splitByMask(s, keep));
  }
  return change.remove.length ? change : null;
}

// ---------------------------------------------------------------------------
// Scribble-to-erase
// ---------------------------------------------------------------------------

function resample(pts, step) {
  const out = [[pts[0][0], pts[0][1]]];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    let [ax, ay] = pts[i - 1];
    const bx = pts[i][0];
    const by = pts[i][1];
    let seg = Math.hypot(bx - ax, by - ay);
    while (carry + seg >= step) {
      const t = (step - carry) / seg;
      ax += (bx - ax) * t;
      ay += (by - ay) * t;
      out.push([ax, ay]);
      seg = Math.hypot(bx - ax, by - ay);
      carry = 0;
    }
    carry += seg;
  }
  return out;
}

function convexHull(points) {
  const p = points.map(q => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

function insideHull(hull, x, y, pad) {
  // hull is counter-clockwise in math orientation from the monotone chain
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const len = Math.hypot(ex, ey) || 1;
    if ((ex * (y - a[1]) - ey * (x - a[0])) / len < -pad) return false;
  }
  return true;
}

// If `pts` (a just-finished pen stroke) is a scribble over existing ink, return
// the change that erases what it covers; otherwise null (keep it as ink).
export function detectScribble(pts, strokes) {
  if (pts.length < 10) return null;
  const { minX, minY, maxX, maxY } = ptsBBox(pts);
  const diag = Math.hypot(maxX - minX, maxY - minY);
  if (diag < 15) return null;
  const step = Math.max(2, diag / 45);
  const rs = resample(pts, step);
  if (rs.length < 8) return null;
  const len = (rs.length - 1) * step;
  if (len < diag * 2.8) return null;

  // count sharp direction reversals
  const k = 2;
  let turns = 0;
  for (let i = k; i < rs.length - k; i++) {
    const ax = rs[i][0] - rs[i - k][0], ay = rs[i][1] - rs[i - k][1];
    const bx = rs[i + k][0] - rs[i][0], by = rs[i + k][1] - rs[i][1];
    const c = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    if (c < -0.55) {
      turns++;
      i += k;
    }
  }
  if (turns < 4) return null;

  const hull = convexHull(rs);
  const change = { remove: [], add: [] };
  for (const s of strokes) {
    const b = strokeBBox(s);
    if (b.maxX < minX - 4 || b.minX > maxX + 4 || b.maxY < minY - 4 || b.minY > maxY + 4) continue;
    const inside = s.pts.map(p => insideHull(hull, p[0], p[1], 3));
    const frac = inside.filter(Boolean).length / s.pts.length;
    if (frac === 0) continue;
    if (frac >= 0.6) {
      change.remove.push(s.id);
      continue;
    }
    // partially covered: only cut it if the scribble actually crosses it repeatedly
    let runs = 0;
    let near = false;
    for (let i = 1; i < rs.length; i++) {
      const [ax, ay] = rs[i - 1];
      const [bx, by] = rs[i];
      let hit = false;
      if (nearBox(s, ax, ay, bx, by, 4)) {
        for (const p of s.pts) {
          if (distToSeg(p[0], p[1], ax, ay, bx, by) < radiusAt(s, p) + 3) { hit = true; break; }
        }
      }
      if (hit && !near) runs++;
      near = hit;
    }
    if (runs >= 2) {
      change.remove.push(s.id);
      change.add.push(...splitByMask(s, inside.map(v => !v)));
    }
  }
  return change.remove.length ? change : null;
}
