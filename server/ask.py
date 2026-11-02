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
import json
import os
import shutil
import subprocess
import threading

from . import events, store

CLI = os.environ.get("CLAUDE_CLI") or shutil.which("claude")
_running = set()
_lock = threading.Lock()

SYSTEM = (
    "You are helping a student with homework inside ProblemVault. The student asked a question about "
    "workspace {wid}. Use get_workspace first, view_ink only for ink/images not read yet, and save what "
    "you read (save_transcription / describe_image). If a mark on their page helps (write / draw), add it. "
    "Then reply to the student. Your final message is shown to them as Markdown with $LaTeX$; keep it "
    "focused, and help them learn rather than only giving the answer, unless they ask for the answer."
)


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
    "submit": ("Check and submit to WebAssign",
               "I pressed Submit. Call webassign_read (figures=false if you already saw them) and check ALL my work "
               "on this page. Submit ONLY if every step is right AND each answer box has a final answer I CIRCLED on "
               "the page. Then call webassign_submit with each answer EXACTLY as I wrote it (same digits, rounding "
               "and sign; no units); do not fix or round it for me. If anything is wrong, an answer is not circled, "
               "or a box needs a choice (radio/select): do NOT submit; mark the problem on the page (draw at it, "
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


def available():
    return bool(CLI) and logged_in() and os.environ.get("CLAUDE_CLI_DISABLED") not in ("1", "true")


def status():
    return {
        "installed": bool(CLI),
        "loggedIn": bool(CLI) and logged_in(),
        "tokenSaved": bool(saved_token()),
        "envToken": bool(env_token()),
        "ready": available(),
    }


def test():
    """Run a tiny prompt; (ok, message)."""
    if not CLI:
        return False, "Claude Code is not installed on the server."
    try:
        p = subprocess.run([CLI, "-p", "--output-format", "text", "--strict-mcp-config", "--max-turns", "1"],
                           input="Reply with exactly: OK", capture_output=True, text=True, encoding="utf-8",
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
    """Background: run claude -p and post its answer as a note."""
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
        events.publish(wid, {"type": "ask", "state": "running", "question": q["id"]})
        try:
            p = subprocess.run(
                [CLI, "-p", "--output-format", "text", "--mcp-config", cfg_path, "--strict-mcp-config",
                 "--allowedTools", "mcp__problemvault", "--disallowedTools", "mcp__problemvault__post_note",
                 "--append-system-prompt", SYSTEM.format(wid=wid)],
                input=f"Workspace {wid}, question {q['id']}: {PRESETS[q['preset']][1] if q.get('preset') in PRESETS else q['text']}",
                capture_output=True, text=True, encoding="utf-8", timeout=600, cwd=store.DATA_DIR, env=_env(),
            )
            answer = (p.stdout or "").strip()
            if p.returncode != 0 or not answer or _login_error(answer):
                raise RuntimeError(explain((p.stderr or p.stdout or f"exit {p.returncode}").strip()[-600:]))
            post_note(wid, answer, q["id"])
            events.publish(wid, {"type": "ask", "state": "done", "question": q["id"]})
        except Exception as e:  # report it in the app instead of failing silently
            events.publish(wid, {"type": "ask", "state": "error", "question": q["id"], "error": str(e)})
        finally:
            with _lock:
                _running.discard(wid)

    threading.Thread(target=work, daemon=True).start()
    return True
