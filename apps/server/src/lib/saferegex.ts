/**
 * Linear-time regular expressions for user-supplied patterns (AutoMod).
 *
 * V8's RegExp backtracks, so `(a+)+$` can hang the event loop. This module parses a deliberately small, safe subset and runs it on a
 * Thompson/Pike NFA simulation: matching costs O(input length x program size) no matter the pattern, so catastrophic backtracking cannot happen.
 *
 * Supported: literals, `.`, classes `[a-z]` `[^...]`, `\d \w \s \D \W \S`, `\b \B`, `^ $`, groups `( )` and `(?: )`, alternation `|`,
 * quantifiers `* + ? {m} {m,} {m,n}` (a trailing `?` is accepted and ignored: only "does it match" matters), escapes of punctuation.
 * Rejected with a clear message: back-references, look-around, named groups, unicode property escapes, flags, oversize patterns.
 * Matching is case-insensitive. The input is clipped to MAX_INPUT code units before scanning.
 */
export class RegexError extends Error {}

export const MAX_PATTERN_LENGTH = 100;
export const MAX_PROGRAM_SIZE = 200;
export const MAX_INPUT = 500;
export class RegexTimeout extends Error {}
const MAX_REPEAT = 100;

type Test = (cp: number) => boolean;
type Node =
  | { t: 'char'; test: Test } | { t: 'cat'; items: Node[] } | { t: 'alt'; items: Node[] }
  | { t: 'rep'; node: Node; min: number; max: number } | { t: 'assert'; kind: 'bol' | 'eol' | 'wb' | 'nwb' } | { t: 'empty' };

const isWord = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
const isDigit = (c: number) => c >= 48 && c <= 57;
const isSpace = (c: number) => c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 0xfeff;
const fold = (c: number) => { const s = String.fromCodePoint(c); const l = s.toLowerCase(); return l.length === s.length ? l.codePointAt(0)! : c; };
const unfold = (c: number) => { const s = String.fromCodePoint(c); const u = s.toUpperCase(); return u.length === s.length ? u.codePointAt(0)! : c; };
const ci = (t: Test): Test => (c) => t(c) || t(fold(c)) || t(unfold(c));
const esc: Record<string, Test> = { d: isDigit, D: (c) => !isDigit(c), w: isWord, W: (c) => !isWord(c), s: isSpace, S: (c) => !isSpace(c) };
const ctl: Record<string, number> = { n: 10, r: 13, t: 9, f: 12, v: 11, '0': 0 };

