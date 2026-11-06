"""MCP server (Streamable HTTP, JSON responses) at /mcp.

This is how Claude reaches ProblemVault without the API: Claude Desktop, Claude
Code and claude.ai custom connectors all speak MCP and run on your normal
subscription. The tools are shaped to keep token use low (see render.py):
text first, images only for ink Claude hasn't read yet, cropped tight.
"""
import base64
import datetime
import json
import math
import re
import threading
import time

from . import calcvault, events, inkvault, render, store, webassign
from .latex2mml import latex_to_mathml

PROTOCOL = "2025-06-18"
INSTRUCTIONS = """ProblemVault holds a student's homework: one workspace per problem, each a page of
handwriting (pen ink) drawn over optional pasted images (circuits, equations, figures).

Read cheaply: call get_workspace first. It gives the typed problem text, what you already
transcribed, image descriptions and open questions as TEXT. Only call view_ink for blocks
marked NEW/PARTIAL/EDITED (or images with no description), then save what you read with
save_transcription / describe_image so nobody pays to read it again. Grey ink in a view is
already transcribed context. Answer the student with post_note (Markdown, $LaTeX$); it appears
next to their work. To work WITH them on the page itself, use write (typed text/LaTeX placed beside a
block or at x/y) and draw (arrows, circles, underlines, ticks, crosses), both live and in your own
colour; clean up with remove_marks. When checking work that has a linked CalcVault calculator, call
calcvault_read each time (it is always fresh) and compare its values with the page. If a WebAssign
question is linked, webassign_read shows the real question and which answers WebAssign marked wrong.
When the inkvault_* tools are listed, the student's class notes are there: inkvault_search them for the
method or formula the class used, then inkvault_read the best note. Help them learn: point at the step that's wrong, don't just hand
over answers unless asked."""


def ask_tools_prompt():
    from .ask import tools_prompt  # ask imports this module too
    return tools_prompt()


S = {"type": "string"}
WS = {"type": "string", "description": "Workspace id (or its exact title)"}

TOOLS = [
    {"name": "list_workspaces", "description": "List homework workspaces (folders, status, unread ink, open questions).",
     "inputSchema": {"type": "object", "properties": {"query": {**S, "description": "Filter by title or folder"}}}},
    {"name": "get_workspace", "description": "Text overview of one workspace: problem text, transcribed ink, ink blocks not read yet, images, Claude notes, open questions, linked CalcVault calculator. Cheap; call this before view_ink.",
     "inputSchema": {"type": "object", "properties": {"workspace": WS}, "required": ["workspace"]}},
    {"name": "view_ink", "description": "See handwriting/images as small, tightly cropped PNGs. what='unread' (default): one image per block not yet transcribed, already-read ink drawn grey. 'blocks': the given block ids. 'image': one pasted image with the ink on it. 'page': the whole page, small. 'region': a box in page units (page is 1000 wide).",
     "inputSchema": {"type": "object", "properties": {
         "workspace": WS,
         "what": {"type": "string", "enum": ["unread", "blocks", "image", "page", "region"]},
         "blocks": {"type": "array", "items": S},
         "image": S,
         "region": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"}, "w": {"type": "number"}, "h": {"type": "number"}}},
         "scale": {"type": "number", "description": "Pixels per page unit. Omit for auto (sized to the handwriting). Raise it only if something is unreadable."}},
         "required": ["workspace"]}},
    {"name": "save_transcription", "description": "Store what a block of handwriting says (LaTeX for math, e.g. 'V = IR \\\\Rightarrow I = \\\\frac{12}{4}'). Next time get_workspace returns this text instead of needing the image.",
     "inputSchema": {"type": "object", "properties": {"workspace": WS, "block": S, "blocks": {"type": "array", "items": S, "description": "Several block ids that one text covers (e.g. a grouped view)"}, "text": S}, "required": ["workspace", "text"]}},
    {"name": "describe_image", "description": "Store a description of a pasted image (circuit topology with component values, the printed equation as LaTeX, figure contents) so it never needs viewing again.",
     "inputSchema": {"type": "object", "properties": {"workspace": WS, "image": S, "text": S}, "required": ["workspace", "image", "text"]}},
    {"name": "equation_sheet", "description": "The equation sheet the student uploaded for this problem's class folder, if any. Returns your saved LaTeX copy, or page images the first time. Use it when asked for equations, or to derive an equation from the sheet when asked.",
     "inputSchema": {"type": "object", "properties": {"workspace": WS}, "required": ["workspace"]}},
    {"name": "save_equation_sheet", "description": "Store the full equation sheet as LaTeX, in its order and with its headings, after equation_sheet showed you the page images. Next time equation_sheet returns this text instead of the images.",
     "inputSchema": {"type": "object", "properties": {"workspace": WS, "text": S}, "required": ["workspace", "text"]}},
    {"name": "post_note", "description": "Show a note to the student beside their work (Markdown with $inline$ / $$block$$ LaTeX). Use answers=<question id> when replying to a question they asked.",
     "inputSchema": {"type": "object", "properties": {"workspace": WS, "markdown": S, "answers": S}, "required": ["workspace", "markdown"]}},
    {"name": "write", "description": "Type on the student's page, live, in Claude's colour: a hint, a corrected step, a label. Markdown with $LaTeX$. It never covers the student's writing (moved to the nearest free spot if needed). Place it with near_block (put beside/under that block of their writing) or x/y in page units (page is 1000 wide; view_ink captions give box coords: page_x = box_x0 + pixel_x / scale). With neither, it goes below everything. Returns the mark id.",
     "inputSchema": {"type": "object", "properties": {
         "workspace": WS, "text": S, "near_block": S,
         "x": {"type": "number"}, "y": {"type": "number"},
         "width": {"type": "number", "description": "Wrap width in page units (default fits the space)"},
         "size": {"type": "number", "description": "Font size in page units (default 22, about handwriting size)"},
         "color": {"type": "string", "description": "#rrggbb (default Claude orange)"}},
         "required": ["workspace", "text"]}},
    {"name": "draw", "description": "Draw on the student's page, live, as ink they can erase or move: point at a mistake, circle a term, add a missing current arrow. Coordinates in page units (1000 wide). Shapes: {type:'arrow'|'line', from:[x,y], to:[x,y]}, {type:'circle', center:[x,y], r} or rx/ry for an ellipse, {type:'rect', x, y, w, h}, {type:'underline', x1, x2, y}, {type:'check'|'cross', at:[x,y], size}, {type:'path', points:[[x,y],...]}. Optional per shape: color, width (1-8). Returns mark ids.",
     "inputSchema": {"type": "object", "properties": {"workspace": WS, "shapes": {"type": "array", "items": {"type": "object"}}}, "required": ["workspace", "shapes"]}},
    {"name": "remove_marks", "description": "Remove text or drawings YOU added (by mark id from write/draw, or all=true for all of yours). Never removes the student's work.",
     "inputSchema": {"type": "object", "properties": {"workspace": WS, "ids": {"type": "array", "items": S}, "all": {"type": "boolean"}}, "required": ["workspace"]}},
    {"name": "update_workspace", "description": "Change a workspace's title, status (todo/doing/done) or typed problem statement.",
     "inputSchema": {"type": "object", "properties": {"workspace": WS, "title": S, "status": {"type": "string", "enum": list(store.STATUSES)}, "problem": S}, "required": ["workspace"]}},
    {"name": "create_workspace", "description": "Create a workspace for a new problem, optionally in a folder (folder name or id; created if missing).",
     "inputSchema": {"type": "object", "properties": {"title": S, "folder": S, "problem": S}, "required": ["title"]}},
    {"name": "webassign_read", "description": "The WebAssign question linked to this workspace (text with $LaTeX$), the state of each answer box (correct / incorrect / empty, locked), and its figures (circuits, graphs) as images. Fresh from WebAssign. Read-only: the student submits answers themselves. Use figures=false when you already saw them (saves tokens).",
     "inputSchema": {"type": "object", "properties": {"workspace": WS, "figures": {"type": "boolean", "description": "Include the question's figures (default true)"}}, "required": ["workspace"]}},
    {"name": "calcvault_read", "description": "Lines of the CalcVault calculator linked to this workspace (LaTeX).",
     "inputSchema": {"type": "object", "properties": {"workspace": WS}, "required": ["workspace"]}},
    {"name": "calcvault_add_lines", "description": "Append lines to the workspace's CalcVault calculator (creates and links one if none). Lines: {latex} for an equation such as 'R_1=4' or 'I=\\\\frac{V}{R_1}'; {role:'input', var, label, value}; {role:'output', label, latex}. The student's CalcVault computes the values.",
     "inputSchema": {"type": "object", "properties": {"workspace": WS, "lines": {"type": "array", "items": {"type": "object"}}}, "required": ["workspace", "lines"]}},
]

