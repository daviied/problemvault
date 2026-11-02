"""Google Gemini as a backup for in-app Ask Claude (API key, pay-as-you-go or free tier).

Runs the same ProblemVault tools as Claude, called directly in this process (no MCP hop).
Key: GEMINI_API_KEY env, or pasted in the app (DATA_DIR/secret.json). Model: GEMINI_MODEL.
"""
import json
import os
import urllib.error
import urllib.request

from . import store

API = os.environ.get("GEMINI_API_URL", "https://generativelanguage.googleapis.com/v1beta").rstrip("/")
MODEL = os.environ.get("GEMINI_MODEL") or "gemini-flash-latest"
MAX_TURNS = 30


def _clean(key):
    return "".join((key or "").split())


def env_key():
    return _clean(os.environ.get("GEMINI_API_KEY"))


def saved_key():
    return _clean(store.secrets_file().get("gemini_key", ""))


def set_key(key):
    store.update_secrets({"gemini_key": _clean(key)})


def key():
    return saved_key() or env_key()


def available():
    return bool(key())


def status():
    return {"ready": available(), "keySaved": bool(saved_key()), "envKey": bool(env_key()), "model": MODEL}


class GeminiError(Exception):
    pass


def _post(body, timeout=180):
    req = urllib.request.Request(f"{API}/models/{MODEL}:generateContent", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json", "x-goog-api-key": key()})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        try:
            msg = json.loads(e.read()).get("error", {}).get("message", "")
        except (ValueError, AttributeError):
            msg = ""
        if e.code in (400, 401, 403) and "key" in msg.lower():
            raise GeminiError(f"Gemini refused the API key: {msg}") from None
        if e.code == 429:
            raise GeminiError(f"Gemini quota reached: {msg[:300]}") from None
        raise GeminiError(f"Gemini error {e.code}: {msg[:300]}") from None
    except (urllib.error.URLError, OSError) as e:
        raise GeminiError(f"Cannot reach Gemini: {e}") from None


def _text(resp):
    parts = ((resp.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
    return "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()


def test():
    if not available():
        return False, "No Gemini API key."
    try:
        out = _text(_post({"contents": [{"role": "user", "parts": [{"text": "Reply with exactly: OK"}]}]}, 60))
    except GeminiError as e:
        return False, str(e)
    return (True, f"Gemini answered: {out[:100]}") if out else (False, "Gemini gave an empty answer.")


def run(system, prompt, exclude=("post_note",)):
    """Agent loop with the ProblemVault tools; returns Gemini's final text."""
    from . import mcp
    tools = [t for t in mcp.tools() if t["name"] not in exclude]
    decls = [{"name": t["name"], "description": t["description"], "parametersJsonSchema": t["inputSchema"]} for t in tools]
    names = {t["name"] for t in tools}
    contents = [{"role": "user", "parts": [{"text": prompt}]}]
    for _ in range(MAX_TURNS):
        resp = _post({"systemInstruction": {"parts": [{"text": system}]}, "contents": contents,
                      "tools": [{"functionDeclarations": decls}]})
        cand = (resp.get("candidates") or [{}])[0]
        content = cand.get("content") or {"role": "model", "parts": []}
        calls = [p["functionCall"] for p in content.get("parts") or [] if "functionCall" in p]
        if not calls:
            out = _text(resp)
            if not out:
                raise GeminiError(f"Gemini stopped without an answer ({cand.get('finishReason', 'no reason')}).")
            return out
        contents.append({"role": "model", "parts": content["parts"]})  # as sent: keeps thought signatures
        replies, images = [], []
        for c in calls:
            name, args = c.get("name"), c.get("args") or {}
            try:
                if name not in names:
                    raise mcp.ToolError(f"Unknown tool {name}")
                out = mcp.HANDLERS[name](args)
                ok = True
            except mcp.ToolError as e:
                out, ok = str(e), False
            except Exception as e:  # one bad call should not end the run
                out, ok = f"{type(e).__name__}: {e}", False
            items = out if isinstance(out, list) else [{"type": "text", "text": out}]
            text = "\n".join(i["text"] for i in items if i.get("type") == "text")
            images += [{"inlineData": {"mimeType": i["mimeType"], "data": i["data"]}} for i in items if i.get("type") == "image"]
            fr = {"name": name, "response": {"result": text} if ok else {"error": text}}
            if c.get("id"):
                fr["id"] = c["id"]
            replies.append({"functionResponse": fr})
        if images:
            replies.append({"text": "Images returned by the tools above, in order:"})
        contents.append({"role": "user", "parts": replies + images})
    raise GeminiError(f"Gemini used {MAX_TURNS} tool rounds without finishing.")
