// A small WebAssembly disassembler: turns the actual bytes back into WAT so
// what you read is what runs. Covers the MVP opcodes used by Baabel's
// generators (control flow, locals, i32 arithmetic, memory access, calls).

type Imm = 'none' | 'blocktype' | 'idx' | 'memarg' | 'i32' | 'brtable';

const OPS: Record<number, [string, Imm]> = {
  0x00: ['unreachable', 'none'],
  0x01: ['nop', 'none'],
  0x02: ['block', 'blocktype'],
  0x03: ['loop', 'blocktype'],
  0x04: ['if', 'blocktype'],
  0x05: ['else', 'none'],
  0x0b: ['end', 'none'],
  0x0c: ['br', 'idx'],
  0x0d: ['br_if', 'idx'],
  0x0e: ['br_table', 'brtable'],
  0x0f: ['return', 'none'],
  0x10: ['call', 'idx'],
  0x1a: ['drop', 'none'],
  0x1b: ['select', 'none'],
  0x20: ['local.get', 'idx'],
  0x21: ['local.set', 'idx'],
  0x22: ['local.tee', 'idx'],
  0x23: ['global.get', 'idx'],
  0x24: ['global.set', 'idx'],
  0x28: ['i32.load', 'memarg'],
  0x2d: ['i32.load8_u', 'memarg'],
  0x2c: ['i32.load8_s', 'memarg'],
  0x36: ['i32.store', 'memarg'],
  0x3a: ['i32.store8', 'memarg'],
  0x3f: ['memory.size', 'idx'],
  0x40: ['memory.grow', 'idx'],
  0x41: ['i32.const', 'i32'],
  0x45: ['i32.eqz', 'none'],
  0x46: ['i32.eq', 'none'],
  0x47: ['i32.ne', 'none'],
  0x48: ['i32.lt_s', 'none'],
  0x49: ['i32.lt_u', 'none'],
  0x4a: ['i32.gt_s', 'none'],
  0x4b: ['i32.gt_u', 'none'],
  0x4c: ['i32.le_s', 'none'],
  0x4d: ['i32.le_u', 'none'],
  0x4e: ['i32.ge_s', 'none'],
  0x4f: ['i32.ge_u', 'none'],
  0x6a: ['i32.add', 'none'],
  0x6b: ['i32.sub', 'none'],
  0x6c: ['i32.mul', 'none'],
  0x6d: ['i32.div_s', 'none'],
  0x6e: ['i32.div_u', 'none'],
  0x70: ['i32.rem_u', 'none'],
  0x71: ['i32.and', 'none'],
  0x72: ['i32.or', 'none'],
  0x73: ['i32.xor', 'none'],
  0x74: ['i32.shl', 'none'],
  0x75: ['i32.shr_s', 'none'],
  0x76: ['i32.shr_u', 'none'],
};

class Reader {
  constructor(
    public b: Uint8Array,
    public i = 0,
  ) {}
  u8() {
    return this.b[this.i++];
  }
  uleb() {
    let r = 0;
    let shift = 0;
    for (;;) {
      const x = this.b[this.i++];
      r |= (x & 0x7f) << shift;
      if (!(x & 0x80)) return r >>> 0;
      shift += 7;
    }
  }
  sleb() {
    let r = 0;
    let shift = 0;
    let x: number;
    do {
      x = this.b[this.i++];
      r |= (x & 0x7f) << shift;
      shift += 7;
    } while (x & 0x80);
    if (shift < 32 && x & 0x40) r |= -1 << shift;
    return r | 0;
  }
  name() {
    const n = this.uleb();
    const s = new TextDecoder().decode(this.b.subarray(this.i, this.i + n));
    this.i += n;
    return s;
  }
}

const VALTYPE: Record<number, string> = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64' };
const KIND = ['func', 'table', 'memory', 'global'];

