import './style.css';
import type { EditorView } from 'codemirror';
import { getExamples, identifyExample } from './examples';
import { BF_OPS, PRESETS, checkDialect, dialectName, normalizeDialect, opLabel, parseWhitespace, showWhitespace, translate, type BfOp, type Dialect } from './compiler/dialect';
import { jsToMeeme, meemeToWasm, MeemeError, type FrontResult } from './compiler/pipeline';
import { buildCompiler, GeneratedCompileError, type GeneratedCompiler } from './compiler/compilergen';
import { CompileError } from './compiler/frontend';
import { disassemble, hexdump } from './compiler/disasm';
import { createJsEditor, createMeemeEditor, markErrorLine, onUserEdit, setDocProgrammatically, setEditorDialect } from './ui/editors';
import type { WorkerMessage, WorkerRequest } from './runtime/worker';
import { LOCALES, detectLocale, getLocale, setLocale, spec, t, type Locale, type MessageKey } from './i18n';

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

const savedLocale = store.get<Locale | null>('locale', null);
setLocale(savedLocale && LOCALES.some((l) => l.id === savedLocale) ? savedLocale : detectLocale(navigator.languages ?? [navigator.language]));

let dialect: Dialect = normalizeDialect(store.get<Partial<Dialect> | null>('dialect', null)) ?? PRESETS[0];
if (checkDialect(dialect).errors.length) dialect = PRESETS[0];
let front: FrontResult | null = null;
/** The program.wasm currently shown/run, and how it was produced. */
interface Built {
  wasm: Uint8Array;
  ops: number;
  irOps: number | null;
  ms: number;
  via: 'gen' | 'js';
}
let built: Built | null = null;
type Mode = 'gen' | 'js';
let mode: Mode = store.get<Mode>('mode', 'gen');
let compilerCache: { dialect: Dialect; promise: Promise<GeneratedCompiler> } | null = null;
let currentCompiler: GeneratedCompiler | null = null;
let backSeq = 0;
let meemeDirty = false;
let activeTab = 'output';
let worker: Worker | null = null;
let runTimer: number | undefined;
let lastRun: { runMs: number; instantiateMs: number } | null = null;

const debounce = <A extends unknown[]>(f: (...a: A) => void, ms: number) => {
  let timer: number | undefined;
  return (...a: A) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => f(...a), ms);
  };
};

// ───────────────────────── editors ─────────────────────────

const initialExample = getExamples(getLocale()).find((e) => e.id === store.get('example', 'hello')) ?? getExamples(getLocale())[0];
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

/** Compile the JS. With `keepMeeme`, only refresh status/messages (used when the middle pane is hand-edited). */
function compileFront(src: string, keepMeeme = false) {
  const status = $('js-status');
  const msgs = $('js-messages');
  msgs.replaceChildren();
  let result: FrontResult;
  try {
    result = jsToMeeme(src, dialect);
  } catch (e) {
    front = null;
    const line = e instanceof CompileError ? e.line : undefined;
    status.className = 'status err';
    status.textContent = line ? t('status.jsErrLine', { line }) : t('status.error');
    const msg = (e as Error).message;
    msgs.append(el('div', 'error', line ? t('msg.line', { line, msg }) : msg));
    markErrorLine(jsView, line ?? null);
    renderStats();
    return;
  }
  front = result;
  markErrorLine(jsView, null);
  status.className = 'status ok';
  status.textContent = t('status.jsOk', { n: result.bf.length.toLocaleString() });
  for (const w of result.warnings) msgs.append(el('div', 'warn', `⚠ ${w}`));
  if (keepMeeme) return renderStats();
  setDocProgrammatically(meemeView, result.meeme);
  setDirty(false);
  pulse(0);
  // the meeme editor's change listener triggers stage 2
}

// ───────────────────────── stage 2: 羊語 → Wasm ─────────────────────────

function onMeemeChange(text: string) {
  compileBack(text);
}

function getCompiler(): Promise<GeneratedCompiler> {
  if (compilerCache?.dialect !== dialect) {
    const d = dialect;
    const promise = buildCompiler(d).then((c) => {
      if (dialect === d) {
        currentCompiler = c;
        renderCompilerInfo();
      }
      return c;
    });
    compilerCache = { dialect: d, promise };
  }
  return compilerCache.promise;
}

