// The two real compilation stages:
//   JS  --frontend-->  Brainfuck  --serialize(dialect)-->  羊語 text
//   羊語 text  --lex(dialect)-->  Brainfuck  --optimize-->  IR  --emit-->  .wasm
//
// The second stage always starts from the text in the middle pane.

import { compileJs } from './frontend';
import { checkDialect, Lexer, serialize, type Dialect } from './dialect';
import { optimize, countOps, BracketError } from './optimizer';
import { emitWasm } from './wasm';

export interface FrontResult {
  meeme: string;
  bf: string;
  warnings: string[];
  cells: number;
  ms: number;
}

export function jsToMeeme(src: string, dialect: Dialect): FrontResult {
  const t0 = performance.now();
  const { bf, warnings, cells } = compileJs(src);
  const check = checkDialect(dialect);
  if (check.errors.length) throw new Error(check.errors.join('\n'));
  const meeme = serialize(bf, dialect, check.needsSeparator);
  return { meeme, bf, warnings, cells, ms: performance.now() - t0 };
}

export interface BackResult {
  wasm: Uint8Array;
  bf: string;
  rawOps: number;
  irOps: number;
  lexMs: number;
  optMs: number;
  emitMs: number;
  commentChars: number;
}

export class MeemeError extends Error {
  constructor(
    message: string,
    public offset?: number,
  ) {
    super(message);
  }
}

export function meemeToWasm(text: string, dialect: Dialect): BackResult {
  const t0 = performance.now();
  const lexed = new Lexer(dialect).lex(text);
  const t1 = performance.now();
  let ir;
  try {
    ir = optimize(lexed.ops);
  } catch (e) {
    if (e instanceof BracketError) throw new MeemeError(e.message, lexed.pos[e.opIndex]);
    throw e;
  }
  const t2 = performance.now();
  const wasm = emitWasm(ir);
  const t3 = performance.now();
  return {
    wasm,
    bf: lexed.ops,
    rawOps: lexed.ops.length,
    irOps: countOps(ir),
    lexMs: t1 - t0,
    optMs: t2 - t1,
    emitMs: t3 - t2,
    commentChars: lexed.commentChars,
  };
}
