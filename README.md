# ProblemVault

Homework workspaces. One page per problem: paste the circuit or equation, work it out on top in pen ink, and let Claude read, mark up and comment on it, on your normal Claude subscription (no API key).

- **Drawing**: InkVault's ink engine (`public/ink.js`) and tools: pen / pencil / highlighter, pressure and tilt, colours, sizes, dashed and dotted lines, scribble-to-erase, stroke or precise eraser, pen eraser end, lasso (move, copy, cut, duplicate, delete, paste), undo / redo, two-finger pan and zoom, palm rejection, black canvas, growing page.
- **Images**: paste (Ctrl+V), drop or upload (camera on a phone). Move with the lasso, resize from the corner, write on top.
- **PDFs**: upload, drop or paste a PDF. Each page becomes an image, stacked down the problem below your work (one undo). **⋯ → Export PDF (my writing only)** downloads a PDF with the pages, your ink and your typed text. Claude's ink and notes are left out. Work outside the PDF pages becomes extra pages.
- **Text**: Text tool (T). Tap to type, `$…$` for math (KaTeX).
- **Organised**: folders (course → assignment) with problems, drag to move, status (to do / working / done), search.
- **CalcVault**: link a calculator per problem (search, suggested matches, grouped by folder; or create one in the matching folder). **Update Calc** (tablet bar and CalcVault tab): Claude checks your math; if it is right, it adds your givens and equations that are not in the calculator yet. If not, it marks the mistake and changes nothing.
- **WebAssign** (through AssignPad): view the real question, answer it (MathLive) and Save / Submit, without leaving the problem. Import an assignment as one problem per question; put the question's figures on the page.
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

## WebAssign

Needs your AssignPad server (the `Web-Assign` project) running. ProblemVault calls its API with its password; your Cengage login stays only in AssignPad.

1. Set `ASSIGNPAD_URL` (for example `http://192.168.1.20:8080`) and `ASSIGNPAD_PASSWORD` (AssignPad's `APP_PASSWORD`).
2. Panel → **WebAssign**:
   - No question linked: pick an assignment, then **Link here** on a question, or **Import all as problems** (a folder named after the assignment, one problem per question, problem text filled in).
   - Linked: the question with answer boxes. **Save** / **Submit** go to WebAssign; ✓ / ✗ show WebAssign's marks. **Refresh** reads it again. **Use as problem text** copies the question (cheap for Claude). **Add figures to page** puts its images on the page to write on.
   - **Extension** (under the question): WebAssign's extension rule and **Request extension** (only the automatic extension). Auto extension (X hours after due, for assignments under 100%) is set in AssignPad.
3. Claude: `webassign_read` gives the question and which answers WebAssign marked wrong.
4. Tablet → **Submit** (only on a WebAssign problem): Claude checks your work. If it is right and each final answer is circled, Claude types your answers exactly as written into the math/text boxes and submits. Otherwise it marks what to fix and does not submit. Claude can submit only after you press Submit: one submission, within 15 minutes. Choice boxes (radio, select) you answer yourself.

## InkVault notes

Claude can search and read your InkVault class notes (read-only): typed text as text, handwriting as small cropped PNGs.

1. In InkVault, set `AI_PASSWORD`.
2. In ProblemVault, set `INKVAULT_URL` (for example `https://notes.example.com`) and `INKVAULT_PASSWORD` (the same value).
3. Claude tab → **Let Claude read my InkVault notes** turns it on or off for all devices. When off, Claude does not get the notes tools.

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

Then ask, e.g. *"check my work on HW4 #2"*. Claude tools: `list_workspaces`, `get_workspace`, `view_ink`, `save_transcription`, `describe_image`, `post_note`, `write`, `draw`, `remove_marks`, `update_workspace`, `create_workspace`, `webassign_read`, `calcvault_read`, `calcvault_add_lines`.

**Ask Claude** in the side panel:
- The Docker image includes Claude Code. Log it in once:
  1. CasaOS terminal: `docker exec -it problemvault claude setup-token`. Open the link, log in, copy the token.
  2. App → plug icon → **Claude in this app** → paste → **Save** → **Test**.
  - Or set `CLAUDE_CODE_OAUTH_TOKEN` in the compose file, or run `docker exec -it problemvault claude` and `/login` (kept on the data volume).
- Then Ask Claude runs `claude -p` with only these tools. It uses your plan; `ANTHROPIC_API_KEY` is never passed.
- Not logged in (and no Gemini key): it saves the question and copies a one-line prompt to paste into any connected Claude app.

## Gemini backup

When your Claude limit is used up, Gemini can answer Ask Claude, **Check with Claude**, **Next step** and **Submit** with the same tools. Gemini uses an API key (Google's free tier, or pay per use).

1. Make a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Plug icon → **Gemini backup** → paste → **Save** → **Test**. Or set `GEMINI_API_KEY` (and `GEMINI_MODEL`, default `gemini-flash-latest`).
3. Claude tab → **AI**:
   - **Auto** (default): Claude answers. If Claude Code says the limit is reached, ProblemVault reads the reset time, Gemini answers that request, and Gemini answers until the reset. Then Claude answers again. If the reset time is not given, it tries Claude again after 1 hour.
   - **Claude** or **Gemini**: always that one.

Notes from Gemini show "Gemini" in the Claude panel.

## Run on CasaOS

1. Push this folder to a GitHub repo named `problemvault`. GitHub Actions builds `ghcr.io/<user>/problemvault:latest` (amd64 + arm64).
2. GitHub → Packages → `problemvault` → Package settings → make it Public.
3. If your GitHub user is not `daviied`, change it in `docker-compose.yml`.
4. CasaOS → App Store → **+** → Install a customized app → Import → paste `docker-compose.yml`. Set `APP_PASSWORD`, `CALCVAULT_PASSWORD`, the `ASSIGNPAD_*` and the `INKVAULT_*` values in the form. (docker compose CLI: copy `.env.example` to `.env`.) Never commit passwords or tokens: the repo is public.
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

Env (see `.env.example`): `PORT` (8787), `DATA_DIR` (`./data`), `APP_PASSWORD` (generated and printed if unset), `MCP_TOKEN`, `CALCVAULT_URL`, `CALCVAULT_PUBLIC_URL`, `CALCVAULT_PASSWORD`, `ASSIGNPAD_URL`, `ASSIGNPAD_PASSWORD`, `INKVAULT_URL`, `INKVAULT_PASSWORD`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLAUDE_CLI`, `GEMINI_API_KEY`, `GEMINI_MODEL`.

## Layout

```
server/app.py        HTTP server, REST API, live updates (server-sent events)
server/mcp.py        MCP tools for Claude
server/render.py     ink + image rasteriser for Claude (pure Python)
server/store.py      file storage
server/calcvault.py  CalcVault client
server/webassign.py  AssignPad (WebAssign) client
server/inkvault.py   InkVault notes client (read-only)
server/ask.py        in-app Ask Claude via the Claude Code CLI; auto switch to Gemini
server/gemini.py     Gemini backup (API key) with the same tools
public/              web app (board.js = drawing board, ink.js = InkVault engine)
mcp_stdio.py         stdio bridge for Claude Desktop
```
