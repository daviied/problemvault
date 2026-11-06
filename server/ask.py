"""'Ask Claude' from inside the app, on the subscription.

The Docker image includes the Claude Code CLI. Once it is logged in with your
Claude account, ProblemVault runs `claude -p` with only this app's MCP tools.
That usage counts against your Pro/Max plan like any Claude Code session; no
API key is involved.

Logging in (once), either way:
  * Token: run `claude setup-token` (in the container: `docker exec -it
    problemvault claude setup-token`), then paste the token into the app
    (plug icon -> Claude in this app). Stored in DATA_DIR/secret.json and given
    to the CLI as CLAUDE_CODE_OAUTH_TOKEN. Or set that env var on the container.
  * Interactive: `docker exec -it problemvault claude`, then /login. HOME is on
    the data volume, so the login survives updates.

Without a logged-in CLI the question is saved in the workspace and the app hands
you a one-line prompt to paste into Claude Desktop / claude.ai (with the
ProblemVault connector added), which answers it with the same tools.
"""
import datetime
import json
import os
import re
import shutil
import subprocess
import threading
import time

from . import events, gemini, store

CLI = os.environ.get("CLAUDE_CLI") or shutil.which("claude")
_running = set()
_lock = threading.Lock()

SYSTEM = (
    "You are helping a student with homework inside ProblemVault. The student asked a question about "
    "the workspace named in their message. Use get_workspace first, view_ink only for ink/images not read yet, and save what "
    "you read (save_transcription / describe_image). If a mark on their page helps (write / draw), add it. "
    "Then reply to the student. Your final message is shown to them as Markdown with $LaTeX$; keep it "
    "focused, and help them learn rather than only giving the answer, unless they ask for the answer."
)


PROMPT_MAX = 20000


def system_prompt():
    """The global prompt for every in-app question (student's version, or the default)."""
    return store.get_settings().get("prompt_system") or SYSTEM


def tools_prompt():
    """The tool guide: in-app questions and connected Claude apps both get it."""
    from .mcp import INSTRUCTIONS
    return store.get_settings().get("prompt_tools") or INSTRUCTIONS


def prompts():
    from .mcp import INSTRUCTIONS
    return {"system": system_prompt(), "tools": tools_prompt(),
            "presets": {k: preset_prompt(k) for k in PRESETS},
            "labels": {k: v[0] for k, v in PRESETS.items()},
            "defaults": {"system": SYSTEM, "tools": INSTRUCTIONS, "presets": {k: v[1] for k, v in PRESETS.items()}}}


def preset_prompt(key):
    """What a one-tap button sends (student's version, or the default)."""
    return (store.get_settings().get("prompt_presets") or {}).get(key) or PRESETS[key][1]


def question_text(q):
    return preset_prompt(q["preset"]) if q.get("preset") in PRESETS else q["text"]


def set_prompts(system, tools, presets=None):
    """Empty text, or the default text, means "use the default" (so later updates reach it)."""
    d = prompts()["defaults"]
    clean = lambda v, default: "" if str(v or "").strip() == default.strip() else str(v or "").strip()[:PROMPT_MAX]
    presets = presets if isinstance(presets, dict) else {}
    saved = {k: clean(presets.get(k), v) for k, v in d["presets"].items()}
    store.update_settings({"prompt_system": clean(system, d["system"]), "prompt_tools": clean(tools, d["tools"]),
                           "prompt_presets": {k: v for k, v in saved.items() if v}})


