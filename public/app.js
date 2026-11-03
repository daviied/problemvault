// ProblemVault shell: problem tree, routing, live sync, and the side panel
// (problem details, Claude notes / questions, CalcVault). The drawing board
// itself lives in board.js.
//
// One page, three installable apps (the server sets <html data-mode>):
//   desktop  /        everything side by side
//   tablet   /tablet  the page first; problems and the panel slide in as menus
//   phone    /phone   problems, Claude, CalcVault, and a read-only view of the page
// Devices with Follow on all open the problem last opened on any of them.
import * as board from './board.js';
import * as webassign from './webassign.js';

const $ = s => document.querySelector(s);
const clientId = Math.random().toString(36).slice(2, 10);
const MODE = document.documentElement.dataset.mode || 'desktop';
const BASE = MODE === 'desktop' ? '' : `/${MODE}`;
let follow = localStorage.getItem('problemvault.follow') !== '0';
let state = null; // /api/state
let ws = null; // { meta, claude } of the open workspace
let wsEvents = null;
const openFolders = new Set(JSON.parse(localStorage.getItem('problemvault.open') || '[]'));

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function call(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401 && !url.startsWith('/api/login')) { showLogin(); throw new Error('Log in first'); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

// Board changes are sent strictly in order, one at a time.
const outbox = [];
let sending = false;
async function flush() {
  if (sending) return;
  sending = true;
  while (outbox.length) {
    const [id, change] = outbox[0];
    try {
      await call('POST', `/api/ws/${id}/change`, { change, client: clientId });
      outbox.shift();
    } catch (err) {
      toast(`Not saved yet (${err.message}), retrying…`, 3000);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  sending = false;
}
window.addEventListener('beforeunload', e => { if (outbox.length) e.preventDefault(); });

board.init({
  change(id, change) { outbox.push([id, change]); flush(); },
  live(id, sid, stroke) { fetch(`/api/ws/${id}/live`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sid, stroke, client: clientId }) }).catch(() => {}); },
  uploadImage: (id, payload) => call('POST', `/api/ws/${id}/img`, payload),
  imageUrl: (id, imgId) => `/api/ws/${id}/img/${imgId}`,
  renderText: md => markdown(md),
  toast,
});

// ---------------------------------------------------------------------------
// Start-up and login
// ---------------------------------------------------------------------------

async function start() {
  const s = await call('GET', '/api/session');
  if (!s.authed) return showLogin();
  $('#login').hidden = true;
  $('#app').hidden = false;
  await loadState();
  listen('index', m => (m.type === 'focus' ? onFocus(m.ws) : loadState()));
  route(true);
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-pw').focus();
}
$('#login form').onsubmit = async e => {
  e.preventDefault();
  try {
    await call('POST', '/api/login', { password: $('#login-pw').value });
    $('#login-err').textContent = '';
    start();
  } catch (err) {
    $('#login-err').textContent = err.message;
  }
};

async function loadState() {
  state = await call('GET', '/api/state');
  renderInkToggle();
  renderAi();
  renderTree();
  renderFolderSelect();
}

// InkVault notes for Claude: shown once the server is connected to InkVault; on/off for every device
function renderInkToggle() {
  const iv = state.inkvault || {};
  $('#ink-toggle').hidden = !iv.configured;
  $('#ink-on').checked = !!iv.enabled;
}
$('#ink-on').addEventListener('change', async e => {
  try { state.inkvault = await call('PUT', '/api/inkvault', { enabled: e.target.checked }); }
  catch (err) { toast(err.message); }
  renderInkToggle();
});

// Which AI answers in the app: Auto (Claude; Gemini while Claude is at its limit), Claude or Gemini
const aiName = by => (by === 'gemini' ? 'Gemini' : 'Claude');
function renderAi() {
  const ai = state.ai || {};
  $('#ai-pick').hidden = !(ai.gemini && ai.gemini.ready);
  document.querySelectorAll('input[name="ai-mode"]').forEach(r => { r.checked = r.value === ai.mode; });
  const until = ai.limitedUntil ? new Date(ai.limitedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
  $('#ai-note').textContent = !ai.provider ? `${aiName(ai.mode)} is not set up`
    : until ? `Claude limit reached, resets about ${until}. ${ai.mode === 'auto' ? 'Gemini answers until then.' : ''}`
      : `${aiName(ai.provider)} answers`;
}
document.querySelectorAll('input[name="ai-mode"]').forEach(r => r.addEventListener('change', async () => {
  try { state.ai = await call('PUT', '/api/ai', { mode: r.value }); } catch (err) { toast(err.message); }
  renderAi();
}));

// Server-sent events, reconnecting on their own
function listen(key, onMsg) {
  const es = new EventSource(`/api/events?key=${encodeURIComponent(key)}`);
  es.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.origin && m.origin === clientId) return;
    onMsg(m);
  };
  return es;
}

