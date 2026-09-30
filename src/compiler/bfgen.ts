// Low-level Brainfuck emitter with compile-time pointer tracking.
//
// Every cell is addressed by an absolute index. The emitter always knows where
// the tape head is, so moving to a cell is just the right number of `>`/`<`.
// Loops are emitted so that the head is back on the loop cell before `]`,
// which keeps the pointer position static across the whole program
// (except inside explicit "dynamic" snippets such as array walks).
//
// Allocation invariant: a free cell always holds 0 at runtime.

export class BfGen {
  private out: string[] = [];
  private used: boolean[] = [];
  ptr = 0;
  maxCell = 0;

  code(): string {
    return this.out.join('');
  }

  alloc(): number {
    let i = 0;
    while (this.used[i]) i++;
    this.used[i] = true;
    this.maxCell = Math.max(this.maxCell, i);
    return i;
  }

  /** Allocate `n` contiguous cells, returns the first index. */
  allocBlock(n: number): number {
    let i = 0;
    for (;;) {
      let ok = true;
      for (let k = 0; k < n; k++) {
        if (this.used[i + k]) {
          ok = false;
          i = i + k + 1;
          break;
        }
      }
      if (ok) break;
    }
    for (let k = 0; k < n; k++) this.used[i + k] = true;
    this.maxCell = Math.max(this.maxCell, i + n - 1);
    return i;
  }

  /** Release a cell. The caller guarantees that it is 0 at runtime. */
  free(c: number): void {
    this.used[c] = false;
  }

  /** Clear the cell, then release it. */
  release(c: number): void {
    this.clear(c);
    this.free(c);
  }

  emit(s: string): void {
    this.out.push(s);
  }

  moveTo(c: number): void {
    const d = c - this.ptr;
    if (d > 0) this.emit('>'.repeat(d));
    else if (d < 0) this.emit('<'.repeat(-d));
    this.ptr = c;
  }

  /** Raw `+`/`-` (n is taken modulo 256 and the shorter direction is used). */
  add(c: number, n: number): void {
    n = ((n % 256) + 256) % 256;
    if (n === 0) return;
    this.moveTo(c);
    if (n <= 128) this.emit('+'.repeat(n));
    else this.emit('-'.repeat(256 - n));
  }

  /** Add a constant, using a multiplication loop when it is shorter. */
  addConst(c: number, n: number): void {
    n = ((n % 256) + 256) % 256;
    if (n > 128) n -= 256;
    const abs = Math.abs(n);
    if (abs <= 15) {
      this.add(c, n);
      return;
    }
    const sign = n < 0 ? -1 : 1;
    let best = { a: 0, b: 0, r: abs, cost: abs };
    for (let a = 2; a <= 16; a++) {
      const b = Math.floor(abs / a);
      for (const bb of [b, b + 1]) {
        const r = abs - a * bb;
        const cost = a + bb + Math.abs(r) + 8;
        if (cost < best.cost) best = { a, b: bb, r, cost };
      }
    }
    if (best.a === 0) {
      this.add(c, n);
      return;
    }
    const t = this.alloc();
    this.add(t, best.a);
    this.loop(t, () => {
      this.add(t, -1);
      this.add(c, sign * best.b);
    });
    this.free(t);
    this.add(c, sign * best.r);
  }

  clear(c: number): void {
    this.moveTo(c);
    this.emit('[-]');
  }

  loop(c: number, body: () => void): void {
    this.moveTo(c);
    this.emit('[');
    body();
    this.moveTo(c);
    this.emit(']');
  }

  output(c: number): void {
    this.moveTo(c);
    this.emit('.');
  }

  input(c: number): void {
    this.moveTo(c);
    this.emit(',');
  }

  /** src → Σ targets (with factors). src becomes 0. */
  moveAdd(src: number, targets: Array<[number, number]>): void {
    this.loop(src, () => {
      this.add(src, -1);
      for (const [t, f] of targets) this.add(t, f);
    });
  }

  /** Copy src into dest (dest += src), src preserved. */
  copyAdd(src: number, dest: number): void {
    const t = this.alloc();
    this.moveAdd(src, [
      [dest, 1],
      [t, 1],
    ]);
    this.moveAdd(t, [[src, 1]]);
    this.free(t);
  }

  /** Copy into a newly allocated cell. */
  copy(src: number): number {
    const d = this.alloc();
    this.copyAdd(src, d);
    return d;
  }

  /**
   * Emit a snippet that moves the head dynamically but ends at a known cell.
   * `start` is where the snippet expects the head, `end` where it leaves it.
   */
  dynamic(start: number, snippet: string, end: number): void {
    this.moveTo(start);
    this.emit(snippet);
    this.ptr = end;
  }
}
