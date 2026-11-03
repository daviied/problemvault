// The drawing board: InkVault's tablet client (web/tablet/main.js) adapted to
// live inside a workspace. Same pen engine and tools (pen / pencil /
// highlighter, pressure + tilt, colours, sizes, dashes, scribble-to-erase,
// stroke / precise eraser, pen eraser end, lasso with move / copy / cut /
// duplicate / delete / paste, undo / redo, two-finger pan + zoom, palm
// rejection, black canvas, growing page), plus images under the ink: paste,
// drop or upload a picture of a circuit or equation and write on top of it,
// and typed text (yours or Claude's) with $LaTeX$ on an HTML layer above it.
import {
  PAGE_WIDTH, PAPER_DARK, drawPage, drawStroke, inkColor, applyChange, inverseOf, finishPoints,
  eraseAlong, detectScribble, uid, strokeBBox,
} from './ink.js';

const PALETTES = {
  pen: ['#1f1f1f', '#2457d6', '#d63b2f', '#1f8a4c', '#e07b00', '#7b3fd1', '#8a5a2b'],
  pencil: ['#2b2b2b', '#3d5a80', '#9b2c2c', '#2f6b45', '#6b4f2b'],
  highlighter: ['#ffd60a', '#6ee77a', '#ff7ccf', '#62d0ff', '#ffa94d'],
};
const SIZES = { pen: [1.6, 3, 5.5], pencil: [2, 4, 8], highlighter: [14, 24, 38], eraser: [12, 28, 60] };
const PEN_GRACE_MS = 600; // ignore touches this long after the pen was last seen
const PRESSURE_EASE = 0.35; // 1 = raw pen pressure, lower = steadier line width
const IMG_MAX_SIDE = 2400; // stored image size cap (pixels)
const RGB_MAX_SIDE = 1600; // copy the server renders for Claude

// ---------------------------------------------------------------------------
// Settings (per device)
// ---------------------------------------------------------------------------

const settings = Object.assign({
  tool: 'pen',
  pen: { color: PALETTES.pen[0], size: 1 },
  pencil: { color: PALETTES.pencil[0], size: 1 },
  highlighter: { color: PALETTES.highlighter[0], size: 1 },
  eraser: { size: 1, mode: 'stroke' },
  scribble: true,
  darkPaper: false,
  fingerDraws: false,
}, load());
function load() {
  try { return JSON.parse(localStorage.getItem('problemvault.board') || '{}'); } catch { return {}; }
}
function save() {
  // a tool forced by setTools (desktop) is not remembered, so /tablet in the same browser keeps its own
  try { localStorage.setItem('problemvault.board', JSON.stringify({ ...settings, tool: chosenTool })); } catch {}
}
let chosenTool = settings.tool;
let allowedTools = null; // null = every tool

// Limit the toolbar (the desktop app only selects, moves and adds images).
let imagesOnly = false; // desktop: the lasso picks only images, and a click on an image grabs it
export function setTools(list, opts = {}) {
  allowedTools = list;
  imagesOnly = !!opts.imagesOnly;
  document.querySelectorAll('[data-tool]').forEach(b => { b.hidden = !list.includes(b.dataset.tool); });
  if (!list.includes(settings.tool)) settings.tool = list[0];
  renderToolbar();
}
const toolAllowed = t => !allowedTools || allowedTools.includes(t);

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = s => document.querySelector(s);
const stage = $('#stage');
const baseCv = $('#base');
const liveCv = $('#live');
const baseCtx = baseCv.getContext('2d');
const liveCtx = liveCv.getContext('2d');

let api = null; // { change(id, change), live(id, sid, stroke), uploadImage(id, payload), imageUrl(id, imgId), renderText(md), toast(text, ms) }
let current = null; // { id, drawing, undo: [], redo: [] }
let view = { scale: 1, ox: 0, oy: 0 };
let dpr = 1;
let stageRect = stage.getBoundingClientRect();
const bitmaps = new Map(); // image id -> HTMLImageElement (loaded)
const remoteLive = new Map(); // strokes being drawn on another device

export function init(callbacks) {
  api = callbacks;
  renderToolbar();
  updateUndoButtons();
  resize();
  requestAnimationFrame(frame);
}

export function open(id, drawing) {
  const same = current && current.id === id;
  if (!same) { cancelInput(); setSelection(null); remoteLive.clear(); }
  current = same ? Object.assign(current, { drawing }) : { id, drawing, undo: [], redo: [] };
  current.drawing.images ||= [];
  current.drawing.texts ||= [];
  loadBitmaps();
  resize();
  if (!same) fitWidth();
  updateUndoButtons();
  dirty.base = dirty.live = true;
}

export function close() {
  cancelInput();
  setSelection(null);
  current = null;
  dirty.base = dirty.live = true;
}

export function remoteChange(change) {
  if (!current) return;
  applyChange(current.drawing, change);
  loadBitmaps();
  refreshSelection();
  dirty.base = true;
}

export function remoteStroke(sid, stroke) {
  if (stroke) remoteLive.set(sid, stroke);
  else remoteLive.delete(sid);
  dirty.live = true;
}

// re-render typed text (e.g. once KaTeX has loaded)
export function refreshTexts() {
  for (const c of textCache.values()) c.md = null;
  dirty.base = true;
}

// Read-only (the phone app): drag pans, two fingers zoom, nothing draws.
let readOnly = false;
let pan = null; // { id, x, y, ox, oy }
export function setReadOnly(v) {
  readOnly = v;
  cancelInput();
  setSelection(null);
  stage.classList.toggle('readonly', v);
}

export function relayout() {
  resize();
  clampView();
}

export function toolsHelp() {
  return 'Pen, mouse or finger (if enabled) draws. Two fingers pan & zoom; Ctrl+wheel zooms. Paste (Ctrl+V), drop or upload images, then write on top.';
}

function loadBitmaps() {
  for (const im of current.drawing.images) {
    if (bitmaps.has(im.id)) continue;
    const el = new Image();
    el.decoding = 'async';
    el.onload = () => { dirty.base = dirty.live = true; };
    el.src = api.imageUrl(current.id, im.id);
    bitmaps.set(im.id, el);
  }
}
const readyBitmaps = () => new Map([...bitmaps].filter(([, el]) => el.complete && el.naturalWidth));

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const dirty = { base: false, live: false };
let flash = null; // strokes just erased by a scribble, faded out on the live layer

function resize() {
  dpr = window.devicePixelRatio || 1;
  stageRect = stage.getBoundingClientRect();
  for (const cv of [baseCv, liveCv]) {
    cv.width = Math.max(1, Math.round(stageRect.width * dpr));
    cv.height = Math.max(1, Math.round(stageRect.height * dpr));
  }
  dirty.base = dirty.live = true;
}

function fitWidth() {
  const margin = stageRect.width > 700 ? 24 : 10;
  view.scale = clamp((stageRect.width - margin * 2) / PAGE_WIDTH, 0.1, 1.6); // a hidden stage has width 0
  view.ox = (stageRect.width - PAGE_WIDTH * view.scale) / 2;
  view.oy = margin;
  dirty.base = dirty.live = true;
}

function clampView() {
  if (!current) return;
  const w = PAGE_WIDTH * view.scale;
  const h = current.drawing.height * view.scale;
  const W = stageRect.width, H = stageRect.height, m = 60;
  view.ox = w + 2 * m < W ? (W - w) / 2 : Math.min(m, Math.max(W - w - m, view.ox));
  view.oy = Math.min(m, Math.max(Math.min(m, H - h - m), view.oy));
}

function applyView(ctx) {
  ctx.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.ox, dpr * view.oy);
}

