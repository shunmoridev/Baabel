import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../src/examples';
import { jsToMeeme, meemeToWasm } from '../src/compiler/pipeline';
import { PRESETS, checkDialect, translate } from '../src/compiler/dialect';
import { execWasm } from '../src/runtime/exec';
import { disassemble } from '../src/compiler/disasm';
import { compileJs } from '../src/compiler/frontend';

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Run the source as real JavaScript with Baabel's builtins, as the oracle. */
function runAsJs(code: string, input = ''): string {
  const inBytes = enc.encode(input);
  let pos = 0;
  const out: number[] = [];
  const write = (s: string) => out.push(...enc.encode(s));
  const fmt = (v: unknown) => String(v);
  const g = {
    console: { log: (...a: unknown[]) => write(a.map(fmt).join(' ') + '\n') },
    print: (...a: unknown[]) => write(a.map(fmt).join('')),
    putchar: (c: number | string) => out.push(typeof c === 'string' ? c.charCodeAt(0) : c & 255),
    getchar: () => (pos < inBytes.length ? inBytes[pos++] : 0),
    readInt: () => {
      let n = 0;
      let c = g.getchar();
      while (c === 32 || c === 10 || c === 13 || c === 9) c = g.getchar();
      while (c >= 48 && c <= 57) {
        n = n * 10 + c - 48;
        c = g.getchar();
      }
      return n;
    },
  };
  new Function(...Object.keys(g), code)(...Object.values(g));
  return dec.decode(Uint8Array.from(out));
}

async function runBaabel(code: string, input = '', dialect = PRESETS[0]) {
  const front = jsToMeeme(code, dialect);
  const back = meemeToWasm(front.meeme, dialect);
  expect(back.bf).toBe(front.bf); // lossless round-trip through the dialect
  expect(WebAssembly.validate(back.wasm as BufferSource)).toBe(true);
  const chunks: Uint8Array[] = [];
  await execWasm(back.wasm, enc.encode(input), (c) => chunks.push(c));
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  return { out: dec.decode(all), front, back };
}

describe('examples match real JavaScript', () => {
  for (const ex of EXAMPLES) {
    it(ex.title, async () => {
      const { out } = await runBaabel(ex.code, ex.input);
      expect(out).toBe(runAsJs(ex.code, ex.input));
    });
  }
});

describe('language features', () => {
  const cases: Array<[string, string]> = [
    ['arith', 'let a = 200, b = 7; console.log(a + b, a - b, a * 1, Math.floor(a / b), a % b, b * b);'],
    ['compare', 'for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) print(+(a < b), +(a <= b), +(a > b), +(a >= b), +(a == b), +(a != b), " "); console.log();'],
    ['divmod dynamic', 'for (let d = 1; d < 12; d++) print(Math.floor(100 / d), ",", 100 % d, " "); console.log();'],
    ['logical', 'let x = 0, y = 3; console.log(x && y, x || y, y && 5, +!x, +!y, x || 0);'],
    ['ternary', 'for (let i = 0; i < 5; i++) print(i % 2 == 0 ? 10 : 20, " "); console.log();'],
    ['break continue', 'for (let i = 0; i < 20; i++) { if (i % 3 == 0) continue; if (i > 13) break; print(i, " "); } console.log();'],
    ['nested break', 'for (let i = 0; i < 4; i++) { let j = 0; while (true) { j++; if (j > i) break; } print(j, " "); } console.log();'],
    ['do while', 'let i = 0; do { print(i); i++; } while (i < 5); console.log();'],
    ['early return', 'function f(n) { for (let i = 0; i < 10; i++) { if (i == n) return i * 2; } return 99; } console.log(f(3), f(12), f(0));'],
    ['array', 'let a = [5, 3, 8, 1, 9, 2]; for (let i = 0; i < a.length; i++) for (let j = 0; j + 1 < a.length - i; j++) if (a[j] > a[j + 1]) { const t = a[j]; a[j] = a[j + 1]; a[j + 1] = t; } console.log(a[0], a[1], a[2], a[3], a[4], a[5]);'],
    ['array compound', 'let a = new Array(5).fill(1); for (let i = 0; i < 5; i++) { a[i] += i; a[i] *= 3; a[i]++; } console.log(a[0], a[1], a[2], a[3], a[4]);'],
    ['string array', 'const s = "Baa!"; for (let i = s.length; i > 0; i--) putchar(s.charCodeAt(i - 1)); console.log(); for (const ch of s) { putchar(ch); print(" "); } console.log();'],
    ['arrow fn', 'const sq = (x) => x * x; const add = (a, b) => { return a + b; }; console.log(sq(12), add(sq(3), 1));'],
    ['min max', 'console.log(Math.min(3, 9), Math.max(3, 9), Math.min(200, 100));'],
    ['assign expr', 'let a, b; a = b = 7; let i = 0; const j = i++; const k = ++i; console.log(a, b, i, j, k);'],
    ['globals in fn', 'let count = 0; function inc(n) { count += n; } inc(3); inc(4); console.log(count);'],
    ['shift and', 'let x = 13; console.log(x << 2, x >> 1, x & 1, x & 7);'],
  ];
  for (const [name, code] of cases) {
    it(name, async () => {
      const { out } = await runBaabel(code);
      expect(out).toBe(runAsJs(code));
    });
  }

  it('wraps at 8 bits', async () => {
    const { out } = await runBaabel('let x = 250; x += 10; console.log(x); let y = 0; y--; console.log(y);');
    expect(out).toBe('4\n255\n');
  });

  it('rejects recursion with a clear message', () => {
    expect(() => compileJs('function f(n) { return f(n); } f(1);')).toThrow(/再帰/);
  });
});

