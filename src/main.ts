import './style.css';
import type { EditorView } from 'codemirror';
import { EXAMPLES } from './examples';
import { BF_OPS, OP_LABELS, PRESETS, checkDialect, translate, type BfOp, type Dialect } from './compiler/dialect';
import { jsToMeeme, meemeToWasm, MeemeError, type BackResult, type FrontResult } from './compiler/pipeline';
import { CompileError } from './compiler/frontend';
import { disassemble, hexdump } from './compiler/disasm';
import { createJsEditor, createMeemeEditor, markErrorLine, onUserEdit, setDocProgrammatically, setEditorDialect } from './ui/editors';
import type { WorkerMessage, WorkerRequest } from './runtime/worker';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const TIMEOUT_MS = 5000;

// ───────────────────────── persistence (best effort) ─────────────────────────

const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(`baabel:${key}`);
      return v == null ? fallback : (JSON.parse(v) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, v: unknown) {
    try {
      localStorage.setItem(`baabel:${key}`, JSON.stringify(v));
    } catch {
      /* storage unavailable */
    }
  },
};

// ───────────────────────── state ─────────────────────────

let dialect: Dialect = store.get<Dialect>('dialect', PRESETS[0]);
if (checkDialect(dialect).errors.length) dialect = PRESETS[0];
let front: FrontResult | null = null;
let back: BackResult | null = null;
let meemeDirty = false;
let activeTab = 'output';
let worker: Worker | null = null;
let runTimer: number | undefined;

const debounce = <A extends unknown[]>(f: (...a: A) => void, ms: number) => {
  let t: number | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => f(...a), ms);
  };
};

// ───────────────────────── editors ─────────────────────────

const initialExample = EXAMPLES.find((e) => e.id === store.get('example', 'hello')) ?? EXAMPLES[0];
const jsView: EditorView = createJsEditor($('js-editor'), store.get('js', initialExample.code), debounce(onJsChange, 350));
const meemeView: EditorView = createMeemeEditor($('meeme-editor'), debounce(onMeemeChange, 250));
setEditorDialect(meemeView, dialect);
$<HTMLTextAreaElement>('stdin').value = store.get('stdin', initialExample.input ?? '');

onUserEdit(() => setDirty(true));

// ───────────────────────── stage 1: JS → 羊語 ─────────────────────────

function onJsChange(src: string) {
  store.set('js', src);
  compileFront(src);
}

function compileFront(src: string) {
  const status = $('js-status');
  const msgs = $('js-messages');
  msgs.replaceChildren();
  try {
    front = jsToMeeme(src, dialect);
  } catch (e) {
    front = null;
    const line = e instanceof CompileError ? e.line : undefined;
    status.className = 'status err';
    status.textContent = line ? `✗ ${line}行目でエラー` : '✗ エラー';
    msgs.append(el('div', 'error', (line ? `${line}行目: ` : '') + (e as Error).message));
    markErrorLine(jsView, line ?? null);
    renderStats();
    return;
  }
  markErrorLine(jsView, null);
  status.className = 'status ok';
  status.textContent = `✓ ${front.bf.length.toLocaleString()} 命令`;
  for (const w of front.warnings) msgs.append(el('div', 'warn', `⚠ ${w}`));
  setDocProgrammatically(meemeView, front.meeme);
  setDirty(false);
  pulse(0);
  // the meeme editor's change listener triggers stage 2
}

// ───────────────────────── stage 2: 羊語 → Wasm ─────────────────────────

function onMeemeChange(text: string) {
  compileBack(text);
}

function compileBack(text: string) {
  const msgs = $('meeme-messages');
  msgs.replaceChildren();
  try {
    back = meemeToWasm(text, dialect);
  } catch (e) {
    back = null;
    let line: number | null = null;
    if (e instanceof MeemeError && e.offset != null) line = meemeView.state.doc.lineAt(e.offset).number;
    msgs.append(el('div', 'error', (line ? `${line}行目: ` : '') + (e as Error).message));
    markErrorLine(meemeView, line);
    setRunStatus('err', '✗ コンパイルできません');
    renderStats();
    return;
  }
  markErrorLine(meemeView, null);
  pulse(1);
  renderArtifacts();
  renderStats();
  if ($<HTMLInputElement>('autorun').checked) run();
}