function renderBase() {
  const ctx = baseCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, baseCv.width, baseCv.height);
  if (!current) { renderTexts(); return; }
  const d = current.drawing;
  applyView(ctx);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,.35)';
  ctx.shadowBlur = 18 / view.scale;
  ctx.fillStyle = settings.darkPaper ? PAPER_DARK : '#fff';
  ctx.fillRect(0, 0, d.width, d.height);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, d.width, d.height);
  ctx.clip();
  // strokes / images being dragged are drawn on the live layer instead
  const skip = input?.kind === 'move' || input?.kind === 'resize' ? new Set([...selection.ids, ...selection.imgs]) : null;
  drawPage(ctx, d, { dark: settings.darkPaper, skip, bitmaps: readyBitmaps() });
  ctx.restore();
  renderTexts();
  if (settings.darkPaper) {
    ctx.strokeStyle = 'rgba(255,255,255,.12)';
    ctx.lineWidth = 1 / view.scale;
    ctx.strokeRect(0, 0, d.width, d.height);
  }
}

// Typed text lives in DOM elements inside #texts, which is scaled like the page,
// so element sizes and positions are in page units.
const textsEl = $('#texts');
const textCache = new Map(); // text id -> { el, md }

function renderTexts() {
  const list = current?.drawing.texts || [];
  textsEl.style.transform = `translate(${view.ox}px, ${view.oy}px) scale(${view.scale})`;
  const seen = new Set();
  for (const t of list) {
    seen.add(t.id);
    let c = textCache.get(t.id);
    if (!c) {
      c = { el: document.createElement('div'), md: null };
      textsEl.appendChild(c.el);
      textCache.set(t.id, c);
    }
    if (c.md !== t.md) { c.el.innerHTML = api.renderText(t.md); c.md = t.md; }
    c.el.className = 'txt' + (t.by === 'claude' ? ' claude' : '');
    Object.assign(c.el.style, { left: `${t.x}px`, top: `${t.y}px`, width: `${t.w}px`, fontSize: `${t.size}px`, color: inkColor(t.color, settings.darkPaper) });
  }
  for (const [id, c] of textCache) if (!seen.has(id)) { c.el.remove(); textCache.delete(id); }
}

function textBox(t) {
  const el = textCache.get(t.id)?.el;
  return { minX: t.x, minY: t.y, maxX: t.x + (el?.offsetWidth || t.w), maxY: t.y + (el?.offsetHeight || t.size * 1.5) };
}

function textAt(x, y) {
  const ts = current.drawing.texts;
  for (let k = ts.length - 1; k >= 0; k--) {
    const b = textBox(ts[k]);
    if (x >= b.minX && x <= b.maxX && y >= b.minY && y <= b.maxY) return ts[k];
  }
  return null;
}

// Text tool: tap empty paper to type, tap text to edit it. $…$ / $$…$$ for math.
function typeText(p) {
  const hit = textAt(p[0], p[1]);
  setTimeout(() => { // after the pointer events, so the dialog doesn't swallow them
    if (hit) return editText(hit);
    const md = prompt('Type text (use $…$ for math, e.g. $V_{th} = 7.2\\,V$):');
    if (!md?.trim() || !current) return;
    const t = { id: uid(), z: Date.now() * 1000, x: Math.round(p[0]), y: Math.round(p[1] - 14), w: Math.max(160, Math.round(PAGE_WIDTH - p[0] - 20)), md: md.trim(), color: settings.pen.color, size: 22 };
    commit({ textAdd: [t] });
  });
}

function editText(t) {
  const md = prompt('Edit text:', t.md);
  if (md === null || !current) return;
  if (!md.trim()) commit({ textRemove: [t.id] });
  else commit({ textAdd: [{ ...t, md: md.trim() }] });
}

