"""What Claude sees of a page, built to cost as few image tokens as possible.

Claude bills an image by its pixel area (about w*h/750 tokens), not by how much
detail it holds. So instead of a screenshot of the whole screen we:

  * group strokes into blocks (roughly: one line of writing or one equation),
  * render only the blocks asked for, cropped tight to the ink,
  * pick the scale from the handwriting itself, so letters come out ~22 px tall
    (legible, but no bigger), and
  * remember what Claude already transcribed: that ink is drawn faint grey for
    context and never needs re-reading; get_workspace returns its text instead.

Pure Python (zlib only), so the server has no dependencies. Mirrors the brush
model of public/ink.js (radiusAt / alphaAt) closely enough for reading.
"""
import hashlib
import math
import struct
import zlib

from . import store

WHITE = (255, 255, 255)
FADED = (200, 200, 205)
LETTER_PX = 22          # target height of a typical handwritten stroke
MAX_SIDE = 1400         # never send an image bigger than this on its long side
TOKEN_PX = 750          # ~pixels per image token


def smoothstep(e0, e1, x):
    t = min(1.0, max(0.0, (x - e0) / (e1 - e0)))
    return t * t * (3 - 2 * t)


def radius_at(s, p):
    pr = p[2]
    shade = smoothstep(0.3, 0.85, p[3] if len(p) > 3 else 0)
    size = s["size"]
    tool = s["tool"]
    if tool == "pencil":
        return size * (0.3 + 0.7 * pr) * (1 + 3 * shade) / 2
    if tool == "highlighter":
        return size * (0.85 + 0.3 * pr) * (1 + 0.8 * shade) / 2
    return max(0.35, size * (0.2 + 0.8 * pr ** 0.85) / 2)


def alpha_at(s, p):
    if s["tool"] == "highlighter":
        return 0.32
    if s["tool"] == "pencil":
        shade = smoothstep(0.3, 0.85, p[3] if len(p) > 3 else 0)
        return min(0.95, max(0.08, (0.35 + 0.6 * p[2]) * (1 - 0.6 * shade)))
    return 1.0


def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def stroke_bbox(s):
    xs = [p[0] for p in s["pts"]]
    ys = [p[1] for p in s["pts"]]
    r = s["size"]
    return [min(xs) - r, min(ys) - r, max(xs) + r, max(ys) + r]


def union(a, b):
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


# ---------------------------------------------------------------------------
# Blocks: strokes that are close together (a word, a line, an equation)
# ---------------------------------------------------------------------------

PAD_X, PAD_Y = 60, 9   # page units; words on one line join, separate lines don't


def _near(a, b):
    return not (a[2] + PAD_X < b[0] or b[2] + PAD_X < a[0] or a[3] + PAD_Y < b[1] or b[3] + PAD_Y < a[1])


def blocks(page):
    """[{id, box, strokes: [stroke ids]}], top to bottom."""
    clusters = []  # [box, [ids]]
    for s in page["strokes"]:
        if s["tool"] == "highlighter" or s.get("by") == "claude":
            continue  # highlighting marks up writing, it isn't writing; Claude's own marks need no reading
        b = stroke_bbox(s)
        hit = [c for c in clusters if _near(c[0], b)]
        if not hit:
            clusters.append([b, [s["id"]]])
            continue
        keep = hit[0]
        keep[0] = union(keep[0], b)
        keep[1].append(s["id"])
        for c in hit[1:]:
            keep[0] = union(keep[0], c[0])
            keep[1].extend(c[1])
            clusters.remove(c)
    # merging can make clusters newly overlap each other
    changed = True
    while changed:
        changed = False
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                if _near(clusters[i][0], clusters[j][0]):
                    clusters[i][0] = union(clusters[i][0], clusters[j][0])
                    clusters[i][1].extend(clusters[j][1])
                    del clusters[j]
                    changed = True
                    break
            if changed:
                break
    clusters.sort(key=lambda c: (round(c[0][1] / 40), c[0][0]))
    out = []
    for box, ids in clusters:
        h = hashlib.sha1(",".join(sorted(ids)).encode()).hexdigest()[:6]
        out.append({"id": f"b{h}", "box": [round(v) for v in box], "strokes": ids})
    return out