async function compileBack(text: string) {
  const seq = ++backSeq;
  const msgs = $('meeme-messages');
  try {
    if (mode === 'gen') {
      const c = await getCompiler();
      if (seq !== backSeq) return;
      const r = c.compile(text);
      built = { wasm: r.wasm, ops: r.ops, irOps: null, ms: r.ms, via: 'gen' };
    } else {
      const r = meemeToWasm(text, dialect);
      built = { wasm: r.wasm, ops: r.rawOps, irOps: r.irOps, ms: r.lexMs + r.optMs + r.emitMs, via: 'js' };
    }
  } catch (e) {
    if (seq !== backSeq) return;
    built = null;
    msgs.replaceChildren();
    let line: number | null = null;
    const offset = e instanceof MeemeError || e instanceof GeneratedCompileError ? e.offset : undefined;
    if (offset != null) line = meemeView.state.doc.lineAt(Math.min(offset, meemeView.state.doc.length)).number;
    const msg = (e as Error).message;
    msgs.append(el('div', 'error', line ? t('msg.line', { line, msg }) : msg));
    markErrorLine(meemeView, line);
    setRunStatus('err', t('status.cannotCompile'));
    renderStats();
    return;
  }
  msgs.replaceChildren();
  markErrorLine(meemeView, null);
  pulse(1);
  renderArtifacts();
  renderStats();
  if ($<HTMLInputElement>('autorun').checked) run();
}

function setDirty(d: boolean) {
  meemeDirty = d;
  const badge = $('meeme-badge');
  badge.textContent = t(d ? 'badge.dirty' : 'badge.generated');
  badge.title = t(d ? 'badge.dirtyTitle' : 'badge.generatedTitle');
  badge.classList.toggle('dirty', d);
  $('regen').hidden = !d;
  renderStats();
}

// ───────────────────────── stage 3: run ─────────────────────────

const decoder = { current: new TextDecoder() };

function run() {
  if (!built) return;
  stopWorker();
  const out = $('output');
  out.replaceChildren();
  decoder.current = new TextDecoder();
  const input = new TextEncoder().encode($<HTMLTextAreaElement>('stdin').value);
  setRunStatus('', t('status.running'));
  const runBtn = $('run');
  runBtn.textContent = t('ui.stop');
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
      setRunStatus('ok', t('status.done', { ms: fmtMs(m.runMs) }));
      renderTape(m.tape, m.ptr);
      bounce();
    } else {
      out.append(el('div', 'sys err', '\n' + t('out.runtimeError', { msg: m.message })));
      setRunStatus('err', t('status.runtimeError'));
    }
    renderStats();
  };
  worker.onerror = (e) => {
    finish();
    out.append(el('div', 'sys err', `\n✗ ${e.message}`));
    setRunStatus('err', t('status.error'));
  };
  const req: WorkerRequest = { wasm: built.wasm, input, locale: getLocale() };
  worker.postMessage(req);
  runTimer = window.setTimeout(() => {
    stopWorker();
    out.append(el('div', 'sys err', '\n' + t('out.timeout', { s: TIMEOUT_MS / 1000 })));
    setRunStatus('err', t('status.timeout'));
    lastRun = null;
    renderStats();
  }, TIMEOUT_MS);
}