function renderLive() {
  const ctx = liveCtx;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, liveCv.width, liveCv.height);
  if (!current) return;
  applyView(ctx);
  if (flash) {
    const t = (performance.now() - flash.start) / 350;
    if (t >= 1) flash = null;
    else {
      for (const s of flash.strokes) drawStroke(ctx, { ...s, color: '#ff4d4d' }, { cache: false, alphaScale: 1 - t });
      dirty.live = true;
    }
  }
  for (const s of remoteLive.values()) drawStroke(ctx, s, { cache: false, dark: settings.darkPaper });
  if (input && input.kind === 'draw') {
    const s = input.predicted?.length ? { ...input.stroke, pts: input.stroke.pts.concat(input.predicted) } : input.stroke;
    drawStroke(ctx, s, { cache: false, dark: settings.darkPaper });
  }
  renderSelection(ctx);
  const cursor = input && input.kind === 'erase' ? input.last : settings.tool === 'lasso' && !hover?.eraser ? null : hover;
  if (cursor) {
    const erasing = (input && input.kind === 'erase') || hover?.eraser;
    ctx.lineWidth = 1.2 / view.scale;
    ctx.beginPath();
    if (erasing) {
      ctx.strokeStyle = settings.darkPaper ? 'rgba(255,255,255,.6)' : 'rgba(0,0,0,.5)';
      ctx.arc(cursor[0], cursor[1], eraserRadius(), 0, Math.PI * 2);
      ctx.stroke();
    } else {
      const t = settings[settings.tool] || settings.pen;
      ctx.fillStyle = inkColor(t.color || '#000000', settings.darkPaper);
      ctx.globalAlpha = 0.6;
      ctx.arc(cursor[0], cursor[1], Math.max(1.5, (SIZES[settings.tool]?.[t.size] || 3) / 2), 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
}

function frame() {
  requestAnimationFrame(frame); // first, so one bad frame can never stop rendering for good
  try {
    if (dirty.base) { dirty.base = false; renderBase(); }
    if (dirty.live) { dirty.live = false; renderLive(); }
  } catch (err) {
    reportError(err);
  }
}

let lastError = '';
function reportError(err) {
  const msg = `Error: ${err?.message || err}`;
  console.error(err);
  if (msg === lastError) return;
  lastError = msg;
  api?.toast(msg, 6000);
}

new ResizeObserver(() => {
  const wasFit = current && Math.abs(view.scale - Math.min((stageRect.width - (stageRect.width > 700 ? 48 : 20)) / PAGE_WIDTH, 1.6)) < 1e-3;
  resize();
  if (wasFit) fitWidth();
  clampView();
}).observe(stage);

// ---------------------------------------------------------------------------
// Changes + undo/redo
// ---------------------------------------------------------------------------

function commit(change, { record = true, inverse = null } = {}) {
  if (!current) return;
  const inv = inverse || inverseOf(current.drawing, change);
  applyChange(current.drawing, change);
  api.change(current.id, change);
  if (record) {
    current.undo.push({ change, inv });
    if (current.undo.length > 200) current.undo.shift();
    current.redo = [];
  }
  refreshSelection();
  dirty.base = true;
  updateUndoButtons();
}

export function undo() {
  if (input) return; // not in the middle of a stroke / drag
  const e = current?.undo.pop();
  if (!e) return;
  commit(e.inv, { record: false });
  current.redo.push(e);
  updateUndoButtons();
}
export function redo() {
  const e = current?.redo.pop();
  if (!e) return;
  commit(e.change, { record: false });
  current.undo.push(e);
  updateUndoButtons();
}
function updateUndoButtons() {
  $('#undo').disabled = !current?.undo.length;
  $('#redo').disabled = !current?.redo.length;
}

// ---------------------------------------------------------------------------
// Pen input
// ---------------------------------------------------------------------------

let input = null; // { kind: 'draw'|'erase'|'lasso'|'move'|'resize', pointerId, ... }
let hover = null;
let lastPenSeen = 0;
let liveTimer = 0;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const eraserRadius = () => SIZES.eraser[settings.eraser.size] / 2;

function tiltOf(e) {
  if (e.pointerType !== 'pen') return 0;
  if (e.tiltX || e.tiltY) {
    const tx = Math.tan((e.tiltX * Math.PI) / 180);
    const ty = Math.tan((e.tiltY * Math.PI) / 180);
    return clamp(1 - Math.atan(1 / Math.hypot(tx, ty)) / (Math.PI / 2), 0, 1);
  }
  if (typeof e.altitudeAngle === 'number') return clamp(1 - e.altitudeAngle / (Math.PI / 2), 0, 1);
  return 0;
}

function pagePoint(e) {
  const pressure = e.pointerType === 'pen' ? Math.max(0.02, e.pressure || 0) : 0.5;
  return [
    (e.clientX - stageRect.left - view.ox) / view.scale,
    (e.clientY - stageRect.top - view.oy) / view.scale,
    pressure,
    tiltOf(e),
  ];
}

const isPenEraser = e => e.pointerType === 'pen' && ((e.buttons & 32) || e.button === 5 || (e.buttons & 2));

function onPenDown(e) {
  if (!current || input) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (e.pointerType === 'pen') lastPenSeen = performance.now();
  endGesture();
  stageRect = stage.getBoundingClientRect();
  try { stage.setPointerCapture(e.pointerId); } catch {}
  const p = pagePoint(e);
  hover = null;
  if (settings.tool === 'text' && !isPenEraser(e)) {
    typeText(p);
    return;
  }
  if (settings.tool === 'eraser' || (isPenEraser(e) && toolAllowed('eraser'))) {
    input = { kind: 'erase', pointerId: e.pointerId, last: p, removed: new Map(), added: new Map() };
    eraseTo(p);
  } else if (settings.tool === 'lasso') {
    // the resize handle of a single selected image; inside the selection: drag it; else a new lasso
    const b = selection && selectionBox();
    const handle = selection && selection.imgs.size === 1 && !selection.ids.size && !selection.texts.size && b
      && Math.hypot(p[0] - b.maxX, p[1] - b.maxY) < 16 / view.scale;
    if (handle) {
      const im = current.drawing.images.find(i => selection.imgs.has(i.id));
      input = { kind: 'resize', pointerId: e.pointerId, start: p, im, k: 1 };
      dirty.base = true;
    } else if (b && p[0] >= b.minX && p[0] <= b.maxX && p[1] >= b.minY && p[1] <= b.maxY) {
      input = { kind: 'move', pointerId: e.pointerId, start: p, dx: 0, dy: 0 };
      dirty.base = true; // take the selection off the base layer while it moves
    } else if (imagesOnly && imageAt(p[0], p[1])) {
      setSelection(null, new Set([imageAt(p[0], p[1]).id]));
      input = { kind: 'move', pointerId: e.pointerId, start: p, dx: 0, dy: 0 };
      dirty.base = true;
    } else {
      setSelection(null);
      input = { kind: 'lasso', pointerId: e.pointerId, pts: [p] };
    }
  } else {
    const t = settings[settings.tool];
    input = {
      kind: 'draw',
      pointerId: e.pointerId,
      stroke: { id: uid(), z: Date.now() * 1000 + Math.floor(Math.random() * 1000), tool: settings.tool, color: t.color, size: SIZES[settings.tool][t.size], pts: [p] },
    };
    if (t.dash && t.dash !== 'solid') input.stroke.dash = t.dash;
  }
  dirty.live = true;
}

function onPenMove(e) {
  if (e.pointerType === 'pen') lastPenSeen = performance.now();
  if (!input || e.pointerId !== input.pointerId) {
    if (!input && e.pointerType !== 'touch' && current) {
      stageRect = stage.getBoundingClientRect();
      hover = Object.assign(pagePoint(e), { eraser: settings.tool === 'eraser' || (isPenEraser(e) && toolAllowed('eraser')) });
      if (imagesOnly) stage.classList.toggle('over-img', !!imageAt(hover[0], hover[1]));
      dirty.live = true;
    }
    return;
  }
  // Coalesced events carry every pen sample since the last frame (full pen rate).
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of events.length ? events : [e]) {
    const p = pagePoint(ev);
    if (input.kind === 'erase') eraseTo(p);
    else if (input.kind === 'lasso') input.pts.push(p);
    else if (input.kind === 'move') {
      input.dx = p[0] - input.start[0];
      input.dy = p[1] - input.start[1];
    } else if (input.kind === 'resize') {
      const im = input.im;
      input.k = Math.max(40 / im.w, (p[0] - im.x) / im.w); // keeps the aspect ratio
    } else {
      const pts = input.stroke.pts;
      const q = pts[pts.length - 1];
      // pen pressure is noisy; ease it so the line edge doesn't wobble
      p[2] = q[2] + (p[2] - q[2]) * PRESSURE_EASE;
      if (Math.hypot(p[0] - q[0], p[1] - q[1]) * view.scale >= 0.75) pts.push(p);
      else q[2] = Math.max(q[2], p[2]);
    }
  }
  if (input.kind === 'draw') {
    // Where the pen is about to be: drawn ahead of time to hide latency, never saved.
    const predicted = e.getPredictedEvents ? e.getPredictedEvents() : [];
    input.predicted = predicted.slice(0, 3).map(ev => {
      const p = pagePoint(ev);
      p[2] = input.stroke.pts[input.stroke.pts.length - 1][2];
      return p;
    });
    sendLive();
  }
  dirty.live = true;
}

function onPenUp(e) {
  if (!input || e.pointerId !== input.pointerId) return;
  if (e.pointerType === 'pen') lastPenSeen = performance.now();
  const done = input;
  input = null;
  if (done.kind === 'erase') finishErase(done);
  else if (done.kind === 'lasso') finishLasso(done.pts);
  else if (done.kind === 'move') finishMove(done.dx, done.dy);
  else if (done.kind === 'resize') finishResize(done);
  else finishStroke(done.stroke);
  dirty.live = true;
}

function cancelInput() {
  if (input?.kind === 'draw' && current) api.live(current.id, input.stroke.id, null);
  if (input?.kind === 'erase') finishErase(input);
  if (input?.kind === 'move' || input?.kind === 'resize') dirty.base = true; // put the selection back
  input = null;
  hover = null;
}

function sendLive(force = false) {
  const now = performance.now();
  if (!force && now - liveTimer < 60) return;
  liveTimer = now;
  api.live(current.id, input.stroke.id, input.stroke);
}

function finishStroke(stroke) {
  stroke.pts = finishPoints(stroke.pts);
  api.live(current.id, stroke.id, null);
  if (settings.scribble && stroke.tool !== 'highlighter') {
    const erase = detectScribble(stroke.pts, current.drawing.strokes);
    if (erase) {
      const gone = new Set(erase.remove);
      flash = { start: performance.now(), strokes: current.drawing.strokes.filter(s => gone.has(s.id)) };
      commit(erase);
      return;
    }
  }
  const change = { add: [stroke] };
  const maxY = Math.max(...stroke.pts.map(p => p[1]));
  if (maxY > current.drawing.height - 80) change.height = Math.ceil(maxY + 300); // grow the page as you write
  commit(change);
}

function eraseTo(p) {
  const st = input;
  const change = eraseAlong(current.drawing.strokes, st.last[0], st.last[1], p[0], p[1], eraserRadius(), settings.eraser.mode);
  st.last = p;
  if (!change) return;
  const byId = new Map(current.drawing.strokes.map(s => [s.id, s]));
  for (const id of change.remove) {
    if (st.added.has(id)) st.added.delete(id);
    else st.removed.set(id, byId.get(id));
  }
  for (const s of change.add) st.added.set(s.id, s);
  applyChange(current.drawing, change);
  api.change(current.id, change);
  dirty.base = true;
}

function finishErase(st) {
  if (!current || !st.removed.size) return;
  current.undo.push({
    change: { remove: [...st.removed.keys()], add: [...st.added.values()] },
    inv: { remove: [...st.added.keys()], add: [...st.removed.values()] },
  });
  current.redo = [];
  updateUndoButtons();
}

// ---------------------------------------------------------------------------
// Touch: two fingers pan/zoom; single touches (palms) are ignored, unless
// "finger draws" is on (phones and tablets without a pen).
// ---------------------------------------------------------------------------

const touches = new Map();
let gesture = null;
let fingerPen = null; // pointerId of the finger currently drawing

const penNearby = () => (!!input && fingerPen === null) || performance.now() - lastPenSeen < PEN_GRACE_MS;

function onTouchDown(e) {
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (settings.fingerDraws && touches.size === 1 && !penNearby()) {
    fingerPen = e.pointerId;
    onPenDown(e);
    return;
  }
  if (fingerPen !== null && touches.size === 2) {
    // a second finger: that was the start of a pinch, not a stroke
    if (input?.kind === 'draw') api.live(current.id, input.stroke.id, null);
    input = null;
    fingerPen = null;
    dirty.live = true;
  }
  if (penNearby()) return;
  if (touches.size === 2) startGesture();
  else if (touches.size > 2) endGesture();
}

function onTouchMove(e) {
  if (e.pointerId === fingerPen) { onPenMove(e); return; }
  const t = touches.get(e.pointerId);
  if (!t) return;
  t.x = e.clientX;
  t.y = e.clientY;
  if (penNearby()) { endGesture(); return; }
  if (gesture && touches.size === 2) updateGesture();
}

function onTouchUp(e) {
  touches.delete(e.pointerId);
  if (e.pointerId === fingerPen) { fingerPen = null; onPenUp(e); }
  if (touches.size < 2) endGesture();
}

function twoTouches() {
  const [a, b] = [...touches.values()];
  return { cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
}
function startGesture() {
  const g = twoTouches();
  gesture = { ...g, view: { ...view } };
}
function updateGesture() {
  const g = twoTouches();
  const s0 = gesture.view.scale;
  const fit = Math.max(0.1, (stageRect.width - 20) / PAGE_WIDTH);
  const s = clamp(s0 * (g.d / gesture.d), fit * 0.5, fit * 6);
  const px = (gesture.cx - stageRect.left - gesture.view.ox) / s0;
  const py = (gesture.cy - stageRect.top - gesture.view.oy) / s0;
  view.scale = s;
  view.ox = g.cx - stageRect.left - px * s;
  view.oy = g.cy - stageRect.top - py * s;
  clampView();
  dirty.base = dirty.live = true;
}
function endGesture() {
  gesture = null;
}

// ---------------------------------------------------------------------------
// Lasso selection: circle writing (or tap a stroke / image) to select it,
// then drag it, or copy / cut / duplicate / delete it from the bar above it.
// A single selected image gets a corner handle to resize it.
// ---------------------------------------------------------------------------

let selection = null; // { ids: Set, imgs: Set, texts: Set, halo: [stroke] }
let clipboard = (() => { try { return JSON.parse(localStorage.getItem('problemvault.clipboard') || 'null'); } catch { return null; } })();
const SEL_COLOR = '#8b7bff';
const selbar = $('#selbar');

function selectedStrokes() {
  return selection ? current.drawing.strokes.filter(s => selection.ids.has(s.id)) : [];
}
function selectedImages() {
  return selection ? current.drawing.images.filter(i => selection.imgs.has(i.id)) : [];
}
function selectedTexts() {
  return selection ? current.drawing.texts.filter(t => selection.texts.has(t.id)) : [];
}

function setSelection(ids, imgs = null, texts = null) {
  const list = ids && current ? current.drawing.strokes.filter(s => ids.has(s.id)) : [];
  const ims = imgs && current ? current.drawing.images.filter(i => imgs.has(i.id)) : [];
  const txs = texts && current ? current.drawing.texts.filter(t => texts.has(t.id)) : [];
  selection = list.length || ims.length || txs.length
    ? {
      ids: new Set(list.map(s => s.id)),
      imgs: new Set(ims.map(i => i.id)),
      texts: new Set(txs.map(t => t.id)),
      halo: list.map(s => ({ ...s, id: `${s.id}h`, color: SEL_COLOR, size: s.size + 7, tool: 'pen' })),
    }
    : null;
  dirty.live = true;
}

// after any change: drop strokes that no longer exist, pick up moved ones
function refreshSelection() {
  if (selection && input?.kind !== 'move' && input?.kind !== 'resize') setSelection(selection.ids, selection.imgs, selection.texts);
}

function selectionBox(dx = 0, dy = 0) {
  let b = null;
  const add = (minX, minY, maxX, maxY) => {
    b = b ? { minX: Math.min(b.minX, minX), minY: Math.min(b.minY, minY), maxX: Math.max(b.maxX, maxX), maxY: Math.max(b.maxY, maxY) }
      : { minX, minY, maxX, maxY };
  };
  for (const s of selectedStrokes()) {
    const r = strokeBBox(s);
    const pad = s.size + 8;
    add(r.minX - pad, r.minY - pad, r.maxX + pad, r.maxY + pad);
  }
  for (const i of selectedImages()) add(i.x, i.y, i.x + i.w, i.y + i.h);
  for (const t of selectedTexts()) { const tb = textBox(t); add(tb.minX - 4, tb.minY - 4, tb.maxX + 4, tb.maxY + 4); }
  return b && { minX: b.minX + dx, minY: b.minY + dy, maxX: b.maxX + dx, maxY: b.maxY + dy };
}

function insidePolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function imageAt(x, y) {
  const ims = current.drawing.images;
  for (let k = ims.length - 1; k >= 0; k--) {
    const i = ims[k];
    if (x >= i.x && x <= i.x + i.w && y >= i.y && y <= i.y + i.h) return i;
  }
  return null;
}

function finishLasso(pts) {
  let span = 0;
  for (const p of pts) span = Math.max(span, Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]));
  if (imagesOnly) {
    const [x, y] = pts[0];
    const imgs = span < 8 ? new Set(imageAt(x, y) ? [imageAt(x, y).id] : [])
      : new Set(current.drawing.images.filter(i => insidePolygon(i.x + i.w / 2, i.y + i.h / 2, pts)).map(i => i.id));
    setSelection(null, imgs);
    if (!imgs.size && span >= 8) api.toast('No images selected');
    return;
  }
  if (span < 8) {
    // a tap: select the stroke under the pen, or else the image under it
    const [x, y] = pts[0];
    const hit = eraseAlong(current.drawing.strokes, x, y, x, y, 6, 'stroke');
    const tx = !hit && textAt(x, y);
    if (hit) setSelection(new Set([hit.remove[hit.remove.length - 1]]));
    else if (tx) setSelection(null, null, new Set([tx.id]));
    else {
      const im = imageAt(x, y);
      setSelection(null, im ? new Set([im.id]) : null);
    }
    return;
  }
  // a stroke is selected when most of it lies inside the loop; an image when its centre does
  const ids = new Set();
  for (const s of current.drawing.strokes) {
    const inside = s.pts.filter(p => insidePolygon(p[0], p[1], pts)).length;
    if (inside / s.pts.length >= 0.5) ids.add(s.id);
  }
  const imgs = new Set(current.drawing.images.filter(i => insidePolygon(i.x + i.w / 2, i.y + i.h / 2, pts)).map(i => i.id));
  const texts = new Set(current.drawing.texts.filter(t => { const b = textBox(t); return insidePolygon((b.minX + b.maxX) / 2, (b.minY + b.maxY) / 2, pts); }).map(t => t.id));
  setSelection(ids, imgs, texts);
  if (!ids.size && !imgs.size && !texts.size) api.toast('Nothing selected');
}

