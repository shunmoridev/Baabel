// Compiler generator: dialect → meeme-compiler.wasm
//
// Given a dialect, this emits a WebAssembly module that compiles source text
// written in that dialect straight into a runnable program.wasm. The dialect's
// tokens are not stored as data: the trie is turned into nested branches in
// the generated `match` function, so each dialect gets its own compiler.
//
// Exports of the generated compiler:
//   mem                      memory (the host writes UTF-8 source at src_ptr())
//   compile(len) -> i32      length of program.wasm at out_ptr(), or
//                            -1 (']' without '[') / -2 ('[' not closed); see err_pos()
//   src_ptr() out_ptr() err_pos() op_count()

import { BF_OPS, type BfOp, type Dialect } from './dialect';
import { Asm } from './asm';
import { programHeader, sleb, uleb } from './wasm';
import { t as tr } from '../i18n';

const OP_CODE: Record<BfOp, number> = { '>': 1, '<': 2, '+': 3, '-': 4, '.': 5, ',': 6, '[': 7, ']': 8 };

const HEADER_ADDR = 16;
const SRC = 1024;

// function indices
const F_MATCH = 0;
const F_EMIT = 1;
const F_SLEB = 2;
const F_WRITE5 = 3;
const F_COMPILE = 4;

// globals
const G_O = 0; // output cursor
const G_ERR = 1;
const G_NOPS = 2;
const G_OUTBASE = 3;

// program-side instruction templates (must match wasm.ts)
const T = {
  addHead: [0x20, 0, 0x20, 0, 0x2d, 0, 0, 0x41],
  addTail: [0x6a, 0x3a, 0, 0],
  moveHead: [0x20, 0, 0x41],
  moveTail: [0x6a, 0x21, 0],
  out: [0x20, 0, 0x2d, 0, 0, 0x10, 0],
  in: [0x20, 0, 0x10, 1, 0x3a, 0, 0],
  clear: [0x20, 0, 0x41, 0, 0x3a, 0, 0],
  open: [0x02, 0x40, 0x03, 0x40, 0x20, 0, 0x2d, 0, 0, 0x45, 0x0d, 1],
  close: [0x0c, 0, 0x0b, 0x0b],
  end: [0x20, 0, 0x0b],
};

interface Trie {
  next: Map<number, Trie>;
  op?: BfOp;
}

function buildTrie(d: Dialect): Trie {
  const root: Trie = { next: new Map() };
  const enc = new TextEncoder();
  for (const op of BF_OPS) {
    let n = root;
    for (const byte of enc.encode(d.tokens[op])) {
      let c = n.next.get(byte);
      if (!c) n.next.set(byte, (c = { next: new Map() }));
      n = c;
    }
    n.op = op;
  }
  return root;
}

/** match(i, end): (length << 4) | opcode of the longest token at i, or 0. */
function genMatch(d: Dialect): number[] {
  const a = new Asm();
  const I = 0,
    END = 1,
    C = 2,
    BEST = 3;
  const node = (n: Trie, depth: number) => {
    if (n.op) a.i32((depth << 4) | OP_CODE[n.op]).set(BEST);
    const kids = [...n.next.entries()];
    if (!kids.length) return;
    // if (i + depth < end)
    a.get(I).i32(depth).add().get(END).lt_u();
    a.if(() => {
      a.get(I).load8(depth).set(C);
      const chain = (k: number) => {
        if (k >= kids.length) return;
        const [byte, child] = kids[k];
        a.get(C).i32(byte).eq();
        a.if(
          () => node(child, depth + 1),
          k + 1 < kids.length ? () => chain(k + 1) : undefined,
        );
      };
      chain(0);
    });
  };
  a.i32(0).set(BEST);
  node(buildTrie(d), 0);
  a.get(BEST);
  return a.body(2);
}

function genEmitByte(): number[] {
  const a = new Asm();
  a.gget(G_O).get(0).store8();
  a.gget(G_O).i32(1).add().gset(G_O);
  return a.body(0);
}

