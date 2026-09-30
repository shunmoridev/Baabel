// Records the promo video described in promo/SCENARIO.md.
//
//   npm run promo          → promo/out/baabel-promo-ja.mp4
//   npm run promo -- en    → promo/out/baabel-promo-en.mp4
//
// Serves the production build with `vite preview`, drives it with Playwright,
// captures frames with the Chrome DevTools screencast (at device resolution,
// unlike Playwright's recordVideo) and encodes them to H.264 with ffmpeg
// (must be on PATH).
// Captions, the fake cursor and the title/end cards are injected into the page
// only for the recording; the app itself is untouched.

import { chromium } from 'playwright-core';
import { preview } from 'vite';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const lang = process.argv[2] === 'en' ? 'en' : 'ja';
const OUT_DIR = resolve('promo/out');
// Chrome's screencast delivers frames in CSS pixels, so instead of a device
// scale factor the page is rendered at 1920×1080 with CSS zoom 1.5: the UI is
// laid out like a 1280×720 window but drawn at full resolution.
const VIEW = { width: 1920, height: 1080 };
const ZOOM = 1.5;

const TEXT = {
  ja: {
    title: 'JavaScript → 羊語 → WebAssembly',
    type: 'JavaScript を書くと…',
    compiled: '羊語にコンパイルされて、WebAssembly で動く',
    real: '羊語はただの飾りじゃない。これが実行されるソース',
    shift: '「メェ」を 1 つ足すと、全部 1 文字ずれる 🐑',
    fizz: 'FizzBuzz も羊語で動く',
    dialects: '命令セットは自由に変えられる',
    regen: '変えるたびに、専用コンパイラ（.wasm）をその場で生成',
    compiler: 'コンパイラ自体も WebAssembly。Wasm が Wasm を書き出す',
    endSub: 'ブラウザだけで動きます',
  },
  en: {
    title: 'JavaScript → Sheep → WebAssembly',
    type: 'Write JavaScript…',
    compiled: '…it compiles to sheep, and runs as WebAssembly',
    real: 'The sheep is not decoration. It is the source that runs',
    shift: 'Add one “メェ” and every character shifts by one 🐑',
    fizz: 'FizzBuzz runs in sheep too',
    dialects: 'Swap the instruction set freely',
    regen: 'Each one gets its own compiler (.wasm), generated on the spot',
    compiler: 'The compiler is WebAssembly too: Wasm writing Wasm',
    endSub: 'Runs entirely in your browser',
  },
}[lang];

// ───────────────────────── overlay (captions, cursor, cards) ─────────────────────────

