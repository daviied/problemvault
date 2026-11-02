// WebAssign tab: view the WebAssign question linked to this problem, answer it
// (MathLive, as in AssignPad) and save / submit it, all through AssignPad.
// Without a link: browse assignments, link a question, or import a whole
// assignment as one problem per question.
import { mmlToLatex } from './mml2tex.js';

const $ = s => document.querySelector(s);
const MML = 'http://www.w3.org/1998/Math/MathML';
let ctx = null; // { call, toast, esc, getWs, insertImage, loadState, openWorkspace, enabled }
let ML = null; // MathLive module, loaded on first use
let browsing = null; // dep of the assignment shown in the browser, or null for the list

export function init(c) {
  ctx = c;
  $('#wa-refresh').onclick = () => render(true);
  $('#wa-unlink').onclick = async () => {
    const ws = ctx.getWs();
    if (ws && confirm('Unlink this WebAssign question from the problem?')) await ctx.call('PATCH', `/api/workspaces/${ws.meta.id}`, { wa: null });
  };
  $('#wa-list-refresh').onclick = () => showList(true);
  $('#wa-back').onclick = () => { browsing = null; showList(); };
}

async function mathlive() {
  if (!ML) {
    ML = await import('/vendor/mathlive/mathlive.min.mjs');
    ML.MathfieldElement.fontsDirectory = '/vendor/mathlive/fonts';
  }
  return ML;
}

const proxied = html => String(html || '').replaceAll('/api/proxy?u=', '/api/webassign/proxy?u=');
const draftKey = (dep, name) => `problemvault.wa:${dep}:${name}`;
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch {} },
  del: k => { try { localStorage.removeItem(k); } catch {} },
};

export async function render(refresh = false) {
  const ws = ctx.getWs();
  $('#wa-off').hidden = ctx.enabled();
  $('#wa-on').hidden = !ctx.enabled();
  if (!ctx.enabled() || !ws) return;
  const link = ws.meta.wa;
  $('#wa-linked').hidden = !link;
  $('#wa-browse').hidden = !!link;
  if (!link) return showList();
  $('#wa-title').textContent = `${link.name} · question ${link.number}`;
  const body = $('#wa-question');
  body.innerHTML = `<p class="muted">${refresh ? 'Reading WebAssign…' : 'Loading…'}</p>`;
  try {
    const [asg] = await Promise.all([
      ctx.call('GET', `/api/webassign/assignments/${link.dep}${refresh ? '?refresh=1' : ''}`),
      mathlive(),
    ]);
    if (ctx.getWs()?.meta.id !== ws.meta.id) return;
    const q = asg.questions.find(x => x.box === link.box);
    if (!q) { body.innerHTML = '<p class="muted">This question is no longer in the assignment. Unlink it.</p>'; return; }
    $('#wa-open').href = `${asg.url}#${q.box}`;
    buildQuestion(asg, q, body);
  } catch (err) {
    body.innerHTML = `<p class="muted">${ctx.esc(err.message)}</p>`;
  }
}

function latexToMathml(latex) {
  const tpl = document.createElement('template');
  tpl.innerHTML = `<math xmlns="${MML}">${ML.convertLatexToMathMl(latex)}</math>`;
  const m = tpl.content.firstElementChild;
  // MathType does not send invisible operators, and writes function names (sin, ln, ...) as <mi>.
  m.querySelectorAll('mo').forEach(o => {
    if (/^[⁡⁢⁣]$/.test(o.textContent)) o.remove();
    else if (/^[a-z]{2,}$/i.test(o.textContent)) {
      const mi = document.createElementNS(MML, 'mi'); mi.textContent = o.textContent; o.replaceWith(mi);
    }
  });
  return new XMLSerializer().serializeToString(m).replace(/ xmlns="http:\/\/www.w3.org\/1999\/xhtml"/g, '');
}