_SUBMIT_TOOL = {"name": "webassign_submit", "description": "Type the student's circled final answers into the linked WebAssign question and submit it. ONLY when the student pressed Submit in ProblemVault (otherwise it is refused), and only after you checked that their work is right and each answer is circled. Answers exactly as the student wrote them (same digits, rounding and sign; no units). Math boxes take LaTeX, e.g. {\"RA_1_1\": \"7.2\"}; matrix boxes take \"[a,b;c,d]\" (',' between columns, ';' between rows); multiple-choice and drop-down boxes take the option value from webassign_read, select-all (checkbox) boxes a list of values. Graph boxes cannot be filled. Box names come from webassign_read. Returns which answers WebAssign marked correct.",
                "inputSchema": {"type": "object", "properties": {"workspace": WS, "answers": {"type": "object", "description": "box name -> answer (LaTeX for math boxes)"}}, "required": ["workspace", "answers"]}}
TOOLS.append(_SUBMIT_TOOL)

# The student's Submit button allows ONE submission of that workspace's question, for 15 minutes.
_permits = {}
_permit_lock = threading.Lock()


def allow_submit(wid, minutes=15):
    with _permit_lock:
        _permits[wid] = time.time() + minutes * 60


def _take_permit(wid):
    with _permit_lock:
        ok = _permits.pop(wid, 0) > time.time()
    return ok

# listed only while InkVault is connected and switched on
INKVAULT_TOOLS = [
    {"name": "inkvault_search", "description": "Search the student's InkVault class notes (typed text) for words. Returns note paths with matching lines. Without q, lists every note with when it changed.",
     "inputSchema": {"type": "object", "properties": {"q": {"type": "string", "description": "Words to find; omit to list all notes"}}}},
    {"name": "inkvault_read", "description": "One InkVault note: its Markdown text, plus its handwriting (cropped to the ink, ~200-400 tokens each) and photos as images, in note order. Use images=false for the text only.",
     "inputSchema": {"type": "object", "properties": {"path": {"type": "string", "description": "Note path from inkvault_search"},
                                                      "images": {"type": "boolean", "description": "Include handwriting and photos (default true)"},
                                                      "max_images": {"type": "integer", "description": "Default 6, max 12"}}, "required": ["path"]}},
]


