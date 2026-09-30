// Brainfuck → optimised IR.
//
// Straight-line code is folded into offset-addressed operations so the head
// only moves at loop boundaries. Common loop idioms are recognised:
//   [-]            → clear
//   [->+>++<<]     → mul (cell[p+1] += cell[p]*1, cell[p+2] += cell[p]*2), clear
//   [>] / [<<]     → scan

import { t } from '../i18n';

export type Op =
  | { k: 'add'; o: number; n: number }
  | { k: 'move'; n: number }
  | { k: 'clear'; o: number }
  | { k: 'mul'; src: number; dst: number; f: number }
  | { k: 'out'; o: number }
  | { k: 'in'; o: number }
  | { k: 'loop'; body: Op[] }
  | { k: 'scan'; step: number };

export class BracketError extends Error {
  constructor(
    message: string,
    public opIndex: number,
  ) {
    super(message);
  }
}

type Raw = { k: 'add'; n: number } | { k: 'move'; n: number } | { k: 'out' } | { k: 'in' } | { k: 'loop'; body: Raw[] };

function parseRaw(bf: string): Raw[] {
  const stack: Array<{ list: Raw[]; at: number }> = [];
  let cur: Raw[] = [];
  for (let i = 0; i < bf.length; i++) {
    const c = bf[i];
    const last = cur[cur.length - 1];
    switch (c) {
      case '+':
      case '-': {
        const d = c === '+' ? 1 : -1;
        if (last?.k === 'add') last.n += d;
        else cur.push({ k: 'add', n: d });
        break;
      }
      case '>':
      case '<': {
        const d = c === '>' ? 1 : -1;
        if (last?.k === 'move') last.n += d;
        else cur.push({ k: 'move', n: d });
        break;
      }
      case '.':
        cur.push({ k: 'out' });
        break;
      case ',':
        cur.push({ k: 'in' });
        break;
      case '[':
        stack.push({ list: cur, at: i });
        cur = [];
        break;
      case ']': {
        const top = stack.pop();
        if (!top) throw new BracketError(t('bf.unmatchedClose'), i);
        top.list.push({ k: 'loop', body: cur });
        cur = top.list;
        break;
      }
    }
  }
  if (stack.length) throw new BracketError(t('bf.unclosedOpen'), stack[stack.length - 1].at);
  return cur;
}

function optimizeBlock(raw: Raw[]): Op[] {
  const out: Op[] = [];
  let off = 0;
  const pushAdd = (o: number, n: number) => {
    const last = out[out.length - 1];
    if (last?.k === 'add' && last.o === o) {
      last.n += n;
      if (last.n % 256 === 0) out.pop();
    } else if (n % 256 !== 0) out.push({ k: 'add', o, n });
  };
  for (const r of raw) {
    switch (r.k) {
      case 'move':
        off += r.n;
        break;
      case 'add':
        pushAdd(off, r.n);
        break;
      case 'out':
        out.push({ k: 'out', o: off });
        break;
      case 'in':
        out.push({ k: 'in', o: off });
        break;
      case 'loop': {
        const idiom = loopIdiom(r.body);
        if (idiom === 'clear') {
          const last = out[out.length - 1];
          if (last?.k === 'add' && last.o === off) out.pop();
          out.push({ k: 'clear', o: off });
        } else if (idiom && 'mul' in idiom) {
          for (const [d, f] of idiom.mul) out.push({ k: 'mul', src: off, dst: off + d, f });
          out.push({ k: 'clear', o: off });
        } else if (idiom && 'scan' in idiom) {
          if (off !== 0) out.push({ k: 'move', n: off });
          off = 0;
          out.push({ k: 'scan', step: idiom.scan });
        } else {
          // A general loop may move the head by an unknown amount:
          // settle the pending offset first.
          if (off !== 0) out.push({ k: 'move', n: off });
          off = 0;
          out.push({ k: 'loop', body: optimizeBlock(r.body) });
        }
        break;
      }
    }
  }
  if (off !== 0) out.push({ k: 'move', n: off });
  return out;
}

type Idiom = 'clear' | { mul: Array<[number, number]> } | { scan: number } | null;

function loopIdiom(body: Raw[]): Idiom {
  if (body.length === 1 && body[0].k === 'add' && Math.abs(body[0].n) % 2 === 1) {
    // [-], [+], [---] … all terminate at 0 for odd steps
    return 'clear';
  }
  if (body.length === 1 && body[0].k === 'move') return { scan: body[0].n };
  // multiplication loop: only adds/moves, net movement 0, cell 0 decremented by 1
  let off = 0;
  const deltas = new Map<number, number>();
  for (const r of body) {
    if (r.k === 'move') off += r.n;
    else if (r.k === 'add') deltas.set(off, (deltas.get(off) ?? 0) + r.n);
    else return null;
  }
  if (off !== 0) return null;
  if ((((deltas.get(0) ?? 0) % 256) + 256) % 256 !== 255) return null;
  deltas.delete(0);
  return { mul: [...deltas.entries()].filter(([, f]) => f % 256 !== 0) };
}

export function optimize(bf: string): Op[] {
  return optimizeBlock(parseRaw(bf));
}

export function countOps(ops: Op[]): number {
  let n = 0;
  for (const op of ops) {
    n++;
    if (op.k === 'loop') n += countOps(op.body);
  }
  return n;
}
