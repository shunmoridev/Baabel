// Dialects: the user-defined surface syntax for the 8 Brainfuck instructions.
//
// A dialect is a real language definition: the lexer is built from it (a trie
// with longest-match), and the program that runs is whatever the lexer reads
// from the middle pane. Characters that match no token are comments, exactly
// like in standard Brainfuck.

export const BF_OPS = ['>', '<', '+', '-', '.', ',', '[', ']'] as const;
export type BfOp = (typeof BF_OPS)[number];

export const OP_LABELS: Record<BfOp, string> = {
  '>': 'ポインタを右へ',
  '<': 'ポインタを左へ',
  '+': '値を +1',
  '-': '値を -1',
  '.': '出力',
  ',': '入力',
  '[': 'ループ開始',
  ']': 'ループ終了',
};

export interface Dialect {
  name: string;
  tokens: Record<BfOp, string>;
}

export const PRESETS: Dialect[] = [
  {
    name: '羊語',
    tokens: { '>': 'メェ→', '<': '←メェ', '+': 'メェ', '-': 'ベェ', '.': 'メェ！', ',': 'メェ？', '[': '群れ', ']': '解散' },
  },
  {
    name: 'Brainfuck',
    tokens: { '>': '>', '<': '<', '+': '+', '-': '-', '.': '.', ',': ',', '[': '[', ']': ']' },
  },
  {
    name: 'Ook!',
    tokens: { '>': 'Ook. Ook?', '<': 'Ook? Ook.', '+': 'Ook. Ook.', '-': 'Ook! Ook!', '.': 'Ook! Ook.', ',': 'Ook. Ook!', '[': 'Ook! Ook?', ']': 'Ook? Ook!' },
  },
  {
    name: '猫語',
    tokens: { '>': 'にゃ', '<': 'みゃ', '+': 'にゃーん', '-': 'しゃー', '.': 'ごろごろ', ',': 'すりすり', '[': 'ふみ', ']': 'ふみふみ' },
  },
  {
    name: '絵文字',
    tokens: { '>': '👉', '<': '👈', '+': '👍', '-': '👎', '.': '📣', ',': '👂', '[': '🔁', ']': '🔚' },
  },
];

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
    const t = d.tokens[op];
    if (!t) errors.push(`「${op}」の命令が空です`);
    else if (t !== t.trim()) errors.push(`「${op}」の命令の前後に空白は使えません`);
    else if (/[\r\n]/.test(t)) errors.push(`「${op}」の命令に改行は使えません`);
    else if (seen.has(t)) errors.push(`「${seen.get(t)}」と「${op}」が同じ文字列です`);
    else seen.set(t, op);
  }
  if (errors.length) return { errors, needsSeparator: false };
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
  errors.push('命令どうしが区別できません（ある命令が別の命令の組み合わせと重なっています）');
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

  constructor(d: Dialect) {
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
}

// ───────────────────────── serializer ─────────────────────────

/**
 * Render a Brainfuck program in the dialect. Short loops stay on one line,
 * longer loops are broken into indented lines so the structure is visible.
 */
export function serialize(bf: string, d: Dialect, needsSeparator: boolean): string {
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