const shifted = (s, dx, dy, extra = {}) => ({
  ...s,
  ...extra,
  pts: s.pts.map(p => [Math.round((p[0] + dx) * 10) / 10, Math.round((p[1] + dy) * 10) / 10, p[2], p[3]]),
});

function growFor(strokes, change, images = []) {
  const maxY = Math.max(...strokes.flatMap(s => s.pts.map(p => p[1])), ...images.map(i => i.y + i.h), 0);
  if (maxY > current.drawing.height - 80) change.height = Math.ceil(maxY + 300);
  return change;
}

function finishMove(dx, dy) {
  dirty.base = true;
  if (Math.hypot(dx, dy) < 1) return;
  const { ids, imgs, texts } = selection;
  const moved = selectedStrokes().map(s => shifted(s, dx, dy)); // same ids: replaces the originals
  const movedImgs = selectedImages().map(i => ({ ...i, x: Math.round(i.x + dx), y: Math.round(i.y + dy) }));
  const change = growFor(moved, {}, movedImgs);
  if (moved.length) change.add = moved;
  if (movedImgs.length) change.imgAdd = movedImgs;
  const movedTexts = selectedTexts().map(t => ({ ...t, x: Math.round(t.x + dx), y: Math.round(t.y + dy) }));
  if (movedTexts.length) change.textAdd = movedTexts;
  commit(change);
  setSelection(ids, imgs, texts);
}