function installOverlay({ title, endSub }) {
  const css = `
    #promo-caption { position: fixed; left: 50%; bottom: 58px; transform: translateX(-50%) translateY(12px);
      white-space: nowrap; padding: 12px 26px; border-radius: 16px; background: rgba(22, 21, 26, 0.88); color: #fff;
      font: 800 26px/1.4 'M PLUS Rounded 1c', system-ui, sans-serif; text-align: center; opacity: 0;
      transition: opacity .35s, transform .35s; z-index: 99999; pointer-events: none; box-shadow: 0 10px 30px rgba(0,0,0,.35); }
    #promo-caption.on { opacity: 1; transform: translateX(-50%) translateY(0); }
    #promo-cursor { position: fixed; left: 0; top: 0; width: 26px; height: 26px; z-index: 100000; pointer-events: none;
      transition: left .45s cubic-bezier(.3,.7,.2,1), top .45s cubic-bezier(.3,.7,.2,1); }
    #promo-cursor svg { filter: drop-shadow(0 2px 3px rgba(0,0,0,.45)); }
    .promo-ripple { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
      border: 3px solid #ffcf6b; z-index: 99998; pointer-events: none; animation: promo-ripple .55s ease-out forwards; }
    @keyframes promo-ripple { from { transform: scale(.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }
    .promo-card { position: fixed; inset: 0; z-index: 100001; display: grid; place-items: center; text-align: center;
      background: radial-gradient(circle at 50% 40%, #2a2733, #121116); color: #f3d9a4; transition: opacity .6s; }
    .promo-card .sheep { font-size: 120px; line-height: 1; }
    .promo-card h1 { font: 800 76px/1.1 'M PLUS Rounded 1c', system-ui, sans-serif; margin: 14px 0 8px; color: #f3d9a4; }
    .promo-card p { font: 800 28px/1.5 'M PLUS Rounded 1c', system-ui, sans-serif; margin: 0; color: #ece8df; }
    .promo-card small { display: block; margin-top: 22px; font: 600 22px/1.4 'JetBrains Mono', monospace; color: #aaa498; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.append(style);

  const caption = Object.assign(document.createElement('div'), { id: 'promo-caption' });
  const cursor = Object.assign(document.createElement('div'), { id: 'promo-cursor' });
  cursor.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M4 2l16 9.5-7 1.6L9.6 20z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  // everything inside the zoomed page is in zoomed units: convert viewport px
  const Z = parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
  cursor.style.left = `${960 / Z}px`;
  cursor.style.top = `${630 / Z}px`;
  document.body.append(caption, cursor);

  const card = (sub, extra) => {
    const el = document.createElement('div');
    el.className = 'promo-card';
    el.innerHTML = `<div><div class="sheep">🐑</div><h1>Baabel</h1><p></p>${extra ? '<small></small>' : ''}</div>`;
    el.querySelector('p').textContent = sub;
    if (extra) el.querySelector('small').textContent = extra;
    document.body.append(el);
    return el;
  };

  window.__promo = {
    caption(text) {
      if (!text) return caption.classList.remove('on');
      caption.classList.remove('on');
      setTimeout(() => {
        caption.textContent = text;
        caption.classList.add('on');
      }, caption.textContent ? 180 : 0);
    },
    cursor(x, y) {
      cursor.style.left = `${(x - 6) / Z}px`;
      cursor.style.top = `${(y - 3) / Z}px`;
    },
    ripple(x, y) {
      const r = Object.assign(document.createElement('div'), { className: 'promo-ripple' });
      r.style.left = `${x / Z}px`;
      r.style.top = `${y / Z}px`;
      document.body.append(r);
      setTimeout(() => r.remove(), 700);
    },
    titleCard() {
      const el = card(title);
      return () => {
        el.style.opacity = '0';
        setTimeout(() => el.remove(), 700);
      };
    },
    endCard() {
      const el = card(endSub, 'github.com/shunmoridev/Baabel');
      el.style.opacity = '0';
      requestAnimationFrame(() => (el.style.opacity = '1'));
    },
  };
}

// ───────────────────────── recording ─────────────────────────

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const frameDir = mkdtempSync(join(tmpdir(), 'baabel-promo-'));
  const server = await preview({ preview: { port: 4179, strictPort: false }, logLevel: 'warn' });
  const url = server.resolvedUrls.local[0];

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEW,
    colorScheme: 'dark',
    locale: lang === 'ja' ? 'ja-JP' : 'en-US',
  });
  await context.addInitScript(
    ({ l, zoom }) => {
      localStorage.setItem('baabel:locale', JSON.stringify(l));
      localStorage.setItem('baabel:mode', JSON.stringify('gen'));
      document.addEventListener('DOMContentLoaded', () => {
        document.documentElement.style.zoom = String(zoom);
        // viewport units are zoomed too: keep the panes inside the window
        const st = document.createElement('style');
        st.textContent = `
          html, body { overflow: hidden !important; }
          body { min-height: calc(100vh / ${zoom}) !important; height: calc(100vh / ${zoom}); }
          .panes { height: auto !important; flex: 1; min-height: 0; }`;
        document.head.append(st);
      });
    },
    { l: lang, zoom: ZOOM },
  );

  const page = await context.newPage();

  // Screencast: Chrome sends a frame whenever the page repaints.
  const cdp = await context.newCDPSession(page);
  const frames = []; // { file, t }
  let capturing = false;
  cdp.on('Page.screencastFrame', async (f) => {
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
    if (!capturing) return;
    const file = join(frameDir, `${String(frames.length).padStart(6, '0')}.jpg`);
    writeFileSync(file, Buffer.from(f.data, 'base64'));
    frames.push({ file, t: f.metadata.timestamp });
  });
  const startCapture = async () => {
    capturing = true;
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: VIEW.width, maxHeight: VIEW.height, everyNthFrame: 1 });
  };
  const sleep = (ms) => page.waitForTimeout(ms);
  const say = (text) => page.evaluate((t) => window.__promo.caption(t), text);

  let cur = { x: 960, y: 630 };
  async function cursorTo(x, y) {
    await page.evaluate(({ x, y }) => window.__promo.cursor(x, y), { x, y });
    await page.mouse.move(x, y, { steps: 10 });
    cur = { x, y };
    await sleep(480);
  }
  async function center(locator) {
    const b = await locator.boundingBox();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  async function ripple() {
    await page.evaluate(({ x, y }) => window.__promo.ripple(x, y), cur);
  }
  async function choose(selectId, value) {
    const sel = page.locator(`#${selectId}`);
    const c = await center(sel);
    await cursorTo(c.x, c.y);
    await ripple();
    await sel.selectOption(value);
  }
  const output = page.locator('#output');

  await page.goto(url);
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.querySelector('#output')?.textContent.length > 0);
  await page.evaluate(installOverlay, { title: TEXT.title, endSub: TEXT.endSub });
  const fit = await page.evaluate(() => ({ doc: document.documentElement.scrollHeight, win: innerHeight }));
  if (fit.doc > fit.win + 1) throw new Error(`page does not fit the window: ${fit.doc} > ${fit.win}`);

  // ── 0. title card ──
  await page.evaluate(() => (window.__hideTitle = window.__promo.titleCard()));
  await startCapture();
  await sleep(1800);
  await page.evaluate(() => window.__hideTitle());
  await sleep(500);

  // ── 1. type JavaScript ──
  await say(TEXT.type);
  const js = page.locator('#js-editor .cm-content');
  const jsBox = await js.boundingBox();
  await cursorTo(jsBox.x + 180, jsBox.y + 60);
  await ripple();
  await js.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await sleep(250);
  await page.keyboard.type('console.log("Hello, World!");', { delay: 70 });
  await page.waitForFunction(() => document.querySelector('#output').textContent.startsWith('Hello, World!'));
  await sleep(400);
  await say(TEXT.compiled);
  await cursorTo(960, 450);
  await sleep(2200);

  // ── 2. edit the sheep: one more メェ before the first output ──
  await say(TEXT.real);
  const firstOut = page.locator('#meeme-editor .tk-io').first();
  const ob = await firstOut.boundingBox();
  await cursorTo(ob.x + 3, ob.y + ob.height / 2);
  await sleep(900);
  await ripple();
  await page.mouse.click(ob.x + 1, ob.y + ob.height / 2);
  await sleep(300);
  await say(TEXT.shift);
  await page.keyboard.type('メェ', { delay: 220 });
  await page.waitForFunction(() => document.querySelector('#output').textContent.startsWith('Ifmmp'));
  await cursorTo(1590, 375);
  await sleep(2600);

  // ── 3. FizzBuzz ──
  await say(TEXT.fizz);
  await choose('example-select', 'fizzbuzz');
  await page.waitForFunction(() => document.querySelector('#output').textContent.includes('FizzBuzz'));
  await cursorTo(1620, 630);
  await page.evaluate(() => {
    const out = document.querySelector('#output');
    out.scrollTo({ top: out.scrollHeight, behavior: 'smooth' });
  });
  await sleep(2800);

  // ── 4. swap instruction sets ──
  await say(TEXT.dialects);
  for (const [i, id] of ['cat', 'emoji', 'brainpower', 'whitefuck'].entries()) {
    if (i === 2) await say(TEXT.regen);
    await choose('dialect-select', id);
    await page.waitForFunction(() => document.querySelector('#output').textContent.includes('FizzBuzz'));
    await sleep(1400);
  }
  await choose('dialect-select', 'sheep');
  await sleep(900);

  // ── 5. the generated compiler ──
  await say(TEXT.compiler);
  const tab = page.locator('[data-tab=compiler]');
  const tc = await center(tab);
  await cursorTo(tc.x, tc.y);
  await ripple();
  await tab.click();
  await sleep(900);
  await page.evaluate(() => {
    const box = document.querySelector('#compiler');
    const pre = box.querySelector('.wat-inline');
    const at = pre.textContent.indexOf('(func $match');
    const lineHeight = parseFloat(getComputedStyle(pre).lineHeight) || 18;
    const target = pre.offsetTop + pre.textContent.slice(0, at).split('\n').length * lineHeight - 20;
    box.scrollTo({ top: target, behavior: 'smooth' });
  });
  await sleep(3200);

  // ── 6. end card ──
  await say('');
  await page.evaluate(() => window.__promo.endCard());
  await sleep(3200);

  await cdp.send('Page.stopScreencast');
  const endT = Date.now() / 1000;
  await context.close();
  await browser.close();
  await server.close();

  // Each frame is shown until the next one arrives (variable frame rate → 30 fps).
  const posix = (p) => p.replace(/\\/g, '/');
  const list = frames.map((f, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : Math.max(endT, f.t + 0.1);
    return `file '${posix(f.file)}'\nduration ${Math.max(next - f.t, 0.001).toFixed(4)}`;
  });
  list.push(`file '${posix(frames[frames.length - 1].file)}'`);
  const listFile = join(frameDir, 'frames.txt');
  writeFileSync(listFile, list.join('\n') + '\n');

  const out = join(OUT_DIR, `baabel-promo-${lang}.mp4`);
  const poster = join(OUT_DIR, `baabel-promo-${lang}.png`);
  const ff = (args) => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });
  ff(['-f', 'concat', '-safe', '0', '-i', listFile, '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-movflags', '+faststart', out]);
  ff(['-ss', '11', '-i', out, '-frames:v', '1', poster]);
  rmSync(frameDir, { recursive: true, force: true });
  console.log(`frames: ${frames.length}`);
  console.log(`✓ ${out}\n✓ ${poster}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