// ---------------------------------------------------------------------------
// Routing: /w/<id>
// ---------------------------------------------------------------------------

async function route(first = false) {
  const m = /\/w\/([a-z0-9]+)/i.exec(location.pathname);
  let id = m?.[1];
  if (first && follow) { // join whatever problem the other devices are on
    const f = await call('GET', '/api/focus').catch(() => ({}));
    if (f.ws) { id = f.ws; history.replaceState(null, '', `${BASE}/w/${id}`); }
  }
  if (id) openWorkspace(id, false, { announce: false });
  else showEmpty();
}
window.addEventListener('popstate', () => route());

// Another device opened a problem
function onFocus(id) {
  if (follow && id && id !== ws?.meta.id) openWorkspace(id, true, { announce: false });
}

function renderFollow() {
  document.querySelectorAll('.follow-btn').forEach(b => {
    b.classList.toggle('on', follow);
    b.title = follow ? 'Following: this device opens the problem you open on any device. Click to stop.' : 'Not following other devices. Click to follow.';
  });
}

function setFollow(on) {
  follow = on;
  localStorage.setItem('problemvault.follow', on ? '1' : '0');
  renderFollow();
  if (on) {
    call('GET', '/api/focus').then(f => {
      if (f.ws && f.ws !== ws?.meta.id) openWorkspace(f.ws, true, { announce: false });
      else if (!f.ws && ws) call('PUT', '/api/focus', { ws: ws.meta.id, client: clientId });
    }).catch(() => {});
  }
}
document.querySelectorAll('.follow-btn').forEach(b => { b.onclick = () => setFollow(!follow); });
renderFollow();

function showEmpty() {
  ws = null;
  wsEvents?.close();
  board.close();
  $('#board').hidden = true;
  $('#empty').hidden = false;
  renderTree();
}

async function openWorkspace(id, push = true, { announce = true } = {}) {
  if (push) history.pushState(null, '', `${BASE}/w/${id}`);
  let data;
  try {
    data = await call('GET', `/api/ws/${id}`);
  } catch (err) {
    toast(err.message);
    history.replaceState(null, '', BASE || '/');
    return showEmpty();
  }
  if (announce && follow) call('PUT', '/api/focus', { ws: id, client: clientId }).catch(() => {});
  ws = { meta: data.meta, claude: data.claude };
  $('#empty').hidden = true;
  $('#board').hidden = false;
  $('#app').classList.remove('side-open');
  board.open(id, data.page);
  renderMeta();
  renderClaude();
  renderCalc();
  if (currentTab() === 'wa') webassign.render();
  renderTree();
  wsEvents?.close();
  wsEvents = listen(id, onWsEvent);
}

async function onWsEvent(m) {
  if (!ws) return;
  if (m.type === 'change') board.remoteChange(m.change);
  else if (m.type === 'live') board.remoteStroke(m.sid, m.stroke);
  else if (m.type === 'claude') {
    const d = await call('GET', `/api/ws/${ws.meta.id}`);
    const newNote = d.claude.notes.length > ws.claude.notes.length;
    ws.claude = d.claude;
    renderClaude();
    if (newNote) {
      toast('Claude posted a note', 2500);
      if (currentTab() !== 'claude' || !$('#main').classList.contains('panel-open')) $('#claude-badge').hidden = false;
    }
  } else if (m.type === 'meta') {
    const d = await call('GET', `/api/ws/${ws.meta.id}`);
    const relink = JSON.stringify(d.meta.wa) !== JSON.stringify(ws.meta.wa);
    ws.meta = d.meta;
    renderMeta();
    renderCalc();
    if (relink) webassign.render();
  } else if (m.type === 'calc') renderCalc();
  else if (m.type === 'wa-submitted') { if (currentTab() === 'wa') webassign.render(); }
  else if (m.type === 'ask') {
    const el = $('#ask-state');
    const who = aiName(m.by);
    if (m.state === 'running') el.textContent = `${who} is working on it…`;
    else if (m.state === 'done') el.textContent = '';
    else if (m.state === 'error') { el.textContent = `${who} failed: ${m.error}`; toast(`${who} failed (see the Claude tab)`, 3000); }
    setQuickBusy(m.state === 'running');
    if (m.state === 'done' && MODE === 'tablet') toast(`${who} is done: see the marks on your page`, 2500);
  }
}

// ---------------------------------------------------------------------------
// Sidebar tree: folders (nestable) and problems, drag a problem onto a folder
// ---------------------------------------------------------------------------

