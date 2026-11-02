"""File-based storage. Everything lives under DATA_DIR:

    index.json                 folders + workspace metadata
    secret.json                MCP token and cookie-signing key (generated on first start)
    ws/<id>/page.json          the drawing (same model as public/ink.js)
    ws/<id>/claude.json        Claude's notes, transcriptions, image descriptions, questions
    ws/<id>/img/<img>.<ext>    pasted / uploaded image as the browser sent it
    ws/<id>/img/<img>.rgb      deflated RGB pixels of that image (for server-side rendering)
    ws/<id>/img/<img>.json     {"w": .., "h": ..} of the .rgb pixels
"""
import json
import os
import re
import secrets
import threading
import time

DATA_DIR = os.path.abspath(os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "data")))
ID_RE = re.compile(r"^[a-z0-9]{1,40}$", re.I)
STATUSES = ("todo", "doing", "done")
TOOLS = ("pen", "pencil", "highlighter")
PAGE_WIDTH = 1000
DEFAULT_HEIGHT = 1400

_lock = threading.RLock()  # one lock is plenty for a single-user app


def now_ms():
    return int(time.time() * 1000)


def new_id():
    return secrets.token_hex(5)


def _read(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def _write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"))
    os.replace(tmp, path)


def ws_dir(wid):
    if not ID_RE.match(wid or ""):
        raise KeyError(wid)
    return os.path.join(DATA_DIR, "ws", wid)


# ---------------------------------------------------------------------------
# Secrets
# ---------------------------------------------------------------------------

def secrets_file():
    with _lock:
        path = os.path.join(DATA_DIR, "secret.json")
        s = _read(path, {})
        if not s.get("mcp_token") or not s.get("cookie_key"):
            s.setdefault("mcp_token", secrets.token_urlsafe(24))
            s.setdefault("cookie_key", secrets.token_hex(32))
            _write(path, s)
        return s


def update_secrets(fields):
    with _lock:
        s = secrets_file()
        s.update(fields)
        _write(os.path.join(DATA_DIR, "secret.json"), s)


# ---------------------------------------------------------------------------
# Index: folders and workspaces
# ---------------------------------------------------------------------------

def index():
    with _lock:
        return _read(os.path.join(DATA_DIR, "index.json"), {"folders": [], "workspaces": []})


def _save_index(ix):
    _write(os.path.join(DATA_DIR, "index.json"), ix)


def _clean_name(v, fallback):
    v = str(v or "").strip()[:120]
    return v or fallback


def create_folder(name, parent=None):
    with _lock:
        ix = index()
        if parent and not any(f["id"] == parent for f in ix["folders"]):
            parent = None
        f = {"id": new_id(), "name": _clean_name(name, "New folder"), "parent": parent or None}
        ix["folders"].append(f)
        _save_index(ix)
        return f


def update_folder(fid, fields):
    with _lock:
        ix = index()
        f = next((f for f in ix["folders"] if f["id"] == fid), None)
        if not f:
            return None
        if "name" in fields:
            f["name"] = _clean_name(fields["name"], f["name"])
        if "parent" in fields:
            p = fields["parent"] or None
            # refuse to move a folder into itself or one of its own subfolders
            cur = p
            while cur:
                if cur == fid:
                    p = f["parent"]
                    break
                cur = next((x["parent"] for x in ix["folders"] if x["id"] == cur), None)
            f["parent"] = p
        _save_index(ix)
        return f


def delete_folder(fid):
    """Deletes the folder; its subfolders and workspaces move up to its parent."""
    with _lock:
        ix = index()
        f = next((f for f in ix["folders"] if f["id"] == fid), None)
        if not f:
            return False
        for x in ix["folders"]:
            if x["parent"] == fid:
                x["parent"] = f["parent"]
        for w in ix["workspaces"]:
            if w.get("folder") == fid:
                w["folder"] = f["parent"]
        ix["folders"] = [x for x in ix["folders"] if x["id"] != fid]
        _save_index(ix)
        return True


def folder_path(ix, fid):
    names = []
    seen = set()
    while fid and fid not in seen:
        seen.add(fid)
        f = next((f for f in ix["folders"] if f["id"] == fid), None)
        if not f:
            break
        names.append(f["name"])
        fid = f["parent"]
    return " / ".join(reversed(names))


def create_workspace(title, folder=None):
    with _lock:
        ix = index()
        if folder and not any(f["id"] == folder for f in ix["folders"]):
            folder = None
        t = now_ms()
        w = {"id": new_id(), "title": _clean_name(title, "Untitled problem"), "folder": folder or None,
             "status": "todo", "problem": "", "calc": None, "created": t, "updated": t}
        ix["workspaces"].append(w)
        _save_index(ix)
        _write(os.path.join(ws_dir(w["id"]), "page.json"),
               {"v": 1, "id": w["id"], "width": PAGE_WIDTH, "height": DEFAULT_HEIGHT, "strokes": [], "images": [], "texts": []})
        return w


def get_workspace(wid):
    return next((w for w in index()["workspaces"] if w["id"] == wid), None)


def find_workspace(ref):
    """Accepts an id or a (case-insensitive) title, for Claude's convenience."""
    ix = index()
    ref = str(ref or "").strip()
    w = next((w for w in ix["workspaces"] if w["id"] == ref), None)
    if w:
        return w
    low = ref.lower()
    exact = [w for w in ix["workspaces"] if w["title"].lower() == low]
    if len(exact) == 1:
        return exact[0]
    part = [w for w in ix["workspaces"] if low and low in w["title"].lower()]
    return part[0] if len(part) == 1 else None


def update_workspace(wid, fields):
    with _lock:
        ix = index()
        w = next((w for w in ix["workspaces"] if w["id"] == wid), None)
        if not w:
            return None
        if "title" in fields:
            w["title"] = _clean_name(fields["title"], w["title"])
        if "status" in fields and fields["status"] in STATUSES:
            w["status"] = fields["status"]
        if "problem" in fields:
            w["problem"] = str(fields["problem"] or "")[:20000]
        if "folder" in fields:
            fo = fields["folder"] or None
            w["folder"] = fo if (fo is None or any(f["id"] == fo for f in ix["folders"])) else w["folder"]
        if "calc" in fields:
            c = fields["calc"]
            w["calc"] = {"id": int(c["id"]), "name": str(c.get("name", ""))[:200]} if c else None
        w["updated"] = now_ms()
        _save_index(ix)
        return w


def touch(wid):
    with _lock:
        ix = index()
        w = next((w for w in ix["workspaces"] if w["id"] == wid), None)
        if w:
            w["updated"] = now_ms()
            _save_index(ix)


def delete_workspace(wid):
    import shutil
    with _lock:
        ix = index()
        before = len(ix["workspaces"])
        ix["workspaces"] = [w for w in ix["workspaces"] if w["id"] != wid]
        if len(ix["workspaces"]) == before:
            return False
        _save_index(ix)
        # moved to a trash folder rather than deleted outright
        src = ws_dir(wid)
        if os.path.isdir(src):
            dst = os.path.join(DATA_DIR, "trash", f"{wid}-{now_ms()}")
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
        return True


# ---------------------------------------------------------------------------
# Page (drawing) and changes. Mirrors sanitize*/applyChange in public/ink.js.
# ---------------------------------------------------------------------------

def _num(v, lo, hi, dflt):
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v or v in (float("inf"), float("-inf")):
        return dflt
    return min(hi, max(lo, v))


def sanitize_stroke(s):
    if not isinstance(s, dict) or not ID_RE.match(str(s.get("id", ""))) or not isinstance(s.get("pts"), list):
        return None
    pts = []
    for p in s["pts"][:20000]:
        if not isinstance(p, list) or len(p) < 2:
            continue
        x = _num(p[0], -1e5, 1e5, None)
        y = _num(p[1], -1e5, 1e5, None)
        if x is None or y is None:
            continue
        pts.append([x, y, _num(p[2] if len(p) > 2 else None, 0, 1, 0.5), _num(p[3] if len(p) > 3 else None, 0, 1, 0)])
    if not pts:
        return None
    color = s.get("color")
    out = {
        "id": s["id"],
        "z": _num(s.get("z"), 0, 2 ** 53, now_ms()),
        "tool": s.get("tool") if s.get("tool") in TOOLS else "pen",
        "color": color if isinstance(color, str) and re.match(r"^#[0-9a-f]{6}$", color, re.I) else "#1f1f1f",
        "size": _num(s.get("size"), 0.3, 200, 3),
        "pts": pts,
    }
    if s.get("dash") in ("dash", "dot"):
        out["dash"] = s["dash"]
    if s.get("by") == "claude":
        out["by"] = "claude"
    return out


def sanitize_text(t):
    if not isinstance(t, dict) or not ID_RE.match(str(t.get("id", ""))):
        return None
    color = t.get("color")
    out = {
        "id": t["id"],
        "z": _num(t.get("z"), 0, 2 ** 53, now_ms()),
        "x": _num(t.get("x"), -1e5, 1e5, 0),
        "y": _num(t.get("y"), -1e5, 1e5, 0),
        "w": _num(t.get("w"), 20, 1000, 400),
        "md": str(t.get("md") or "")[:8000],
        "color": color if isinstance(color, str) and re.match(r"^#[0-9a-f]{6}$", color, re.I) else "#1f1f1f",
        "size": _num(t.get("size"), 8, 120, 22),
    }
    if t.get("by") == "claude":
        out["by"] = "claude"
    return out


def sanitize_image(i):
    if not isinstance(i, dict) or not ID_RE.match(str(i.get("id", ""))):
        return None
    return {
        "id": i["id"],
        "z": _num(i.get("z"), 0, 2 ** 53, now_ms()),
        "x": _num(i.get("x"), -1e5, 1e5, 0),
        "y": _num(i.get("y"), -1e5, 1e5, 0),
        "w": _num(i.get("w"), 4, 1e5, 100),
        "h": _num(i.get("h"), 4, 1e5, 100),
        **({"name": str(i["name"])[:120]} if i.get("name") else {}),
    }


def sanitize_change(c):
    if not isinstance(c, dict):
        return None
    out = {}
    ids = lambda v: [x for x in v if isinstance(x, str) and ID_RE.match(x)] if isinstance(v, list) else []
    if "remove" in c:
        out["remove"] = ids(c["remove"])
    if "add" in c and isinstance(c["add"], list):
        out["add"] = [s for s in map(sanitize_stroke, c["add"]) if s]
    if "imgRemove" in c:
        out["imgRemove"] = ids(c["imgRemove"])
    if "imgAdd" in c and isinstance(c["imgAdd"], list):
        out["imgAdd"] = [i for i in map(sanitize_image, c["imgAdd"]) if i]
    if "textRemove" in c:
        out["textRemove"] = ids(c["textRemove"])
    if "textAdd" in c and isinstance(c["textAdd"], list):
        out["textAdd"] = [t for t in map(sanitize_text, c["textAdd"]) if t]
    if "height" in c:
        h = _num(c["height"], 100, 40000, None)
        if h is not None:
            out["height"] = h
    return out


def load_page(wid):
    d = _read(os.path.join(ws_dir(wid), "page.json"), None)
    if d is None:
        d = {"v": 1, "id": wid, "width": PAGE_WIDTH, "height": DEFAULT_HEIGHT, "strokes": [], "images": [], "texts": []}
    d.setdefault("images", [])
    d.setdefault("texts", [])
    return d


def apply_change(wid, change):
    with _lock:
        d = load_page(wid)
        if change.get("remove"):
            rm = set(change["remove"])
            d["strokes"] = [s for s in d["strokes"] if s["id"] not in rm]
        if change.get("add"):
            add_ids = {s["id"] for s in change["add"]}
            d["strokes"] = [s for s in d["strokes"] if s["id"] not in add_ids] + change["add"]
            d["strokes"].sort(key=lambda s: s["z"])
        if change.get("imgRemove") or change.get("imgAdd"):
            rm = set(change.get("imgRemove") or []) | {i["id"] for i in change.get("imgAdd") or []}
            d["images"] = [i for i in d["images"] if i["id"] not in rm] + (change.get("imgAdd") or [])
            d["images"].sort(key=lambda i: i["z"])
        if change.get("textRemove") or change.get("textAdd"):
            rm = set(change.get("textRemove") or []) | {t["id"] for t in change.get("textAdd") or []}
            d["texts"] = [t for t in d["texts"] if t["id"] not in rm] + (change.get("textAdd") or [])
            d["texts"].sort(key=lambda t: t["z"])
        if "height" in change:
            d["height"] = change["height"]
        _write(os.path.join(ws_dir(wid), "page.json"), d)
    touch(wid)
    return d


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------

IMAGE_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}


