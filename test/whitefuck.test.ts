import { describe, expect, it } from 'vitest';
import { PRESETS, Lexer, serialize, translate } from '../src/compiler/dialect';
import { buildCompiler } from '../src/compiler/compilergen';
import { jsToMeeme, meemeToWasm } from '../src/compiler/pipeline';
import { execWasm } from '../src/runtime/exec';

const WF = PRESETS.find((d) => d.id === 'whitefuck')!;
const BF = PRESETS.find((d) => d.id === 'bf')!;

// Table from https://github.com/sevenc-nanashi/whitefuck (s = space, t = tab, one command per line)
const TABLE: Record<string, string> = { '+': 'ss', '-': 'st', '>': 'ts', '<': 'tt', '.': 'sss', ',': 'sst', '[': 'sts', ']': 'stt' };
const ws = (code: string) => code.replace(/s/g, ' ').replace(/t/g, '\t');

async function run(wasm: Uint8Array) {
  const out: number[] = [];
  await execWasm(wasm, new Uint8Array(), (c) => out.push(...c));
  return new TextDecoder().decode(Uint8Array.from(out));
}

describe('Whitefuck', () => {
  it('uses the original command table', () => {
    for (const [op, code] of Object.entries(TABLE)) expect(WF.tokens[op as keyof typeof WF.tokens]).toBe(ws(code));
  });

  it('serializes like the original convert(): every command followed by a newline', () => {
    expect(serialize('+[-].', WF, false)).toBe(['ss', 'sts', 'st', 'stt', 'sss'].map((c) => ws(c) + '\n').join(''));
  });

  it('matches whole lines only; other lines are comments; CRLF is accepted', () => {
    const src = ['ss', 'ss x', 'sssss', '', 'this is a comment', 'sss'].map(ws).join('\r\n');
    // "ss x" and "sssss" are not commands (no partial matches inside a line)
    expect(new Lexer(WF).lex(src).ops).toBe('+.');
  });

  it('round-trips a compiled program and runs through both compilers', async () => {
    const { meeme, bf } = jsToMeeme('console.log("Baa!");', WF);
    expect(new Lexer(WF).lex(meeme).ops).toBe(bf);
    expect(translate(meeme, WF, BF).replace(/\s/g, '')).toBe(bf);
    expect(await run(meemeToWasm(meeme, WF).wasm)).toBe('Baa!\n');
    const gen = await buildCompiler(WF);
    expect(await run(gen.compile(meeme).wasm)).toBe('Baa!\n');
    expect(await run(gen.compile(meeme.replace(/\n/g, '\r\n')).wasm)).toBe('Baa!\n');
  });

  it('generated compiler agrees with the JS lexer on comments and odd lines', async () => {
    const gen = await buildCompiler(WF);
    const lines = [...Array(65)].map(() => 'ss').concat(['ss x', 'sssss', 'hello', '', 'sss']);
    const src = lines.map(ws).join('\n');
    expect(gen.compile(src).ops).toBe(new Lexer(WF).lex(src).ops.length);
    expect(await run(gen.compile(src).wasm)).toBe('A');
  });

  it('reports bracket errors at the right line', async () => {
    const gen = await buildCompiler(WF);
    const src = ['ss', 'stt'].map(ws).join('\n');
    expect(() => gen.compile(src)).toThrow();
    expect(() => meemeToWasm(src, WF)).toThrow();
  });
});