function finishResize({ im, k }) {
  dirty.base = true;
  if (Math.abs(k - 1) < 0.01) return;
  const resized = { ...im, w: Math.round(im.w * k), h: Math.round(im.h * k) };
  commit(growFor([], { imgAdd: [resized] }, [resized]));
  setSelection(null, new Set([im.id]));
}

// new copies of strokes (new ids, painted on top in their original order)
function copies(strokes, dx, dy) {
  const base = Date.now() * 1000;
  return [...strokes].sort((a, b) => a.z - b.z).map((s, i) => shifted(s, dx, dy, { id: uid(), z: base + i }));
}

function copySelection() {
  const list = selectedStrokes();
  if (!list.length) { if (selection?.imgs.size) api.toast('Images are copied by pasting the file again'); return; }
  clipboard = list;
  try { localStorage.setItem('problemvault.clipboard', JSON.stringify(list)); } catch {}
  updatePasteButton();
  api.toast(`Copied ${list.length} stroke${list.length > 1 ? 's' : ''}`);
}
function deleteSelection() {
  if (!selection) return;
  const change = {};
  if (selection.ids.size) change.remove = [...selection.ids];
  if (selection.imgs.size) change.imgRemove = [...selection.imgs];
  if (selection.texts.size) change.textRemove = [...selection.texts];
  commit(change);
  setSelection(null);
}
function cutSelection() {
  copySelection();
  deleteSelection();
}
function duplicateSelection() {
  const list = selectedStrokes();
  if (!list.length) return;
  const dupes = copies(list, 24, 24);
  commit(growFor(dupes, { add: dupes }));
  setSelection(new Set(dupes.map(s => s.id)));
}
function pasteStrokes() {
  if (!current || !clipboard?.length) return;
  const { cx, cy } = visibleCentre();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of clipboard) for (const p of s.pts) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  const dx = clamp(cx - (minX + maxX) / 2, 10 - minX, PAGE_WIDTH - 10 - maxX); // keep it on the page
  const dy = Math.max(cy - (minY + maxY) / 2, 10 - minY);
  const pasted = copies(clipboard, dx, dy);
  commit(growFor(pasted, { add: pasted }));
  selectTool('lasso');
  setSelection(new Set(pasted.map(s => s.id))); // selected, ready to drag into place
}

function visibleCentre() {
  return {
    cx: (stageRect.width / 2 - view.ox) / view.scale,
    cy: (stageRect.height / 2 - view.oy) / view.scale,
    top: Math.max(0, -view.oy / view.scale),
  };
}

function updatePasteButton() {
  $('#paste').hidden = !clipboard?.length;
}