def save_image(wid, iid, mime, data, rgb_w, rgb_h, rgb_deflated):
    if not ID_RE.match(iid) or mime not in IMAGE_TYPES:
        raise ValueError("bad image")
    d = os.path.join(ws_dir(wid), "img")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, f"{iid}.{IMAGE_TYPES[mime]}"), "wb") as f:
        f.write(data)
    if rgb_deflated:
        with open(os.path.join(d, f"{iid}.rgb"), "wb") as f:
            f.write(rgb_deflated)
        _write(os.path.join(d, f"{iid}.json"), {"w": rgb_w, "h": rgb_h, "mime": mime})


def image_file(wid, iid):
    if not ID_RE.match(iid or ""):
        return None, None
    d = os.path.join(ws_dir(wid), "img")
    for mime, ext in IMAGE_TYPES.items():
        p = os.path.join(d, f"{iid}.{ext}")
        if os.path.exists(p):
            return p, mime
    return None, None


def image_pixels(wid, iid):
    """(w, h, raw RGB bytes) of an image, or None."""
    import zlib
    d = os.path.join(ws_dir(wid), "img")
    meta = _read(os.path.join(d, f"{iid}.json"), None)
    try:
        with open(os.path.join(d, f"{iid}.rgb"), "rb") as f:
            raw = zlib.decompress(f.read())
    except (FileNotFoundError, zlib.error):
        return None
    if not meta or len(raw) != meta["w"] * meta["h"] * 3:
        return None
    return meta["w"], meta["h"], raw


# ---------------------------------------------------------------------------
# Claude's side of a workspace
#   notes:        [{id, at, md, reply_to?}]       shown in the app's Claude panel
#   transcripts:  [{id, at, strokes: [ids], text}] what Claude has already read
#   images:       {imgId: {at, text}}             image descriptions
#   questions:    [{id, at, text, answered}]      asked from the app
# ---------------------------------------------------------------------------

def load_claude(wid):
    c = _read(os.path.join(ws_dir(wid), "claude.json"), {})
    c.setdefault("notes", [])
    c.setdefault("transcripts", [])
    c.setdefault("images", {})
    c.setdefault("questions", [])
    return c


def update_claude(wid, fn):
    with _lock:
        c = load_claude(wid)
        result = fn(c)
        _write(os.path.join(ws_dir(wid), "claude.json"), c)
        return result