describe('dialects', () => {
  it('every preset is valid and round-trips', async () => {
    const code = EXAMPLES.find((e) => e.id === 'fizzbuzz')!.code;
    for (const d of PRESETS) {
      expect(checkDialect(d).errors).toEqual([]);
      const { out } = await runBaabel(code, '', d);
      expect(out.startsWith('1\n2\nFizz\n')).toBe(true);
    }
  });

  it('detects ambiguous dialects', () => {
    const d = { name: 'bad', tokens: { '>': 'a', '<': 'b', '+': 'ab', '-': 'c', '.': 'd', ',': 'e', '[': 'f', ']': 'g' } };
    const check = checkDialect(d);
    expect(check.errors).toEqual([]);
    expect(check.needsSeparator).toBe(true);
    const clash = { name: 'x', tokens: { '>': 'a', '<': 'a', '+': 'b', '-': 'c', '.': 'd', ',': 'e', '[': 'f', ']': 'g' } };
    expect(checkDialect(clash).errors.length).toBeGreaterThan(0);
  });

  it('translates between dialects', () => {
    const bf = compileJs('console.log("hi");').bf;
    const sheep = translate(bf, PRESETS[1], PRESETS[0]);
    const back = translate(sheep, PRESETS[0], PRESETS[1]);
    expect(back.replace(/\s/g, '')).toBe(bf);
  });

  it('treats unknown text as comments', () => {
    const r = meemeToWasm('これはコメント メェメェ ←メェここも', PRESETS[0]);
    expect(r.bf).toBe('++<');
  });
});

describe('wasm', () => {
  it('disassembles generated modules', async () => {
    const { back } = await runBaabel('console.log("A");');
    const { text } = disassemble(back.wasm);
    expect(text).toContain('(import "env" "putc"');
    expect(text).toContain('call 0');
  });

  it('reports unbalanced loops', () => {
    expect(() => meemeToWasm('群れ メェ', PRESETS[0])).toThrow(/閉じられていない/);
    expect(() => meemeToWasm('解散', PRESETS[0])).toThrow(/ループ開始のない/);
  });

  it('traps when the head leaves the tape', async () => {
    const back = meemeToWasm('←メェ メェ', PRESETS[0]);
    await expect(execWasm(back.wasm, new Uint8Array(), () => {})).rejects.toThrow();
  });
});