# one-tap requests from the tablet: label shown in the app, prompt sent to Claude
PRESETS = {
    "check": ("Check my work",
              "Check ALL of my work on this page, step by step (read any ink you have not read yet; use "
              "calcvault_read / webassign_read if linked). For each mistake, put a correction ON THE PAGE: draw "
              "to point at it (circle, underline or cross) and write a short correction beside that block with "
              "near_block. Mark correct steps with a small check. Never place text over my writing. Do not solve "
              "the parts I have not done yet. Reply with a 1-3 line summary."),
    "next": ("Next step",
             "Look at what I have done so far on this page and check it first (read any ink you have not read "
             "yet; use calcvault_read / webassign_read if linked). If there is a mistake: mark it on the page "
             "(draw at it, write near_block) and help me fix it with a hint or the corrected step, and do NOT "
             "give the next step yet. If everything so far is right: write ONLY the next step (one step, not "
             "the whole solution) on the page below my last line, as a hint I can follow. Never place text over "
             "my writing. Reply with a 1-2 line summary."),
    "equations": ("Relevant equations",
                  "List the equations relevant to this problem. First read the problem: the typed text, image "
                  "descriptions and any image not read yet (use webassign_read if linked; if the inkvault_* tools are "
                  "listed, search my class notes for the method and formulas my class used). Then call equation_sheet. "
                  "If there is no sheet, choose the equations yourself and do not mention a sheet. If there is a sheet, "
                  "take the equations from it, written the way the sheet writes them. If the problem needs an equation "
                  "that is not on the sheet: when it can be derived from equations on the sheet, list those sheet "
                  "equations first, then add the line '⚠ Not on your sheet: <name>. It can be derived from the equations "
                  "above. Ask me if you want it.' and do NOT write the derived equation; when it cannot be derived, add "
                  "the line '⚠ Not on your sheet: <name>: <equation>'. Then call write ONCE, with no near_block and no "
                  "x/y so it goes below everything: a short list in $LaTeX$, each equation with its name, and what a "
                  "symbol means only if it is not clear. Give the general equations only: do NOT put in the numbers, "
                  "solve, show steps, give an answer or check my work. Reply with one line that says you added them and "
                  "how many flags there are, if any."),
    "calc": ("Update CalcVault from my work",
             "I pressed Update Calc. Read my math on this page (any ink you have not read yet) and check every given "
             "and equation, step by step. Then call calcvault_read to see what the linked calculator already has. "
             "If everything is right: call calcvault_add_lines ONCE with only what is not there yet, in the order I "
             "wrote it: each given number as {role:'input', var, label, value} (value without units; label says "
             "what it is), and each equation I wrote as {latex} with the same variable names as the inputs (solved "
             "for the unknown, like 'I=\\frac{V}{R_1}'). Use my equations as I wrote them; do not add steps I did "
             "not write. If something is wrong: do NOT change the calculator; mark the mistake on the page (draw at "
             "it, write near_block) and tell me what to fix. Never place text over my writing. Reply with a 1-2 line "
             "summary that says what you added, or why you added nothing."),
    "submit": ("Check and submit to WebAssign",
               "I pressed Submit. Call webassign_read (figures=false if you already saw them) and check ALL my work "
               "on this page. Submit ONLY if every step is right AND each answer box has a final answer I CIRCLED on "
               "the page. Then call webassign_submit with each answer EXACTLY as I wrote it (same digits, rounding "
               "and sign; no units); do not fix or round it for me. For multiple-choice, select-all and drop-down boxes, "
               "use the option(s) I circled or wrote on the page (option values are in webassign_read); never guess. "
               "If anything is wrong, an answer is not circled or marked, or the question has a graph box: do NOT submit; mark the problem on the page (draw at it, "
               "write near_block) and tell me what to fix. Never place text over my writing. Reply with a 1-2 line "
               "summary that says whether you submitted and what WebAssign marked."),
}


def _clean(token):
    # a token copied from a terminal is often wrapped onto several lines
    return "".join((token or "").split())