function renderTree() {
  if (!state) return;
  const { folders, workspaces } = state.index;
  const q = $('#search').value.trim().toLowerCase();
  const tree = $('#tree');
  tree.innerHTML = '';
  const byParent = p => folders.filter(f => (f.parent || null) === p).sort((a, b) => a.name.localeCompare(b.name));
  const wsIn = f => workspaces.filter(w => (w.folder || null) === f).sort((a, b) => b.updated - a.updated);
  const folderMatches = f => !q || f.name.toLowerCase().includes(q)
    || wsIn(f.id).some(w => w.title.toLowerCase().includes(q)) || byParent(f.id).some(folderMatches);

  function wsNode(w) {
    const el = document.createElement('div');
    el.className = 'node ws' + (ws?.meta.id === w.id ? ' active' : '');
    el.draggable = true;
    el.innerHTML = `<span class="dot ${w.status}"></span><span class="name"></span>${w.questions ? `<span class="badge" title="Open questions for Claude">${w.questions}?</span>` : ''}`;
    el.querySelector('.name').textContent = w.title;
    el.title = w.title;
    el.onclick = () => openWorkspace(w.id);
    el.ondragstart = e => e.dataTransfer.setData('text/problemvault-ws', w.id);
    return el;
  }

  function dropTarget(el, folderId) {
    el.addEventListener('dragover', e => {
      if ([...e.dataTransfer.types].some(t => t.startsWith('text/problemvault'))) { e.preventDefault(); el.classList.add('drop'); }
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop'));
    el.addEventListener('drop', async e => {
      e.preventDefault();
      el.classList.remove('drop');
      const wid = e.dataTransfer.getData('text/problemvault-ws');
      const fid = e.dataTransfer.getData('text/problemvault-folder');
      if (wid) await call('PATCH', `/api/workspaces/${wid}`, { folder: folderId });
      if (fid && fid !== folderId) await call('PATCH', `/api/folders/${fid}`, { parent: folderId });
      if (folderId) openFolders.add(folderId);
      saveOpen();
      loadState();
    });
  }

  function folderNode(f, parentEl) {
    if (!folderMatches(f)) return;
    const open = openFolders.has(f.id) || !!q;
    const el = document.createElement('div');
    el.className = 'node folder' + (open ? ' open' : '');
    el.draggable = true;
    el.innerHTML = `<span class="caret">▶</span><span class="name"></span><span class="acts">
      <button data-a="ws" title="New problem here">+</button><button data-a="sub" title="New subfolder">⊞</button>
      <button data-a="ren" title="Rename">✎</button><button data-a="del" title="Delete folder">×</button></span>`;
    el.querySelector('.name').textContent = f.name;
    el.onclick = e => {
      const a = e.target.dataset?.a;
      if (a === 'ws') return newWorkspace(f.id);
      if (a === 'sub') return newFolder(f.id);
      if (a === 'ren') return renameFolder(f);
      if (a === 'del') return deleteFolder(f);
      open ? openFolders.delete(f.id) : openFolders.add(f.id);
      saveOpen();
      renderTree();
    };
    el.ondragstart = e => e.dataTransfer.setData('text/problemvault-folder', f.id);
    dropTarget(el, f.id);
    parentEl.appendChild(el);
    if (!open) return;
    const kids = document.createElement('div');
    kids.className = 'children';
    for (const sub of byParent(f.id)) folderNode(sub, kids);
    for (const w of wsIn(f.id)) if (!q || w.title.toLowerCase().includes(q) || f.name.toLowerCase().includes(q)) kids.appendChild(wsNode(w));
    parentEl.appendChild(kids);
  }

  for (const f of byParent(null)) folderNode(f, tree);
  for (const w of wsIn(null)) if (!q || w.title.toLowerCase().includes(q)) tree.appendChild(wsNode(w));
  const root = document.createElement('div');
  root.className = 'root-drop';
  dropTarget(root, null);
  tree.appendChild(root);
  if (!folders.length && !workspaces.length) {
    tree.insertAdjacentHTML('afterbegin', '<p class="muted small" style="padding:8px">Make a folder per course (and one per assignment inside it), then a problem for each question.</p>');
  }
}
function saveOpen() { localStorage.setItem('problemvault.open', JSON.stringify([...openFolders])); }
$('#search').oninput = renderTree;

async function newWorkspace(folder = null) {
  const title = prompt('Problem name (e.g. "HW4 #2 – Thevenin")');
  if (!title) return;
  if (folder) { openFolders.add(folder); saveOpen(); }
  const w = await call('POST', '/api/workspaces', { title, folder: folder ?? (ws?.meta.folder || null) });
  await loadState();
  openWorkspace(w.id);
}
async function newFolder(parent = null) {
  const name = prompt(parent ? 'Subfolder name (e.g. "Homework 4")' : 'Folder name (e.g. "ECE 210")');
  if (!name) return;
  if (parent) { openFolders.add(parent); saveOpen(); }
  const f = await call('POST', '/api/folders', { name, parent });
  openFolders.add(f.id);
  saveOpen();
  loadState();
}
async function renameFolder(f) {
  const name = prompt('Rename folder', f.name);
  if (name) { await call('PATCH', `/api/folders/${f.id}`, { name }); loadState(); }
}
async function deleteFolder(f) {
  if (!confirm(`Delete folder "${f.name}"? Its problems and subfolders move up a level; nothing is lost.`)) return;
  await call('DELETE', `/api/folders/${f.id}`);
  loadState();
}
$('#new-ws').onclick = () => newWorkspace();
$('#empty-new').onclick = () => newWorkspace();
$('#new-folder').onclick = () => newFolder();
$('#logout-btn').onclick = async () => {
  await call('POST', '/api/logout');
  location.href = '/';
};
$('#side-toggle').onclick = () => $('#app').classList.toggle('side-open');
$('#empty-menu').onclick = () => $('#app').classList.add('side-open');
document.addEventListener('pointerdown', e => {
  if ($('#app').classList.contains('side-open') && !e.target.closest('#sidebar, #side-toggle, #empty-menu')) $('#app').classList.remove('side-open');
});

// ---------------------------------------------------------------------------
// Panel: tabs
// ---------------------------------------------------------------------------

const currentTab = () => document.querySelector('.tabs .on')?.dataset.tab;
function showTab(tab) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach(t => { t.hidden = t.id !== `tab-${tab}`; });
  if (tab === 'claude') $('#claude-badge').hidden = true;
  if (tab === 'wa' && ws) webassign.render();
  localStorage.setItem('problemvault.tab', tab);
}
document.querySelectorAll('.tabs button').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });
showTab(localStorage.getItem('problemvault.tab') || 'problem');

