"""Small LaTeX -> MathML converter for WebAssign answers (numbers, units-free expressions).

The browser uses MathLive for this; the server needs it when Claude submits an answer.
Covers what answers contain: numbers, signs, variables, + - * / =, \\cdot \\times, ^ _, \\frac,
\\sqrt, parentheses, Greek letters and function names. The output matches MathLive's shape
(no invisible operators, function names as <mi>), like latexToMathml in webassign.js.
"""
import re
from xml.sax.saxutils import escape

MML = "http://www.w3.org/1998/Math/MathML"
GREEK = {n: c for n, c in zip(
    "alpha beta gamma delta epsilon theta lambda mu pi rho sigma tau phi omega Delta Omega Theta Phi Sigma Pi".split(),
    "αβγδεθλμπρστφωΔΩΘΦΣΠ")}
OPS = {"cdot": "⋅", "times": "⋅", "div": "÷", "pm": "±", "approx": "≈", "le": "≤", "ge": "≥", "degree": "°", "circ": "∘"}
FUNCS = {"sin", "cos", "tan", "ln", "log", "exp", "sec", "csc", "cot", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh"}
TOKEN = re.compile(r"\d+(?:\.\d*)?|\.\d+|\\[A-Za-z]+|\\.|[A-Za-z]|\S")


class _P:
    def __init__(self, s):
        self.t = TOKEN.findall(s)
        self.i = 0
        self.last_end = None

    def peek(self):
        return self.t[self.i] if self.i < len(self.t) else None

    def take(self):
        tok = self.peek()
        self.i += 1
        return tok

    def group(self):
        """One argument: {...} or a single token."""
        if self.peek() == "{":
            self.take()
            return _row(self.seq("}"))
        a = self.atom()
        if isinstance(a, tuple):
            a = f"<mrow><mo>(</mo>{_row(a[1])}<mo>)</mo></mrow>"
        return a or "<mrow></mrow>"

    def seq(self, end=None):
        ends = end if isinstance(end, tuple) else (end,)
        out = []
        while self.peek() is not None and self.peek() not in ends:
            a = self.atom()
            if a is None:
                continue
            if isinstance(a, tuple):
                inner = a[1]
                vec = "<mo>,</mo>" in inner and out and out[-1].startswith(("<mi>", "<mn>", "<msub>", "<msup>", "<mrow>"))
                o, c = ("[", "]") if vec else ("(", ")")
                a = f"<mrow><mo>{o}</mo>{_row(inner)}<mo>{c}</mo></mrow>"
            while self.peek() in ("^", "_"):
                op = self.take()
                arg = self.group()
                a = f"<msup>{a}{arg}</msup>" if op == "^" else f"<msub>{a}{arg}</msub>"
            out.append(a)
        if end:
            self.last_end = self.take()
        return out

    def atom(self):
        tok = self.take()
        if tok is None:
            return None
        if tok == "{":
            return _row(self.seq("}"))
        if tok == "(":
            return self.paren(self.seq(")"))
        if tok[0].isdigit() or tok[0] == ".":
            return f"<mn>{tok}</mn>"
        if tok.startswith("\\"):
            name = tok[1:]
            if name in ("frac", "tfrac", "dfrac", "cfrac"):
                return f"<mfrac>{self.group()}{self.group()}</mfrac>"
            if name == "begin":
                return self.matrix()
            if name == "sqrt":
                return f"<msqrt>{self.group()}</msqrt>"
            if name == "left" and self.peek() == "(":
                self.take()
                inner = self.seq("\\right")
                if self.peek() == ")":
                    self.take()
                return self.paren(inner)
            if name in ("left", "right"):
                d = self.take() or ""
                return None if d == "." else f"<mo>{escape(d.lstrip(chr(92)))}</mo>"
            if name in ("text", "mathrm", "operatorname"):
                txt = "".join(self._raw_group())
                return f"<mi>{escape(txt)}</mi>"
            if name in GREEK:
                return f"<mi>{GREEK[name]}</mi>"
            if name in OPS:
                return f"<mo>{OPS[name]}</mo>"
            if name in FUNCS:
                return f"<mi>{name}</mi>"
            if name in (",", ";", "!", " ", "quad", "qquad"):
                return None
            return f"<mi>{escape(name)}</mi>"
        if tok.isalpha():
            return f"<mi>{tok}</mi>"
        if tok == "*":
            return "<mo>⋅</mo>"
        if tok == "-":
            return "<mo>-</mo>"  # ASCII: WebAssign's legacy charset turns a true minus sign into "?"
        if tok in "}^_":
            return None
        return f"<mo>{escape(tok)}</mo>"

    def matrix(self):
        """\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix} -> [a, b; c, d] as WebAssign takes it.
        A one-column matrix becomes the row list [a, b, c] (WebAssign asks for column vectors as a row)."""
        self._raw_group()  # environment name: bmatrix, pmatrix, matrix ... all sent with brackets
        rows, row = [], []
        while self.peek() is not None:
            cell = self.seq(("&", "\\\\", "\\end"))
            row.append(_row(cell) if cell else "<mrow></mrow>")
            if self.last_end != "&":
                rows.append(row)
                row = []
            if self.last_end in ("\\end", None):
                self._raw_group()
                break
        rows = [r for r in rows if any(c != "<mrow></mrow>" for c in r)]
        if not rows:
            return None
        if all(len(r) == 1 for r in rows):
            items = "<mo>,</mo>".join(r[0] for r in rows)
            return f"<mrow><mo>[</mo><mrow>{items}</mrow><mo>]</mo></mrow>"
        body = "".join("<mtr>" + "".join(f"<mtd>{c}</mtd>" for c in r) + "</mtr>" for r in rows)
        return f"<mrow><mo>[</mo><mtable>{body}</mtable><mo>]</mo></mrow>"

    def paren(self, inner):
        """(...) group. A list after a factor ("c_1(1, 4)") becomes [...]: WebAssign reads "c1(1,4)" as a call."""
        return ("paren", inner)

    def _raw_group(self):
        if self.peek() != "{":
            return [self.take() or ""]
        self.take()
        out = []
        while self.peek() not in (None, "}"):
            out.append(self.take())
        self.take()
        return out


def _row(items):
    return items[0] if len(items) == 1 else f"<mrow>{''.join(items)}</mrow>"


def latex_to_mathml(latex):
    latex = (latex or "").strip().strip("$").replace("\\displaystyle", "")
    latex = re.sub("[\u2212\u2013\u2010]", "-", latex)
    out = f'<math xmlns="{MML}">{_row(_P(latex).seq())}</math>'
    # WebAssign posts in a legacy charset: send non-ASCII as character references, as MathType does
    return re.sub(r"[^\x00-\x7F]", lambda m: f"&#x{ord(m.group()):X};", out)