function renderSelection(ctx) {
  if (input?.kind === 'lasso') {
    ctx.save();
    ctx.strokeStyle = SEL_COLOR;
    ctx.lineWidth = 2 / view.scale;
    ctx.setLineDash([6 / view.scale, 5 / view.scale]);
    ctx.beginPath();
    input.pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.stroke();
    ctx.restore();
  }
  for (const [id, c] of textCache) { // selected text follows the drag
    const on = input?.kind === 'move' && !!selection?.texts.has(id);
    c.el.style.transform = on ? `translate(${input.dx}px, ${input.dy}px)` : '';
    c.el.classList.toggle('moving', on);
  }
  if (!selection) {
    selbar.hidden = true;
    return;
  }
  const moving = input?.kind === 'move';
  const resizing = input?.kind === 'resize';
  const dx = moving ? input.dx : 0;
  const dy = moving ? input.dy : 0;
  const bms = readyBitmaps();
  ctx.save();
  ctx.translate(dx, dy);
  if (moving || resizing) {
    for (const i of selectedImages()) {
      const k = resizing ? input.k : 1;
      const bm = bms.get(i.id);
      if (bm) ctx.drawImage(bm, i.x, i.y, i.w * k, i.h * k);
    }
  }
  for (const h of selection.halo) drawStroke(ctx, h, { alphaScale: 0.28 });
  if (moving) for (const s of selectedStrokes()) drawStroke(ctx, s, { dark: settings.darkPaper });
  ctx.restore();
  let b = selectionBox(dx, dy);
  if (!b) return;
  if (resizing) {
    const i = input.im;
    b = { minX: i.x, minY: i.y, maxX: i.x + i.w * input.k, maxY: i.y + i.h * input.k };
  }
  ctx.save();
  ctx.strokeStyle = SEL_COLOR;
  ctx.lineWidth = 1.2 / view.scale;
  ctx.setLineDash([5 / view.scale, 4 / view.scale]);
  ctx.strokeRect(b.minX, b.minY, b.maxX - b.minX, b.maxY - b.minY);
  if (selection.imgs.size === 1 && !selection.ids.size && !selection.texts.size) {
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 2 / view.scale;
    ctx.beginPath();
    ctx.arc(b.maxX, b.maxY, 8 / view.scale, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
  // action bar above the selection (below it if there's no room), hidden while dragging
  selbar.hidden = moving || resizing;
  if (!moving && !resizing) {
    selbar.querySelector('[data-act=edit]').hidden = !(selection.texts.size === 1 && !selection.ids.size && !selection.imgs.size);
    selbar.querySelector('[data-act=copy]').hidden = !selection.ids.size;
    selbar.querySelector('[data-act=cut]').hidden = !selection.ids.size;
    selbar.querySelector('[data-act=duplicate]').hidden = !selection.ids.size;
    const x = stageRect.left + view.ox + ((b.minX + b.maxX) / 2) * view.scale;
    const top = stageRect.top + view.oy + b.minY * view.scale;
    const bottom = stageRect.top + view.oy + b.maxY * view.scale;
    const h = selbar.offsetHeight || 44;
    const y = top - h - 10 > stageRect.top ? top - h - 10 : Math.min(bottom + 10, innerHeight - h - 10);
    selbar.style.left = `${clamp(x - selbar.offsetWidth / 2, 8, innerWidth - selbar.offsetWidth - 8)}px`;
    selbar.style.top = `${y}px`;
  }
}

selbar.addEventListener('pointerdown', e => e.stopPropagation());
selbar.querySelector('[data-act=edit]').onclick = () => { const t = selectedTexts()[0]; if (t) editText(t); };
selbar.querySelector('[data-act=copy]').onclick = copySelection;
selbar.querySelector('[data-act=cut]').onclick = cutSelection;
selbar.querySelector('[data-act=duplicate]').onclick = duplicateSelection;
selbar.querySelector('[data-act=delete]').onclick = deleteSelection;
$('#paste').onclick = pasteStrokes;
updatePasteButton();

// ---------------------------------------------------------------------------
// Images: paste, drop or upload. The original goes to the server as-is (or
// shrunk if huge), plus a deflated RGB copy the server can render for Claude
// without any image libraries.
// ---------------------------------------------------------------------------

export async function insertImage(file) {
  if (!current || !file || !file.type.startsWith('image/')) return;
  const id = current.id;
  api.toast('Adding image…', 4000);
  try {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    URL.revokeObjectURL(url);
    let { naturalWidth: w, naturalHeight: h } = img;
    let blob = file;
    let mime = file.type;
    if (Math.max(w, h) > IMG_MAX_SIDE || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
      const k = Math.min(1, IMG_MAX_SIDE / Math.max(w, h));
      const cv = document.createElement('canvas');
      cv.width = Math.round(w * k);
      cv.height = Math.round(h * k);
      cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
      mime = mime === 'image/png' || mime === 'image/gif' ? 'image/png' : 'image/jpeg';
      blob = await new Promise(r => cv.toBlob(r, mime, 0.9));
      w = cv.width;
      h = cv.height;
    }
    const imgId = await uploadPicture(id, img, w, h, blob, mime, file.name || '');
    if (!current || current.id !== id) return;
    // place it at the top of the visible area, at most page-width wide
    const dispW = Math.min(PAGE_WIDTH - 80, Math.max(160, w / (window.devicePixelRatio || 1)));
    const dispH = dispW * (h / w);
    const { top } = visibleCentre();
    const im = {
      id: imgId,
      z: Date.now(),
      x: Math.round((PAGE_WIDTH - dispW) / 2),
      y: Math.round(top + 30),
      w: Math.round(dispW),
      h: Math.round(dispH),
      name: (file.name || '').slice(0, 120),
    };
    const el = new Image();
    el.onload = () => { dirty.base = dirty.live = true; };
    el.src = URL.createObjectURL(blob);
    bitmaps.set(imgId, el);
    commit(growFor([], { imgAdd: [im] }, [im]));
    selectTool('lasso');
    setSelection(null, new Set([imgId]));
    api.toast('Image added. Drag to move, corner to resize, then write on it.', 2500);
  } catch (err) {
    reportError(err);
  }
}

// RGB copy on white (transparent PNGs become white, like paper), then upload.
async function uploadPicture(id, src, w, h, blob, mime, name) {
  const k = Math.min(1, RGB_MAX_SIDE / Math.max(w, h));
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * k));
  cv.height = Math.max(1, Math.round(h * k));
  const cx = cv.getContext('2d');
  cx.fillStyle = '#fff';
  cx.fillRect(0, 0, cv.width, cv.height);
  cx.drawImage(src, 0, 0, cv.width, cv.height);
  const rgba = cx.getImageData(0, 0, cv.width, cv.height).data;
  const rgb = new Uint8Array(cv.width * cv.height * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    rgb[j] = rgba[i]; rgb[j + 1] = rgba[i + 1]; rgb[j + 2] = rgba[i + 2];
  }
  const deflated = await new Response(new Blob([rgb]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
  const imgId = uid();
  await api.uploadImage(id, {
    id: imgId,
    mime,
    name,
    data: await b64(await blob.arrayBuffer()),
    rgb: { w: cv.width, h: cv.height, data: await b64(deflated) },
  });
  return imgId;
}

// ---------------------------------------------------------------------------
// PDFs: each page becomes an image, stacked down the problem below what is
// already there. Export rebuilds a PDF with only your writing (Claude's ink
// and notes are left out).
// ---------------------------------------------------------------------------

const PDF_RENDER_W = 1700; // pixels per page width (~200 dpi for Letter)
const PDF_MARGIN = 20; // page units left / right of each PDF page
const PDF_GAP = 30; // page units between PDF pages
const PDF_MAX_PAGES = 80;
let pdfjsLib = null;

async function loadPdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(new URL('./vendor/pdfjs/pdf.min.mjs', import.meta.url).href);
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
  }
  return pdfjsLib;
}

const isPdf = f => f && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name || ''));

export function insertFile(file) {
  return isPdf(file) ? insertPdf(file) : insertImage(file);
}

async function insertFiles(list) {
  for (const f of list || []) await insertFile(f); // one at a time, so PDFs stack in order
}

function contentBottom() {
  const d = current.drawing;
  let y = 0;
  for (const s of d.strokes) for (const p of s.pts) y = Math.max(y, p[1]);
  for (const im of d.images) y = Math.max(y, im.y + im.h);
  for (const t of d.texts || []) y = Math.max(y, textBox(t).maxY);
  return y;
}

export async function insertPdf(file) {
  if (!current || readOnly || !file) return;
  const id = current.id;
  const name = (file.name || 'document.pdf').slice(0, 100);
  try {
    api.toast('Opening PDF…', 4000);
    const lib = await loadPdfjs();
    const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
    let n = doc.numPages;
    if (n > PDF_MAX_PAGES && !confirm(`This PDF has ${n} pages. Add only the first ${PDF_MAX_PAGES}?`)) return;
    n = Math.min(n, PDF_MAX_PAGES);
    const dispW = PAGE_WIDTH - PDF_MARGIN * 2;
    let y = contentBottom();
    y = y > 0 ? Math.round(y + 60) : PDF_MARGIN;
    const added = [];
    for (let i = 1; i <= n; i++) {
      api.toast(`Adding PDF page ${i} of ${n}…`, 60000);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 }); // PDF points
      const vp = page.getViewport({ scale: PDF_RENDER_W / base.width });
      const cv = document.createElement('canvas');
      cv.width = Math.round(vp.width);
      cv.height = Math.round(vp.height);
      const cx = cv.getContext('2d');
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, cv.width, cv.height);
      await page.render({ canvasContext: cx, viewport: vp }).promise;
      page.cleanup();
      const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));
      const imgId = await uploadPicture(id, cv, cv.width, cv.height, blob, 'image/jpeg', `${name} p${i}`);
      if (!current || current.id !== id) return;
      const h = Math.round(dispW * cv.height / cv.width);
      const im = {
        id: imgId, z: Date.now() + i, x: PDF_MARGIN, y, w: dispW, h,
        name: `${name} p${i}`.slice(0, 120),
        pdf: { name, page: i, n, pw: Math.round(base.width * 100) / 100, ph: Math.round(base.height * 100) / 100 },
      };
      const el = new Image();
      el.onload = () => { dirty.base = dirty.live = true; };
      el.src = URL.createObjectURL(blob);
      bitmaps.set(imgId, el);
      added.push(im);
      y += h + PDF_GAP;
    }
    doc.destroy();
    if (!added.length) return;
    commit(growFor([], { imgAdd: added }, added)); // one undo for the whole PDF
    api.toast(`Added ${added.length} PDF page${added.length > 1 ? 's' : ''}. Write on them, then use ⋯ → Export PDF.`, 4000);
  } catch (err) {
    if (/password/i.test(err?.name || err?.message || '')) api.toast('That PDF is password-protected. Remove the password first.', 5000);
    else reportError(err);
  }
}

// --- export -----------------------------------------------------------------

const LETTER = { pw: 612, ph: 792 };