def tools():
    return TOOLS + (INKVAULT_TOOLS if inkvault.enabled() else [])


class ToolError(Exception):
    pass


def _ws(args):
    w = store.find_workspace(args.get("workspace"))
    if not w:
        raise ToolError(f"No workspace {args.get('workspace')!r}. Use list_workspaces.")
    return w


def _ago(ms):
    d = datetime.datetime.now() - datetime.datetime.fromtimestamp(ms / 1000)
    s = d.total_seconds()
    if s < 90:
        return "just now"
    if s < 5400:
        return f"{int(s // 60)} min ago"
    if s < 129600:
        return f"{int(s // 3600)} h ago"
    return f"{int(s // 86400)} d ago"


def _unread_count(wid):
    page = store.load_page(wid)
    c = store.load_claude(wid)
    live = {s["id"] for s in page["strokes"]}
    n = sum(1 for b in render.blocks(page) if render.block_status(b, c["transcripts"], live)[0] != "read")
    n += sum(1 for im in page["images"] if im["id"] not in c["images"])
    return n, sum(1 for q in c["questions"] if not q.get("answered"))


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------

def t_list_workspaces(args):
    ix = store.index()
    q = str(args.get("query") or "").lower()
    rows = []
    for w in sorted(ix["workspaces"], key=lambda w: -w["updated"]):
        path = store.folder_path(ix, w.get("folder"))
        if q and q not in w["title"].lower() and q not in path.lower():
            continue
        unread, questions = _unread_count(w["id"])
        extra = []
        if unread:
            extra.append(f"{unread} unread")
        if questions:
            extra.append(f"{questions} open question{'s' * (questions > 1)}")
        rows.append(f"{w['id']} · {path + ' / ' if path else ''}{w['title']} [{w['status']}] {_ago(w['updated'])}"
                    + (f" — {', '.join(extra)}" if extra else ""))
    return "\n".join(rows) or "No workspaces yet."


def t_get_workspace(args):
    w = _ws(args)
    wid = w["id"]
    ix = store.index()
    page = store.load_page(wid)
    c = store.load_claude(wid)
    live = {s["id"] for s in page["strokes"]}
    out = [f"# {w['title']}  (id {wid}, {w['status']}, folder: {store.folder_path(ix, w.get('folder')) or '-'})"]
    if w.get("problem"):
        out.append(f"\nProblem (typed):\n{w['problem']}")
    if page["images"]:
        out.append("\nImages:")
        for im in page["images"]:
            d = c["images"].get(im["id"])
            where = f"at x{round(im['x'])} y{round(im['y'])} {round(im['w'])}×{round(im['h'])}"
            out.append(f"- {im['id']} {im.get('name', '')} {where}: " + (d["text"] if d else "NOT DESCRIBED (view_ink what=image)"))
    bl = render.blocks(page)
    if bl:
        out.append("\nInk, top to bottom:")
        shown = set()  # a transcript covering several blocks is printed once
        for b in bl:
            status, cover, unread = render.block_status(b, c["transcripts"], live)
            y = f"x{b['box'][0]}–{b['box'][2]} y{b['box'][1]}–{b['box'][3]}"
            text = " | ".join("(same text as above)" if t["id"] in shown else t["text"] for t in cover)
            shown.update(t["id"] for t in cover)
            if status == "read":
                out.append(f"- {b['id']} {y}: {text}")
            elif status == "new":
                out.append(f"- {b['id']} {y}: NEW ({len(unread)} strokes)")
            elif status == "partial":
                out.append(f"- {b['id']} {y}: PARTIAL, {len(unread)} new strokes. Read so far: {text}")
            else:
                out.append(f"- {b['id']} {y}: EDITED (some ink erased since). Was: {text}")
    else:
        out.append("\nNo ink yet.")
    if page["texts"]:
        out.append("\nTyped text on the page:")
        for t in page["texts"]:
            who = "you (Claude)" if t.get("by") == "claude" else "student"
            out.append(f"- {t['id']} by {who} at x{round(t['x'])} y{round(t['y'])}: {t['md'][:300]}")
    mine = {s["id"].split("s")[0] for s in page["strokes"] if s.get("by") == "claude"}
    if mine:
        out.append(f"\nYour drawn marks still on the page: {', '.join(sorted(mine))}")
    out.append(f"\nPage: 1000 wide, {round(page['height'])} tall; content ends near y{round(_content_bottom(page))}.")
    if w.get("wa"):
        out.append(f"\nWebAssign: {w['wa']['name']} question {w['wa']['number']} — webassign_read for the question and answer status")
    _, sheet = store.sheet_for_folder(w.get("folder"))
    if sheet:
        out.append(f"\nEquation sheet: {sheet['name']} — equation_sheet to read it")
    if w.get("calc"):
        out.append(f"\nCalcVault calculator: {w['calc']['name']} (id {w['calc']['id']}) — calcvault_read for its lines")
    open_q = [q for q in c["questions"] if not q.get("answered")]
    if open_q:
        out.append("\nOpen questions from the student (answer with post_note answers=<id>):")
        from .ask import question_text  # a one-tap request carries its full instructions
        out += [f"- {q['id']}: {question_text(q)}" for q in open_q]
    if c["notes"]:
        out.append(f"\nYour last note ({_ago(c['notes'][-1]['at'])}):\n{c['notes'][-1]['md'][:600]}")
    return "\n".join(out)