def env_token():
    return _clean(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"))


def saved_token():
    return _clean(store.secrets_file().get("claude_token", ""))


def set_token(token):
    store.update_secrets({"claude_token": _clean(token)})


def _env():
    env = dict(os.environ)
    env.pop("ANTHROPIC_API_KEY", None)  # never fall back to API billing
    # an empty CLAUDE_CODE_OAUTH_TOKEN (the compose default) would hide a /login made in the terminal
    env.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
    tok = saved_token() or env_token()
    if tok:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = tok
    return env


def logged_in():
    if env_token() or saved_token():
        return True
    return os.path.exists(os.path.join(os.path.expanduser("~"), ".claude", ".credentials.json"))


def explain(err):
    """Turn Claude Code's login errors into steps the student can follow."""
    if "/login" in err or "Invalid API key" in err or "401" in err or "OAuth" in err:
        how = ("the saved token is wrong or expired" if saved_token() else
               "the CLAUDE_CODE_OAUTH_TOKEN token is wrong or expired" if env_token() else
               "the terminal login has expired")
        return (f"Claude Code is not logged in: {how}. Make a new token with "
                "`docker exec -it problemvault claude setup-token`, then paste it in the plug dialog "
                f"(Claude in this app) and click Save and Test. Details: {err[-200:]}")
    return err


def claude_ready():
    return bool(CLI) and logged_in() and os.environ.get("CLAUDE_CLI_DISABLED") not in ("1", "true")


def status():
    return {
        "installed": bool(CLI),
        "loggedIn": bool(CLI) and logged_in(),
        "tokenSaved": bool(saved_token()),
        "envToken": bool(env_token()),
        "ready": claude_ready(),
    }


# ---------------------------------------------------------------------------
# Which AI answers: auto (Claude, Gemini while Claude's limit is used up), or one of them
# ---------------------------------------------------------------------------

MODES = ("auto", "claude", "gemini")
_LIMIT = re.compile(r"(usage|rate|session|weekly|5-hour|daily)[ _-]limit|limit (reached|exceeded)|hit your limit|out of (extra )?usage", re.I)
_RESET = re.compile(r"resets?(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?", re.I)


def mode():
    m = store.get_settings().get("ai_mode")
    return m if m in MODES else "auto"


def set_mode(m):
    if m in MODES:
        store.update_settings({"ai_mode": m})


def limited_until():
    """ms timestamp until which Claude's limit is used up, or 0."""
    t = store.get_settings().get("claude_limited_until") or 0
    return t if t > time.time() * 1000 else 0


def is_limit(err):
    return bool(_LIMIT.search(err or ""))


def reset_time(err, now=None):
    """When Claude Code says the limit resets (ms). Unknown: in 1 hour, then Claude is tried again."""
    now = now or time.time()
    m = re.search(r"\|(\d{10})\b", err)  # "Claude AI usage limit reached|1767225600"
    if m:
        return int(m.group(1)) * 1000
    m = _RESET.search(err)
    if m:
        h, mi, ap, tzname = int(m.group(1)), int(m.group(2) or 0), (m.group(3) or "").lower(), m.group(4)
        if ap == "pm" and h < 12:
            h += 12
        if ap == "am" and h == 12:
            h = 0
        tz = None
        if tzname:
            try:
                from zoneinfo import ZoneInfo
                tz = ZoneInfo(tzname.strip())
            except Exception:
                tz = None
        cur = datetime.datetime.fromtimestamp(now, tz) if tz else datetime.datetime.fromtimestamp(now)
        if h < 24 and mi < 60:
            at = cur.replace(hour=h, minute=mi, second=0, microsecond=0)
            if at <= cur:
                at += datetime.timedelta(days=1)
            return int(at.timestamp() * 1000)
    return int((now + 3600) * 1000)


def mark_limited(err):
    store.update_settings({"claude_limited_until": reset_time(err)})
    events.publish("index", {"type": "settings"})


def provider():
    """'claude', 'gemini' or None (nothing set up: the app gives a prompt to paste)."""
    m, c, g = mode(), claude_ready(), gemini.available()
    if m == "claude":
        return "claude" if c else None
    if m == "gemini":
        return "gemini" if g else None
    if c and not limited_until():
        return "claude"
    return "gemini" if g else ("claude" if c else None)


def available():
    return provider() is not None


def ai_status():
    return {"mode": mode(), "provider": provider(), "limitedUntil": limited_until(),
            "claude": claude_ready(), "gemini": gemini.status()}


def test():
    """Run a tiny prompt; (ok, message)."""
    if not CLI:
        return False, "Claude Code is not installed on the server."
    try:
        p = subprocess.run([CLI, "-p", "--output-format", "text", "--strict-mcp-config", "--max-turns", "1"],
                           input="Reply with exactly: OK", capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=90, cwd=store.DATA_DIR, env=_env())
    except (OSError, subprocess.TimeoutExpired) as e:
        return False, str(e)
    out = (p.stdout or "").strip()
    if p.returncode == 0 and out and not _login_error(out):
        return True, f"Claude answered: {out[:100]}"
    return False, explain((p.stderr or p.stdout or f"exit {p.returncode}").strip()[-400:])


def _login_error(text):
    # Claude Code can print its login error as the "answer" on stdout
    return len(text) < 300 and ("/login" in text or "Invalid API key" in text)


def manual_prompt(w, q):
    return f'Use ProblemVault: answer question {q["id"]} in workspace "{w["title"]}" ({w["id"]}).'


def run(w, q, port, token):
    """Background: run claude -p (or Gemini) and post its answer as a note."""
    from .mcp import post_note
    wid = w["id"]
    with _lock:
        if wid in _running:
            return False
        _running.add(wid)

    def work():
        cfg_path = os.path.join(store.DATA_DIR, "claude-mcp.json")
        cfg = {"mcpServers": {"problemvault": {"type": "http", "url": f"http://127.0.0.1:{port}/mcp",
                                                "headers": {"Authorization": f"Bearer {token}"}}}}
        with open(cfg_path, "w", encoding="utf-8") as f:
            json.dump(cfg, f)
        prompt = f"Workspace {wid}, question {q['id']}: {question_text(q)}"
        who = provider()
        try:
            answer = None
            if who == "claude":
                events.publish(wid, {"type": "ask", "state": "running", "question": q["id"], "by": "claude"})
                p = subprocess.run(
                    [CLI, "-p", "--output-format", "text", "--mcp-config", cfg_path, "--strict-mcp-config",
                     "--allowedTools", "mcp__problemvault", "--disallowedTools", "mcp__problemvault__post_note",
                     "--append-system-prompt", system_prompt()],
                    input=prompt, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600,
                    cwd=store.DATA_DIR, env=_env(),
                )
                answer = (p.stdout or "").strip()
                if p.returncode != 0 or not answer or _login_error(answer) or (len(answer) < 300 and is_limit(answer)):
                    err = (p.stderr or p.stdout or f"exit {p.returncode}").strip()[-600:]
                    if not is_limit(err):
                        raise RuntimeError(explain(err))
                    mark_limited(err)
                    if mode() != "auto" or not gemini.available():
                        raise RuntimeError(f"Claude's usage limit is used up. {err[-200:]}")
                    answer, who = None, "gemini"  # auto: Gemini answers this one
            if who == "gemini":
                events.publish(wid, {"type": "ask", "state": "running", "question": q["id"], "by": "gemini"})
                answer = gemini.run(system_prompt() + "\n\n" + tools_prompt(), prompt)
            if answer is None:
                raise RuntimeError("No AI is set up.")
            post_note(wid, answer, q["id"], by=who)
            events.publish(wid, {"type": "ask", "state": "done", "question": q["id"], "by": who})
        except Exception as e:  # report it in the app instead of failing silently
            events.publish(wid, {"type": "ask", "state": "error", "question": q["id"], "error": str(e), "by": who})
        finally:
            with _lock:
                _running.discard(wid)

    threading.Thread(target=work, daemon=True).start()
    return True