function setDirty(d: boolean) {
  meemeDirty = d;
  const badge = $('meeme-badge');
  badge.textContent = d ? '手で編集中' : 'JSから生成';
  badge.title = d ? '中央のテキストを直接書き換えています。実行されるのはこのテキストです（左の JS とは別物になっています）' : '左の JavaScript からコンパイルされたテキストです';
  badge.classList.toggle('dirty', d);
  $('regen').hidden = !d;
  renderStats();
}

// ───────────────────────── stage 3: run ─────────────────────────

const decoder = { current: new TextDecoder() };

function run() {
  if (!back) return;
  stopWorker();
  const out = $('output');
  out.replaceChildren();
  decoder.current = new TextDecoder();
  const input = new TextEncoder().encode($<HTMLTextAreaElement>('stdin').value);
  setRunStatus('', '実行中…');
  const runBtn = $('run');
  runBtn.textContent = '■ 停止';
  runBtn.classList.add('running');

  worker = new Worker(new URL('./runtime/worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
    const m = e.data;
    if (m.type === 'out') {
      out.append(document.createTextNode(decoder.current.decode(m.bytes, { stream: true })));
      out.scrollTop = out.scrollHeight;
      return;
    }
    const tail = decoder.current.decode();
    if (tail) out.append(tail);
    finish();
    if (m.type === 'done') {
      lastRun = { runMs: m.runMs, instantiateMs: m.instantiateMs };
      setRunStatus('ok', `✓ 終了（${fmtMs(m.runMs)}）`);
      renderTape(m.tape, m.ptr);
      bounce();
    } else {
      out.append(el('div', 'sys err', `\n✗ 実行時エラー: ${m.message}`));
      setRunStatus('err', '✗ 実行時エラー');
    }
    renderStats();
  };
  worker.onerror = (e) => {
    finish();
    out.append(el('div', 'sys err', `\n✗ ${e.message}`));
    setRunStatus('err', '✗ エラー');
  };
  const req: WorkerRequest = { wasm: back.wasm, input };
  worker.postMessage(req);
  runTimer = window.setTimeout(() => {
    stopWorker();
    out.append(el('div', 'sys err', `\n⏱ ${TIMEOUT_MS / 1000} 秒経っても終わらないので停止しました（無限ループかも？）`));
    setRunStatus('err', '⏱ タイムアウト');
    lastRun = null;
    renderStats();
  }, TIMEOUT_MS);
}

let lastRun: { runMs: number; instantiateMs: number } | null = null;

function finish() {
  clearTimeout(runTimer);
  worker?.terminate();
  worker = null;
  const runBtn = $('run');
  runBtn.textContent = '▶ 実行';
  runBtn.classList.remove('running');
}

function stopWorker() {
  if (!worker) return;
  finish();
}

function setRunStatus(kind: '' | 'ok' | 'err', text: string) {
  const s = $('run-status');
  s.className = `status ${kind}`;
  s.textContent = text;
}

// ───────────────────────── views ─────────────────────────

function renderArtifacts() {
  if (!back) return;
  if (activeTab === 'wat') {
    const { text, truncated } = disassemble(back.wasm);
    $('wat').textContent = text + (truncated ? '\n;; …長いので省略しました' : '');
  }
  if (activeTab === 'hex') $('hex').textContent = hexdump(back.wasm);
}

function renderTape(tape: Uint8Array, ptr: number) {
  const box = $('tape');
  box.replaceChildren();
  let last = 0;
  for (let i = 0; i < tape.length; i++) if (tape[i]) last = i;
  const n = Math.max(32, Math.min(tape.length, Math.ceil((Math.max(last, ptr) + 1) / 8) * 8));
  box.append(el('p', '', `実行後のテープ（先頭 ${n} セル）。枠が光っているのが最終的なポインタ位置 ${ptr} です。`));
  const grid = el('div', 'tape-grid');
  for (let i = 0; i < n; i++) {
    const c = el('div', `cell${tape[i] ? ' nz' : ''}${i === ptr ? ' ptr' : ''}`, String(tape[i]));
    c.append(el('small', '', `#${i}`));
    grid.append(c);
  }
  box.append(grid);
}

function renderStats() {
  const s = $('stats');
  s.replaceChildren();
  const add = (label: string, value: string) => {
    const d = el('span', 'stat', `${label} `);
    d.append(el('b', '', value));
    s.append(d);
  };
  if (front) add('JS → 羊語', fmtMs(front.ms));
  if (back) {
    add('羊語 → Wasm', fmtMs(back.lexMs + back.optMs + back.emitMs));
    add('羊語', `${meemeView.state.doc.length.toLocaleString()} 文字`);
    add('BF命令', `${back.rawOps.toLocaleString()} → 最適化後 ${back.irOps.toLocaleString()}`);
    add('Wasm', `${back.wasm.length.toLocaleString()} bytes`);
    if (back.commentChars) add('コメント扱い', `${back.commentChars} 文字`);
  }
  if (lastRun) add('実行', fmtMs(lastRun.runMs));
  if (front && !meemeDirty) add('使用セル', `${front.cells}`);
}

function renderLegend() {
  const box = $('legend');
  box.replaceChildren();
  const cls: Record<BfOp, string> = { '>': 'tk-move', '<': 'tk-move', '+': 'tk-add', '-': 'tk-sub', '.': 'tk-io', ',': 'tk-io', '[': 'tk-loop', ']': 'tk-loop' };
  for (const op of BF_OPS) {
    const chip = el('span', 'chip');
    chip.title = OP_LABELS[op];
    chip.append(el('span', cls[op], dialect.tokens[op]), el('code', '', op));
    box.append(chip);
  }
  $('meeme-title').textContent = dialect.name;
  $('tagline-dialect').textContent = dialect.name;
}

// ───────────────────────── dialects ─────────────────────────

function allDialects(): Dialect[] {
  const custom = store.get<Dialect | null>('custom', null);
  return custom ? [...PRESETS, custom] : PRESETS;
}

function fillDialectSelect() {
  const sel = $<HTMLSelectElement>('dialect-select');
  sel.replaceChildren();
  for (const d of allDialects()) {
    const o = new Option(d.name, d.name);
    sel.append(o);
  }
  sel.value = dialect.name;
}

function applyDialect(next: Dialect) {
  const prev = dialect;
  dialect = next;
  store.set('dialect', next);
  setEditorDialect(meemeView, next);
  renderLegend();
  fillDialectSelect();
  // Translate what is in the middle pane, so hand edits survive.
  const text = translate(meemeView.state.doc.toString(), prev, next);
  const wasDirty = meemeDirty;
  setDocProgrammatically(meemeView, text);
  if (front) front = { ...front, meeme: text };
  setDirty(wasDirty);
}

function openDialectEditor() {
  const dlg = $<HTMLDialogElement>('dialect-dialog');
  const grid = $('token-grid');
  const presets = $('preset-row');
  const inputs = {} as Record<BfOp, HTMLInputElement>;
  grid.replaceChildren();
  for (const op of BF_OPS) {
    const label = el('label');
    const input = document.createElement('input');
    input.value = dialect.tokens[op];
    input.spellcheck = false;
    input.addEventListener('input', validate);
    inputs[op] = input;
    label.append(el('code', '', op), el('span', '', OP_LABELS[op]), input);
    grid.append(label);
  }
  presets.replaceChildren(el('span', 'hint', 'プリセット:'));
  for (const p of PRESETS) {
    const b = el('button', 'btn tiny', p.name) as HTMLButtonElement;
    b.type = 'button';
    b.onclick = () => {
      for (const op of BF_OPS) inputs[op].value = p.tokens[op];
      validate();
    };
    presets.append(b);
  }
  const current = (): Dialect => {
    const tokens = {} as Record<BfOp, string>;
    for (const op of BF_OPS) tokens[op] = inputs[op].value;
    const preset = PRESETS.find((p) => BF_OPS.every((op) => p.tokens[op] === tokens[op]));
    return { name: preset?.name ?? 'カスタム', tokens };
  };
  function validate() {
    const errs = $('dialect-errors');
    errs.replaceChildren();
    const check = checkDialect(current());
    for (const op of BF_OPS) inputs[op].classList.toggle('bad', !inputs[op].value.trim());
    for (const e of check.errors) errs.append(el('div', 'error', `✗ ${e}`));
    if (!check.errors.length && check.needsSeparator) errs.append(el('div', 'warn', '⚠ 命令をつなげて書くと区別できない組み合わせがあるので、命令の間に空白を入れて表示します'));
    $<HTMLButtonElement>('dialect-apply').disabled = check.errors.length > 0;
  }
  validate();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'apply') return;
    const d = current();
    if (d.name === 'カスタム') store.set('custom', d);
    applyDialect(d);
  };
  dlg.showModal();
}

