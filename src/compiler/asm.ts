// A tiny structured assembler for writing WebAssembly functions from TS.

import { sleb, uleb } from './wasm';

export class Asm {
  b: number[] = [];

  private op(...x: number[]) {
    for (const v of x) this.b.push(v);
    return this;
  }

  i32(n: number) {
    return this.op(0x41, ...sleb(n | 0));
  }
  get(l: number) {
    return this.op(0x20, ...uleb(l));
  }
  set(l: number) {
    return this.op(0x21, ...uleb(l));
  }
  tee(l: number) {
    return this.op(0x22, ...uleb(l));
  }
  gget(g: number) {
    return this.op(0x23, ...uleb(g));
  }
  gset(g: number) {
    return this.op(0x24, ...uleb(g));
  }
  load8(offset = 0) {
    return this.op(0x2d, 0, ...uleb(offset));
  }
  store8(offset = 0) {
    return this.op(0x3a, 0, ...uleb(offset));
  }
  load32(offset = 0) {
    return this.op(0x28, 2, ...uleb(offset));
  }
  store32(offset = 0) {
    return this.op(0x36, 2, ...uleb(offset));
  }
  add() {
    return this.op(0x6a);
  }
  sub() {
    return this.op(0x6b);
  }
  and() {
    return this.op(0x71);
  }
  or() {
    return this.op(0x72);
  }
  shl() {
    return this.op(0x74);
  }
  shr_s() {
    return this.op(0x75);
  }
  shr_u() {
    return this.op(0x76);
  }
  eq() {
    return this.op(0x46);
  }
  ne() {
    return this.op(0x47);
  }
  eqz() {
    return this.op(0x45);
  }
  lt_u() {
    return this.op(0x49);
  }
  ge_u() {
    return this.op(0x4f);
  }
  select() {
    return this.op(0x1b);
  }
  call(f: number) {
    return this.op(0x10, ...uleb(f));
  }
  br(n: number) {
    return this.op(0x0c, ...uleb(n));
  }
  br_if(n: number) {
    return this.op(0x0d, ...uleb(n));
  }
  ret() {
    return this.op(0x0f);
  }

  block(body: () => void) {
    this.op(0x02, 0x40);
    body();
    return this.op(0x0b);
  }
  loop(body: () => void) {
    this.op(0x03, 0x40);
    body();
    return this.op(0x0b);
  }
  if(then: () => void, otherwise?: () => void) {
    this.op(0x04, 0x40);
    then();
    if (otherwise) {
      this.op(0x05);
      otherwise();
    }
    return this.op(0x0b);
  }

  /** Function body: locals (all i32) + code + end. */
  body(nLocals: number): number[] {
    const locals = nLocals ? [1, ...uleb(nLocals), 0x7f] : [0];
    const code = [...locals, ...this.b, 0x0b];
    return [...uleb(code.length), ...code];
  }
}
