"""Client for a CalcVault server (github: calcvault, FastAPI + SQLite).

Configured with CALCVAULT_URL and CALCVAULT_PASSWORD. ProblemVault logs in once
with CalcVault's shared password and keeps the session cookie, then reads and
edits calculators through CalcVault's own REST API:

    POST  /api/login                {password}
    GET   /api/tree                 folders + calculators
    POST  /api/calculators          {name, folder_id}
    GET   /api/calculators/<id>     {id, name, folder_id, data: {locked, lines: [...]}}
    PATCH /api/calculators/<id>     {data}
"""
import json
import os
import threading
import urllib.error
import urllib.request
import uuid

URL = os.environ.get("CALCVAULT_URL", "").rstrip("/")
PUBLIC_URL = os.environ.get("CALCVAULT_PUBLIC_URL", URL).rstrip("/")  # what the browser opens
PASSWORD = os.environ.get("CALCVAULT_PASSWORD", "")

_cookie = None
_lock = threading.RLock()  # _login runs inside it and calls _request again


class CalcVaultError(Exception):
    pass


def enabled():
    return bool(URL and PASSWORD)


def _request(method, path, body=None, retry=True):
    global _cookie
    if not enabled():
        raise CalcVaultError("CalcVault is not configured (set CALCVAULT_URL and CALCVAULT_PASSWORD)")
    with _lock:
        if _cookie is None and path != "/api/login":
            _login()
        cookie = _cookie
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(URL + path, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if cookie:
        req.add_header("Cookie", cookie)
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read() or b"null"), r.headers
    except urllib.error.HTTPError as e:
        if e.code == 401 and retry and path != "/api/login":
            with _lock:
                _cookie = None
            return _request(method, path, body, retry=False)
        raise CalcVaultError(f"CalcVault {method} {path}: HTTP {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise CalcVaultError(f"Can't reach CalcVault at {URL}: {e}") from None


def _login():
    global _cookie
    _, headers = _request("POST", "/api/login", {"password": PASSWORD}, retry=False)
    for h in headers.get_all("Set-Cookie") or []:
        if h.startswith("cv_session="):
            _cookie = h.split(";", 1)[0]
            return
    raise CalcVaultError("CalcVault login returned no session cookie")


def tree():
    t, _ = _request("GET", "/api/tree")
    return {"folders": t.get("folders", []), "calculators": [c for c in t.get("calculators", []) if c.get("kind") == "calculator"]}


def get(calc_id):
    c, _ = _request("GET", f"/api/calculators/{int(calc_id)}")
    return c


def create(name, folder_id=None):
    c, _ = _request("POST", "/api/calculators", {"name": name, "folder_id": folder_id})
    return c


def add_lines(calc_id, lines):
    """Append lines. Each: {latex} (an Eq line) or {role: 'input', var, label, value}
    or {role: 'output', label, latex}. Returns the updated calculator."""
    c = get(calc_id)
    data = c.get("data") or {}
    data.setdefault("lines", [])
    for ln in lines:
        role = ln.get("role", "none")
        role = role if role in ("none", "input", "output") else "none"
        latex = str(ln.get("latex", ""))
        data["lines"].append({
            "id": str(uuid.uuid4()),
            "role": role,
            "hidden": False,  # lines added from ProblemVault stay visible
            "latex": latex if role == "none" else "",
            "varName": str(ln.get("var", "")) if role == "input" else "",
            "label": str(ln.get("label", "")) if role != "none" else "",
            "value": str(ln.get("value", "")) if role == "input" else "",
            "expr": latex if role == "output" else "",
        })
    out, _ = _request("PATCH", f"/api/calculators/{int(calc_id)}", {"data": data})
    return out


def summarize(c):
    """Compact text of a calculator's lines, for Claude."""
    lines = (c.get("data") or {}).get("lines", [])
    out = []
    for i, ln in enumerate(lines, 1):
        if ln.get("role") == "input":
            out.append(f"{i}. input {ln.get('label') or ln.get('varName')}: {ln.get('varName')} = {ln.get('value')}")
        elif ln.get("role") == "output":
            out.append(f"{i}. output {ln.get('label')}: {ln.get('expr')}")
        elif ln.get("latex"):
            out.append(f"{i}. {ln.get('latex')}")
    return "\n".join(out) or "(no lines yet)"