def t_view_ink(args):
    w = _ws(args)
    wid = w["id"]
    page = store.load_page(wid)
    c = store.load_claude(wid)
    live = {s["id"] for s in page["strokes"]}
    what = args.get("what") or "unread"
    scale = args.get("scale")
    scale = min(3.0, max(0.2, float(scale))) if isinstance(scale, (int, float)) else None
    described = set(c["images"])
    shots = []  # (caption, png, info)

    def fade_for(box):
        ims = [im for im in page["images"] if render._overlaps([im["x"], im["y"], im["x"] + im["w"], im["y"] + im["h"]], box)]
        return bool(ims) and all(im["id"] in described for im in ims)

    def shoot(caption, box, focus=None, fade=None):
        box = render.pad_box(box, page)
        png, info = render.render(wid, page, box, scale=scale, focus=focus, fade_images=fade_for(box) if fade is None else fade)
        shots.append((f"{caption} (box x{round(box[0])} y{round(box[1])} → x{round(box[2])} y{round(box[3])}, ×{info['scale']}, ~{info['tokens']} tokens)", png))

    blocks = render.blocks(page)
    if what == "unread":
        for im in page["images"]:
            if im["id"] not in described and len(shots) < 3:
                shoot(f"Image {im['id']} (not described yet)", [im["x"], im["y"], im["x"] + im["w"], im["y"] + im["h"]], fade=False)
        todo = []
        for b in blocks:
            status, _, unread = render.block_status(b, c["transcripts"], live)
            if status != "read":
                todo.append((b["box"], (b, status, set(b["strokes"]) if status == "edited" else set(unread))))
        for box, members in render.group_shots(todo)[:8]:
            ids = ", ".join(f"{b['id']} [{st}]" for b, st, _ in members)
            label = "Block" if len(members) == 1 else "Blocks (top to bottom)"
            shoot(f"{label} {ids}", box, focus=set().union(*[f for _, _, f in members]))
        if not shots:
            return [{"type": "text", "text": "Nothing unread: every block is transcribed and every image described. get_workspace has the text."}]
    elif what == "blocks":
        want = set(args.get("blocks") or [])
        for b in blocks:
            if b["id"] in want:
                shoot(f"Block {b['id']}", b["box"])
        if not shots:
            raise ToolError("None of those blocks exist any more (ink changed). Call get_workspace for current block ids.")
    elif what == "image":
        im = next((i for i in page["images"] if i["id"] == args.get("image")), None)
        if not im:
            raise ToolError("No such image. Image ids are listed by get_workspace.")
        shoot(f"Image {im['id']} with ink", [im["x"], im["y"], im["x"] + im["w"], im["y"] + im["h"]], fade=False)
    elif what == "page":
        bottom = max([b["box"][3] for b in blocks] + [im["y"] + im["h"] for im in page["images"]] + [200])
        box = [0, 0, page["width"], min(page["height"], bottom + 20)]
        if scale is None:
            scale = min(0.6, render.MAX_SIDE / max(box[2], box[3]))
        shoot("Whole page", box, fade=False)
    elif what == "region":
        r = args.get("region") or {}
        try:
            box = [float(r["x"]), float(r["y"]), float(r["x"]) + float(r["w"]), float(r["y"]) + float(r["h"])]
        except (KeyError, TypeError, ValueError):
            raise ToolError("region needs x, y, w, h in page units") from None
        shoot("Region", box, fade=False)
    else:
        raise ToolError(f"Unknown what={what!r}")

    content = []
    for caption, png in shots:
        content.append({"type": "text", "text": caption})
        content.append({"type": "image", "data": base64.b64encode(png).decode(), "mimeType": "image/png"})
    content.append({"type": "text", "text": "Save what you read with save_transcription (blocks) / describe_image (images)."})
    return content


def t_save_transcription(args):
    w = _ws(args)
    wid = w["id"]
    page = store.load_page(wid)
    want = [args["block"]] if args.get("block") else list(args.get("blocks") or [])
    found = [b for b in render.blocks(page) if b["id"] in want]
    if not found or len(found) < len(set(want)):
        raise ToolError("Some of those blocks no longer exist (the ink changed). Call get_workspace for current ids.")
    text = str(args.get("text") or "").strip()[:4000]
    strokes = [s for b in found for s in b["strokes"]]
    sids = set(strokes)

    def fn(c):
        # one transcript per block: replaces whatever covered parts of it before
        c["transcripts"] = [t for t in c["transcripts"] if not set(t["strokes"]) & sids]
        c["transcripts"].append({"id": store.new_id(), "at": store.now_ms(), "strokes": strokes, "text": text})
    store.update_claude(wid, fn)
    events.publish(wid, {"type": "claude"})
    return f"Saved transcription for {', '.join(b['id'] for b in found)}."


def t_equation_sheet(args):
    w = _ws(args)
    fid, sheet = store.sheet_for_folder(w.get("folder"))
    if not sheet:
        return "No equation sheet for this problem. Do not mention a sheet."
    if sheet.get("text"):
        return f"Equation sheet: {sheet['name']}\n\n{sheet['text']}"
    content = [{"type": "text", "text": f"Equation sheet: {sheet['name']}. Read every equation, then call save_equation_sheet with all of them as LaTeX so nobody pays to read the images again."}]
    for i in range(1, sheet["pages"] + 1):
        with open(store.sheet_path(fid, f"page{i}.png"), "rb") as f:
            content.append({"type": "image", "data": base64.b64encode(f.read()).decode(), "mimeType": "image/png"})
    return content