// ───────────────────────── wiring ─────────────────────────

function fillExamples() {
  const sel = $<HTMLSelectElement>('example-select');
  sel.append(new Option('— 選んでください —', ''));
  for (const ex of EXAMPLES) sel.append(new Option(ex.title, ex.id));
  sel.onchange = () => {
    const ex = EXAMPLES.find((e) => e.id === sel.value);
    if (!ex) return;
    store.set('example', ex.id);
    $<HTMLTextAreaElement>('stdin').value = ex.input ?? '';
    store.set('stdin', ex.input ?? '');
    jsView.dispatch({ changes: { from: 0, to: jsView.state.doc.length, insert: ex.code } });
    sel.value = '';
  };
}

$<HTMLSelectElement>('dialect-select').onchange = (e) => {
  const d = allDialects().find((x) => x.name === (e.target as HTMLSelectElement).value);
  if (d) applyDialect(d);
};
$('dialect-edit').onclick = openDialectEditor;
$('run').onclick = () => (worker ? (stopWorker(), setRunStatus('err', '■ 停止しました')) : run());
$('regen').onclick = () => compileFront(jsView.state.doc.toString());
$<HTMLTextAreaElement>('stdin').addEventListener(
  'input',
  debounce(() => {
    store.set('stdin', $<HTMLTextAreaElement>('stdin').value);
    if ($<HTMLInputElement>('autorun').checked) run();
  }, 400),
);
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
  tab.onclick = () => {
    activeTab = tab.dataset.tab!;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll<HTMLElement>('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === activeTab));
    renderArtifacts();
  };
});
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    run();
  }
});

// ───────────────────────── helpers ─────────────────────────

function el(tag: string, cls = '', text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function fmtMs(ms: number) {
  return ms < 1 ? `${(ms * 1000).toFixed(0)} µs` : `${ms.toFixed(ms < 10 ? 2 : 1)} ms`;
}

function pulse(i: number) {
  const arrow = document.querySelectorAll('.arrow')[i];
  arrow?.classList.add('pulse');
  setTimeout(() => arrow?.classList.remove('pulse'), 400);
}

function bounce() {
  const logo = document.querySelector('.logo');
  logo?.classList.remove('bounce');
  void (logo as HTMLElement | null)?.offsetWidth;
  logo?.classList.add('bounce');
}

// ───────────────────────── boot ─────────────────────────

fillExamples();
fillDialectSelect();
renderLegend();
compileFront(jsView.state.doc.toString());