export function disassemble(bytes: Uint8Array, maxLines = 20000): { text: string; truncated: boolean } {
  const r = new Reader(bytes, 8);
  const lines: string[] = ['(module'];
  const types: string[] = [];
  const funcTypes: number[] = [];
  let importedFuncs = 0;
  let truncated = false;
  const exportNames = new Map<number, string>();

  while (r.i < bytes.length) {
    const id = r.u8();
    const size = r.uleb();
    const end = r.i + size;
    switch (id) {
      case 1: {
        const n = r.uleb();
        for (let k = 0; k < n; k++) {
          r.u8(); // 0x60
          const params = Array.from({ length: r.uleb() }, () => VALTYPE[r.u8()]);
          const results = Array.from({ length: r.uleb() }, () => VALTYPE[r.u8()]);
          const sig = `${params.length ? ` (param ${params.join(' ')})` : ''}${results.length ? ` (result ${results.join(' ')})` : ''}`;
          types.push(sig);
          lines.push(`  (type (;${k};) (func${sig}))`);
        }
        break;
      }
      case 2: {
        const n = r.uleb();
        for (let k = 0; k < n; k++) {
          const mod = r.name();
          const nm = r.name();
          const kind = r.u8();
          if (kind === 0) {
            const t = r.uleb();
            lines.push(`  (import "${mod}" "${nm}" (func $${nm} (;${importedFuncs};) (type ${t})))`);
            funcTypes.push(t);
            importedFuncs++;
          } else {
            lines.push(`  (import "${mod}" "${nm}" (${KIND[kind]}))`);
            r.i = end;
            break;
          }
        }
        break;
      }
      case 3: {
        const n = r.uleb();
        for (let k = 0; k < n; k++) funcTypes.push(r.uleb());
        break;
      }
      case 5: {
        const n = r.uleb();
        for (let k = 0; k < n; k++) {
          const flag = r.u8();
          const min = r.uleb();
          const max = flag & 1 ? ` ${r.uleb()}` : '';
          lines.push(`  (memory (;${k};) ${min}${max})`);
        }
        break;
      }
      case 7: {
        const n = r.uleb();
        for (let k = 0; k < n; k++) {
          const nm = r.name();
          const kind = r.u8();
          const idx = r.uleb();
          if (kind === 0) exportNames.set(idx, nm);
          lines.push(`  (export "${nm}" (${KIND[kind]} ${idx}))`);
        }
        break;
      }
      case 10: {
        const n = r.uleb();
        for (let k = 0; k < n; k++) {
          const fidx = importedFuncs + k;
          const bodySize = r.uleb();
          const bodyEnd = r.i + bodySize;
          const locals: string[] = [];
          const ln = r.uleb();
          for (let j = 0; j < ln; j++) {
            const count = r.uleb();
            const t = VALTYPE[r.u8()];
            for (let c = 0; c < count; c++) locals.push(t);
          }
          const name = exportNames.get(fidx);
          lines.push(`  (func ${name ? `$${name} ` : ''}(;${fidx};) (type ${funcTypes[fidx]})${types[funcTypes[fidx]] ?? ''}`);
          if (locals.length) lines.push(`    (local ${locals.join(' ')})`);
          let depth = 2;
          while (r.i < bodyEnd) {
            if (lines.length >= maxLines) {
              truncated = true;
              r.i = bodyEnd;
              break;
            }
            const at = r.i;
            const opc = r.u8();
            const info = OPS[opc];
            if (!info) {
              lines.push(`${'  '.repeat(depth)};; unknown opcode 0x${opc.toString(16)} at ${at}`);
              r.i = bodyEnd;
              break;
            }
            const [nm, imm] = info;
            let arg = '';
            if (imm === 'blocktype') {
              const bt = r.u8();
              arg = bt === 0x40 ? '' : ` (result ${VALTYPE[bt]})`;
            } else if (imm === 'idx') arg = ` ${r.uleb()}`;
            else if (imm === 'i32') arg = ` ${r.sleb()}`;
            else if (imm === 'memarg') {
              r.uleb(); // align
              const off = r.uleb();
              arg = off ? ` offset=${off}` : '';
            } else if (imm === 'brtable') {
              const cnt = r.uleb();
              const targets = Array.from({ length: cnt + 1 }, () => r.uleb());
              arg = ` ${targets.join(' ')}`;
            }
            if (nm === 'call') {
              const target = Number(arg);
              arg += ` (;$${exportNames.get(target) ?? (target === 0 ? 'putc' : target === 1 ? 'getc' : target)};)`;
            }
            if (nm === 'end' || nm === 'else') depth--;
            if (r.i >= bodyEnd && nm === 'end') break; // function end
            lines.push(`${'  '.repeat(depth)}${nm}${arg}`);
            if (nm === 'block' || nm === 'loop' || nm === 'if' || nm === 'else') depth++;
          }
          lines.push('  )');
          r.i = bodyEnd;
        }
        break;
      }
      default:
        r.i = end;
    }
    r.i = end;
  }
  lines.push(')');
  return { text: lines.join('\n'), truncated };
}

export function hexdump(bytes: Uint8Array, maxBytes = 8192): string {
  const out: string[] = [];
  const n = Math.min(bytes.length, maxBytes);
  for (let i = 0; i < n; i += 16) {
    const row = Array.from(bytes.subarray(i, Math.min(i + 16, n)));
    const hex = row.map((b) => b.toString(16).padStart(2, '0')).join(' ');
    const ascii = row.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·')).join('');
    out.push(`${i.toString(16).padStart(6, '0')}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (bytes.length > n) out.push(`… 残り ${bytes.length - n} バイト`);
  return out.join('\n');
}
