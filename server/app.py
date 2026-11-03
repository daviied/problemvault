"""ProblemVault HTTP server. Python standard library only.

    python -m server.app            (from the project folder)

Env: PORT (8787), HOST (0.0.0.0), DATA_DIR (./data), APP_PASSWORD (login; generated if unset),
MCP_TOKEN (optional; generated otherwise), CALCVAULT_URL / CALCVAULT_PASSWORD /
CALCVAULT_PUBLIC_URL, CLAUDE_CLI.
"""
import base64
import hashlib
import hmac
import ipaddress
import json
import mimetypes
import os
import queue
import secrets

import sys
import time
import urllib.parse
from http import cookies
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from . import ask, calcvault, events, gemini, inkvault, mcp, store, webassign

mimetypes.add_type("text/javascript", ".mjs")

PORT = int(os.environ.get("PORT", "8787"))
HOST = os.environ.get("HOST", "0.0.0.0")
PUBLIC_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "public"))
MAX_BODY = 40 * 1024 * 1024

SECRETS = store.secrets_file()
MCP_TOKEN = os.environ.get("MCP_TOKEN") or SECRETS["mcp_token"]
COOKIE_KEY = SECRETS["cookie_key"].encode()
# A login is always required (the app is meant to sit on the internet behind a reverse
# proxy). Without APP_PASSWORD a random one is made once, saved and printed at start-up.
PASSWORD = os.environ.get("APP_PASSWORD", "")
GENERATED_PASSWORD = not PASSWORD
if GENERATED_PASSWORD:
    PASSWORD = SECRETS.get("app_password") or secrets.token_urlsafe(12)
    if not SECRETS.get("app_password"):
        store.update_secrets({"app_password": PASSWORD})

def session_value():
    return hmac.new(COOKIE_KEY, b"authed:" + PASSWORD.encode(), hashlib.sha256).hexdigest()

