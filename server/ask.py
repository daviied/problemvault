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


def saved_token():
    return store.secrets_file().get("claude_token", "")


def set_token(token):
    store.update_secrets({"claude_token": token.strip()})


def _env():
    env = dict(os.environ)
    tok = saved_token()
    if tok:
        env["CLAUDE_CODE_OAUTH_TOKEN"] = tok
    env.pop("ANTHROPIC_API_KEY", None)  # never fall back to API billing
    return env


def logged_in():
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or saved_token():
        return True
    return os.path.exists(os.path.join(os.path.expanduser("~"), ".claude", ".credentials.json"))


def available():
    return bool(CLI) and logged_in() and os.environ.get("CLAUDE_CLI_DISABLED") not in ("1", "true")


def status():
    return {
        "installed": bool(CLI),
        "loggedIn": bool(CLI) and logged_in(),
        "tokenSaved": bool(saved_token()),
        "envToken": bool(os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")),
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
    if p.returncode == 0 and out:
        return True, f"Claude answered: {out[:100]}"
    return False, (p.stderr or p.stdout or f"exit {p.returncode}").strip()[-400:]


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
                input=f"Workspace {wid}, question {q['id']}: {q['text']}",
                capture_output=True, text=True, encoding="utf-8", timeout=600, cwd=store.DATA_DIR, env=_env(),
            )
            answer = (p.stdout or "").strip()
            if p.returncode != 0 or not answer:
                raise RuntimeError((p.stderr or p.stdout or f"exit {p.returncode}").strip()[-600:])
            post_note(wid, answer, q["id"])
            events.publish(wid, {"type": "ask", "state": "done", "question": q["id"]})
        except Exception as e:  # report it in the app instead of failing silently
            events.publish(wid, {"type": "ask", "state": "error", "question": q["id"], "error": str(e)})
        finally:
            with _lock:
                _running.discard(wid)

    threading.Thread(target=work, daemon=True).start()
    return True
