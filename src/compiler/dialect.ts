// Dialects: the user-defined surface syntax for the 8 Brainfuck instructions.
//
// A dialect is a real language definition: the lexer is built from it (a trie
// with longest-match), and the program that runs is whatever the lexer reads
// from the middle pane. Characters that match no token are comments, exactly
// like in standard Brainfuck.

import { t, type MessageKey } from '../i18n';

export const BF_OPS = ['>', '<', '+', '-', '.', ',', '[', ']'] as const;
export type BfOp = (typeof BF_OPS)[number];

export function opLabel(op: BfOp): string {
  return t(`op.${op}` as MessageKey);
}

export interface Dialect {
  /** Preset id ('sheep', 'bf', …) or 'custom'. */
  id: string;
  tokens: Record<BfOp, string>;
  /**
   * Line mode: one instruction per line, and a line must match a token
   * exactly (as in Whitefuck, whose tokens are made of spaces and tabs).
   * Lines that match nothing are comments.
   */
  lines?: boolean;
}

export const PRESETS: Dialect[] = [
  {
    id: 'sheep',
    tokens: { '>': 'メェ→', '<': '←メェ', '+': 'メェ', '-': 'ベェ', '.': 'メェ！', ',': 'メェ？', '[': '群れ', ']': '解散' },
  },
  {
    id: 'bf',
    tokens: { '>': '>', '<': '<', '+': '+', '-': '-', '.': '.', ',': ',', '[': '[', ']': ']' },
  },
  {
    id: 'ook',
    tokens: { '>': 'Ook. Ook?', '<': 'Ook? Ook.', '+': 'Ook. Ook.', '-': 'Ook! Ook!', '.': 'Ook! Ook.', ',': 'Ook. Ook!', '[': 'Ook! Ook?', ']': 'Ook? Ook!' },
  },
  {
    id: 'cat',
    tokens: { '>': 'にゃ', '<': 'みゃ', '+': 'にゃーん', '-': 'しゃー', '.': 'ごろごろ', ',': 'すりすり', '[': 'ふみ', ']': 'ふみふみ' },
  },
  {
    id: 'emoji',
    tokens: { '>': '👉', '<': '👈', '+': '👍', '-': '👎', '.': '📣', ',': '👂', '[': '🔁', ']': '🔚' },
  },
  {
    // https://github.com/sevenc-nanashi/whitefuck — spaces and tabs, one command per line
    id: 'whitefuck',
    tokens: { '>': '\t ', '<': '\t\t', '+': '  ', '-': ' \t', '.': '   ', ',': '  \t', '[': ' \t ', ']': ' \t\t' },
    lines: true,
  },
];

export function dialectName(d: Dialect): string {
  return PRESETS.some((p) => p.id === d.id) ? t(`dialect.${d.id}` as MessageKey) : t('dialect.custom');
}

/** Restore a dialect saved by an older version (which stored `name` instead of `id`). */
export function normalizeDialect(d: Partial<Dialect> | null | undefined): Dialect | null {
  if (!d?.tokens) return null;
  const tokens = d.tokens;
  const lines = !!d.lines;
  const preset = PRESETS.find((p) => !!p.lines === lines && BF_OPS.every((op) => p.tokens[op] === tokens[op]));
  return preset ?? { id: 'custom', tokens, ...(lines ? { lines } : {}) };
}

/** Make whitespace visible (used wherever tokens are displayed or edited). */
export function showWhitespace(s: string): string {
  return s.replace(/ /g, '·').replace(/\t/g, '⇥');
}

export function parseWhitespace(s: string): string {
  return s.replace(/·/g, ' ').replace(/⇥/g, '\t');
}

// ───────────────────────── validation ─────────────────────────

export interface DialectCheck {
  errors: string[];
  /** Tokens cannot be written back-to-back unambiguously; use a space. */
  needsSeparator: boolean;
}

export function checkDialect(d: Dialect): DialectCheck {
  const errors: string[] = [];
  const seen = new Map<string, BfOp>();
  for (const op of BF_OPS) {
    const tok = d.tokens[op];
    if (!tok) errors.push(t('dialect.empty', { op }));
    else if (!d.lines && tok !== tok.trim()) errors.push(t('dialect.space', { op }));
    else if (/[\r\n]/.test(tok)) errors.push(t('dialect.newline', { op }));
    else if (seen.has(tok)) errors.push(t('dialect.duplicate', { a: seen.get(tok)!, b: op }));
    else seen.set(tok, op);
  }
  if (errors.length || d.lines) return { errors, needsSeparator: false };
  const lexer = new Lexer(d);
  // Multi-word tokens (e.g. "Ook. Ook?") read better with spaces between them.
  const spaced = BF_OPS.some((op) => /\s/.test(d.tokens[op]));
  const roundTrips = (sep: string) => {
    for (const a of BF_OPS)
      for (const b of BF_OPS)
        for (const c of BF_OPS) {
          const text = [a, b, c].map((o) => d.tokens[o]).join(sep);
          if (lexer.lex(text).ops !== a + b + c) return false;
        }
    return true;
  };
  if (!spaced && roundTrips('')) return { errors, needsSeparator: false };
  if (roundTrips(' ')) return { errors, needsSeparator: true };
  errors.push(t('dialect.ambiguous'));
  return { errors, needsSeparator: true };
}

