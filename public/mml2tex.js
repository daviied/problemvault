// From AssignPad (public/mml2tex.js).
// Convert the MathML that WebAssign stores (MathType) to LaTeX for MathLive.
const FUNCS = new Set(['sin', 'cos', 'tan', 'sec', 'csc', 'cot', 'ln', 'log', 'exp', 'arcsin', 'arccos',
  'arctan', 'sinh', 'cosh', 'tanh', 'lim', 'max', 'min', 'det']);
const OPS = { '−': '-', '·': '\\cdot ', '×': '\\times ', '≤': '\\le ', '≥': '\\ge ',
  '≠': '\\ne ', '∞': '\\infty ', '→': '\\to ', '±': '\\pm ', '⁡': '', '⁢': '',
  '{': '\\{', '}': '\\}', '%': '\\%' };
const GREEK = { 'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'ε': 'epsilon', 'θ': 'theta',
  'λ': 'lambda', 'μ': 'mu', 'π': 'pi', 'σ': 'sigma', 'τ': 'tau', 'φ': 'phi', 'ω': 'omega', 'Δ': 'Delta',
  'Ω': 'Omega', 'ρ': 'rho', 'ν': 'nu', 'η': 'eta', 'ζ': 'zeta', 'κ': 'kappa', 'χ': 'chi', 'ψ': 'psi' };

function txt(s) {
  return [...s].map(c => GREEK[c] ? `\\${GREEK[c]} ` : (OPS[c] ?? c)).join('');
}

function kids(el) { return [...el.children].map(conv); }
function g(s) { return `{${s}}`; }

function conv(el) {
  const k = el.children;
  switch (el.localName) {
    case 'math': case 'mrow': case 'mstyle': case 'semantics': case 'mpadded': case 'mphantom':
      return kids(el).join('');
    case 'annotation': case 'annotation-xml': case 'mspace': return '';
    case 'mi': {
      const t = el.textContent.trim();
      if (FUNCS.has(t)) return `\\${t} `;
      return t.length > 1 && !GREEK[t] ? `\\mathrm{${t}}` : txt(t);
    }
    case 'mn': return el.textContent.trim();
    case 'mo': return txt(el.textContent.trim());
    case 'mtext': return el.textContent.trim() ? `\\text{${el.textContent}}` : '';
    case 'msup': return `${g(conv(k[0]))}^${g(conv(k[1]))}`;
    case 'msub': return `${g(conv(k[0]))}_${g(conv(k[1]))}`;
    case 'msubsup': return `${g(conv(k[0]))}_${g(conv(k[1]))}^${g(conv(k[2]))}`;
    case 'mfrac': return `\\frac${g(conv(k[0]))}${g(conv(k[1]))}`;
    case 'msqrt': return `\\sqrt${g(kids(el).join(''))}`;
    case 'mroot': return `\\sqrt[${conv(k[1])}]${g(conv(k[0]))}`;
    case 'mfenced': {
      const o = el.getAttribute('open') ?? '(', c = el.getAttribute('close') ?? ')';
      const sep = el.getAttribute('separators') ?? ',';
      return `\\left${o === '{' ? '\\{' : o}${kids(el).join(sep)}\\right${c === '}' ? '\\}' : c}`;
    }
    case 'mtable': {
      const rows = [...k].map(r => [...r.children].map(conv).join('&')).join('\\\\');
      return `\\begin{matrix}${rows}\\end{matrix}`;
    }
    case 'mtd': case 'mtr': return kids(el).join('');
    case 'munder': return `${g(conv(k[0]))}_${g(conv(k[1]))}`;
    case 'mover': {
      const acc = k[1]?.textContent.trim();
      if (acc === '→' || acc === '⃗') return `\\vec${g(conv(k[0]))}`;
      if (acc === '^') return `\\hat${g(conv(k[0]))}`;
      if (acc === '¯' || acc === '_') return `\\overline${g(conv(k[0]))}`;
      return `${g(conv(k[0]))}^${g(conv(k[1]))}`;
    }
    case 'munderover': return `${g(conv(k[0]))}_${g(conv(k[1]))}^${g(conv(k[2]))}`;
    default: return kids(el).join('') || txt(el.textContent);
  }
}

export function mmlToLatex(mml) {
  if (!mml || !mml.trim()) return '';
  if (!mml.trim().startsWith('<')) return mml; // plain text answer
  const doc = new DOMParser().parseFromString(mml, 'application/xml');
  if (doc.querySelector('parsererror')) return '';
  return conv(doc.documentElement).replace(/\s+/g, ' ').trim();
}