class Parser {
  private cps: number[]; private i = 0;
  constructor(src: string) { this.cps = [...src].map((ch) => ch.codePointAt(0)!); }
  private peek() { return this.cps[this.i]; }
  private ch(c: number) { return String.fromCodePoint(c); }
  parse(): Node {
    const n = this.alt();
    if (this.i < this.cps.length) throw new RegexError('Unbalanced ")"');
    return n;
  }
  private alt(): Node {
    const items = [this.seq()];
    while (this.peek() === 124 /* | */) { this.i++; items.push(this.seq()); }
    return items.length === 1 ? items[0]! : { t: 'alt', items };
  }
  private seq(): Node {
    const items: Node[] = [];
    while (this.i < this.cps.length && this.peek() !== 124 && this.peek() !== 41 /* ) */) {
      let atom = this.atom();
      atom = this.quant(atom);
      items.push(atom);
    }
    return items.length === 0 ? { t: 'empty' } : items.length === 1 ? items[0]! : { t: 'cat', items };
  }
  private quant(atom: Node): Node {
    {
      const c = this.peek(); let min: number, max: number;
      if (c === 42) { min = 0; max = Infinity; this.i++; }
      else if (c === 43) { min = 1; max = Infinity; this.i++; }
      else if (c === 63) { min = 0; max = 1; this.i++; }
      else if (c === 123 /* { */) {
        const m = /^\{(\d{1,3})(,(\d{0,3}))?\}/.exec(this.cps.slice(this.i, this.i + 12).map((x) => this.ch(x)).join(''));
        if (!m) throw new RegexError('Invalid {m,n} quantifier');
        min = Number(m[1]); max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
        if (min > MAX_REPEAT || (max !== Infinity && (max > MAX_REPEAT || max < min))) throw new RegexError(`Repeat counts must be at most ${MAX_REPEAT}`);
        this.i += m[0].length;
      } else return atom;
      if (atom.t === 'assert' || atom.t === 'empty') throw new RegexError('Nothing to repeat');
      if (this.peek() === 63) this.i++; // lazy marker: irrelevant for a yes/no match
      else if (this.peek() === 43) throw new RegexError('Possessive quantifiers are not supported');
      atom = { t: 'rep', node: atom, min, max };
      const nx = this.peek();
      if (nx === 42 || nx === 43 || nx === 63 || nx === 123) throw new RegexError('Nested or repeated quantifiers are not supported');
      return atom;
    }
  }
  private atom(): Node {
    const c = this.cps[this.i++]!;
    switch (c) {
      case 40: { // (
        if (this.peek() === 63) { // (?
          if (this.cps[this.i + 1] === 58) this.i += 2; // (?:
          else throw new RegexError('Look-around and named groups are not supported');
        }
        const n = this.alt();
        if (this.peek() !== 41) throw new RegexError('Unbalanced "("');
        this.i++; return n;
      }
      case 91: return this.klass();
      case 46: return { t: 'char', test: (x) => x !== 10 && x !== 13 };
      case 94: return { t: 'assert', kind: 'bol' };
      case 36: return { t: 'assert', kind: 'eol' };
      case 42: case 43: case 63: throw new RegexError('Nothing to repeat');
      case 92: return this.escape();
      default: { const want = fold(c); return { t: 'char', test: (x) => fold(x) === want }; }
    }
  }
  private escape(): Node {
    const c = this.cps[this.i++];
    if (c === undefined) throw new RegexError('Pattern ends with a backslash');
    const s = this.ch(c);
    if (s === 'b') return { t: 'assert', kind: 'wb' };
    if (s === 'B') return { t: 'assert', kind: 'nwb' };
    if (esc[s]) return { t: 'char', test: esc[s]! };
    if (/[1-9kK]/.test(s)) throw new RegexError('Back-references are not supported');
    if (/[pPuUxXcC]/.test(s)) throw new RegexError(`Escape \\${s} is not supported`);
    if (s in ctl) { const v = ctl[s]!; return { t: 'char', test: (x) => x === v }; }
    if (/[A-Za-z0-9]/.test(s)) throw new RegexError(`Unknown escape \\${s}`);
    return { t: 'char', test: (x) => x === c };
  }
  private klass(): Node {
    let neg = false; if (this.peek() === 94) { neg = true; this.i++; }
    const singles: number[] = [], ranges: [number, number][] = [], tests: Test[] = [];
    let first = true;
    for (;;) {
      const c = this.cps[this.i++];
      if (c === undefined) throw new RegexError('Unterminated character class');
      if (c === 93 && !first) break;
      first = false;
      let lo = c;
      if (c === 92) {
        const e = this.cps[this.i++]; if (e === undefined) throw new RegexError('Unterminated character class');
        const s = this.ch(e);
        if (esc[s]) { tests.push(esc[s]!); continue; }
        if (/[1-9pPuUxXcCkKbB]/.test(s) && !/[bB]/.test(s)) throw new RegexError(`Escape \\${s} is not supported`);
        lo = s in ctl ? ctl[s]! : s === 'b' ? 8 : e;
      }
      if (this.peek() === 45 && this.cps[this.i + 1] !== undefined && this.cps[this.i + 1] !== 93) { // range
        this.i++; let hi = this.cps[this.i++]!;
        if (hi === 92) { const e = this.cps[this.i++]; if (e === undefined) throw new RegexError('Unterminated character class'); if (esc[this.ch(e)]) throw new RegexError('Invalid range'); hi = this.ch(e) in ctl ? ctl[this.ch(e)]! : e; }
        if (hi < lo) throw new RegexError('Character class range is out of order');
        ranges.push([lo, hi]);
      } else singles.push(lo);
    }
    const base: Test = (x) => singles.includes(x) || ranges.some(([a, b]) => x >= a && x <= b) || tests.some((t) => t(x));
    const t = ci(base);
    return { t: 'char', test: neg ? (x) => !t(x) : t };
  }
}

type Inst = { op: 'char'; test: Test } | { op: 'split'; a: number; b: number } | { op: 'jmp'; to: number } | { op: 'assert'; kind: 'bol' | 'eol' | 'wb' | 'nwb' } | { op: 'match' };

