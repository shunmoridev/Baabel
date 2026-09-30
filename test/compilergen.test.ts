import { describe, expect, it } from 'vitest';
import { EXAMPLES } from '../src/examples';
import { jsToMeeme, meemeToWasm } from '../src/compiler/pipeline';
import { PRESETS } from '../src/compiler/dialect';
import { buildCompiler, generateCompiler, GeneratedCompileError } from '../src/compiler/compilergen';
import { execWasm } from '../src/runtime/exec';
import { disassemble } from '../src/compiler/disasm';

const enc = new TextEncoder();
const dec = new TextDecoder();

async function run(wasm: Uint8Array, input = '') {
  const chunks: number[] = [];
  await execWasm(wasm, enc.encode(input), (c) => chunks.push(...c));
  return dec.decode(Uint8Array.from(chunks));
}

describe('generated meeme-compiler.wasm', () => {
  it('is a valid module for every preset', () => {
    for (const d of PRESETS) expect(WebAssembly.validate(generateCompiler(d) as BufferSource)).toBe(true);
  });

  for (const d of PRESETS) {
    it(`compiles every example like the JS pipeline (${d.name})`, async () => {
      const compiler = await buildCompiler(d);
      for (const ex of EXAMPLES) {
        const meeme = jsToMeeme(ex.code, d).meeme;
        const ref = meemeToWasm(meeme, d);
        const gen = compiler.compile(meeme);
        expect(WebAssembly.validate(gen.wasm as BufferSource)).toBe(true);
        expect(gen.ops).toBe(ref.rawOps);
        expect(await run(gen.wasm, ex.input)).toBe(await run(ref.wasm, ex.input));
      }
    });
  }

  it('reports bracket errors with source offsets', async () => {
    const c = await buildCompiler(PRESETS[0]);
    try {
      c.compile('メェ\n解散');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(GeneratedCompileError);
      expect((e as GeneratedCompileError).offset).toBe(3);
    }
    expect(() => c.compile('群れ メェ 群れ ベェ 解散')).toThrow(/閉じられていない/);
  });

  it('can be disassembled', () => {
    const { text } = disassemble(generateCompiler(PRESETS[0]), { names: { 0: 'match', 1: 'emit_byte', 2: 'emit_sleb', 3: 'write5' } });
    expect(text).toContain('(func $match');
    expect(text).toContain('(data (i32.const 16)');
  });

  it('handles large inputs (memory growth)', async () => {
    const c = await buildCompiler(PRESETS[1]);
    const src = '+'.repeat(65) + '.' + '>+<'.repeat(40000);
    const out = await run(c.compile(src).wasm);
    expect(out).toBe('A');
  });
});