def block_status(block, transcripts, live_ids):
    """('new'|'partial'|'read'|'edited', covering transcripts, ids not yet read)."""
    sids = set(block["strokes"])
    cover = [t for t in transcripts if sids & set(t["strokes"])]
    read = set().union(*[set(t["strokes"]) for t in cover]) if cover else set()
    unread = [i for i in block["strokes"] if i not in read]
    if not cover:
        return "new", cover, unread
    if unread:
        return "partial", cover, unread
    erased = any(not set(t["strokes"]) <= live_ids for t in cover)
    return ("edited" if erased else "read"), cover, unread


# ---------------------------------------------------------------------------
# Rasteriser
# ---------------------------------------------------------------------------

class Canvas:
    def __init__(self, w, h, x0, y0, scale):
        self.w, self.h, self.x0, self.y0, self.k = w, h, x0, y0, scale
        self.buf = bytearray(bytes(WHITE) * (w * h))

    def disc(self, cx, cy, r, rgb, multiply=False):
        """Filled disc at page coords, radius in page units."""
        k = self.k
        px, py, pr = (cx - self.x0) * k, (cy - self.y0) * k, max(0.55, r * k)
        y_lo, y_hi = max(0, int(py - pr)), min(self.h - 1, int(py + pr))
        col = bytes(rgb)
        w, buf = self.w, self.buf
        for y in range(y_lo, y_hi + 1):
            dy = y + 0.5 - py
            if dy * dy > pr * pr:
                continue
            half = math.sqrt(pr * pr - dy * dy)
            xa, xb = max(0, int(px - half + 0.5)), min(w - 1, int(px + half - 0.5))
            if xb < xa:
                if 0 <= int(px) < w and pr < 1:
                    xa = xb = int(px)
                else:
                    continue
            i, j = (y * w + xa) * 3, (y * w + xb + 1) * 3
            if multiply:  # highlighter: darken only, never paint over ink
                seg = buf[i:j]
                for n in range(0, len(seg), 3):
                    seg[n] = seg[n] * rgb[0] // 255
                    seg[n + 1] = seg[n + 1] * rgb[1] // 255
                    seg[n + 2] = seg[n + 2] * rgb[2] // 255
                buf[i:j] = seg
            else:
                buf[i:j] = col * (xb - xa + 1)

    def stroke(self, s, rgb_override=None):
        base = rgb_override or hex_rgb(s["color"])
        hl = s["tool"] == "highlighter"
        k = self.k
        step = 0.9 / k  # stamp about every 0.9 output pixels
        dash = s.get("dash")
        on = max(6, s["size"] * 4)
        off = max(5, s["size"] * 3) + s["size"]
        dot = max(4, s["size"] * 2.6)
        dist = 0.0
        pts = s["pts"]
        cache = {}

        def colour(p):
            a = 1.0 if rgb_override else alpha_at(s, p)
            a = round(a * 12) / 12
            if a not in cache:
                # the colour over white paper; for the highlighter it is used as a multiply factor
                cache[a] = tuple(round(255 * (1 - a) + c * a) for c in base)
            return cache[a]

        def stamp(p, d):
            if dash == "dash" and (d % (on + off)) > on:
                return
            if dash == "dot":
                m = d % dot
                if m > step and dot - m > step:
                    return
            self.disc(p[0], p[1], radius_at(s, p), colour(p), multiply=hl)

        stamp(pts[0], 0.0)
        for a, b in zip(pts, pts[1:]):
            seg = math.hypot(b[0] - a[0], b[1] - a[1])
            n = max(1, int(seg / step))
            for i in range(1, n + 1):
                t = i / n
                p = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t,
                     a[2] + (b[2] - a[2]) * t, (a[3] if len(a) > 3 else 0) + ((b[3] if len(b) > 3 else 0) - (a[3] if len(a) > 3 else 0)) * t]
                stamp(p, dist + seg * t)
            dist += seg

    def image(self, im, pixels, fade=False):
        iw, ih, raw = pixels
        k, w = self.k, self.w
        # output pixel range covered by the image
        ox0 = max(0, int((im["x"] - self.x0) * k))
        oy0 = max(0, int((im["y"] - self.y0) * k))
        ox1 = min(self.w, int(math.ceil((im["x"] + im["w"] - self.x0) * k)))
        oy1 = min(self.h, int(math.ceil((im["y"] + im["h"] - self.y0) * k)))
        if ox1 <= ox0 or oy1 <= oy0:
            return
        sx = iw / (im["w"] * k)
        sy = ih / (im["h"] * k)
        left = (im["x"] - self.x0) * k
        top = (im["y"] - self.y0) * k
        xs = [min(iw - 1, max(0, int((ox + 0.5 - left) * sx))) * 3 for ox in range(ox0, ox1)]
        lighten = bytes(range(256)) if not fade else bytes(255 - (255 - v) // 3 for v in range(256))
        for oy in range(oy0, oy1):
            sy_i = min(ih - 1, max(0, int((oy + 0.5 - top) * sy)))
            row = raw[sy_i * iw * 3:(sy_i + 1) * iw * 3]
            out = b"".join(row[x:x + 3] for x in xs)
            if fade:
                out = out.translate(lighten)
            i = (oy * w + ox0) * 3
            self.buf[i:i + len(out)] = out

    def png(self):
        w, h = self.w, self.h
        rows = b"".join(b"\x00" + bytes(self.buf[y * w * 3:(y + 1) * w * 3]) for y in range(h))

        def chunk(tag, data):
            return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

        return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def auto_scale(strokes, box, has_images):
    """Scale (output px per page unit) that makes writing ~LETTER_PX tall."""
    hs = sorted(stroke_bbox(s)[3] - stroke_bbox(s)[1] - 2 * s["size"] for s in strokes if s["tool"] != "highlighter")
    hs = [h for h in hs if h > 6]
    if hs:
        k = LETTER_PX / hs[len(hs) // 2]
        k = min(1.1, max(0.55, k))  # big single shapes (circles, arrows) mustn't shrink to a smudge
    else:
        k = 0.8
    if has_images:
        k = max(k, 0.9)  # circuit symbols and printed text need a little more
    w, h = box[2] - box[0], box[3] - box[1]
    if max(w, h) * k > MAX_SIDE:
        k = MAX_SIDE / max(w, h)
    return k


def render(wid, page, box, *, scale=None, focus=None, include_images=True, fade_images=False):
    """PNG of the page inside box=[x0, y0, x1, y1] (page units).

    focus: set of stroke ids to draw in colour; all other ink is drawn faint grey
    (context Claude already read). None = everything in colour.
    """
    x0, y0, x1, y1 = box
    strokes = [s for s in page["strokes"] if _overlaps(stroke_bbox(s), box)]
    images = [im for im in page.get("images", []) if include_images and _overlaps([im["x"], im["y"], im["x"] + im["w"], im["y"] + im["h"]], box)]
    k = scale or auto_scale([s for s in strokes if focus is None or s["id"] in focus] or strokes, box, bool(images))
    w = max(8, int(math.ceil((x1 - x0) * k)))
    h = max(8, int(math.ceil((y1 - y0) * k)))
    if max(w, h) > MAX_SIDE:
        k *= MAX_SIDE / max(w, h)
        w, h = max(8, int((x1 - x0) * k)), max(8, int((y1 - y0) * k))
    cv = Canvas(w, h, x0, y0, k)
    for im in images:
        px = store.image_pixels(wid, im["id"])
        if px:
            cv.image(im, px, fade=fade_images)
    order = [s for s in strokes if s["tool"] == "highlighter"] + [s for s in strokes if s["tool"] != "highlighter"]
    for s in order:
        cv.stroke(s, None if focus is None or s["id"] in focus else FADED)
    return cv.png(), {"width": w, "height": h, "scale": round(k, 3), "tokens": math.ceil(w * h / TOKEN_PX)}


def group_shots(items, slack=2.0):
    """Merge neighbouring (box, payload) items, in reading order, into one shot when
    the shared crop costs at most `slack` times their separate crops. Fewer, still
    tight images: each image carries some overhead, and lines of one derivation read
    better together."""
    area = lambda b: max(1, (b[2] - b[0]) * (b[3] - b[1]))
    groups = []
    for box, payload in items:
        if groups:
            g = groups[-1]
            u = union(g[0], box)
            if area(u) <= slack * (g[2] + area(box)) and (u[3] - u[1]) < 700:
                g[0] = u
                g[1].append(payload)
                g[2] += area(box)
                continue
        groups.append([list(box), [payload], area(box)])
    return [(g[0], g[1]) for g in groups]


def _overlaps(a, b):
    return not (a[2] < b[0] or a[0] > b[2] or a[3] < b[1] or a[1] > b[3])


def pad_box(box, page, pad=14):
    return [max(-200, box[0] - pad), max(-200, box[1] - pad), min(page["width"] + 200, box[2] + pad), box[3] + pad]