def t_save_equation_sheet(args):
    w = _ws(args)
    fid, sheet = store.sheet_for_folder(w.get("folder"))
    if not sheet:
        raise ToolError("This problem has no equation sheet.")
    if not str(args.get("text") or "").strip():
        raise ToolError("text is empty.")
    store.set_sheet_text(fid, args["text"])
    return "Saved."


def t_describe_image(args):
    w = _ws(args)
    wid = w["id"]
    page = store.load_page(wid)
    if not any(i["id"] == args.get("image") for i in page["images"]):
        raise ToolError("No such image.")
    text = str(args.get("text") or "").strip()[:6000]
    store.update_claude(wid, lambda c: c["images"].__setitem__(args["image"], {"at": store.now_ms(), "text": text}))
    events.publish(wid, {"type": "claude"})
    return "Saved image description."


def post_note(wid, md, answers=None, by=None):
    note = {"id": store.new_id(), "at": store.now_ms(), "md": str(md)[:40000]}
    if by == "gemini":
        note["by"] = "gemini"
    if answers:
        note["reply_to"] = answers

    def fn(c):
        c["notes"].append(note)
        for q in c["questions"]:
            if q["id"] == answers:
                q["answered"] = True
    store.update_claude(wid, fn)
    events.publish(wid, {"type": "claude"})
    return note


def t_post_note(args):
    w = _ws(args)
    post_note(w["id"], args.get("markdown") or "", args.get("answers"))
    return "Posted. The student sees it in the Claude panel of the workspace."


# ---------------------------------------------------------------------------
# Claude on the page: typed text and ink marks, pushed live to open browsers
# ---------------------------------------------------------------------------

CLAUDE_COLOR = "#d9480f"


def _color(v, dflt=CLAUDE_COLOR):
    return v if isinstance(v, str) and len(v) == 7 and v.startswith("#") else dflt


def _content_bottom(page):
    ys = [render.stroke_bbox(s)[3] for s in page["strokes"]] + [i["y"] + i["h"] for i in page["images"]]
    ys += [t["y"] + _text_height(t) for t in page.get("texts", [])]
    return max(ys + [0])