function genEmitSleb(): number[] {
  const a = new Asm();
  const N = 0,
    B = 1;
  a.block(() =>
    a.loop(() => {
      a.get(N).i32(0x7f).and().set(B);
      a.get(N).i32(7).shr_s().set(N);
      a.get(N).eqz().get(B).i32(0x40).and().eqz().and();
      a.get(N).i32(-1).eq().get(B).i32(0x40).and().i32(0).ne().and();
      a.or();
      a.if(() => {
        a.get(B).call(F_EMIT).br(2);
      });
      a.get(B).i32(0x80).or().call(F_EMIT);
      a.br(0);
    }),
  );
  return a.body(1);
}

/** write5(pos, n): fixed-width 5-byte LEB128 (so sizes can be patched in place). */
function genWrite5(): number[] {
  const a = new Asm();
  for (let j = 0; j < 4; j++) a.get(0).get(1).i32(7 * j).shr_u().i32(0x7f).and().i32(0x80).or().store8(j);
  a.get(0).get(1).i32(28).shr_u().i32(0x7f).and().store8(4);
  return a.body(0);
}

function genCompile(): number[] {
  const a = new Asm();
  const LEN = 0,
    I = 1,
    END = 2,
    M = 3,
    N = 4,
    K = 5,
    OP = 6,
    RUN = 7,
    DEPTH = 8,
    OPS = 9,
    OFFS = 10,
    STACK = 11,
    SEC = 12,
    BODY = 13,
    TT = 14;
  const emit = (bytes: number[]) => bytes.forEach((b) => a.i32(b).call(F_EMIT));
  const opAt = (idxLocal: number, plus = 0) => a.get(OPS).get(idxLocal).add().load8(plus);
  const isOp = (code: number) => a.get(OP).i32(code).eq();

  // layout
  a.i32(SRC).get(LEN).add().set(END);
  a.get(END).i32(7).add().i32(-8).and().set(OPS);
  a.get(OPS).get(LEN).add().i32(3).add().i32(-4).and().set(OFFS);
  a.get(OFFS).get(LEN).i32(2).shl().add().set(STACK);
  a.get(STACK).get(LEN).i32(2).shl().add().i32(4).add().gset(G_OUTBASE);

  // ── pass 1: lex with the dialect-specific matcher ──
  a.i32(SRC).set(I).i32(0).set(N);
  a.block(() =>
    a.loop(() => {
      a.get(I).get(END).ge_u().br_if(1);
      a.get(I).get(END).call(F_MATCH).tee(M);
      a.if(
        () => {
          a.get(OPS).get(N).add().get(M).i32(15).and().store8();
          a.get(OFFS).get(N).i32(2).shl().add().get(I).i32(SRC).sub().store32();
          a.get(N).i32(1).add().set(N);
          a.get(I).get(M).i32(4).shr_u().add().set(I);
        },
        () => {
          a.get(I).i32(1).add().set(I); // not a token: comment byte
        },
      );
      a.br(0);
    }),
  );
  a.get(N).gset(G_NOPS);

  // ── module header + code section prologue ──
  a.gget(G_OUTBASE).gset(G_O);
  const headerLen = programHeader().length;
  a.i32(0).set(K);
  a.block(() =>
    a.loop(() => {
      a.get(K).i32(headerLen).ge_u().br_if(1);
      a.get(K).load8(HEADER_ADDR).call(F_EMIT);
      a.get(K).i32(1).add().set(K);
      a.br(0);
    }),
  );
  emit([0x0a]);
  a.gget(G_O).set(SEC).gget(G_O).i32(5).add().gset(G_O);
  emit([0x01]);
  a.gget(G_O).set(BODY).gget(G_O).i32(5).add().gset(G_O);
  emit([0x01, 0x01, 0x7f]); // one local: i32 $p

  // ── pass 2: code generation (runs of +-/<> are folded, [-] becomes a store) ──
  a.i32(0).set(K).i32(0).set(DEPTH);
  a.block(() =>
    a.loop(() => {
      a.get(K).get(N).ge_u().br_if(1);
      opAt(K).set(OP);
      isOp(OP_CODE['+']);
      isOp(OP_CODE['-']);
      a.or();
      a.if(
        () => {
          // + / - run
          a.i32(0).set(RUN);
          a.block(() =>
            a.loop(() => {
              a.get(K).get(N).ge_u().br_if(1);
              opAt(K).set(OP);
              a.get(OP).i32(OP_CODE['+']).ne().get(OP).i32(OP_CODE['-']).ne().and().br_if(1);
              a.get(RUN).i32(1).i32(-1).get(OP).i32(OP_CODE['+']).eq().select().add().set(RUN);
              a.get(K).i32(1).add().set(K);
              a.br(0);
            }),
          );
          a.get(RUN).i32(255).and().tee(RUN);
          a.if(() => {
            emit(T.addHead);
            // signed value: run < 128 ? run : run - 256
            a.get(RUN).get(RUN).i32(256).sub().get(RUN).i32(128).lt_u().select().call(F_SLEB);
            emit(T.addTail);
          });
        },
        () => {
          isOp(OP_CODE['>']);
          isOp(OP_CODE['<']);
          a.or();
          a.if(
            () => {
              // > / < run
              a.i32(0).set(RUN);
              a.block(() =>
                a.loop(() => {
                  a.get(K).get(N).ge_u().br_if(1);
                  opAt(K).set(OP);
                  a.get(OP).i32(OP_CODE['>']).ne().get(OP).i32(OP_CODE['<']).ne().and().br_if(1);
                  a.get(RUN).i32(1).i32(-1).get(OP).i32(OP_CODE['>']).eq().select().add().set(RUN);
                  a.get(K).i32(1).add().set(K);
                  a.br(0);
                }),
              );
              a.get(RUN);
              a.if(() => {
                emit(T.moveHead);
                a.get(RUN).call(F_SLEB);
                emit(T.moveTail);
              });
            },
            () => {
              isOp(OP_CODE['.']);
              a.if(
                () => {
                  emit(T.out);
                  a.get(K).i32(1).add().set(K);
                },
                () => {
                  isOp(OP_CODE[',']);
                  a.if(
                    () => {
                      emit(T.in);
                      a.get(K).i32(1).add().set(K);
                    },
                    () => {
                      isOp(OP_CODE['[']);
                      a.if(
                        () => {
                          // [-] / [+] → clear
                          a.i32(0).set(TT);
                          a.get(K).i32(2).add().get(N).lt_u();
                          a.if(() => {
                            opAt(K, 1).i32(OP_CODE['+']).eq();
                            opAt(K, 1).i32(OP_CODE['-']).eq();
                            a.or();
                            opAt(K, 2).i32(OP_CODE[']']).eq();
                            a.and().set(TT);
                          });
                          a.get(TT);
                          a.if(
                            () => {
                              emit(T.clear);
                              a.get(K).i32(3).add().set(K);
                            },
                            () => {
                              a.get(STACK).get(DEPTH).i32(2).shl().add();
                              a.get(OFFS).get(K).i32(2).shl().add().load32();
                              a.store32();
                              a.get(DEPTH).i32(1).add().set(DEPTH);
                              emit(T.open);
                              a.get(K).i32(1).add().set(K);
                            },
                          );
                        },
                        () => {
                          // ']'
                          a.get(DEPTH).eqz();
                          a.if(() => {
                            a.get(OFFS).get(K).i32(2).shl().add().load32().gset(G_ERR);
                            a.i32(-1).ret();
                          });
                          a.get(DEPTH).i32(1).sub().set(DEPTH);
                          emit(T.close);
                          a.get(K).i32(1).add().set(K);
                        },
                      );
                    },
                  );
                },
              );
            },
          );
        },
      );
      a.br(0);
    }),
  );

  // unclosed '['
  a.get(DEPTH);
  a.if(() => {
    a.get(STACK).get(DEPTH).i32(1).sub().i32(2).shl().add().load32().gset(G_ERR);
    a.i32(-2).ret();
  });

  emit(T.end);
  // patch sizes
  a.get(BODY).gget(G_O).get(BODY).i32(5).add().sub().call(F_WRITE5);
  a.get(SEC).gget(G_O).get(SEC).i32(5).add().sub().call(F_WRITE5);
  a.gget(G_O).gget(G_OUTBASE).sub();
  return a.body(14);
}