// ───────────────────────── lexer ─────────────────────────

interface TrieNode {
  next: Map<string, TrieNode>;
  op?: BfOp;
}

export interface LexResult {
  /** Standard Brainfuck string of recognised instructions. */
  ops: string;
  /** Source offset (UTF-16 index) of each op, for error reporting. */
  pos: number[];
  /** Number of characters treated as comments (excluding whitespace). */
  commentChars: number;
}

export class Lexer {
  private root: TrieNode = { next: new Map() };
  private lineTable: Map<string, BfOp> | null = null;

  constructor(d: Dialect) {
    if (d.lines) this.lineTable = new Map(BF_OPS.map((op) => [d.tokens[op], op]));
    for (const op of BF_OPS) {
      let node = this.root;
      for (const ch of d.tokens[op]) {
        let n = node.next.get(ch);
        if (!n) node.next.set(ch, (n = { next: new Map() }));
        node = n;
      }
      node.op = op;
    }
  }

  lex(src: string): LexResult {
    if (this.lineTable) return this.lexLines(src);
    const ops: string[] = [];
    const pos: number[] = [];
    let commentChars = 0;
    let i = 0;
    while (i < src.length) {
      // longest match
      let node: TrieNode | undefined = this.root;
      let j = i;
      let best: BfOp | undefined;
      let bestEnd = i;
      while (node && j < src.length) {
        const cp = src.codePointAt(j)!;
        const ch = String.fromCodePoint(cp);
        node = node.next.get(ch);
        j += ch.length;
        if (node?.op) {
          best = node.op;
          bestEnd = j;
        }
      }
      if (best) {
        ops.push(best);
        pos.push(i);
        i = bestEnd;
      } else {
        const ch = String.fromCodePoint(src.codePointAt(i)!);
        if (!/\s/.test(ch)) commentChars++;
        i += ch.length;
      }
    }
    return { ops: ops.join(''), pos, commentChars };
  }

  /** Line mode: each whole line (a trailing CR is ignored) is one token, or a comment. */
  private lexLines(src: string): LexResult {
    const ops: string[] = [];
    const pos: number[] = [];
    let commentChars = 0;
    let start = 0;
    while (start <= src.length) {
      let end = src.indexOf('\n', start);
      if (end < 0) end = src.length;
      const line = src.slice(start, end).replace(/\r$/, '');
      const op = this.lineTable!.get(line);
      if (op) {
        ops.push(op);
        pos.push(start);
      } else commentChars += line.replace(/\s/g, '').length;
      start = end + 1;
    }
    return { ops: ops.join(''), pos, commentChars };
  }
}

// ───────────────────────── serializer ─────────────────────────

/**
 * Render a Brainfuck program in the dialect. Short loops stay on one line,
 * longer loops are broken into indented lines so the structure is visible.
 */
export function serialize(bf: string, d: Dialect, needsSeparator: boolean): string {
  // Line mode: exactly one token per line, no indentation (it would change the meaning).
  if (d.lines) return Array.from(bf, (op) => d.tokens[op as BfOp] + '\n').join('');
  const sep = needsSeparator ? ' ' : '';
  const tok = (op: string) => d.tokens[op as BfOp];
  const MAX_LINE = 48; // tokens per line
  const INLINE_LOOP = 12; // loops up to this many ops (and no nesting) stay inline

  // matching brackets
  const match = new Int32Array(bf.length).fill(-1);
  const stack: number[] = [];
  for (let i = 0; i < bf.length; i++) {
    if (bf[i] === '[') stack.push(i);
    else if (bf[i] === ']' && stack.length) {
      const j = stack.pop()!;
      match[i] = j;
      match[j] = i;
    }
  }

  const lines: string[] = [];
  let line: string[] = [];
  let depth = 0;
  const indent = () => '  '.repeat(Math.min(depth, 8));
  const flush = () => {
    if (line.length) lines.push(indent() + line.join(sep));
    line = [];
  };
  const push = (s: string) => {
    line.push(s);
    if (line.length >= MAX_LINE) flush();
  };

  let i = 0;
  while (i < bf.length) {
    const ch = bf[i];
    if (ch === '[') {
      const end = match[i];
      const inner = end > 0 ? bf.slice(i + 1, end) : '';
      if (end > 0 && inner.length <= INLINE_LOOP && !inner.includes('[')) {
        for (let k = i; k <= end; k++) push(tok(bf[k]));
        i = end + 1;
        continue;
      }
      flush();
      line.push(tok('['));
      flush();
      depth++;
      i++;
      continue;
    }
    if (ch === ']') {
      flush();
      depth = Math.max(0, depth - 1);
      line.push(tok(']'));
      flush();
      i++;
      continue;
    }
    push(tok(ch));
    i++;
  }
  flush();
  return lines.join('\n') + '\n';
}

/** Translate text written in one dialect into another (comments are dropped). */
export function translate(text: string, from: Dialect, to: Dialect): string {
  const bf = new Lexer(from).lex(text).ops;
  return serialize(bf, to, checkDialect(to).needsSeparator);
}