function finish() {
  clearTimeout(runTimer);
  worker?.terminate();
  worker = null;
  const runBtn = $('run');
  runBtn.textContent = t('ui.run');
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

const COMPILER_FN_NAMES = { 0: 'match', 1: 'emit_byte', 2: 'emit_sleb', 3: 'write5' };

function renderArtifacts() {
  if (activeTab === 'compiler') return renderCompilerTab();
  if (!built) return;
  if (activeTab === 'wat') {
    const { text, truncated } = disassemble(built.wasm);
    $('wat').textContent = text + (truncated ? '\n' + t('wat.truncated') : '');
  }
  if (activeTab === 'hex') $('hex').textContent = hexdump(built.wasm);
}

function renderCompilerTab() {
  const box = $('compiler');
  box.replaceChildren();
  const c = currentCompiler;
  if (!c) {
    box.append(el('p', '', t('compiler.generating')));
    return;
  }
  const name = dialectName(c.dialect);
  const intro = el('p', '', t('compiler.intro', { dialect: name, bytes: c.bytes.length.toLocaleString(), ms: fmtMs(c.genMs) }));
  const note = el('p', mode === 'gen' ? 'active-note' : '', t(mode === 'gen' ? 'compiler.active' : 'compiler.inactive'));
  // token → UTF-8 bytes, to make the branches in $match readable
  const table = el('table');
  const enc = new TextEncoder();
  for (const op of BF_OPS) {
    const tr = el('tr');
    tr.append(el('td', '', showWhitespace(c.dialect.tokens[op])), el('td', '', op), el('td', '', Array.from(enc.encode(c.dialect.tokens[op])).join(' ')));
    table.append(tr);
  }
  const pre = el('pre', 'wat-inline');
  pre.textContent = disassemble(c.bytes, { names: COMPILER_FN_NAMES }).text;
  box.append(intro, note, el('p', '', t('compiler.bytesTable')), table, pre);
}

function renderCompilerInfo() {
  const info = $('compiler-info');
  info.classList.toggle('inactive', mode !== 'gen');
  const c = currentCompiler;
  if (!c) {
    info.textContent = '⚙ ' + t('compiler.generating');
    return;
  }
  info.replaceChildren();
  const link = el('button', 'linkish', t('compiler.fileName', { dialect: dialectName(c.dialect) }));
  link.onclick = () => selectTab('compiler');
  info.append(t('compiler.infoBefore'), link, t('compiler.infoAfter', { bytes: c.bytes.length.toLocaleString(), ms: fmtMs(c.genMs) }));
  if (activeTab === 'compiler') renderCompilerTab();
}

function renderTape(tape: Uint8Array, ptr: number) {
  const box = $('tape');
  box.replaceChildren();
  let last = 0;
  for (let i = 0; i < tape.length; i++) if (tape[i]) last = i;
  const n = Math.max(32, Math.min(tape.length, Math.ceil((Math.max(last, ptr) + 1) / 8) * 8));
  box.append(el('p', '', t('tape.caption', { n, ptr })));
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
  const name = dialectName(dialect);
  if (front) add(`JS → ${name}`, fmtMs(front.ms));
  if (built) {
    add(`${name} → Wasm（${t(built.via === 'gen' ? 'stats.viaGen' : 'stats.viaJs')}）`, fmtMs(built.ms));
    add(name, t('stats.chars', { n: meemeView.state.doc.length.toLocaleString() }));
    add(t('stats.bfOps'), built.irOps != null ? t('stats.optimized', { a: built.ops.toLocaleString(), b: built.irOps.toLocaleString() }) : built.ops.toLocaleString());
    add('Wasm', `${built.wasm.length.toLocaleString()} bytes`);
  }
  if (lastRun) add(t('stats.run'), fmtMs(lastRun.runMs));
  if (front && !meemeDirty) add(t('stats.cells'), `${front.cells}`);
}

function renderLegend() {
  const box = $('legend');
  box.replaceChildren();
  const cls: Record<BfOp, string> = { '>': 'tk-move', '<': 'tk-move', '+': 'tk-add', '-': 'tk-sub', '.': 'tk-io', ',': 'tk-io', '[': 'tk-loop', ']': 'tk-loop' };
  for (const op of BF_OPS) {
    const chip = el('span', 'chip');
    chip.title = opLabel(op);
    chip.append(el('span', cls[op], showWhitespace(dialect.tokens[op])), el('code', '', op));
    box.append(chip);
  }
  $('meeme-title').textContent = dialectName(dialect);
  $('tagline-dialect').textContent = dialectName(dialect);
}

// ───────────────────────── language spec ─────────────────────────

/** Render text with `code` spans. */
function richText(parent: HTMLElement, text: string) {
  text.split('`').forEach((part, i) => {
    if (!part) return;
    parent.append(i % 2 ? el('code', '', part) : document.createTextNode(part));
  });
}

function renderSpecStrip() {
  const chips = $('spec-chips');
  chips.replaceChildren(...spec().summary.map((s) => el('span', 'spec-chip', s)));
}

function openSpec() {
  const body = $('spec-body');
  body.replaceChildren();
  const s = spec();
  const intro = el('p', 'hint');
  richText(intro, s.intro);
  body.append(intro);
  const icon = { ok: '✅', ng: '❌', note: 'ℹ️' } as const;
  for (const sec of s.sections) {
    const h = el('h3', '', sec.title);
    const ul = el('ul', 'spec-list');
    for (const [kind, text] of sec.items) {
      const li = el('li', `spec-${kind}`);
      li.append(el('span', 'spec-icon', icon[kind]));
      const span = el('span');
      richText(span, text);
      li.append(span);
      ul.append(li);
    }
    body.append(h, ul);
  }
  $<HTMLDialogElement>('spec-dialog').showModal();
}

// ───────────────────────── dialects ─────────────────────────

function allDialects(): Dialect[] {
  const custom = normalizeDialect(store.get<Partial<Dialect> | null>('custom', null));
  return custom && custom.id === 'custom' ? [...PRESETS, custom] : PRESETS;
}

function fillDialectSelect() {
  const sel = $<HTMLSelectElement>('dialect-select');
  sel.replaceChildren();
  for (const d of allDialects()) sel.append(new Option(dialectName(d), d.id));
  sel.value = dialect.id;
}

function applyDialect(next: Dialect) {
  const prev = dialect;
  dialect = next;
  store.set('dialect', next);
  setEditorDialect(meemeView, next);
  currentCompiler = null;
  renderCompilerInfo();
  void getCompiler();
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
  const linesBox = $<HTMLInputElement>('dialect-lines');
  linesBox.checked = !!dialect.lines;
  linesBox.onchange = validate;
  grid.replaceChildren();
  for (const op of BF_OPS) {
    const label = el('label');
    const input = document.createElement('input');
    input.value = showWhitespace(dialect.tokens[op]);
    input.spellcheck = false;
    input.addEventListener('input', validate);
    inputs[op] = input;
    label.append(el('code', '', op), el('span', '', opLabel(op)), input);
    grid.append(label);
  }
  presets.replaceChildren(el('span', 'hint', t('dialog.presets')));
  for (const p of PRESETS) {
    const b = el('button', 'btn tiny', dialectName(p)) as HTMLButtonElement;
    b.type = 'button';
    b.onclick = () => {
      for (const op of BF_OPS) inputs[op].value = showWhitespace(p.tokens[op]);
      linesBox.checked = !!p.lines;
      validate();
    };
    presets.append(b);
  }
  const current = (): Dialect => {
    const tokens = {} as Record<BfOp, string>;
    for (const op of BF_OPS) tokens[op] = parseWhitespace(inputs[op].value);
    return normalizeDialect({ tokens, lines: linesBox.checked })!;
  };
  function validate() {
    const errs = $('dialect-errors');
    errs.replaceChildren();
    const check = checkDialect(current());
    for (const op of BF_OPS) inputs[op].classList.toggle('bad', !inputs[op].value);
    for (const e of check.errors) errs.append(el('div', 'error', `✗ ${e}`));
    if (!check.errors.length && check.needsSeparator) errs.append(el('div', 'warn', t('dialog.needsSeparator')));
    $<HTMLButtonElement>('dialect-apply').disabled = check.errors.length > 0;
  }
  validate();
  dlg.onclose = () => {
    if (dlg.returnValue !== 'apply') return;
    const d = current();
    if (d.id === 'custom') store.set('custom', d);
    applyDialect(d);
  };
  dlg.showModal();
}

// ───────────────────────── i18n ─────────────────────────

function applyStaticTexts() {
  const loc = LOCALES.find((l) => l.id === getLocale())!;
  document.documentElement.lang = loc.htmlLang;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((n) => (n.textContent = t(n.dataset.i18n as MessageKey)));
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach((n) => (n.title = t(n.dataset.i18nTitle as MessageKey)));
  document.querySelectorAll<HTMLTextAreaElement>('[data-i18n-placeholder]').forEach((n) => (n.placeholder = t(n.dataset.i18nPlaceholder as MessageKey)));
  document.querySelector('meta[name=description]')?.setAttribute('content', t('app.description'));
  if (worker) $('run').textContent = t('ui.stop');
}

function fillLocaleSelect() {
  const sel = $<HTMLSelectElement>('locale-select');
  sel.replaceChildren(...LOCALES.map((l) => new Option(l.label, l.id)));
  sel.value = getLocale();
  sel.onchange = () => changeLocale(sel.value as Locale);
}

function changeLocale(next: Locale) {
  const prev = getLocale();
  if (next === prev) return;
  // Swap untouched example code / input to the new language.
  const code = jsView.state.doc.toString();
  const exId = identifyExample(code);
  const stdin = $<HTMLTextAreaElement>('stdin');
  const prevEx = exId ? getExamples(prev).find((e) => e.id === exId) : undefined;
  setLocale(next);
  store.set('locale', next);
  applyStaticTexts();
  fillExamples();
  fillDialectSelect();
  renderLegend();
  renderSpecStrip();
  renderCompilerInfo();
  setDirty(meemeDirty);
  const nextEx = exId ? getExamples(next).find((e) => e.id === exId) : undefined;
  if (nextEx && prevEx && (stdin.value === (prevEx.input ?? ''))) {
    stdin.value = nextEx.input ?? '';
    store.set('stdin', stdin.value);
  }
  if (nextEx && nextEx.code !== code) {
    jsView.dispatch({ changes: { from: 0, to: jsView.state.doc.length, insert: nextEx.code } });
  } else {
    // re-render messages in the new language
    compileFront(code, meemeDirty);
    if (meemeDirty) compileBack(meemeView.state.doc.toString());
  }
  renderArtifacts();
}

// ───────────────────────── wiring ─────────────────────────

function fillExamples() {
  const sel = $<HTMLSelectElement>('example-select');
  sel.replaceChildren(new Option(t('ui.samplePick'), ''));
  for (const ex of getExamples(getLocale())) sel.append(new Option(ex.title, ex.id));
  sel.onchange = () => {
    const ex = getExamples(getLocale()).find((e) => e.id === sel.value);
    if (!ex) return;
    store.set('example', ex.id);
    $<HTMLTextAreaElement>('stdin').value = ex.input ?? '';
    store.set('stdin', ex.input ?? '');
    jsView.dispatch({ changes: { from: 0, to: jsView.state.doc.length, insert: ex.code } });
    sel.value = '';
  };
}

$<HTMLSelectElement>('dialect-select').onchange = (e) => {
  const d = allDialects().find((x) => x.id === (e.target as HTMLSelectElement).value);
  if (d) applyDialect(d);
};
$('dialect-edit').onclick = openDialectEditor;
$('spec-open').onclick = openSpec;
$('run').onclick = () => (worker ? (stopWorker(), setRunStatus('err', t('status.stopped'))) : run());
$('regen').onclick = () => compileFront(jsView.state.doc.toString());
$<HTMLTextAreaElement>('stdin').addEventListener(
  'input',
  debounce(() => {
    store.set('stdin', $<HTMLTextAreaElement>('stdin').value);
    if ($<HTMLInputElement>('autorun').checked) run();
  }, 400),
);
function selectTab(name: string) {
  activeTab = name;
  document.querySelectorAll<HTMLElement>('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === name));
  document.querySelectorAll<HTMLElement>('.view').forEach((v) => v.classList.toggle('active', v.dataset.view === name));
  renderArtifacts();
}
document.querySelectorAll<HTMLButtonElement>('.tab').forEach((tab) => {
  tab.onclick = () => selectTab(tab.dataset.tab!);
});
const modeSelect = $<HTMLSelectElement>('mode-select');
modeSelect.value = mode;
modeSelect.onchange = () => {
  mode = modeSelect.value as Mode;
  store.set('mode', mode);
  renderCompilerInfo();
  compileBack(meemeView.state.doc.toString());
};
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

applyStaticTexts();
fillLocaleSelect();
fillExamples();
fillDialectSelect();
renderLegend();
renderSpecStrip();
renderCompilerInfo();
setDirty(false);
void getCompiler();
compileFront(jsView.state.doc.toString());
