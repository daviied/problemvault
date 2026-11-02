# ProblemVault

Homework workspaces. One page per problem: paste the circuit or equation, work it out on top in pen ink, and let Claude read, mark up and comment on it, on your normal Claude subscription (no API key).

- **Drawing**: InkVault's ink engine (`public/ink.js`) and tools: pen / pencil / highlighter, pressure and tilt, colours, sizes, dashed and dotted lines, scribble-to-erase, stroke or precise eraser, pen eraser end, lasso (move, copy, cut, duplicate, delete, paste), undo / redo, two-finger pan and zoom, palm rejection, black canvas, growing page.
- **Images**: paste (Ctrl+V), drop or upload (camera on a phone). Move with the lasso, resize from the corner, write on top.
- **Text**: Text tool (T). Tap to type, `$…$` for math (KaTeX).
- **Organised**: folders (course → assignment) with problems, drag to move, status (to do / working / done), search.
- **CalcVault**: link a calculator per problem. Claude can put your givens and equations into it.
- **Claude**: MCP server at `/mcp`. Claude reads your ink, posts notes in the side panel, and writes and draws on the page with you, live.
- **PWA**: install it from the browser on laptop or phone (needs https, or localhost).

## Three apps, synced

Open each address on its device and install it (browser menu → Install / Add to Home Screen):

| App | Address | What it shows |
|---|---|---|
| Desktop | `/` | Everything side by side |
| Tablet | `/tablet` | The page, full screen. ☰ opens problems, **Panel** opens Problem / Claude / CalcVault |
| Phone | `/phone` | Problems, Claude, CalcVault, plus a small read-only view of the page (drag to pan, pinch to zoom) |

**Follow** (toolbar and sidebar): when you open a problem on one device, the other devices with Follow on open it too. Turn it off on a device to work on a different problem there. Ink, text and Claude's notes sync live on all devices.

## Low token use

Claude pays for an image by its pixel area. ProblemVault never sends screenshots:

1. `get_workspace` returns text: typed problem, what Claude already read, image descriptions, open questions.
2. `view_ink` renders only ink Claude has not read, grouped into lines / equations, cropped tight, scaled so handwriting is about 22 px tall. A line of working is about 30–60 tokens; a pasted circuit about 270 tokens, once.
3. Claude saves what it read (`save_transcription`, `describe_image`). Next time it gets the text, not the picture. Already-read ink shows grey for context.

**Panel → Claude → What Claude has read → Preview Claude's view** shows exactly what would be sent and the token estimate.

## Connect Claude (subscription, no API)

Click the plug icon in the sidebar for your URL and token, then:

- **Claude Code**: `claude mcp add --transport http problemvault http://<server>:8787/mcp --header "Authorization: Bearer <token>"`
- **Claude Desktop**: Settings → Developer → Edit Config, use `mcp_stdio.py` (in this folder, needs Python):
  ```json
  { "mcpServers": { "problemvault": { "command": "python",
      "args": ["C:\\path\\to\\problemvault\\mcp_stdio.py", "--url", "http://<server>:8787/mcp", "--token", "<token>"] } } }
  ```
- **claude.ai** (web / phone): Settings → Connectors → Add custom connector, URL `https://<public-host>/mcp/<token>`. Needs ProblemVault on the internet over https (reverse proxy or tunnel).

Then ask, e.g. *"check my work on HW4 #2"*. Claude tools: `list_workspaces`, `get_workspace`, `view_ink`, `save_transcription`, `describe_image`, `post_note`, `write`, `draw`, `remove_marks`, `update_workspace`, `create_workspace`, `calcvault_read`, `calcvault_add_lines`.

**Ask Claude** in the side panel:
- The Docker image includes Claude Code. Log it in once:
  1. CasaOS terminal: `docker exec -it problemvault claude setup-token`. Open the link, log in, copy the token.
  2. App → plug icon → **Claude in this app** → paste → **Save** → **Test**.
  - Or set `CLAUDE_CODE_OAUTH_TOKEN` in the compose file, or run `docker exec -it problemvault claude` and `/login` (kept on the data volume).
- Then Ask Claude runs `claude -p` with only these tools. It uses your plan; `ANTHROPIC_API_KEY` is never passed.
- Not logged in: it saves the question and copies a one-line prompt to paste into any connected Claude app.

## Run on CasaOS

1. Push this folder to a GitHub repo named `problemvault`. GitHub Actions builds `ghcr.io/<user>/problemvault:latest` (amd64 + arm64).
2. GitHub → Packages → `problemvault` → Package settings → make it Public.
3. If your GitHub user is not `daviied`, change it in `docker-compose.yml`.
4. CasaOS → App Store → **+** → Install a customized app → Import → paste `docker-compose.yml`. Set `APP_PASSWORD` and `CALCVAULT_PASSWORD`.
5. Open `http://<casaos-ip>:8787` and log in. If `APP_PASSWORD` is empty, the container log shows a generated password.

## Public, behind nginx

Login is always required. The Claude connector uses its own token (`/mcp`). Failed logins and tokens are limited to 10 per 5 minutes per client. Behind https the session cookie is `Secure`.

Nginx `server` block (add your TLS lines):

```nginx
location / {
    proxy_pass http://<casaos-ip>:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 40m;    # pasted images
    proxy_buffering off;         # live updates
    proxy_read_timeout 1h;
}
```

Https also makes the app installable (PWA) and lets claude.ai use the connector.

Data: `/DATA/AppData/problemvault/data` (problems, images, Claude notes; deleted problems go to `trash/`).

## Run without Docker

Python 3.10+, no packages:

```bash
python run.py
```

Env: `PORT` (8787), `DATA_DIR` (`./data`), `APP_PASSWORD` (generated and printed if unset), `MCP_TOKEN`, `CALCVAULT_URL`, `CALCVAULT_PUBLIC_URL`, `CALCVAULT_PASSWORD`, `CLAUDE_CLI`.

## Layout

```
server/app.py        HTTP server, REST API, live updates (server-sent events)
server/mcp.py        MCP tools for Claude
server/render.py     ink + image rasteriser for Claude (pure Python)
server/store.py      file storage
server/calcvault.py  CalcVault client
server/ask.py        in-app Ask Claude via the Claude Code CLI
public/              web app (board.js = drawing board, ink.js = InkVault engine)
mcp_stdio.py         stdio bridge for Claude Desktop
```