function setPanel(open) {
  if (MODE === 'phone') open = true; // the panel is the phone app
  $('#main').classList.toggle('panel-open', open);
  $('#panel-toggle').classList.toggle('on', open);
  localStorage.setItem('problemvault.panel', open ? '1' : '0');
  if (open && currentTab() === 'claude') $('#claude-badge').hidden = true;
  requestAnimationFrame(() => board.relayout());
}
$('#panel-toggle').onclick = () => setPanel(!$('#main').classList.contains('panel-open'));
// tablet: the page first, the panel is a menu you open
setPanel(MODE === 'phone' || (MODE === 'desktop' && localStorage.getItem('problemvault.panel') !== '0' && innerWidth > 1100));
if (MODE === 'phone') board.setReadOnly(true);
// desktop: no drawing (that is the tablet's job), only select / move / resize and images
if (MODE === 'desktop') board.setTools(['lasso'], { imagesOnly: true });
document.documentElement.dataset.mode = MODE;

// ---------------------------------------------------------------------------
// Problem tab
// ---------------------------------------------------------------------------

function renderFolderSelect() {
  const sel = $('#ws-folder');
  const { folders } = state.index;
  const opts = ['<option value="">(no folder)</option>'];
  const walk = (parent, depth) => {
    for (const f of folders.filter(f => (f.parent || null) === parent).sort((a, b) => a.name.localeCompare(b.name))) {
      opts.push(`<option value="${f.id}">${'\u00a0\u00a0'.repeat(depth)}${esc(f.name)}</option>`);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  sel.innerHTML = opts.join('');
  if (ws) sel.value = ws.meta.folder || '';
}

function renderMeta() {
  const m = ws.meta;
  $('#title').textContent = m.title;
  document.title = `${m.title} · ProblemVault`;
  if (document.activeElement !== $('#ws-title')) $('#ws-title').value = m.title;
  if (document.activeElement !== $('#ws-problem')) $('#ws-problem').value = m.problem || '';
  $('#ws-status').value = m.status;
  $('#quick [data-preset=submit]').hidden = !m.wa; // only for a WebAssign problem
  $('#ws-folder').value = m.folder || '';
}

let metaTimer = 0;
function saveMeta(fields, delay = 600) {
  if (!ws) return;
  const id = ws.meta.id;
  Object.assign(ws.meta, fields);
  clearTimeout(metaTimer);
  metaTimer = setTimeout(async () => {
    await call('PATCH', `/api/workspaces/${id}`, fields).catch(err => toast(err.message));
    if ('title' in fields || 'status' in fields || 'folder' in fields) loadState();
  }, delay);
}
$('#ws-title').oninput = e => { $('#title').textContent = e.target.value; saveMeta({ title: e.target.value }); };
$('#ws-problem').oninput = e => saveMeta({ problem: e.target.value }, 900);
$('#ws-status').onchange = e => saveMeta({ status: e.target.value }, 0);
$('#ws-folder').onchange = e => saveMeta({ folder: e.target.value || null }, 0);
$('#ws-delete').onclick = async () => {
  if (!ws || !confirm(`Delete "${ws.meta.title}"? It moves to the data folder's trash.`)) return;
  await call('DELETE', `/api/workspaces/${ws.meta.id}`);
  history.pushState(null, '', BASE || '/');
  await loadState();
  showEmpty();
};

// ---------------------------------------------------------------------------
// Claude tab
// ---------------------------------------------------------------------------

function renderClaude() {
  const c = ws.claude;
  const qs = $('#questions');
  qs.innerHTML = '';
  for (const q of c.questions.filter(q => !q.answered)) {
    const el = document.createElement('div');
    el.className = 'question';
    el.innerHTML = '<span class="q"></span><button title="Remove">×</button>';
    el.querySelector('.q').textContent = `You asked: ${q.text}`;
    el.querySelector('button').onclick = () => call('DELETE', `/api/ws/${ws.meta.id}/questions/${q.id}`);
    qs.appendChild(el);
  }
  const notes = $('#notes');
  notes.innerHTML = '';
  const qById = new Map(c.questions.map(q => [q.id, q]));
  for (const n of [...c.notes].reverse()) {
    const el = document.createElement('div');
    el.className = 'note';
    const q = n.reply_to && qById.get(n.reply_to);
    el.innerHTML = `<div class="note-head"><span>${aiName(n.by)} · ${when(n.at)}</span><button title="Delete note">×</button></div>
      ${q ? '<div class="muted small re"></div>' : ''}<div class="md"></div>`;
    if (q) el.querySelector('.re').textContent = `Re: ${q.text}`;
    el.querySelector('.md').innerHTML = markdown(n.md);
    el.querySelector('button').onclick = () => call('DELETE', `/api/ws/${ws.meta.id}/notes/${n.id}`);
    notes.appendChild(el);
  }
  if (!c.notes.length) {
    notes.innerHTML = `<p class="muted small" style="margin-top:14px">Claude's notes on this problem appear here. ${state.claude.cli
      ? 'Ask above; Claude Code runs on this server with your subscription.'
      : 'Ask above, or from any Claude app connected to ProblemVault (🔌 in the sidebar).'}</p>`;
  }
  const list = $('#read-list');
  list.innerHTML = '';
  const items = [
    ...Object.entries(c.images).map(([, d]) => `🖼 ${d.text}`),
    ...c.transcripts.map(t => `✎ ${t.text}`),
  ];
  for (const t of items) {
    const el = document.createElement('div');
    el.className = 't';
    el.innerHTML = markdown(t.includes('\\') && !t.includes('$') ? `${t.slice(0, 2)} $${t.slice(2)}$` : t);
    list.appendChild(el);
  }
  $('#read-count').textContent = items.length ? `(${items.length})` : '(nothing yet)';
}

$('#ask').onsubmit = async e => {
  e.preventDefault();
  const text = $('#ask-text').value.trim();
  if (!text || !ws) return;
  try {
    const r = await call('POST', `/api/ws/${ws.meta.id}/ask`, { text });
    $('#ask-text').value = '';
    if (r.mode === 'cli') {
      $('#manual').hidden = true;
      $('#ask-state').textContent = `${aiName(r.by)} is working on it…`;
    } else {
      $('#manual').hidden = false;
      $('#manual-prompt').textContent = r.prompt;
      copy(r.prompt);
    }
  } catch (err) {
    toast(err.message);
  }
};
// Tablet: "Check with Claude" and "Next step" send a ready-made request (text is on the server)
function setQuickBusy(busy) {
  document.querySelectorAll('#quick button, #calc-update').forEach(b => { b.disabled = busy; });
}
document.querySelectorAll('#quick button').forEach(b => b.addEventListener('click', async () => {
  if (!ws) return toast('Open a problem first');
  if (b.dataset.preset === 'submit'
    && !confirm('Claude checks your work. If it is right and your answers are circled, Claude types them into WebAssign and submits. Continue?')) return;
  try {
    const r = await call('POST', `/api/ws/${ws.meta.id}/ask`, { preset: b.dataset.preset });
    if (r.mode === 'cli') {
      setQuickBusy(true);
      $('#ask-state').textContent = `${aiName(r.by)} is working on it…`;
      toast({ check: 'Claude is checking your work…', next: 'Claude is looking at your work…', submit: 'Claude is checking before it submits…', calc: 'Claude is checking your math for CalcVault…' }[b.dataset.preset], 2500);
    } else {
      copy(r.prompt);
      toast('Copied: paste it into Claude (ProblemVault connector on)', 3500);
    }
  } catch (err) {
    toast(err.message);
  }
}));
$('#ask-text').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#ask').requestSubmit(); });
$('#manual-copy').onclick = () => copy($('#manual-prompt').textContent);

$('#preview-btn').onclick = async () => {
  const r = await call('GET', `/api/ws/${ws.meta.id}/preview?what=unread`);
  const body = $('#preview-body');
  body.innerHTML = '';
  if (!r.shots.length) body.innerHTML = `<p>${esc(r.note)}</p>`;
  let total = 0;
  for (const s of r.shots) {
    total += Number(/~(\d+) tokens/.exec(s.caption)?.[1] || 0);
    const f = document.createElement('figure');
    f.innerHTML = `<img src="data:image/png;base64,${s.png}"><figcaption></figcaption>`;
    f.querySelector('figcaption').textContent = s.caption;
    body.appendChild(f);
  }
  if (r.shots.length) body.insertAdjacentHTML('afterbegin', `<p class="muted">Only ink Claude hasn't read yet is sent, cropped and sized to your handwriting: about <strong>${total}</strong> image tokens in total. Grey ink is context it already read.</p>`);
  $('#preview').showModal();
};
$('#forget-btn').onclick = async () => {
  if (confirm('Forget everything Claude has read on this page? It will look at all of it again next time.')) {
    await call('POST', `/api/ws/${ws.meta.id}/forget`);
  }
};

// ---------------------------------------------------------------------------
// CalcVault tab
// ---------------------------------------------------------------------------

let calcPicking = false; // linked, but choosing another calculator
let calcTree = null;

async function renderCalc() {
  const cv = state.calcvault;
  $('#calc-off').hidden = cv.enabled;
  $('#calc-on').hidden = !cv.enabled;
  if (!cv.enabled || !ws) return;
  const linked = ws.meta.calc;
  if (!linked) calcPicking = false;
  $('#calc-linked').hidden = !linked || calcPicking;
  $('#calc-unlinked').hidden = !!linked && !calcPicking;
  $('#calc-open').href = cv.url || '#';
  if (linked && !calcPicking) {
    $('#calc-name').textContent = linked.name;
    const ol = $('#calc-lines');
    ol.innerHTML = '<li class="muted">Loading…</li>';
    try {
      const { calc } = await call('GET', `/api/ws/${ws.meta.id}/calc`);
      const lines = calc?.data?.lines || [];
      ol.innerHTML = lines.length ? '' : '<li class="muted">No lines yet.</li>';
      for (const ln of lines) {
        const li = document.createElement('li');
        if (ln.role === 'input') li.innerHTML = `<span class="lbl">${esc(ln.label || 'input')}</span>${tex(`${ln.varName || ''}=${ln.value || ''}`)}`;
        else if (ln.role === 'output') li.innerHTML = `<span class="lbl">${esc(ln.label || 'output')}</span>${tex(ln.expr || '')}`;
        else li.innerHTML = tex(ln.latex || '');
        ol.appendChild(li);
      }
    } catch (err) {
      ol.innerHTML = `<li class="muted">${esc(err.message)}</li>`;
    }
    return;
  }
  // Picker: create a new calculator (folder guessed from the problem's folders), or search and link one
  $('#calc-pick-title').textContent = linked ? 'Change calculator' : 'Link a calculator';
  $('#calc-cancel').hidden = !linked;
  $('#calc-new-name').value = ws.meta.title;
  $('#calc-search').value = '';
  $('#calc-list').innerHTML = '<p class="muted small">Loading…</p>';
  try {
    calcTree = await call('GET', '/api/calcvault/tree');
  } catch (err) {
    $('#calc-list').innerHTML = `<p class="muted small">${esc(err.message)}</p>`;
    return;
  }
  const path = id => {
    const out = [];
    for (let f = calcTree.folders.find(x => x.id === id); f && out.length < 8; f = calcTree.folders.find(x => x.id === f.parent_id)) out.unshift(f.name);
    return out.join(' / ');
  };
  calcTree.calculators.forEach(c => { c.path = path(c.folder_id); });
  const pvFolders = folderPath(ws.meta.folder).map(n => n.toLowerCase());
  const guess = [...calcTree.folders].reverse().find(f => pvFolders.includes(f.name.toLowerCase()));
  $('#calc-new-folder').innerHTML = '<option value="">No folder</option>' + calcTree.folders
    .map(f => ({ id: f.id, p: path(f.id) })).sort((x, y) => x.p.localeCompare(y.p))
    .map(f => `<option value="${f.id}"${guess && guess.id === f.id ? ' selected' : ''}>${esc(f.p)}</option>`).join('');
  renderCalcList();
}

// Names of the problem's folders, outermost first (course, assignment)
function folderPath(id) {
  const out = [];
  for (let f = state.index.folders.find(x => x.id === id); f && out.length < 8; f = state.index.folders.find(x => x.id === f.parent)) out.unshift(f.name);
  return out;
}

function renderCalcList() {
  const list = $('#calc-list');
  if (!calcTree) return;
  const q = $('#calc-search').value.trim().toLowerCase();
  const words = [ws.meta.title, ...folderPath(ws.meta.folder)].join(' ').toLowerCase().split(/[^a-z0-9#.]+/).filter(w => w.length > 1);
  const score = c => words.filter(w => `${c.name} ${c.path}`.toLowerCase().includes(w)).length;
  const calcs = calcTree.calculators.filter(c => !q || `${c.name} ${c.path}`.toLowerCase().includes(q));
  const cur = ws.meta.calc?.id;
  const item = (c, showPath) => `<button data-id="${c.id}"${c.id === cur ? ' class="current"' : ''}><span class="n">${esc(c.name)}</span>
    ${showPath && c.path ? `<span class="f">${esc(c.path)}</span>` : ''}${c.id === cur ? '<span class="f">linked</span>' : ''}</button>`;
  let html = '';
  if (!q) {
    const sugg = calcs.map(c => [score(c), c]).filter(([n]) => n > 0).sort((x, y) => y[0] - x[0]).slice(0, 4).map(([, c]) => c);
    if (sugg.length) html += '<h4>Suggested</h4>' + sugg.map(c => item(c, true)).join('');
  }
  const groups = new Map();
  for (const c of [...calcs].sort((x, y) => x.name.localeCompare(y.name))) {
    if (!groups.has(c.path)) groups.set(c.path, []);
    groups.get(c.path).push(c);
  }
  for (const [p, cs] of [...groups].sort((x, y) => (!x[0]) - (!y[0]) || x[0].localeCompare(y[0]))) {
    html += `<h4>${esc(p || 'No folder')}</h4>` + cs.map(c => item(c, false)).join('');
  }
  list.innerHTML = html || `<p class="muted small">${q ? 'No calculator matches.' : 'No calculators yet. Create one above.'}</p>`;
}
$('#calc-search').addEventListener('input', renderCalcList);
$('#calc-list').addEventListener('click', async e => {
  const b = e.target.closest('button[data-id]');
  if (!b) return;
  calcPicking = false;
  try { await call('POST', `/api/ws/${ws.meta.id}/calc`, { id: Number(b.dataset.id) }); } catch (err) { toast(err.message); }
  renderCalc();
});
$('#calc-create').onclick = async () => {
  const name = $('#calc-new-name').value.trim() || ws.meta.title;
  const folder = $('#calc-new-folder').value;
  calcPicking = false;
  try { await call('POST', `/api/ws/${ws.meta.id}/calc`, { create: true, name, folder_id: folder ? Number(folder) : null }); }
  catch (err) { toast(err.message); }
  renderCalc();
};
$('#calc-new-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('#calc-create').click(); });
$('#calc-change').onclick = () => { calcPicking = true; renderCalc(); };
$('#calc-cancel').onclick = () => { calcPicking = false; renderCalc(); };
$('#calc-unlink').onclick = () => call('DELETE', `/api/ws/${ws.meta.id}/calc`);
$('#calc-update').onclick = () => document.querySelector('#quick [data-preset=calc]').click();
$('#calc-refresh').onclick = () => renderCalc();

webassign.init({
  call, toast, esc,
  getWs: () => ws,
  enabled: () => !!state?.webassign?.enabled,
  insertImage: f => board.insertImage(f),
  loadState: () => loadState(),
  openWorkspace: id => openWorkspace(id),
});

// ---------------------------------------------------------------------------
// Connect dialog
// ---------------------------------------------------------------------------

$('#connect-btn').onclick = () => {
  const { url, token } = state.mcp;
  $('#cc-cmd').textContent = `claude mcp add --transport http problemvault ${url} --header "Authorization: Bearer ${token}"`;
  $('#cd-cfg').textContent = JSON.stringify({
    mcpServers: { problemvault: { command: 'python', args: ['C:\\path\\to\\problemvault\\mcp_stdio.py', '--url', url, '--token', token] } },
  }, null, 2);
  $('#web-url').textContent = `https://<your-public-host>/mcp/${token}`;
  showCli(state.claude);
  showGem(state.ai);
  $('#cli-msg').textContent = '';
  $('#gem-msg').textContent = '';
  $('#connect').showModal();
};

function showCli(s) {
  state.claude = { ...state.claude, ...s, cli: s.ready || !!(state.ai && state.ai.provider) };
  $('#cli-state').textContent = !s.installed ? 'Claude Code is not installed on this server (the Docker image has it)'
    : s.ready ? 'ready: Ask Claude runs here on your subscription'
      : 'installed, not logged in';
  $('#cli-login').hidden = !s.installed || (s.ready && !s.tokenSaved);
  $('#cli-test').hidden = !s.installed;
  $('#cli-forget').hidden = !s.tokenSaved;
}
$('#cli-save').onclick = async () => {
  const token = $('#cli-token').value.trim();
  if (!token) return;
  showCli(await call('POST', '/api/claude/token', { token }));
  $('#cli-token').value = '';
  $('#cli-msg').textContent = 'Saved. Click Test.';
};
$('#cli-test').onclick = async () => {
  $('#cli-msg').textContent = 'Asking Claude…';
  const r = await call('POST', '/api/claude/test').catch(err => ({ ok: false, message: err.message }));
  if (r.installed !== undefined) showCli(r);
  $('#cli-msg').textContent = (r.ok ? '✓ ' : '✗ ') + r.message;
};
function showGem(ai) {
  state.ai = ai;
  const g = ai.gemini || {};
  $('#gem-state').textContent = g.ready ? `key set (${g.envKey && !g.keySaved ? 'from GEMINI_API_KEY' : 'saved'}), model ${g.model}` : 'no key';
  $('#gem-forget').hidden = !g.keySaved;
  $('#gem-test').hidden = !g.ready;
  renderAi();
}
$('#gem-save').onclick = async () => {
  const key = $('#gem-key').value.trim();
  if (!key) return;
  showGem(await call('POST', '/api/gemini/key', { key }));
  $('#gem-key').value = '';
  $('#gem-msg').textContent = 'Saved. Click Test.';
};
$('#gem-test').onclick = async () => {
  $('#gem-msg').textContent = 'Asking Gemini…';
  const r = await call('POST', '/api/gemini/test').catch(err => ({ ok: false, message: err.message }));
  if (r.gemini) showGem(r);
  $('#gem-msg').textContent = (r.ok ? '✓ ' : '✗ ') + r.message;
};
$('#gem-forget').onclick = async () => {
  showGem(await call('POST', '/api/gemini/key', { key: '' }));
  $('#gem-msg').textContent = 'Key removed.';
};
$('#cli-forget').onclick = async () => {
  showCli(await call('POST', '/api/claude/token', { token: '' }));
  $('#cli-msg').textContent = 'Token removed.';
};

// ---------------------------------------------------------------------------
// Helpers: markdown + LaTeX, toast, clipboard
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function tex(src, display = false) {
  if (window.katex) {
    try { return katex.renderToString(src, { displayMode: display, throwOnError: false, output: 'html' }); } catch {}
  }
  return `<code>${esc(src)}</code>`;
}

// Math is cut out before Markdown runs (so _ and * inside it survive), then rendered with KaTeX.
function markdown(src) {
  const math = [];
  const keep = (s, display) => `\u0000${math.push({ s, display }) - 1}\u0000`;
  let text = String(src)
    .replace(/\$\$([\s\S]+?)\$\$/g, (_, m) => keep(m, true))
    .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => keep(m, true))
    .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => keep(m, false))
    .replace(/(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$])?)\$/g, (_, pre, m) => pre + keep(m, false));
  let html;
  if (window.marked) {
    html = marked.parse(text, { breaks: true, renderer: Object.assign(new marked.Renderer(), { html: t => esc(typeof t === 'string' ? t : t.text) }) });
  } else {
    html = esc(text).replace(/\n/g, '<br>');
  }
  return html.replace(/\u0000(\d+)\u0000/g, (_, i) => tex(math[i].s, math[i].display));
}

function when(ms) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

let toastTimer = 0;
function toast(text, ms = 1400) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Select and copy the text'); }
}

// re-render notes once marked/KaTeX (deferred CDN scripts) have arrived
window.addEventListener('load', () => { board.refreshTexts(); if (ws) { renderClaude(); renderCalc(); } });

start().catch(err => toast(err.message, 5000));

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
