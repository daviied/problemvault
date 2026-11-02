"""Client for InkVault's read-only notes API (docs/PROTOCOL.md → "Read API").

Configured with INKVAULT_URL and INKVAULT_PASSWORD (InkVault's AI_PASSWORD). The
student can switch it off in the app; the switch is kept in settings.json.

    GET /api/ai/notes                  [{path, modified}]
    GET /api/ai/search?q=              [{path, hits: [{line, text}]}]
    GET /api/ai/note?path=             {path, text, embeds: [{kind, embed, url, empty?}]}
    GET /api/ai/drawing/<id>.png       handwriting cropped to the ink
    GET /api/ai/file/<name>            a photo
"""
import json
import os
import urllib.error
import urllib.parse
import urllib.request

from . import store

URL = os.environ.get("INKVAULT_URL", "").rstrip("/")
PASSWORD = os.environ.get("INKVAULT_PASSWORD", "")


class InkVaultError(Exception):
    pass


def configured():
    return bool(URL and PASSWORD)


def is_on():
    return store.get_settings().get("inkvault", True)


def enabled():
    return configured() and is_on()


def set_on(on):
    store.update_settings({"inkvault": bool(on)})


def _request(path, raw=False, timeout=20):
    if not configured():
        raise InkVaultError("InkVault is not connected (set INKVAULT_URL and INKVAULT_PASSWORD).")
    if not is_on():
        raise InkVaultError("The student switched off InkVault notes in ProblemVault.")
    req = urllib.request.Request(URL + path)
    req.add_header("Authorization", f"Bearer {PASSWORD}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
            return (data, r.headers.get("Content-Type", "application/octet-stream")) if raw else json.loads(data or b"null")
    except urllib.error.HTTPError as e:
        msg = {401: "InkVault rejected the password (INKVAULT_PASSWORD).",
               403: "InkVault's read API is off (set AI_PASSWORD in InkVault).",
               404: "That note does not exist."}.get(e.code, f"InkVault: HTTP {e.code}")
        raise InkVaultError(msg) from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise InkVaultError(f"Can't reach InkVault at {URL}: {e}") from None


def notes():
    return _request("/api/ai/notes")


def search(q):
    return _request("/api/ai/search?q=" + urllib.parse.quote(q))


def note(path):
    return _request("/api/ai/note?path=" + urllib.parse.quote(path))


def embed(url, width=None):
    """(bytes, mime) of one embed; url is the path the note gave (/api/ai/...)."""
    if not url.startswith("/api/ai/"):
        raise InkVaultError("bad embed url")
    if width and "/drawing/" in url:
        url += f"?width={int(width)}"
    data, ctype = _request(url, raw=True)
    return data, ctype.split(";")[0].strip()
