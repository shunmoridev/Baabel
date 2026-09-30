// Share links: the whole state is compressed into the URL fragment (#s=…).
// No server is involved, and the fragment is never sent to one.
//
// Format: one version char + base64url payload.
//   'z' → deflate-raw compressed JSON   'p' → plain JSON (no CompressionStream)

import { BF_OPS, checkDialect, normalizeDialect, PRESETS, type BfOp, type Dialect } from './compiler/dialect';

export interface SharedState {
  js: string;
  dialect: Dialect;
  stdin: string;
  /** Present when the middle pane was edited by hand (it is then the source of truth). */
  meeme?: string;
}

interface Payload {
  v: 1;
  j: string;
  /** preset id, or [tokens in BF_OPS order, line mode] */
  d: string | [string[], 0 | 1];
  i?: string;
  m?: string;
}

const MAX_DECODED = 1 << 20; // refuse to inflate more than 1 MiB
export const SHARE_PARAM = 's';

// ───────────────────────── base64url ─────────────────────────

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

// ───────────────────────── compression ─────────────────────────

const canCompress = () => typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(stream).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error('share data too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

// ───────────────────────── encode / decode ─────────────────────────

export async function encodeShare(s: SharedState): Promise<string> {
  const preset = PRESETS.find((p) => p.id === s.dialect.id);
  const payload: Payload = {
    v: 1,
    j: s.js,
    d: preset ? preset.id : [BF_OPS.map((op) => s.dialect.tokens[op]), s.dialect.lines ? 1 : 0],
  };
  if (s.stdin) payload.i = s.stdin;
  if (s.meeme != null) payload.m = s.meeme;
  const json = new TextEncoder().encode(JSON.stringify(payload));
  if (!canCompress()) return 'p' + toBase64Url(json);
  return 'z' + toBase64Url(await pipe(json, new CompressionStream('deflate-raw')));
}

export async function decodeShare(data: string): Promise<SharedState> {
  const kind = data[0];
  const bytes = fromBase64Url(data.slice(1));
  let json: Uint8Array;
  if (kind === 'z') json = await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_DECODED);
  else if (kind === 'p') json = bytes;
  else throw new Error('unknown share format');
  if (json.length > MAX_DECODED) throw new Error('share data too large');

  const p = JSON.parse(new TextDecoder().decode(json)) as Partial<Payload>;
  if (p.v !== 1 || typeof p.j !== 'string') throw new Error('bad share payload');
  let dialect: Dialect | null = null;
  if (typeof p.d === 'string') dialect = PRESETS.find((x) => x.id === p.d) ?? null;
  else if (Array.isArray(p.d) && Array.isArray(p.d[0]) && p.d[0].length === BF_OPS.length && p.d[0].every((t) => typeof t === 'string')) {
    const tokens = Object.fromEntries(BF_OPS.map((op, k) => [op, (p.d as [string[], number])[0][k]])) as Record<BfOp, string>;
    dialect = normalizeDialect({ tokens, lines: p.d[1] === 1 });
  }
  if (!dialect || checkDialect(dialect).errors.length) throw new Error('bad dialect in share payload');
  return {
    js: p.j,
    dialect,
    stdin: typeof p.i === 'string' ? p.i : '',
    ...(typeof p.m === 'string' ? { meeme: p.m } : {}),
  };
}

export function shareUrl(data: string, base: string): string {
  return `${base}#${SHARE_PARAM}=${data}`;
}

/** Extract the share data from a location hash, if any. */
export function shareDataFromHash(hash: string): string | null {
  const m = /^#s=([A-Za-z0-9_-]+)$/.exec(hash);
  return m ? m[1] : null;
}