function buildQuestion(asg, q, body) {
  const esc = ctx.esc;
  const dep = ctx.getWs().meta.wa.dep;
  const pts = (q.details?.Points || []).slice(-1)[0] || '';
  const allOk = q.parts.length && q.parts.every(p => p.mark === 'correct');
  const anyBad = q.parts.some(p => p.mark === 'incorrect');
  body.innerHTML = `<div class="wa-info">${pts ? esc(pts) + ' pts' : ''}${q.submissions ? ' · submissions ' + esc(q.submissions) : ''}
      ${allOk ? '<span class="wa-badge ok">Correct</span>' : anyBad ? '<span class="wa-badge bad">Incorrect</span>' : ''}</div>
    <div class="wa-q"></div>
    <div class="wa-actions">
      ${q.canSubmit ? '<button class="subtle" data-act="save">Save</button><button class="primary" data-act="submit">Submit</button>' : '<span class="muted small">No more submissions here.</span>'}
    </div>
    <div class="wa-actions">
      <button class="subtle" id="wa-to-problem">Use as problem text</button>
      <button class="subtle" id="wa-to-page">Add figures to page</button>
    </div>`;
  const root = body.querySelector('.wa-q').attachShadow({ mode: 'open' });
  root.innerHTML = (asg.styles || []).map(h => `<link rel="stylesheet" href="${esc(proxied(h))}">`).join('')
    + `<link rel="stylesheet" href="/vendor/mathlive/mathlive-static.css">
    <style>
      :host { display: block; color: var(--text); overflow-x: auto; }
      .ap-box { display: inline-flex; align-items: center; gap: 4px; vertical-align: middle; margin: 2px 0; white-space: normal; }
      .watexline:has(.ap-box), .watexinlineblock:has(.ap-box) { white-space: nowrap; }
      [class*="watex"] { border-color: currentColor !important; }
      img:not([src*=".svg"]) { filter: invert(.9) hue-rotate(180deg); max-width: 100%; }
      math-field { min-width: 90px; font-size: 18px; background: #0f0f13; color: var(--text); border: 1px solid #2c2c34; border-radius: 6px; }
      input.ap-text { background: #0f0f13; color: var(--text); border: 1px solid #2c2c34; border-radius: 6px; padding: 4px 6px; }
      .ap-mark.correct { color: #3fb950; } .ap-mark.incorrect { color: #ff7b72; }
      .ap-lock { font-size: 12px; opacity: .7; }
    </style><div class="q">${proxied(q.html)}</div>`;
  root.querySelectorAll('.ap-tex').forEach(el => {
    el.dataset.tex = el.textContent; // kept for "Use as problem text"
    try { el.innerHTML = ML.convertLatexToMarkup(el.textContent); } catch {}
  });

  const fields = {};
  for (const p of q.parts) {
    if (p.kind === 'math' || p.kind === 'text') {
      const slot = root.querySelector(`.ap-box[data-name="${p.name}"]`);
      if (!slot) continue;
      const saved = store.get(draftKey(dep, p.name));
      let el;
      if (p.kind === 'math') {
        el = new ML.MathfieldElement();
        el.mathVirtualKeyboardPolicy = 'auto';
        el.smartFence = true;
        el.value = saved ?? mmlToLatex(p.value);
      } else {
        el = document.createElement('input');
        el.className = 'ap-text';
        el.value = saved ?? p.value ?? '';
      }
      el.addEventListener('input', () => store.set(draftKey(dep, p.name), el.value));
      slot.append(el);
      if (!p.enabled) {
        el.readOnly = true;
        slot.insertAdjacentHTML('beforeend', '<span class="ap-lock">🔒</span>');
      }
      if (p.mark) slot.insertAdjacentHTML('beforeend', `<span class="ap-mark ${p.mark}">${p.mark === 'correct' ? '✓' : '✗'}</span>`);
      fields[p.name] = { part: p, el };
    } else {
      fields[p.name] = { part: p };
    }
  }

  body.querySelectorAll('[data-act]').forEach(b => { b.onclick = () => send(asg, q, root, fields, b); });
  body.querySelector('#wa-to-problem').onclick = async () => {
    const ws = ctx.getWs();
    const text = toText(root.querySelector('.q'));
    if (ws.meta.problem && !confirm('Replace the typed problem text with this question?')) return;
    await ctx.call('PATCH', `/api/workspaces/${ws.meta.id}`, { problem: text });
    ctx.toast('Problem text set');
  };
  body.querySelector('#wa-to-page').onclick = async () => {
    const imgs = [...root.querySelectorAll('img')].filter(i => i.getAttribute('src'));
    if (!imgs.length) return ctx.toast('This question has no figures');
    for (const [k, img] of imgs.entries()) {
      const r = await fetch(img.getAttribute('src'));
      if (!r.ok) continue;
      const blob = await r.blob();
      if (blob.type === 'image/svg+xml') continue; // only bitmaps can be rendered for Claude
      await ctx.insertImage(new File([blob], `webassign-q${q.number}-${k + 1}.${blob.type.split('/')[1] || 'png'}`, { type: blob.type }));
    }
  };
}

function readChoice(root, p) {
  const els = [...root.querySelectorAll(`[name="${p.name}"]`)];
  if (p.kind === 'radio') return els.find(i => i.checked)?.value ?? null;
  if (p.kind === 'checkbox') return els.filter(i => i.checked).map(i => i.value);
  return els[0]?.value ?? null;
}