def _text_height(t):
    # rough: line count at ~0.5 em per character; only used for placement
    chars_per_line = max(8, t["w"] / (t["size"] * 0.5))
    lines = sum(max(1, -(-len(ln) // int(chars_per_line))) for ln in t["md"].split("\n"))
    return lines * t["size"] * 1.5


def _apply(wid, change):
    change = store.sanitize_change(change)
    page = store.apply_change(wid, change)
    events.publish(wid, {"type": "change", "change": change})
    return page


def _grow(page, bottom, change):
    if bottom > page["height"] - 80:
        change["height"] = min(40000, int(bottom + 300))
    return change


def _occupied(page):
    """Boxes Claude's typed notes must not cover: the student's ink, images and other typed text."""
    boxes = [b["box"] for b in render.blocks(page)]
    boxes += [[i["x"], i["y"], i["x"] + i["w"], i["y"] + i["h"]] for i in page["images"]]
    boxes += [[t["x"], t["y"], t["x"] + t["w"], t["y"] + _text_height(t)] for t in page.get("texts", [])]
    return boxes


def _free_spot(page, x, y, w, h):
    """(x, y, w) nearest below the wanted spot where a w x h note covers nothing.
    Tries the spot, then narrower to fit beside the content, then each gap lower down."""
    taken = _occupied(page)
    clear = lambda x0, y0, ww: not any(render._overlaps([x0, y0 - 4, x0 + ww, y0 + h + 4], o) for o in taken)
    for yy in sorted({y} | {o[3] + 10 for o in taken if o[3] + 10 > y}):
        if clear(x, yy, w):
            return x, yy, w
        # beside whatever is in the way on this row, if there's a usable strip
        row = [o for o in taken if o[1] < yy + h + 4 and o[3] > yy - 4]
        right = max([o[2] for o in row if o[0] < x + w] + [x]) + 20
        if page["width"] - right - 20 >= 220 and clear(right, yy, page["width"] - right - 20):
            return right, yy, page["width"] - right - 20
    return x, max(y, _content_bottom(page) + 30), w


def t_write(args):
    w = _ws(args)
    wid = w["id"]
    page = store.load_page(wid)
    text = str(args.get("text") or "").strip()
    if not text:
        raise ToolError("text is empty")
    size = min(60, max(10, float(args.get("size") or 22)))
    x, y, width = args.get("x"), args.get("y"), args.get("width")
    if args.get("near_block"):
        b = next((b for b in render.blocks(page) if b["id"] == args["near_block"]), None)
        if not b:
            raise ToolError("No such block (ink changed?). get_workspace lists current ids.")
        x0, y0, x1, y1 = b["box"]
        # beside it if the strip to its right is empty, else below it
        others = [o["box"] for o in render.blocks(page) if o["id"] != b["id"]]
        others += [[i["x"], i["y"], i["x"] + i["w"], i["y"] + i["h"]] for i in page["images"]]
        others += [[t["x"], t["y"], t["x"] + t["w"], t["y"] + _text_height(t)] for t in page["texts"]]
        right = [x1 + 24, y0 - 4, page["width"], max(y1, y0 + size * 1.6) + 4]
        if page["width"] - x1 - 30 >= 220 and not any(render._overlaps(right, o) for o in others):
            x, y, width = x1 + 24, y0, width or page["width"] - x1 - 44
        else:
            x, y, width = x0, y1 + 12, width or page["width"] - x0 - 20
    if x is None or y is None:
        x = 40 if x is None else x
        y = _content_bottom(page) + 30 if y is None else y
    width = float(width or max(200, page["width"] - float(x) - 20))
    t = {"id": "c" + store.new_id(), "z": store.now_ms() * 1000, "x": float(x), "y": float(y), "w": width,
         "md": text, "color": _color(args.get("color")), "size": size, "by": "claude"}
    # never cover the student's writing: slide to the nearest free spot
    t["x"], t["y"], t["w"] = _free_spot(page, t["x"], t["y"], t["w"], _text_height(t))
    _apply(wid, _grow(page, t["y"] + _text_height(t), {"textAdd": [t]}))
    return f"Wrote mark {t['id']} at x{round(t['x'])} y{round(t['y'])} (width {round(t['w'])}). The student sees it now."


def _dense(pts, step=2.0):
    out = [pts[0]]
    for a, b in zip(pts, pts[1:]):
        n = max(1, int(math.hypot(b[0] - a[0], b[1] - a[1]) / step))
        out += [[a[0] + (b[0] - a[0]) * i / n, a[1] + (b[1] - a[1]) * i / n] for i in range(1, n + 1)]
    return [[round(p[0], 1), round(p[1], 1), 0.55, 0] for p in out]


def _shape_paths(sh):
    """A shape -> list of polylines in page units."""
    kind = sh.get("type")
    P = lambda v: [float(v[0]), float(v[1])]
    if kind in ("line", "arrow"):
        a, b = P(sh["from"]), P(sh["to"])
        paths = [[a, b]]
        if kind == "arrow":
            ang = math.atan2(b[1] - a[1], b[0] - a[0])
            L = min(22, max(10, math.hypot(b[0] - a[0], b[1] - a[1]) * 0.25))
            for d in (2.6, -2.6):
                paths.append([[b[0] + L * math.cos(ang + d), b[1] + L * math.sin(ang + d)], b])
        return paths
    if kind == "circle":
        c = P(sh["center"])
        rx = float(sh.get("rx") or sh.get("r") or 30)
        ry = float(sh.get("ry") or sh.get("r") or rx)
        n = 48
        return [[[c[0] + rx * math.cos(2 * math.pi * i / n - 0.4), c[1] + ry * math.sin(2 * math.pi * i / n - 0.4)] for i in range(n + 3)]]
    if kind == "rect":
        x, y, wd, ht = (float(sh[k]) for k in ("x", "y", "w", "h"))
        return [[[x, y], [x + wd, y], [x + wd, y + ht], [x, y + ht], [x, y]]]
    if kind == "underline":
        y = float(sh["y"])
        return [[[float(sh["x1"]), y], [float(sh["x2"]), y]]]
    if kind in ("check", "cross"):
        x, y = P(sh["at"])
        s = float(sh.get("size") or 24)
        if kind == "check":
            return [[[x - s / 2, y], [x - s / 8, y + s / 2.5], [x + s / 2, y - s / 2]]]
        return [[[x - s / 2, y - s / 2], [x + s / 2, y + s / 2]], [[x + s / 2, y - s / 2], [x - s / 2, y + s / 2]]]
    if kind == "path":
        pts = [P(p) for p in sh.get("points") or []]
        if len(pts) < 2:
            raise ToolError("a path needs at least 2 points")
        return [pts]
    raise ToolError(f"Unknown shape type {kind!r}")


def t_draw(args):
    w = _ws(args)
    wid = w["id"]
    page = store.load_page(wid)
    shapes = [s for s in (args.get("shapes") or []) if isinstance(s, dict)][:40]
    if not shapes:
        raise ToolError("shapes is empty")
    strokes, ids = [], []
    z = store.now_ms() * 1000
    for sh in shapes:
        try:
            paths = _shape_paths(sh)
        except (KeyError, TypeError, ValueError, IndexError) as e:
            raise ToolError(f"Bad {sh.get('type')} shape: missing or wrong {e}") from None
        gid = "c" + store.new_id()
        ids.append(f"{gid} ({sh.get('type')})")
        for i, path in enumerate(paths):
            z += 1
            strokes.append({"id": f"{gid}s{i}", "z": z, "tool": "pen", "color": _color(sh.get("color")),
                            "size": min(8, max(1, float(sh.get("width") or 3))), "pts": _dense(path), "by": "claude"})
    bottom = max(p[1] for s in strokes for p in s["pts"])
    _apply(wid, _grow(page, bottom, {"add": strokes}))
    return "Drew " + ", ".join(ids) + ". The student sees it now; remove_marks takes these ids."


def t_remove_marks(args):
    w = _ws(args)
    wid = w["id"]
    page = store.load_page(wid)
    want = set(args.get("ids") or [])
    every = bool(args.get("all"))
    hit = lambda i: every or i in want or any(i.startswith(g + "s") for g in want)  # draw ids name stroke groups
    strokes = [s["id"] for s in page["strokes"] if s.get("by") == "claude" and hit(s["id"])]
    texts = [t["id"] for t in page["texts"] if t.get("by") == "claude" and hit(t["id"])]
    if not strokes and not texts:
        return "Nothing of yours matched (the student may have erased it already)."
    _apply(wid, {"remove": strokes, "textRemove": texts})
    return f"Removed {len(texts)} text and {len(strokes)} ink stroke(s)."


def t_update_workspace(args):
    w = _ws(args)
    fields = {k: args[k] for k in ("title", "status", "problem") if k in args}
    store.update_workspace(w["id"], fields)
    events.publish(w["id"], {"type": "meta"})
    events.publish("index", {"type": "index"})
    return "Updated."


def t_create_workspace(args):
    folder = args.get("folder")
    fid = None
    if folder:
        ix = store.index()
        f = next((f for f in ix["folders"] if f["id"] == folder or f["name"].lower() == str(folder).lower()), None)
        fid = f["id"] if f else store.create_folder(folder)["id"]
    w = store.create_workspace(args.get("title"), fid)
    if args.get("problem"):
        store.update_workspace(w["id"], {"problem": args["problem"]})
    events.publish("index", {"type": "index"})
    return f"Created workspace {w['id']} ({w['title']})."


def _calc_for(w, create=False):
    if not calcvault.enabled():
        raise ToolError("CalcVault isn't connected to ProblemVault (CALCVAULT_URL / CALCVAULT_PASSWORD).")
    if w.get("calc"):
        return w["calc"]["id"]
    if not create:
        raise ToolError("No CalcVault calculator is linked to this workspace yet (calcvault_add_lines creates one).")
    c = calcvault.create(w["title"])
    store.update_workspace(w["id"], {"calc": {"id": c["id"], "name": c["name"]}})
    events.publish(w["id"], {"type": "meta"})
    return c["id"]


def t_webassign_read(args):
    w = _ws(args)
    if not w.get("wa"):
        raise ToolError("No WebAssign question is linked to this workspace.")
    try:
        a, q = webassign.question(w["wa"]["dep"], w["wa"]["box"], refresh=True)
    except webassign.WebAssignError as e:
        raise ToolError(str(e)) from None
    content = [{"type": "text", "text": webassign.summarize(a, q)}]
    if args.get("figures", True):
        for i, (data, mime) in enumerate(webassign.figures(q), 1):
            content.append({"type": "text", "text": f"Figure {i}:"})
            content.append({"type": "image", "data": base64.b64encode(data).decode(), "mimeType": mime})
    return content


def matrix_value(v):
    """A matrix answer in WebAssign's form "[a,b;c,d]", from that form, rows as lists, or a LaTeX matrix."""
    if isinstance(v, list):
        rows = [r if isinstance(r, list) else [r] for r in v]
    else:
        s = str(v).strip().strip("$")
        m = re.search(r"\\begin\{[a-zA-Z]*matrix\*?\}(.*?)\\end\{[a-zA-Z]*matrix\*?\}", s, re.S)
        if m:
            rows = [r.split("&") for r in re.split(r"\\\\", m.group(1)) if r.strip()]
        elif s.startswith("[") and s.endswith("]"):
            rows = [r.split(",") for r in s[1:-1].split(";")]
        else:
            raise ValueError("matrix answer must look like [a,b;c,d] (',' between columns, ';' between rows)")
    rows = [[str(c).strip().replace(r"\frac", "").replace("{", "(").replace("}", ")").replace(")(", ")/(")
             for c in r] for r in rows]
    rows = [[c[1:-1] if re.fullmatch(r"\(\d+\)", c) else c for c in r] for r in rows]
    if not rows or len({len(r) for r in rows}) != 1 or any(not c for r in rows for c in r):
        raise ValueError("every matrix row needs the same number of entries, none empty")
    return "[" + ";".join(",".join(r) for r in rows) + "]"


def choice_value(v, opts, kind):
    """Option value(s) for a choice box, from option values (or exact option labels)."""
    want = v if isinstance(v, list) else [v]
    if kind != "checkbox" and len(want) != 1:
        raise ValueError("pick exactly one option")
    out = []
    for x in want:
        x = str(x).strip()
        hit = next((o[0] for o in opts if o[0] == x), None)
        if hit is None:
            hit = next((o[0] for o in opts if o[1] and o[1].lower() == x.lower()), None)
        if hit is None or hit == "":  # "" is a drop-down's "--Select--"
            raise ValueError(f"no option {x!r}; options: " + "; ".join(f"{o[0]} = {o[1] or '(image/math)'}" for o in opts))
        out.append(hit)
    return out if kind == "checkbox" else out[0]


def t_webassign_submit(args):
    w = _ws(args)
    if not w.get("wa"):
        raise ToolError("No WebAssign question is linked to this workspace.")
    given = args.get("answers") if isinstance(args.get("answers"), dict) else {}
    if not given:
        raise ToolError("answers is empty")
    try:
        a, q = webassign.question(w["wa"]["dep"], w["wa"]["box"], refresh=True)
    except webassign.WebAssignError as e:
        raise ToolError(str(e)) from None
    parts = {p["name"]: p for p in q.get("parts", [])}
    kinds = ("math", "text", "matrix", "radio", "checkbox", "select")
    bad = [n for n in given if n not in parts or parts[n]["kind"] not in kinds or not parts[n].get("enabled", True)]
    if bad:
        raise ToolError(f"Can't fill {', '.join(bad)}: only open answer boxes of this question ({', '.join(parts)}); "
                        "graph boxes are answered on WebAssign by the student.")
    options = webassign.choice_options(q)
    answers = {n: p["value"] for n, p in parts.items() if p.get("enabled", True) and p.get("value") is not None}
    for n, v in given.items():
        kind = parts[n]["kind"]
        try:
            if kind in ("radio", "checkbox", "select"):
                answers[n] = choice_value(v, options.get(n, []), kind)
            else:
                answers[n] = latex_to_mathml(str(v)) if kind == "math" else matrix_value(v) if kind == "matrix" else str(v)
        except ValueError as e:
            raise ToolError(f"{n}: {e}") from None
    if not _take_permit(w["id"]):  # after the checks: a bad answer does not use up the student's press
        raise ToolError("Not allowed: the student did not press Submit in ProblemVault (or it expired). Tell them their answers instead.")
    try:
        a = webassign.submit(w["wa"]["dep"], w["wa"]["box"], answers, "submit")
    except webassign.WebAssignError as e:
        raise ToolError(f"Submit failed: {e}") from None
    events.publish(w["id"], {"type": "wa-submitted"})
    nq = next((x for x in a.get("questions", []) if x.get("box") == w["wa"]["box"]), None)
    marks = ", ".join(f"{p['name']}: {p.get('mark') or 'no mark'}" for p in (nq or {}).get("parts", []))
    return f"Submitted to WebAssign. {marks or 'No marks returned.'}"


def t_calcvault_read(args):
    w = _ws(args)
    try:
        c = calcvault.get(_calc_for(w))
    except calcvault.CalcVaultError as e:
        raise ToolError(str(e)) from None
    return f"{c['name']} (CalcVault id {c['id']}):\n{calcvault.summarize(c)}"


def t_calcvault_add_lines(args):
    w = _ws(args)
    lines = [ln for ln in (args.get("lines") or []) if isinstance(ln, dict)][:50]
    if not lines:
        raise ToolError("lines is empty")
    try:
        c = calcvault.add_lines(_calc_for(w, create=True), lines)
    except calcvault.CalcVaultError as e:
        raise ToolError(str(e)) from None
    events.publish(w["id"], {"type": "calc"})
    return f"Added {len(lines)} line(s) to {c['name']}. CalcVault shows their computed values."


def t_inkvault_search(args):
    q = (args.get("q") or "").strip()
    try:
        if not q:
            ns = inkvault.notes()
            return f"{len(ns)} notes:\n" + "\n".join(f"- {n['path']} ({str(n.get('modified') or '')[:10]})" for n in ns[:300])
        res = inkvault.search(q)
    except inkvault.InkVaultError as e:
        raise ToolError(str(e)) from None
    if not res:
        return f"No typed text matches '{q}' (handwriting is not searchable; try other words or list all notes)."
    out = []
    for r in res[:20]:
        out.append(f"{r['path']}:")
        out += [f"  {h['line']}: {h['text'][:200]}" for h in r.get("hits", [])[:5]]
    return "\n".join(out)


def t_inkvault_read(args):
    try:
        n = inkvault.note(str(args.get("path") or ""))
    except inkvault.InkVaultError as e:
        raise ToolError(str(e)) from None
    text = n.get("text") or ""
    embeds = [e for e in n.get("embeds", []) if not e.get("empty")]
    content = [{"type": "text", "text": f"# {n['path']}\n\n{text[:20000]}"}]
    if args.get("images", True) and embeds:
        limit = max(1, min(12, int(args.get("max_images") or 6)))
        for e in embeds[:limit]:
            try:
                data, mime = inkvault.embed(e["url"], width=700)
            except inkvault.InkVaultError:
                continue
            if mime in ("image/png", "image/jpeg", "image/gif", "image/webp") and len(data) <= 1_500_000:
                content.append({"type": "text", "text": f"{e['kind']} ![[{e['embed']}]]:"})
                content.append({"type": "image", "data": base64.b64encode(data).decode(), "mimeType": mime})
        if len(embeds) > limit:
            content.append({"type": "text", "text": f"({len(embeds) - limit} more embeds; call again with a larger max_images)"})
    return content


HANDLERS = {name[2:]: fn for name, fn in globals().items() if name.startswith("t_")}


# ---------------------------------------------------------------------------
# JSON-RPC
# ---------------------------------------------------------------------------

def handle(msg):
    """One JSON-RPC message in, response dict out (None for notifications)."""
    mid = msg.get("id")
    method = msg.get("method")
    if mid is None:
        return None  # notifications/initialized and friends
    try:
        if method == "initialize":
            client_ver = (msg.get("params") or {}).get("protocolVersion") or PROTOCOL
            result = {"protocolVersion": client_ver if client_ver <= PROTOCOL else PROTOCOL,
                      "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": {"name": "problemvault", "version": "0.1.0"},
                      "instructions": ask_tools_prompt()}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            result = {"tools": tools()}
        elif method == "tools/call":
            p = msg.get("params") or {}
            fn = HANDLERS.get(p.get("name"))
            if not fn:
                return _err(mid, -32602, f"Unknown tool {p.get('name')}")
            try:
                out = fn(p.get("arguments") or {})
                content = out if isinstance(out, list) else [{"type": "text", "text": out}]
                result = {"content": content, "isError": False}
            except ToolError as e:
                result = {"content": [{"type": "text", "text": str(e)}], "isError": True}
        elif method in ("resources/list", "prompts/list"):
            result = {method.split("/")[0]: []}
        else:
            return _err(mid, -32601, f"Method not found: {method}")
        return {"jsonrpc": "2.0", "id": mid, "result": result}
    except Exception as e:  # never kill the connection over one bad call
        return _err(mid, -32603, f"{type(e).__name__}: {e}")


def _err(mid, code, message):
    return {"jsonrpc": "2.0", "id": mid, "error": {"code": code, "message": message}}


def handle_body(raw):
    try:
        msg = json.loads(raw)
    except json.JSONDecodeError:
        return _err(None, -32700, "Parse error")
    if isinstance(msg, list):
        out = [r for r in (handle(m) for m in msg if isinstance(m, dict)) if r]
        return out or None
    return handle(msg) if isinstance(msg, dict) else _err(None, -32600, "Invalid request")
