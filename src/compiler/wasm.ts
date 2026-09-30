// IR → WebAssembly binary, written byte by byte (no toolchain involved).
//
// Module shape:
//   (import "env" "putc" (func (param i32)))
//   (import "env" "getc" (func (result i32)))
//   (memory (export "tape") 1)          ;; 65536 cells of 8 bits
//   (func (export "run") (result i32)   ;; returns the final head position
//     (local $p i32) ...)

import type { Op } from './optimizer';

export const OPC = {
  block: 0x02,
  loop: 0x03,
  br: 0x0c,
  br_if: 0x0d,
  end: 0x0b,
  call: 0x10,
  local_get: 0x20,
  local_set: 0x21,
  i32_load8_u: 0x2d,
  i32_store8: 0x3a,
  i32_const: 0x41,
  i32_eqz: 0x45,
  i32_add: 0x6a,
  i32_mul: 0x6c,
} as const;

export const TAPE_PAGES = 1;

export function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n !== 0) b |= 0x80;
    out.push(b);
  } while (n !== 0);
  return out;
}

export function sleb(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) {
      out.push(b);
      return out;
    }
    out.push(b | 0x80);
  }
}

const str = (s: string) => {
  const b = Array.from(new TextEncoder().encode(s));
  return [...uleb(b.length), ...b];
};

const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];
const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()];

const FN_PUTC = 0;
const FN_GETC = 1;
const LOCAL_P = 0;

class CodeWriter {
  bytes: number[] = [];

  emit(...b: number[]) {
    for (const x of b) this.bytes.push(x);
  }

  /** Push the address of cell p+o and return the memarg offset to use. */
  addr(o: number): number {
    this.emit(OPC.local_get, LOCAL_P);
    if (o >= 0) return o;
    this.emit(OPC.i32_const, ...sleb(o), OPC.i32_add);
    return 0;
  }

  load(o: number) {
    const off = this.addr(o);
    this.emit(OPC.i32_load8_u, 0, ...uleb(off));
  }

  store(off: number) {
    this.emit(OPC.i32_store8, 0, ...uleb(off));
  }

  ops(list: Op[]) {
    for (const op of list) this.op(op);
  }

  op(op: Op) {
    switch (op.k) {
      case 'add': {
        const off = this.addr(op.o);
        this.load(op.o);
        this.emit(OPC.i32_const, ...sleb(op.n), OPC.i32_add);
        this.store(off);
        break;
      }
      case 'clear': {
        const off = this.addr(op.o);
        this.emit(OPC.i32_const, 0);
        this.store(off);
        break;
      }
      case 'mul': {
        const off = this.addr(op.dst);
        this.load(op.dst);
        this.load(op.src);
        if (op.f !== 1) this.emit(OPC.i32_const, ...sleb(op.f), OPC.i32_mul);
        this.emit(OPC.i32_add);
        this.store(off);
        break;
      }
      case 'move':
        this.emit(OPC.local_get, LOCAL_P, OPC.i32_const, ...sleb(op.n), OPC.i32_add, OPC.local_set, LOCAL_P);
        break;
      case 'out':
        this.load(op.o);
        this.emit(OPC.call, FN_PUTC);
        break;
      case 'in': {
        const off = this.addr(op.o);
        this.emit(OPC.call, FN_GETC);
        this.store(off);
        break;
      }
      case 'loop':
        // block { loop { if (!cell[p]) break; body; continue } }
        this.emit(OPC.block, 0x40, OPC.loop, 0x40);
        this.load(0);
        this.emit(OPC.i32_eqz, OPC.br_if, 1);
        this.ops(op.body);
        this.emit(OPC.br, 0, OPC.end, OPC.end);
        break;
      case 'scan':
        this.emit(OPC.block, 0x40, OPC.loop, 0x40);
        this.load(0);
        this.emit(OPC.i32_eqz, OPC.br_if, 1);
        this.emit(OPC.local_get, LOCAL_P, OPC.i32_const, ...sleb(op.step), OPC.i32_add, OPC.local_set, LOCAL_P);
        this.emit(OPC.br, 0, OPC.end, OPC.end);
        break;
    }
  }
}

/** Everything before the code section: identical for every program. */
export function programHeader(): number[] {
  const I32 = 0x7f;
  const FUNC = 0x60;
  const types = vec([
    [FUNC, ...vec([[I32]]), ...vec([])], // 0: (i32) -> ()
    [FUNC, ...vec([]), ...vec([[I32]])], // 1: () -> i32
  ]);
  const imports = vec([
    [...str('env'), ...str('putc'), 0x00, 0],
    [...str('env'), ...str('getc'), 0x00, 1],
  ]);
  const funcs = vec([[1]]);
  const memory = vec([[0x00, ...uleb(TAPE_PAGES)]]);
  const exports = vec([
    [...str('run'), 0x00, 2],
    [...str('tape'), 0x02, 0],
  ]);
  return [
    0x00, 0x61, 0x73, 0x6d, // \0asm
    0x01, 0x00, 0x00, 0x00, // version 1
    ...section(1, types),
    ...section(2, imports),
    ...section(3, funcs),
    ...section(5, memory),
    ...section(7, exports),
  ];
}

export function emitWasm(ops: Op[]): Uint8Array {
  const w = new CodeWriter();
  w.ops(ops);
  w.emit(OPC.local_get, LOCAL_P, OPC.end);
  const locals = vec([[1, 0x7f]]);
  const body = [...locals, ...w.bytes];
  const code = vec([[...uleb(body.length), ...body]]);
  return new Uint8Array([...programHeader(), ...section(10, code)]);
}