const getter = (build: (a: Asm) => void) => {
  const a = new Asm();
  build(a);
  return a.body(0);
};

export function generateCompiler(d: Dialect): Uint8Array {
  const I32 = 0x7f;
  const FUNC = 0x60;
  const str = (s: string) => {
    const b = Array.from(new TextEncoder().encode(s));
    return [...uleb(b.length), ...b];
  };
  const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];
  const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()];

  const types = vec([
    [FUNC, 2, I32, I32, 1, I32], // 0: (i32 i32) -> i32
    [FUNC, 1, I32, 0], // 1: (i32) -> ()
    [FUNC, 2, I32, I32, 0], // 2: (i32 i32) -> ()
    [FUNC, 1, I32, 1, I32], // 3: (i32) -> i32
    [FUNC, 0, 1, I32], // 4: () -> i32
  ]);
  const funcs = vec([[0], [1], [1], [2], [3], [4], [4], [4], [4]]);
  const memory = vec([[0x00, 1]]);
  const globals = vec([0, 1, 2, 3].map(() => [I32, 0x01, 0x41, 0x00, 0x0b]));
  const exports = vec([
    [...str('mem'), 0x02, 0],
    [...str('compile'), 0x00, F_COMPILE],
    [...str('src_ptr'), 0x00, 5],
    [...str('out_ptr'), 0x00, 6],
    [...str('err_pos'), 0x00, 7],
    [...str('op_count'), 0x00, 8],
  ]);
  const bodies = [
    genMatch(d),
    genEmitByte(),
    genEmitSleb(),
    genWrite5(),
    genCompile(),
    getter((a) => a.i32(SRC)),
    getter((a) => a.gget(G_OUTBASE)),
    getter((a) => a.gget(G_ERR)),
    getter((a) => a.gget(G_NOPS)),
  ];
  const code = [...uleb(bodies.length), ...bodies.flat()];
  const header = programHeader();
  const data = vec([[0x00, 0x41, ...sleb(HEADER_ADDR), 0x0b, ...uleb(header.length), ...header]]);

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, types),
    ...section(3, funcs),
    ...section(5, memory),
    ...section(6, globals),
    ...section(7, exports),
    ...section(10, code),
    ...section(11, data),
  ]);
}

