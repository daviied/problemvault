"""stdio <-> HTTP bridge so Claude Desktop can use ProblemVault's MCP server.

Claude Desktop starts local MCP servers as programs that talk over stdin/stdout.
This forwards each JSON-RPC message to ProblemVault's /mcp endpoint (on this PC
or on your home server) and writes the reply back. Standard library only.

Claude Desktop config (Settings -> Developer -> Edit Config):

  "mcpServers": {
    "problemvault": {
      "command": "python",
      "args": ["C:\\\\path\\\\to\\\\problemvault\\\\mcp_stdio.py",
               "--url", "http://192.168.1.20:8787/mcp", "--token", "<token from the app>"]
    }
  }
"""
import argparse
import json
import sys
import urllib.error
import urllib.request


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True, help="ProblemVault MCP URL, e.g. http://localhost:8787/mcp")
    ap.add_argument("--token", required=True)
    a = ap.parse_args()
    out = sys.stdout.buffer
    for line in sys.stdin.buffer:
        line = line.strip()
        if not line:
            continue
        try:
            msg_id = json.loads(line).get("id")
        except (json.JSONDecodeError, AttributeError):
            msg_id = None
        req = urllib.request.Request(a.url, data=line, method="POST", headers={
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
            "Authorization": f"Bearer {a.token}",
        })
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                body = r.read()
        except (urllib.error.URLError, OSError) as e:
            if msg_id is None:
                continue
            body = json.dumps({"jsonrpc": "2.0", "id": msg_id,
                               "error": {"code": -32000, "message": f"Can't reach ProblemVault at {a.url}: {e}"}}).encode()
        if body.strip():
            out.write(body.strip() + b"\n")
            out.flush()


if __name__ == "__main__":
    main()