// Page regions in reading order: every PDF page, plus Letter-size pages for
// your work in the space above, between or below them.
function exportRegions(d, studentStrokes, studentTexts) {
  const pdfs = d.images.filter(i => i.pdf).sort((a, b) => a.y - b.y || a.x - b.x);
  const regions = pdfs.map(i => ({ x: i.x, y: i.y, w: i.w, h: i.h, pw: i.pdf.pw || LETTER.pw }));
  const boxes = [
    ...studentStrokes.map(s => strokeBBox(s)),
    ...d.images.filter(i => !i.pdf).map(i => ({ minX: i.x, minY: i.y, maxX: i.x + i.w, maxY: i.y + i.h })),
    ...studentTexts.map(t => textBox(t)),
  ];
  const covered = b => regions.some(r => b.minX >= r.x - 2 && b.maxX <= r.x + r.w + 2 && b.minY >= r.y - 2 && b.maxY <= r.y + r.h + 2);
  const loose = boxes.filter(b => !covered(b)).sort((a, b) => a.minY - b.minY);
  const sliceH = Math.round(PAGE_WIDTH * LETTER.ph / LETTER.pw);
  const extra = [];
  for (const b of loose) {
    if (extra.some(r => b.minY >= r.y && b.minY < r.y + r.h)) continue; // starts on a page we already have
    let y = Math.max(0, Math.floor(b.minY - 30));
    const inside = regions.find(r => y >= r.y && y < r.y + r.h);
    if (inside) y = inside.y + inside.h; // don't repeat a PDF page
    const next = Math.min(...regions.filter(r => r.y > y).map(r => r.y), Infinity);
    const h = Math.min(sliceH, next - y);
    if (h >= 20) extra.push({ x: 0, y, w: PAGE_WIDTH, h, pw: LETTER.pw });
  }
  return [...regions, ...extra].sort((a, b) => a.y - b.y || a.x - b.x);
}

function wrapText(cx, text, maxW) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const t = line ? line + ' ' + word : word;
      if (line && cx.measureText(t).width > maxW) { lines.push(line); line = word; } else line = t;
    }
    lines.push(line);
  }
  return lines;
}

const plainText = md => md.replace(/\$\$?([^$]*)\$\$?/g, '$1').replace(/\\(,|;|!|quad)/g, ' ').replace(/\\([a-zA-Z]+)/g, '$1').replace(/[{}]/g, '').replace(/[*_`#]/g, '');

async function loadAllBitmaps(images) {
  loadBitmaps();
  await Promise.all(images.map(im => {
    const el = bitmaps.get(im.id);
    if (!el || (el.complete && el.naturalWidth)) return null;
    return el.decode().catch(() => null);
  }));
}

export async function exportPdf() {
  if (!current) return;
  const d = current.drawing;
  const strokes = d.strokes.filter(s => s.by !== 'claude');
  const texts = (d.texts || []).filter(t => t.by !== 'claude');
  if (!strokes.length && !d.images.length && !texts.length) { api.toast('Nothing to export yet.', 2500); return; }
  try {
    api.toast('Making PDF…', 60000);
    await loadAllBitmaps(d.images);
    const bm = readyBitmaps();
    const mine = { ...d, strokes, texts: [] };
    const pages = [];
    for (const r of exportRegions(d, strokes, texts)) {
      const k = PDF_RENDER_W / r.w;
      const cv = document.createElement('canvas');
      cv.width = Math.round(r.w * k);
      cv.height = Math.round(r.h * k);
      const cx = cv.getContext('2d');
      cx.fillStyle = '#fff';
      cx.fillRect(0, 0, cv.width, cv.height);
      cx.setTransform(k, 0, 0, k, -r.x * k, -r.y * k);
      drawPage(cx, mine, { bitmaps: bm });
      for (const t of texts) { // your typed text, as plain text
        cx.fillStyle = t.color || '#1f1f1f';
        cx.font = `${t.size}px system-ui, sans-serif`;
        cx.textBaseline = 'top';
        wrapText(cx, plainText(t.md), t.w).forEach((line, n) => cx.fillText(line, t.x, t.y + n * t.size * 1.35));
      }
      const blob = await new Promise(res => cv.toBlob(res, 'image/jpeg', 0.9));
      pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), w: cv.width, h: cv.height, pw: r.pw, ph: r.pw * r.h / r.w });
    }
    const title = ($('#ws-title')?.value || d.images.find(i => i.pdf)?.pdf.name || 'problem').replace(/\.pdf$/i, '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buildPdf(pages)], { type: 'application/pdf' }));
    a.download = `${title.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'problem'}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    api.toast(`Exported ${pages.length} page${pages.length > 1 ? 's' : ''} (your writing only).`, 3000);
  } catch (err) {
    reportError(err);
  }
}

// Minimal PDF writer: one full-page JPEG per page.
function buildPdf(pages) {
  const enc = new TextEncoder();
  const parts = [];
  const offsets = [];
  let len = 0;
  const push = b => { const u = typeof b === 'string' ? enc.encode(b) : b; parts.push(u); len += u.length; };
  const obj = (n, body) => { offsets[n] = len; push(`${n} 0 obj\n`); for (const b of [].concat(body)) push(b); push('\nendobj\n'); };
  const f = n => (Math.round(n * 100) / 100).toString();
  push('%PDF-1.4\n%âãÏÓ\n');
  const kids = pages.map((_, i) => `${3 + i * 3} 0 R`).join(' ');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((p, i) => {
    const n = 3 + i * 3;
    const content = `q ${f(p.pw)} 0 0 ${f(p.ph)} 0 0 cm /Im0 Do Q`;
    obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${f(p.pw)} ${f(p.ph)}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
    obj(n + 1, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(n + 2, [`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, '\nendstream']);
  });
  const count = 3 + pages.length * 3;
  const xref = len;
  let x = `xref\n0 ${count}\n0000000000 65535 f \n`;
  for (let n = 1; n < count; n++) x += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(x + `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(len);
  let o = 0;
  for (const u of parts) { out.set(u, o); o += u.length; }
  return out;
}

async function b64(buf) {
  // FileReader is the fast path for big buffers
  const url = await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(new Blob([buf])); });
  return url.slice(url.indexOf(',') + 1);
}

document.addEventListener('paste', e => {
  if (!current || readOnly || e.target.closest?.('input, textarea, [contenteditable]')) return;
  const file = [...(e.clipboardData?.items || [])].find(i => i.kind === 'file' && (i.type.startsWith('image/') || i.type === 'application/pdf'))?.getAsFile();
  e.preventDefault();
  if (file) insertFile(file);
  else pasteStrokes();
});
stage.addEventListener('dragover', e => { e.preventDefault(); stage.classList.add('drop'); });
stage.addEventListener('dragleave', () => stage.classList.remove('drop'));
stage.addEventListener('drop', e => {
  e.preventDefault();
  stage.classList.remove('drop');
  if (readOnly) return;
  insertFiles(e.dataTransfer?.files);
});
$('#img-file').addEventListener('change', e => {
  insertFiles([...e.target.files]);
  e.target.value = '';
});
$('#add-image').onclick = () => $('#img-file').click();

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

stage.addEventListener('pointerdown', e => {
  e.preventDefault();
  if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  if (readOnly) {
    if (e.pointerType === 'touch') onTouchDown(e);
    pan = e.pointerType !== 'touch' || touches.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY, ox: view.ox, oy: view.oy } : null;
    try { stage.setPointerCapture(e.pointerId); } catch {}
    return;
  }
  if (e.pointerType === 'touch') onTouchDown(e);
  else onPenDown(e);
});
stage.addEventListener('pointermove', e => {
  if (readOnly) {
    if (e.pointerType === 'touch') onTouchMove(e);
    if (pan && e.pointerId === pan.id && !gesture) {
      view.ox = pan.ox + e.clientX - pan.x;
      view.oy = pan.oy + e.clientY - pan.y;
      clampView();
      dirty.base = dirty.live = true;
    }
    return;
  }
  if (e.pointerType === 'touch') onTouchMove(e);
  else onPenMove(e);
});
for (const type of ['pointerup', 'pointercancel']) {
  stage.addEventListener(type, e => {
    if (readOnly) {
      if (e.pointerType === 'touch') onTouchUp(e);
      if (pan?.id === e.pointerId) pan = null;
      return;
    }
    if (e.pointerType === 'touch') onTouchUp(e);
    else onPenUp(e);
  });
}
stage.addEventListener('pointerleave', e => {
  if (e.pointerType !== 'touch' && !input) { hover = null; dirty.live = true; }
});
// iOS: stop the page from scrolling/zooming/selecting under the palm and pen.
for (const type of ['touchstart', 'touchmove', 'touchend']) stage.addEventListener(type, e => e.preventDefault(), { passive: false });
stage.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('gesturestart', e => e.preventDefault());

// Mouse wheel / trackpad
stage.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey) {
    const s0 = view.scale;
    const fit = Math.max(0.1, (stageRect.width - 20) / PAGE_WIDTH);
    const s = clamp(s0 * Math.exp(-e.deltaY * 0.01), fit * 0.5, fit * 6);
    const px = (e.clientX - stageRect.left - view.ox) / s0;
    const py = (e.clientY - stageRect.top - view.oy) / s0;
    view.scale = s;
    view.ox = e.clientX - stageRect.left - px * s;
    view.oy = e.clientY - stageRect.top - py * s;
  } else {
    view.ox -= e.deltaX;
    view.oy -= e.deltaY;
  }
  clampView();
  dirty.base = dirty.live = true;
}, { passive: false });

