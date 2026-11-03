"""Client for AssignPad (the WebAssign front end in ../Web-Assign).

AssignPad logs in to WebAssign and parses assignments; ProblemVault only calls
its REST API, server to server, with AssignPad's APP_PASSWORD as a Bearer token:

    GET  /api/assignments[?refresh=1]          {course, assignments: [{dep, name, due, score, group}]}
    GET  /api/assignments/<dep>[?refresh=1]    {name, url, styles, questions: [{box, number, html, parts, ...}]}
    POST /api/assignments/<dep>/questions/<box>  {answers, action: save|submit}
    GET  /api/proxy?u=<webassign url>          images / stylesheets of a question

Configured with ASSIGNPAD_URL and ASSIGNPAD_PASSWORD.
"""
import html as htmllib
import json
import os
import re
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

URL = os.environ.get("ASSIGNPAD_URL", "").rstrip("/")
PASSWORD = os.environ.get("ASSIGNPAD_PASSWORD", "")


class WebAssignError(Exception):
    pass


def enabled():
    return bool(URL and PASSWORD)


def _request(method, path, body=None, timeout=160, raw=False):
    if not enabled():
        raise WebAssignError("WebAssign is not connected (set ASSIGNPAD_URL and ASSIGNPAD_PASSWORD).")
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode() if body is not None else None, method=method)
    req.add_header("Authorization", f"Bearer {PASSWORD}")
    if body is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
            return (data, r.headers.get("Content-Type", "application/octet-stream")) if raw else json.loads(data or b"null")
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("detail") or ""
        except (ValueError, AttributeError):
            msg = ""
        if e.code == 401:
            msg = "AssignPad rejected the password (ASSIGNPAD_PASSWORD)."
        raise WebAssignError(msg or f"AssignPad: HTTP {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise WebAssignError(f"Can't reach AssignPad at {URL}: {e}") from None


def assignments(refresh=False):
    return _request("GET", "/api/assignments" + ("?refresh=1" if refresh else ""))


def assignment(dep, refresh=False):
    if not str(dep).isdigit():
        raise WebAssignError("bad assignment id")
    return _request("GET", f"/api/assignments/{dep}" + ("?refresh=1" if refresh else ""), timeout=130)


def submit(dep, box, answers, action):
    if not str(dep).isdigit() or not re.fullmatch(r"question\d+_\d+", box or "") or action not in ("save", "submit"):
        raise WebAssignError("bad request")
    return _request("POST", f"/api/assignments/{dep}/questions/{box}", {"answers": answers, "action": action}, timeout=130)


def extension(dep, request=False):
    """Extension info for an assignment, or (request=True) ask for WebAssign's automatic extension."""
    if not str(dep).isdigit():
        raise WebAssignError("bad assignment id")
    return _request("POST" if request else "GET", f"/api/assignments/{dep}/extension", {} if request else None, timeout=200)


def proxy(u):
    """(bytes, content type) of a question image / stylesheet, through AssignPad."""
    return _request("GET", "/api/proxy?u=" + urllib.parse.quote(u, safe=""), raw=True, timeout=30)


def figures(q, limit=3, max_bytes=1_500_000):
    """[(bytes, mime)] of the question's bitmap figures, for Claude (SVG and huge files skipped)."""
    out = []
    for src in re.findall(r'<img[^>]+src="/api/proxy\?u=([^"]+)"', q.get("html") or ""):
        if len(out) >= limit:
            break
        try:
            data, ctype = proxy(urllib.parse.unquote(htmllib.unescape(src)))
        except WebAssignError:
            continue
        mime = ctype.split(";")[0].strip()
        if mime in ("image/png", "image/jpeg", "image/gif", "image/webp") and len(data) <= max_bytes:
            out.append((data, mime))
    return out


def question(dep, box, refresh=False):
    a = assignment(dep, refresh)
    q = next((q for q in a.get("questions", []) if q.get("box") == box), None)
    if not q:
        raise WebAssignError("That question is no longer in the assignment.")
    return a, q


def open_url(dep, box=None):
    return f"https://www.webassign.net/web/Student/Assignment-Responses/last?dep={dep}" + (f"#{box}" if box else "")


class _Text(HTMLParser):
    """Question HTML -> plain text with $LaTeX$ (cheap for Claude, fine as a problem statement)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.tex, self.skip = [], None, 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ("style", "script"):
            self.skip += 1
        elif "ap-tex" in (a.get("class") or ""):
            self.tex = []
        elif "ap-box" in (a.get("class") or ""):
            self.out.append(" [answer] ")
        elif tag == "img":
            self.out.append(" [figure] ")
        elif tag in ("br", "p", "div", "li", "tr", "table"):
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in ("style", "script"):
            self.skip = max(0, self.skip - 1)
        elif tag == "span" and self.tex is not None:
            t = "".join(self.tex).replace("\\displaystyle ", "").strip()
            self.out.append(f"${t}$" if t else "")
            self.tex = None

    def handle_data(self, data):
        if self.skip:
            return
        (self.tex if self.tex is not None else self.out).append(data)


def question_text(q):
    p = _Text()
    p.feed(q.get("html") or "")
    text = htmllib.unescape("".join(p.out))
    text = re.sub(r"[ \t ]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n\n", text).strip()[:6000]


def summarize(a, q):
    """Text for Claude: the question, and the state of each answer box."""
    lines = [f"WebAssign: {a.get('name')} — question {q.get('number')}"]
    if q.get("submissions"):
        lines.append(f"Submissions used: {q['submissions']}")
    lines.append("\n" + question_text(q))
    if q.get("parts"):
        lines.append("\nAnswer boxes:")
        for i, p in enumerate(q["parts"], 1):
            state = p.get("mark") or ("answered" if p.get("value") else "empty")
            lock = ", locked" if not p.get("enabled", True) else ""
            lines.append(f"{i}. {p.get('name')}: {p.get('kind')} ({state}{lock})")
    return "\n".join(lines)