function compile(root: Node): Inst[] {
  const prog: Inst[] = [];
  const emit = (i: Inst) => { if (prog.length >= MAX_PROGRAM_SIZE) throw new RegexError('Pattern is too complex'); prog.push(i); return prog.length - 1; };
  const gen = (n: Node): void => {
    switch (n.t) {
      case 'empty': return;
      case 'char': emit({ op: 'char', test: n.test }); return;
      case 'assert': emit({ op: 'assert', kind: n.kind }); return;
      case 'cat': n.items.forEach(gen); return;
      case 'alt': {
        const jumps: number[] = [];
        n.items.forEach((it, idx) => {
          if (idx < n.items.length - 1) {
            const sp = emit({ op: 'split', a: 0, b: 0 }); (prog[sp] as any).a = prog.length; gen(it); jumps.push(emit({ op: 'jmp', to: 0 })); (prog[sp] as any).b = prog.length;
          } else gen(it);
        });
        for (const j of jumps) (prog[j] as any).to = prog.length;
        return;
      }
      case 'rep': {
        for (let k = 0; k < n.min; k++) gen(n.node);
        if (n.max === Infinity) { // L: split(body, out); body; jmp L
          const sp = emit({ op: 'split', a: 0, b: 0 }); (prog[sp] as any).a = prog.length; gen(n.node); emit({ op: 'jmp', to: sp }); (prog[sp] as any).b = prog.length;
        } else {
          const splits: number[] = [];
          for (let k = n.min; k < n.max; k++) { const sp = emit({ op: 'split', a: 0, b: 0 }); (prog[sp] as any).a = prog.length; splits.push(sp); gen(n.node); }
          for (const sp of splits) (prog[sp] as any).b = prog.length;
        }
      }
    }
  };
  gen(root); emit({ op: 'match' });
  return prog;
}

export class SafeRegex {
  private constructor(readonly source: string, private prog: Inst[]) {}
  static compile(pattern: string): SafeRegex {
    if (typeof pattern !== 'string' || !pattern.length) throw new RegexError('Pattern is empty');
    if (pattern.length > MAX_PATTERN_LENGTH) throw new RegexError(`Pattern is longer than ${MAX_PATTERN_LENGTH} characters`);
    const ast = new Parser(pattern).parse();
    return new SafeRegex(pattern, compile(ast));
  }
  /** True when the pattern matches anywhere in `input`. Always O(len * program). */
  test(input: string, deadline?: number): boolean {
    const truncated = input.length > MAX_INPUT; // `$` must not match at the artificial clip boundary
    const cps = [...input.slice(0, MAX_INPUT)].map((c) => c.codePointAt(0)!);
    const prog = this.prog, n = prog.length;
    let clist: number[] = [], nlist: number[] = [];
    const mark = new Int32Array(n).fill(-1);
    const assertOk = (kind: string, pos: number) => {
      const prev = pos > 0 ? cps[pos - 1]! : -1, next = pos < cps.length ? cps[pos]! : -1;
      switch (kind) {
        case 'bol': return pos === 0 || prev === 10;
        case 'eol': return (pos === cps.length && !truncated) || next === 10;
        default: { const wb = (prev >= 0 && isWord(prev)) !== (next >= 0 && isWord(next)); return kind === 'wb' ? wb : !wb; }
      }
    };
    // add thread pc to `list` for step `gen` following epsilon edges; returns true if MATCH is reachable
    const add = (list: number[], pc0: number, pos: number, gen: number): boolean => {
      const stack = [pc0]; let matched = false;
      while (stack.length) {
        const pc = stack.pop()!;
        if (mark[pc] === gen) continue; mark[pc] = gen;
        const ins = prog[pc]!;
        if (ins.op === 'jmp') stack.push(ins.to);
        else if (ins.op === 'split') { stack.push(ins.b); stack.push(ins.a); }
        else if (ins.op === 'assert') { if (assertOk(ins.kind, pos)) stack.push(pc + 1); }
        else if (ins.op === 'match') matched = true;
        else list.push(pc);
      }
      return matched;
    };
    for (let pos = 0; pos <= cps.length; pos++) {
      if (deadline !== undefined && (pos & 15) === 0 && Date.now() > deadline) throw new RegexTimeout('regex time budget exceeded');
      if (add(clist, 0, pos, pos * 2)) return true; // a fresh attempt starting here
      if (pos === cps.length) break;
      const c = cps[pos]!; nlist = [];
      for (const pc of clist) {
        const ins = prog[pc]! as Extract<Inst, { op: 'char' }>;
        if (ins.test(c) && add(nlist, pc + 1, pos + 1, pos * 2 + 1)) return true;
      }
      clist = nlist;
    }
    return false;
  }
}

/** Compile or throw RegexError (message is safe to show to the admin). */
export const compileSafeRegex = (p: string) => SafeRegex.compile(p);