async function send(asg, q, root, fields, btn) {
  const link = ctx.getWs().meta.wa;
  const dep = link.dep;
  const action = btn.dataset.act;
  const answers = {};
  for (const [name, f] of Object.entries(fields)) {
    if (!f.part.enabled) continue;
    if (f.part.kind === 'math') {
      const latex = f.el.value.trim();
      answers[name] = latex ? latexToMathml(latex) : '';
    } else if (f.part.kind === 'text') answers[name] = f.el.value;
    else { const v = readChoice(root, f.part); if (v != null) answers[name] = v; }
  }
  if (action === 'submit' && !confirm(`Submit question ${q.number} to WebAssign?`)) return;
  const btns = btn.parentElement.querySelectorAll('button');
  btns.forEach(b => { b.disabled = true; });
  btn.textContent = action === 'submit' ? 'Submitting…' : 'Saving…';
  try {
    const data = await ctx.call('POST', `/api/webassign/assignments/${link.dep}/questions/${q.box}`, { answers, action });
    Object.keys(fields).forEach(n => store.del(draftKey(dep, n)));
    const nq = data.questions.find(x => x.box === q.box);
    if (action === 'submit' && nq) {
      const ok = nq.parts.filter(p => p.mark === 'correct').length;
      ctx.toast(`Submitted: ${ok} of ${nq.parts.length} correct`, 3000);
    } else ctx.toast('Saved to WebAssign');
    render();
  } catch (err) {
    ctx.toast(err.message, 6000);
    btns.forEach(b => { b.disabled = false; });
    btn.textContent = action === 'submit' ? 'Submit' : 'Save';
  }
}

// Question HTML as text with $LaTeX$ (typed text is the cheapest form for Claude)
function toText(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('.ap-tex').forEach(t => t.replaceWith(`$${(t.dataset.tex || t.textContent).replace('\\displaystyle ', '').trim()}$`));
  c.querySelectorAll('.ap-box').forEach(b => b.replaceWith(' [answer] '));
  c.querySelectorAll('img').forEach(i => i.replaceWith(' [figure] '));
  c.querySelectorAll('br, p, div, li, tr').forEach(n => n.append('\n'));
  return c.textContent.replace(/[ \t ]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Browse: assignments -> questions -> link / import
// ---------------------------------------------------------------------------

async function showList(refresh = false) {
  const box = $('#wa-items');
  $('#wa-back').hidden = !browsing;
  if (browsing) return showAssignment(browsing, refresh);
  $('#wa-browse-title').textContent = 'Assignments';
  box.innerHTML = `<p class="muted">${refresh ? 'Reading WebAssign…' : 'Loading…'}</p>`;
  try {
    const list = await ctx.call('GET', `/api/webassign/assignments${refresh ? '?refresh=1' : ''}`);
    $('#wa-browse-title').textContent = list.course || 'Assignments';
    box.innerHTML = '';
    for (const group of ['current', 'past']) {
      const rows = list.assignments.filter(a => (a.group || 'current') === group);
      if (!rows.length) continue;
      box.insertAdjacentHTML('beforeend', `<h4>${group === 'current' ? 'Current' : 'Past'}</h4>`);
      for (const a of rows) {
        const el = document.createElement('button');
        el.className = 'wa-row';
        el.innerHTML = `<span class="n"></span><span class="m"></span>`;
        el.querySelector('.n').textContent = a.name;
        el.querySelector('.m').textContent = [a.due && `due ${a.due}`, a.score].filter(Boolean).join(' · ');
        el.onclick = () => { browsing = a.dep; showList(); };
        box.appendChild(el);
      }
    }
  } catch (err) {
    box.innerHTML = `<p class="muted">${ctx.esc(err.message)}</p>`;
  }
}

async function showAssignment(dep, refresh) {
  const box = $('#wa-items');
  box.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const asg = await ctx.call('GET', `/api/webassign/assignments/${dep}${refresh ? '?refresh=1' : ''}`);
    $('#wa-browse-title').textContent = asg.name;
    box.innerHTML = '';
    const imp = document.createElement('button');
    imp.className = 'primary wa-import';
    imp.textContent = 'Import all as problems';
    imp.title = 'One problem per question, in a folder named after the assignment';
    imp.onclick = async () => {
      imp.disabled = true;
      const r = await ctx.call('POST', '/api/webassign/import', { dep, folder: ctx.getWs()?.meta.folder || null }).catch(e => { ctx.toast(e.message, 5000); return null; });
      imp.disabled = false;
      if (!r) return;
      await ctx.loadState();
      ctx.toast(r.created.length ? `Made ${r.created.length} problem${r.created.length > 1 ? 's' : ''}` : 'Already imported');
      if (r.created[0]) ctx.openWorkspace(r.created[0]);
    };
    box.appendChild(imp);
    for (const q of asg.questions) {
      const el = document.createElement('div');
      el.className = 'wa-row';
      const ok = q.parts.length && q.parts.every(p => p.mark === 'correct');
      el.innerHTML = `<span class="n"></span><span class="m"></span><button class="subtle">Link here</button>`;
      el.querySelector('.n').textContent = `${q.number}. ${ok ? '✓ ' : ''}${q.text || ''}`;
      el.querySelector('.m').textContent = q.submissions ? `submissions ${q.submissions}` : '';
      el.querySelector('button').onclick = async () => {
        const ws = ctx.getWs();
        const fields = { wa: { dep, box: q.box, name: asg.name, number: q.number } };
        await ctx.call('PATCH', `/api/workspaces/${ws.meta.id}`, fields);
        browsing = null;
        ctx.toast('Linked');
      };
      box.appendChild(el);
    }
  } catch (err) {
    box.innerHTML = `<p class="muted">${ctx.esc(err.message)}</p>`;
  }
}