class HttpError(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "ProblemVault/0.1"

    def log_message(self, fmt, *args):
        if os.environ.get("QUIET") != "1" and not self.path.startswith(("/api/events", "/api/ws/")):
            sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    # -- helpers ------------------------------------------------------------

    def send(self, code, body=b"", ctype="application/json", headers=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        elif isinstance(body, str):
            body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "same-origin")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            raise HttpError(413, "Too large")
        return self.rfile.read(n) if n else b""

    def json_body(self):
        try:
            return json.loads(self.body() or b"{}")
        except json.JSONDecodeError:
            raise HttpError(400, "Bad JSON") from None

    def client_ip(self):
        """The real client. X-Forwarded-For is only believed from a private / local
        address (the reverse proxy), so nobody can fake it from the internet."""
        ip = self.client_address[0]
        fwd = self.headers.get("X-Forwarded-For") or self.headers.get("X-Real-IP")
        try:
            if fwd and (ipaddress.ip_address(ip).is_private or ipaddress.ip_address(ip).is_loopback):
                return fwd.split(",")[0].strip()
        except ValueError:
            pass
        return ip

    def public_origin(self):
        proto = self.headers.get("X-Forwarded-Proto") or "http"
        host = self.headers.get("X-Forwarded-Host") or self.headers.get("Host") or f"localhost:{PORT}"
        return f"{proto.split(',')[0].strip()}://{host.split(',')[0].strip()}"

    _attempts = {}

    def limit(self, kind):
        """At most 10 failed tries per 5 minutes per client (login and MCP token)."""
        key = (kind, self.client_ip())
        recent = [t for t in self._attempts.get(key, []) if time.time() - t < 300]
        self._attempts[key] = recent
        if len(recent) >= 10:
            raise HttpError(429, "Too many attempts, wait a few minutes")
        return key

    def failed(self, key):
        self._attempts.setdefault(key, []).append(time.time())

    def authed(self):
        c = cookies.SimpleCookie(self.headers.get("Cookie") or "")
        return "pv_session" in c and hmac.compare_digest(c["pv_session"].value, session_value())

    # -- dispatch -----------------------------------------------------------

    def do_GET(self):
        self.route("GET")

    def do_HEAD(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PUT(self):
        self.route("PUT")

    def do_PATCH(self):
        self.route("PATCH")

    def do_DELETE(self):
        self.route("DELETE")

    def route(self, method):
        url = urllib.parse.urlsplit(self.path)
        path = url.path
        qs = dict(urllib.parse.parse_qsl(url.query))
        try:
            if path == "/mcp" or path.startswith("/mcp/"):
                return self.mcp(method, path)
            if path.startswith("/api/"):
                if path == "/api/login" and method == "POST":
                    return self.login()
                if path == "/api/logout" and method == "POST":
                    return self.send(200, {"authed": False}, headers={"Set-Cookie": "pv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"})
                if path == "/api/session":
                    return self.send(200, {"authed": self.authed()})
                if not self.authed():
                    raise HttpError(401, "Log in first")
                return self.api(method, path, qs)
            return self.static(path)
        except HttpError as e:
            # the request body may be unread: close rather than parse it as the next request
            self.close_connection = True
            self.send(e.code, {"error": str(e)}, headers={"Connection": "close"})
        except (KeyError, ValueError) as e:
            self.close_connection = True
            self.send(400, {"error": f"Bad request: {e}"}, headers={"Connection": "close"})
        except (BrokenPipeError, ConnectionResetError):
            pass

    # -- static files ---------------------------------------------------------

    def static(self, path):
        # Three installable apps share one page: / (desktop), /tablet (drawing first),
        # /phone (problems, Claude, CalcVault; page view only). Each has its own manifest.
        mode = next((m for m in ("tablet", "phone") if path == f"/{m}" or path.startswith(f"/{m}/w/")), None)
        if mode or path in ("/", "/index.html") or path.startswith("/w/"):
            with open(os.path.join(PUBLIC_DIR, "index.html"), encoding="utf-8") as f:
                html = f.read()
            if mode:
                html = (html.replace('<html lang="en">', f'<html lang="en" data-mode="{mode}">', 1)
                        .replace('href="/manifest.webmanifest"', f'href="/manifest-{mode}.webmanifest"', 1)
                        .replace("<title>ProblemVault</title>", f"<title>ProblemVault {mode.title()}</title>", 1))
            return self.send(200, html, "text/html; charset=utf-8", {"Cache-Control": "no-cache"})
        full = os.path.abspath(os.path.join(PUBLIC_DIR, path.lstrip("/")))
        if not full.startswith(PUBLIC_DIR + os.sep) or not os.path.isfile(full):
            raise HttpError(404, "Not found")
        ctype = mimetypes.guess_type(full)[0] or "application/octet-stream"
        if full.endswith(".js"):
            ctype = "text/javascript"
        with open(full, "rb") as f:
            self.send(200, f.read(), ctype + ("; charset=utf-8" if ctype.startswith("text/") else ""),
                      {"Cache-Control": "no-cache"})

    # -- auth -------------------------------------------------------------------

    def login(self):
        key = self.limit("login")
        pw = str(self.json_body().get("password", ""))
        if not hmac.compare_digest(pw.encode(), PASSWORD.encode()):
            self.failed(key)
            raise HttpError(401, "Wrong password")
        secure = "; Secure" if self.public_origin().startswith("https:") else ""
        cookie = f"pv_session={session_value()}; Path=/; HttpOnly; SameSite=Lax; Max-Age={60 * 60 * 24 * 60}{secure}"
        self.send(200, {"authed": True}, headers={"Set-Cookie": cookie})

    # -- MCP --------------------------------------------------------------------

    def mcp(self, method, path):
        token = path[5:] if path.startswith("/mcp/") else ""
        auth = self.headers.get("Authorization") or ""
        if auth.startswith("Bearer "):
            token = auth[7:].strip()
        key = self.limit("mcp")
        if not hmac.compare_digest(token.encode(), MCP_TOKEN.encode()):
            self.failed(key)
            raise HttpError(401, "MCP token missing or wrong")
        if method == "GET":  # no server-initiated stream
            return self.send(405, {"error": "Use POST"}, headers={"Allow": "POST"})
        if method == "DELETE":
            return self.send(200, {})
        out = mcp.handle_body(self.body())
        if out is None:
            return self.send(202)
        self.send(200, out, headers={"Mcp-Session-Id": "problemvault"})

    # -- API --------------------------------------------------------------------

    def api(self, method, path, qs):
        parts = [urllib.parse.unquote(p) for p in path.split("/")[2:]]
        head = parts[0]

        if head == "state" and method == "GET":
            return self.send(200, self.state())
        if head == "focus":  # the problem open on your devices; the others follow it
            if method == "PUT":
                b = self.json_body()
                wid = b.get("ws")
                if wid and not store.get_workspace(wid):
                    raise HttpError(404, "No such workspace")
                f = store.set_focus(wid or None)
                events.publish("index", {"type": "focus", "ws": f["ws"]}, origin=b.get("client"))
                return self.send(200, f)
            return self.send(200, store.get_focus())
        if head == "events" and method == "GET":
            return self.sse(qs.get("key", "index"))
        if head == "folders":
            return self.folders(method, parts[1:])
        if head == "workspaces":
            return self.workspaces(method, parts[1:])
        if head == "ws" and len(parts) >= 2:
            wid = parts[1]
            w = store.get_workspace(wid)
            if not w:
                raise HttpError(404, "No such workspace")
            return self.ws(method, w, parts[2:], qs)
        if head == "webassign":
            return self.webassign(method, parts[1:], qs)
        if head == "calcvault" and parts[1:] == ["tree"]:
            try:
                return self.send(200, calcvault.tree())
            except calcvault.CalcVaultError as e:
                raise HttpError(502, str(e)) from None
        if head == "inkvault" and parts[1:] == [] and method in ("GET", "PUT"):  # notes for Claude: on/off
            if method == "PUT":
                inkvault.set_on(self.json_body().get("enabled"))
                events.publish("index", {"type": "settings"})
            return self.send(200, self.inkvault_state())
        if head == "ai" and parts[1:] == [] and method in ("GET", "PUT"):  # auto / claude / gemini
            if method == "PUT":
                ask.set_mode(self.json_body().get("mode"))
                events.publish("index", {"type": "settings"})
            return self.send(200, ask.ai_status())
        if head == "gemini":  # Gemini backup: API key, test
            if parts[1:] == ["key"] and method == "POST":
                gemini.set_key(str(self.json_body().get("key", ""))[:500])
                events.publish("index", {"type": "settings"})
                return self.send(200, ask.ai_status())
            if parts[1:] == ["test"] and method == "POST":
                ok, msg = gemini.test()
                return self.send(200, {"ok": ok, "message": msg, **ask.ai_status()})
        if head == "claude":  # Claude Code CLI on this server: status, token, test
            if parts[1:] == [] and method == "GET":
                return self.send(200, ask.status())
            if parts[1:] == ["token"] and method == "POST":
                ask.set_token(str(self.json_body().get("token", ""))[:2000])
                return self.send(200, ask.status())
            if parts[1:] == ["test"] and method == "POST":
                ok, msg = ask.test()
                return self.send(200, {"ok": ok, "message": msg, **ask.status()})
        raise HttpError(404, "Not found")

    def webassign(self, method, rest, qs):
        """WebAssign through AssignPad: list, view, save/submit, images, import as problems."""
        refresh = qs.get("refresh") == "1"
        try:
            if rest == ["assignments"] and method == "GET":
                return self.send(200, webassign.assignments(refresh))
            if len(rest) == 2 and rest[0] == "assignments" and method == "GET":
                a = webassign.assignment(rest[1], refresh)
                return self.send(200, {**a, "url": a.get("url") or webassign.open_url(rest[1])})
            if len(rest) == 3 and rest[0] == "assignments" and rest[2] == "extension" and method in ("GET", "POST"):
                return self.send(200, webassign.extension(rest[1], request=method == "POST"))
            if len(rest) == 4 and rest[0] == "assignments" and rest[2] == "questions" and method == "POST":
                b = self.json_body()
                answers = b.get("answers") if isinstance(b.get("answers"), dict) else {}
                return self.send(200, webassign.submit(rest[1], rest[3], answers, b.get("action")))
            if rest == ["proxy"] and method == "GET":
                data, ctype = webassign.proxy(qs.get("u", ""))
                if ctype.split(";")[0].strip() not in ("image/png", "image/jpeg", "image/gif", "image/svg+xml", "image/webp", "text/css"):
                    raise HttpError(415, "Not an image or stylesheet")
                return self.send(200, data, ctype, {"Cache-Control": "private, max-age=604800"})
            if rest == ["import"] and method == "POST":
                return self.send(200, self.wa_import(self.json_body()))
        except webassign.WebAssignError as e:
            raise HttpError(502, str(e)) from None
        raise HttpError(404, "Not found")

    def wa_import(self, b):
        """One problem per question of an assignment, in a folder named after it."""
        dep = str(b.get("dep", ""))
        a = webassign.assignment(dep)
        parent = b.get("folder") or None
        ix = store.index()
        folder = (next((f for f in ix["folders"] if f["name"] == a["name"] and f.get("parent") == parent), None)
                  or store.create_folder(a["name"], parent))
        linked = {(w.get("wa") or {}).get("box") for w in ix["workspaces"] if (w.get("wa") or {}).get("dep") == dep}
        made = []
        for q in a.get("questions", []):
            if q["box"] in linked:
                continue  # imported before
            w = store.create_workspace(f"{a['name']} #{q['number']}", folder["id"])
            store.update_workspace(w["id"], {"problem": webassign.question_text(q),
                                             "wa": {"dep": dep, "box": q["box"], "name": a["name"], "number": q["number"]}})
            made.append(w["id"])
        events.publish("index", {"type": "index"})
        return {"folder": folder["id"], "created": made}

    @staticmethod
    def inkvault_state():
        return {"configured": inkvault.configured(), "enabled": inkvault.is_on(), "url": inkvault.URL}

    def state(self):
        ix = store.index()
        for w in ix["workspaces"]:
            w["unread"], w["questions"] = mcp._unread_count(w["id"])
        return {
            "index": ix,
            "calcvault": {"enabled": calcvault.enabled(), "url": calcvault.PUBLIC_URL},
            "webassign": {"enabled": webassign.enabled()},
            "inkvault": self.inkvault_state(),
            "claude": {**ask.status(), "cli": ask.available()},
            "ai": ask.ai_status(),
            "mcp": {"url": f"{self.public_origin()}/mcp", "token": MCP_TOKEN},
        }

    def folders(self, method, rest):
        if method == "POST" and not rest:
            b = self.json_body()
            f = store.create_folder(b.get("name"), b.get("parent"))
        elif method == "PATCH" and rest:
            f = store.update_folder(rest[0], self.json_body())
            if not f:
                raise HttpError(404, "No such folder")
        elif method == "DELETE" and rest:
            f = {"ok": store.delete_folder(rest[0])}
        else:
            raise HttpError(405, "Method not allowed")
        events.publish("index", {"type": "index"})
        self.send(200, f)

    def workspaces(self, method, rest):
        if method == "POST" and not rest:
            b = self.json_body()
            w = store.create_workspace(b.get("title"), b.get("folder"))
        elif method == "PATCH" and rest:
            w = store.update_workspace(rest[0], self.json_body())
            if not w:
                raise HttpError(404, "No such workspace")
            events.publish(w["id"], {"type": "meta"})
        elif method == "DELETE" and rest:
            w = {"ok": store.delete_workspace(rest[0])}
        else:
            raise HttpError(405, "Method not allowed")
        events.publish("index", {"type": "index"})
        self.send(200, w)

    def ws(self, method, w, rest, qs):
        wid = w["id"]
        sub = rest[0] if rest else ""
        if sub == "" and method == "GET":
            return self.send(200, {"meta": w, "page": store.load_page(wid), "claude": store.load_claude(wid)})
        if sub == "change" and method == "POST":
            b = self.json_body()
            change = store.sanitize_change(b.get("change"))
            if change is None:
                raise HttpError(400, "Bad change")
            store.apply_change(wid, change)
            events.publish(wid, {"type": "change", "change": change}, origin=b.get("client"))
            return self.send(200, {"ok": True})
        if sub == "live" and method == "POST":
            b = self.json_body()
            stroke = store.sanitize_stroke(b.get("stroke")) if b.get("stroke") else None
            events.publish(wid, {"type": "live", "sid": str(b.get("sid", ""))[:40], "stroke": stroke}, origin=b.get("client"))
            return self.send(200, {"ok": True})
        if sub == "img" and method == "POST":
            b = self.json_body()
            rgb = b.get("rgb") or {}
            store.save_image(wid, str(b["id"]), str(b["mime"]), base64.b64decode(b["data"]),
                             int(rgb.get("w", 0)), int(rgb.get("h", 0)),
                             base64.b64decode(rgb["data"]) if rgb.get("data") else None)
            return self.send(200, {"ok": True})
        if sub == "img" and len(rest) == 2 and method == "GET":
            p, mime = store.image_file(wid, rest[1])
            if not p:
                raise HttpError(404, "No such image")
            with open(p, "rb") as f:
                return self.send(200, f.read(), mime, {"Cache-Control": "private, max-age=31536000, immutable"})
        if sub == "preview" and method == "GET":
            return self.preview(w, qs)
        if sub == "ask" and method == "POST":
            b = self.json_body()
            preset = b.get("preset") if b.get("preset") in ask.PRESETS else None
            text = ask.PRESETS[preset][0] if preset else str(b.get("text", "")).strip()[:4000]
            if not text:
                raise HttpError(400, "Empty question")
            q = {"id": "q" + store.new_id()[:6], "at": store.now_ms(), "text": text}
            if preset == "calc" and not calcvault.enabled():
                raise HttpError(400, "CalcVault is not connected (CALCVAULT_URL / CALCVAULT_PASSWORD)")
            if preset == "submit":
                if not w.get("wa"):
                    raise HttpError(400, "No WebAssign question is linked to this problem")
                mcp.allow_submit(wid)  # the one place a submission is allowed from
            if preset:
                q["preset"] = preset
            store.update_claude(wid, lambda c: c["questions"].append(q))
            events.publish(wid, {"type": "claude"})
            if ask.available():
                ask.run(w, q, PORT, MCP_TOKEN)
                return self.send(200, {"mode": "cli", "by": ask.provider(), "question": q})
            return self.send(200, {"mode": "manual", "question": q, "prompt": ask.manual_prompt(w, q)})
        if sub == "notes" and len(rest) == 2 and method == "DELETE":
            store.update_claude(wid, lambda c: c.__setitem__("notes", [n for n in c["notes"] if n["id"] != rest[1]]))
            events.publish(wid, {"type": "claude"})
            return self.send(200, {"ok": True})
        if sub == "questions" and len(rest) == 2 and method == "DELETE":
            store.update_claude(wid, lambda c: c.__setitem__("questions", [q for q in c["questions"] if q["id"] != rest[1]]))
            events.publish(wid, {"type": "claude"})
            return self.send(200, {"ok": True})
        if sub == "forget" and method == "POST":  # make Claude re-read everything
            def fn(c):
                c["transcripts"] = []
                c["images"] = {}
            store.update_claude(wid, fn)
            events.publish(wid, {"type": "claude"})
            return self.send(200, {"ok": True})
        if sub == "calc":
            return self.calc(method, w)
        raise HttpError(404, "Not found")

    def preview(self, w, qs):
        """What view_ink would send Claude right now, for the 'Claude's view' button."""
        args = {"workspace": w["id"], "what": qs.get("what", "unread")}
        content = mcp.t_view_ink(args)
        shots = []
        for i, c in enumerate(content):
            if c["type"] == "image":
                shots.append({"caption": content[i - 1]["text"], "png": c["data"]})
        note = content[0]["text"] if not shots else ""
        self.send(200, {"shots": shots, "note": note})

    def calc(self, method, w):
        try:
            if method == "GET":
                if not w.get("calc"):
                    return self.send(200, {"calc": None})
                return self.send(200, {"calc": calcvault.get(w["calc"]["id"])})
            if method == "POST":
                b = self.json_body()
                if b.get("create"):
                    c = calcvault.create(b.get("name") or w["title"], b.get("folder_id"))
                else:
                    c = calcvault.get(int(b["id"]))
                store.update_workspace(w["id"], {"calc": {"id": c["id"], "name": c["name"]}})
            elif method == "DELETE":
                store.update_workspace(w["id"], {"calc": None})
                c = None
            else:
                raise HttpError(405, "Method not allowed")
        except calcvault.CalcVaultError as e:
            raise HttpError(502, str(e)) from None
        events.publish(w["id"], {"type": "meta"})
        self.send(200, {"calc": c})

    # -- server-sent events -----------------------------------------------------

    def sse(self, key):
        q = events.subscribe(key)
        try:
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Accel-Buffering", "no")  # nginx: don't buffer the stream
            self.end_headers()
            self.wfile.write(b"retry: 2000\n\n")
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=20)
                    self.wfile.write(f"data: {msg}\n\n".encode())
                except queue.Empty:
                    self.wfile.write(b": ping\n\n")  # keeps proxies from closing it
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            events.unsubscribe(key, q)
            self.close_connection = True

class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def main():
    os.makedirs(store.DATA_DIR, exist_ok=True)
    os.makedirs(os.path.expanduser("~"), exist_ok=True)  # HOME=/data/home in Docker (Claude Code login)
    srv = Server((HOST, PORT), Handler)
    print(f"ProblemVault on http://localhost:{PORT}  (data: {store.DATA_DIR})")
    print(f"MCP endpoint: http://localhost:{PORT}/mcp   token: {MCP_TOKEN}")
    if GENERATED_PASSWORD:
        print(f"Login password (generated, set APP_PASSWORD to choose one): {PASSWORD}")
    print(f"CalcVault: {'connected to ' + calcvault.URL if calcvault.enabled() else 'not configured'}"
          f" · Claude CLI: {ask.CLI or 'not found (Ask Claude gives a prompt to paste instead)'}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