document.addEventListener('keydown', e => {
  if (!current || readOnly || e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (mod && k === 'y') { e.preventDefault(); redo(); }
  else if (mod && k === 'c') { e.preventDefault(); copySelection(); }
  else if (mod && k === 'x') { e.preventDefault(); cutSelection(); }
  else if (mod && k === 'd') { e.preventDefault(); duplicateSelection(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selection) { e.preventDefault(); deleteSelection(); }
  else if (e.key === 'Escape' && selection) setSelection(null);
  else if (!mod && !e.altKey) {
    const keys = { p: 'pen', n: 'pencil', h: 'highlighter', l: 'lasso', e: 'eraser', t: 'text' };
    if (keys[k]) selectTool(keys[k]);
  }
});

// ---------------------------------------------------------------------------
// Toolbar
// ---------------------------------------------------------------------------

function selectTool(tool) {
  if (!toolAllowed(tool)) return;
  settings.tool = tool;
  chosenTool = tool;
  if (tool !== 'lasso') setSelection(null);
  save();
  renderToolbar();
}

function renderToolbar() {
  document.querySelectorAll('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === settings.tool));
  stage.dataset.activeTool = settings.tool; // CSS: the system cursor shows unless a pen-like tool draws its own
  const tool = settings.tool;
  const colors = $('#colors');
  colors.innerHTML = '';
  for (const c of PALETTES[tool] || []) {
    const b = document.createElement('button');
    b.className = 'swatch' + (settings[tool].color === c ? ' on' : '');
    b.style.setProperty('--c', inkColor(c, settings.darkPaper)); // show the colour as it will look
    b.setAttribute('aria-label', `Color ${c}`);
    b.onclick = () => { settings[tool].color = c; save(); renderToolbar(); };
    colors.appendChild(b);
  }
  if (PALETTES[tool]) {
    const custom = document.createElement('label');
    custom.className = 'swatch custom';
    custom.title = 'Custom color';
    custom.innerHTML = `<input type="color" value="${settings[tool].color}">`;
    custom.querySelector('input').oninput = e => { settings[tool].color = e.target.value; save(); };
    custom.querySelector('input').onchange = () => renderToolbar();
    if (!PALETTES[tool].includes(settings[tool].color)) custom.classList.add('on');
    colors.appendChild(custom);
  }
  colors.hidden = !PALETTES[tool];
  const sizes = $('#sizes');
  sizes.innerHTML = '';
  sizes.hidden = !SIZES[tool];
  (SIZES[tool] || []).forEach((sz, i) => {
    const b = document.createElement('button');
    b.className = 'size' + (settings[tool].size === i ? ' on' : '');
    b.innerHTML = `<i style="width:${6 + i * 5}px;height:${6 + i * 5}px"></i>`;
    b.setAttribute('aria-label', ['Fine', 'Medium', 'Thick'][i]);
    b.onclick = () => { settings[tool].size = i; save(); renderToolbar(); };
    sizes.appendChild(b);
  });
  // line style: solid / dashed / dotted (pen, pencil, highlighter)
  const dashes = $('#dashes');
  dashes.innerHTML = '';
  dashes.hidden = !PALETTES[tool];
  if (PALETTES[tool]) {
    const icons = {
      solid: '<path d="M3 12h18"/>',
      dash: '<path d="M3 12h4M10 12h4M17 12h4"/>',
      dot: '<circle cx="4" cy="12" r="1.4"/><circle cx="9.3" cy="12" r="1.4"/><circle cx="14.7" cy="12" r="1.4"/><circle cx="20" cy="12" r="1.4"/>',
    };
    for (const [dash, label] of [['solid', 'Solid line'], ['dash', 'Dashed line'], ['dot', 'Dotted line']]) {
      const b = document.createElement('button');
      b.className = 'dash' + ((settings[tool].dash || 'solid') === dash ? ' on' : '');
      b.innerHTML = `<svg viewBox="0 0 24 24">${icons[dash]}</svg>`;
      b.setAttribute('aria-label', label);
      b.title = label;
      b.onclick = () => { settings[tool].dash = dash; save(); renderToolbar(); };
      dashes.appendChild(b);
    }
  }
  $('#opt-scribble').checked = settings.scribble;
  $('#opt-dark').checked = settings.darkPaper;
  $('#opt-precise').checked = settings.eraser.mode === 'precise';
  $('#opt-finger').checked = settings.fingerDraws;
}

document.querySelectorAll('[data-tool]').forEach(b => { b.onclick = () => selectTool(b.dataset.tool); });
$('#undo').onclick = undo;
$('#redo').onclick = redo;
$('#more').onclick = e => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; };
document.addEventListener('pointerdown', e => { if (!e.target.closest('#menu, #more')) closeMenu(); });
function closeMenu() { $('#menu').hidden = true; }

$('#opt-scribble').onchange = e => { settings.scribble = e.target.checked; save(); };
$('#opt-dark').onchange = e => {
  settings.darkPaper = e.target.checked;
  save();
  renderToolbar();
  dirty.base = dirty.live = true;
};
$('#opt-precise').onchange = e => { settings.eraser.mode = e.target.checked ? 'precise' : 'stroke'; save(); };
$('#opt-finger').onchange = e => { settings.fingerDraws = e.target.checked; save(); };
$('#act-pdf').onclick = () => { closeMenu(); exportPdf(); };
$('#act-extend').onclick = () => { if (current) commit({ height: current.drawing.height + 400 }); closeMenu(); };
$('#act-fit').onclick = () => { fitWidth(); closeMenu(); };
$('#act-clear').onclick = () => {
  closeMenu();
  const d = current?.drawing;
  if (d && (d.strokes.length || d.images.length || d.texts.length) && confirm('Clear this page (ink, text and images)? You can undo this.')) {
    commit({ remove: d.strokes.map(s => s.id), imgRemove: d.images.map(i => i.id), textRemove: d.texts.map(t => t.id) });
  }
};
$('#act-fullscreen').onclick = () => {
  closeMenu();
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.().catch(() => api.toast('Fullscreen not available'));
};
