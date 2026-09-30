import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare, shareDataFromHash, shareUrl } from '../src/share';
import { PRESETS } from '../src/compiler/dialect';
import { getExamples } from '../src/examples';

describe('share links', () => {
  it('round-trips code, preset dialect and stdin', async () => {
    const ex = getExamples('ja').find((e) => e.id === 'echo')!;
    const state = { js: ex.code, dialect: PRESETS[0], stdin: ex.input! };
    const data = await encodeShare(state);
    expect(data.startsWith('z')).toBe(true);
    expect(await decodeShare(data)).toEqual(state);
  });

  it('round-trips custom and line-mode dialects and a hand-edited middle pane', async () => {
    const custom = { id: 'custom', tokens: { '>': 'a', '<': 'b', '+': 'もこ', '-': 'もこもこ', '.': 'd', ',': 'e', '[': 'f', ']': 'g' } };
    const s1 = { js: 'print(1);', dialect: custom, stdin: '', meeme: 'もこ もこ d\n' };
    expect(await decodeShare(await encodeShare(s1))).toEqual(s1);
    const wf = PRESETS.find((p) => p.id === 'whitefuck')!;
    const s2 = { js: '', dialect: wf, stdin: '', meeme: '  \n   \n' };
    expect(await decodeShare(await encodeShare(s2))).toEqual(s2);
  });

  it('compresses typical programs well', async () => {
    const js = getExamples('ja').find((e) => e.id === 'functions')!.code;
    const data = await encodeShare({ js, dialect: PRESETS[0], stdin: '' });
    // shorter than the same text put in the URL uncompressed (base64 of UTF-8)
    const raw = Math.ceil((new TextEncoder().encode(js).length * 4) / 3);
    expect(data.length).toBeLessThan(raw);
  });

  it('parses the URL hash', () => {
    expect(shareDataFromHash('#s=zAbc_-1')).toBe('zAbc_-1');
    expect(shareDataFromHash('#other')).toBeNull();
    expect(shareUrl('zX', 'https://example.com/app/')).toBe('https://example.com/app/#s=zX');
  });

  it('rejects broken or malicious data', async () => {
    await expect(decodeShare('zNOT*base64')).rejects.toThrow();
    await expect(decodeShare('qAAAA')).rejects.toThrow();
    const bad = btoa(JSON.stringify({ v: 1, j: 'x', d: 'nope' })).replace(/=+$/, '');
    await expect(decodeShare('p' + bad)).rejects.toThrow();
    // decompression bomb: 5 MB of zeros compresses to a few KB
    const bomb = new Uint8Array(await new Response(new Blob([new Uint8Array(5 << 20)]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    let bin = '';
    for (const b of bomb) bin += String.fromCharCode(b);
    await expect(decodeShare('z' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))).rejects.toThrow(/too large/);
  });
});
