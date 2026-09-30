// Instantiate and run a compiled program. Shared by the Web Worker and tests.

import { t } from '../i18n';

export const OUTPUT_LIMIT = 1 << 20; // 1 MiB

export interface ExecResult {
  instantiateMs: number;
  runMs: number;
  ptr: number;
  /** First cells of the tape after execution. */
  tape: Uint8Array;
}

export class ExecError extends Error {}

export function friendlyTrap(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/out of bounds/i.test(msg)) return t('rt.outOfBounds');
  return msg;
}

export async function execWasm(bytes: Uint8Array, input: Uint8Array, onOutput: (chunk: Uint8Array) => void, tapeCells = 256): Promise<ExecResult> {
  let inPos = 0;
  let total = 0;
  let buf: number[] = [];
  let last = performance.now();
  const flush = () => {
    if (buf.length) onOutput(Uint8Array.from(buf));
    buf = [];
    last = performance.now();
  };
  const env = {
    putc(c: number) {
      buf.push(c & 0xff);
      if (++total > OUTPUT_LIMIT) {
        flush();
        throw new ExecError(t('rt.outputLimit'));
      }
      if (buf.length >= 4096 || performance.now() - last > 50) flush();
    },
    getc() {
      return inPos < input.length ? input[inPos++] : 0; // EOF → 0
    },
  };
  const t0 = performance.now();
  const { instance } = await WebAssembly.instantiate(bytes as BufferSource, { env });
  const t1 = performance.now();
  const run = instance.exports.run as () => number;
  const memory = instance.exports.tape as WebAssembly.Memory;
  let ptr: number;
  try {
    ptr = run();
  } finally {
    flush();
  }
  const t2 = performance.now();
  return {
    instantiateMs: t1 - t0,
    runMs: t2 - t1,
    ptr,
    tape: new Uint8Array(memory.buffer, 0, tapeCells).slice(),
  };
}