// ───────────────────────── host side ─────────────────────────

export interface GeneratedCompiler {
  dialect: Dialect;
  bytes: Uint8Array;
  genMs: number;
  compile(text: string): { wasm: Uint8Array; ops: number; ms: number };
}

export class GeneratedCompileError extends Error {
  constructor(
    message: string,
    /** UTF-16 offset in the source text. */
    public offset: number,
  ) {
    super(message);
  }
}

export async function buildCompiler(d: Dialect): Promise<GeneratedCompiler> {
  const t0 = performance.now();
  const bytes = generateCompiler(d);
  const genMs = performance.now() - t0;
  const { instance } = await WebAssembly.instantiate(bytes as BufferSource);
  const ex = instance.exports as {
    mem: WebAssembly.Memory;
    compile(len: number): number;
    src_ptr(): number;
    out_ptr(): number;
    err_pos(): number;
    op_count(): number;
  };
  const enc = new TextEncoder();
  return {
    dialect: d,
    bytes,
    genMs,
    compile(text: string) {
      const t = performance.now();
      const src = enc.encode(text);
      const need = ex.src_ptr() + src.length * 26 + 4096 + programHeader().length;
      const pages = Math.ceil(need / 65536);
      if (ex.mem.buffer.byteLength < pages * 65536) ex.mem.grow(pages - ex.mem.buffer.byteLength / 65536);
      new Uint8Array(ex.mem.buffer, ex.src_ptr(), src.length).set(src);
      const len = ex.compile(src.length);
      if (len < 0) {
        const at = new TextDecoder().decode(src.subarray(0, ex.err_pos())).length;
        throw new GeneratedCompileError(tr(len === -1 ? 'bf.unmatchedClose' : 'bf.unclosedOpen'), at);
      }
      const wasm = new Uint8Array(ex.mem.buffer, ex.out_ptr(), len).slice();
      return { wasm, ops: ex.op_count(), ms: performance.now() - t };
    },
  };
}
