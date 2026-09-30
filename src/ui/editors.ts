import { EditorView, basicSetup } from 'codemirror';
import { Annotation, Compartment, EditorState, StateEffect, StateField, type Extension, RangeSetBuilder } from '@codemirror/state';
import { Decoration, type DecorationSet, ViewPlugin, type ViewUpdate, highlightWhitespace } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { Lexer, type BfOp, type Dialect } from '../compiler/dialect';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13.5px', backgroundColor: 'var(--editor-bg)', color: 'var(--text)' },
  '.cm-scroller': { fontFamily: 'var(--mono)', lineHeight: '1.6', fontVariantLigatures: 'none' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--text-faint)', border: 'none' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--active-line)', color: 'var(--text-dim)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--selection) !important' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-foldPlaceholder': { background: 'var(--chip)', border: 'none', color: 'var(--text-dim)' },
  '.cm-tooltip': { background: 'var(--panel)', border: '1px solid var(--border)' },
  '.cm-error-line': { backgroundColor: 'var(--error-bg)' },
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: 'var(--syn-keyword)' },
  { tag: [t.string, t.special(t.string)], color: 'var(--syn-string)' },
  { tag: t.number, color: 'var(--syn-number)' },
  { tag: t.bool, color: 'var(--syn-number)' },
  { tag: t.comment, color: 'var(--syn-comment)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-fn)' },
  { tag: t.definition(t.variableName), color: 'var(--syn-def)' },
  { tag: t.operator, color: 'var(--syn-op)' },
  { tag: t.propertyName, color: 'var(--syn-prop)' },
]);

// ───────────── error line marker (shared) ─────────────

const setErrorLine = StateEffect.define<number | null>();
const errorLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorLine)) {
        if (e.value == null || e.value < 1 || e.value > tr.state.doc.lines) deco = Decoration.none;
        else {
          const line = tr.state.doc.line(e.value);
          deco = Decoration.set([Decoration.line({ class: 'cm-error-line' }).range(line.from)]);
        }
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function markErrorLine(view: EditorView, line: number | null) {
  view.dispatch({ effects: setErrorLine.of(line) });
}

// ───────────── JavaScript editor ─────────────

export function createJsEditor(parent: HTMLElement, doc: string, onChange: (text: string) => void): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        basicSetup,
        javascript(),
        theme,
        syntaxHighlighting(highlight),
        errorLineField,
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        }),
      ],
    }),
  });
}

// ───────────── 羊語 editor: highlighting driven by the dialect lexer ─────────────

const OP_CLASS: Record<BfOp, string> = {
  '>': 'tk-move',
  '<': 'tk-move',
  '+': 'tk-add',
  '-': 'tk-sub',
  '.': 'tk-io',
  ',': 'tk-io',
  '[': 'tk-loop',
  ']': 'tk-loop',
};

const marks = Object.fromEntries(Object.entries(OP_CLASS).map(([op, cls]) => [op, Decoration.mark({ class: cls })])) as Record<BfOp, Decoration>;

export const setDialectEffect = StateEffect.define<Dialect>();
const dialectField = StateField.define<Dialect | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setDialectEffect)) v = e.value;
    return v;
  },
});

function tokenHighlighter(): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      lexer: Lexer | null = null;
      dialect: Dialect | null = null;
      constructor(view: EditorView) {
        this.decorations = this.build(view);
      }
      update(u: ViewUpdate) {
        const d = u.state.field(dialectField);
        if (u.docChanged || u.viewportChanged || d !== this.dialect) this.decorations = this.build(u.view);
      }
      build(view: EditorView): DecorationSet {
        const d = view.state.field(dialectField);
        if (!d) return Decoration.none;
        if (d !== this.dialect) {
          this.dialect = d;
          this.lexer = new Lexer(d);
        }
        const b = new RangeSetBuilder<Decoration>();
        for (const { from, to } of view.visibleRanges) {
          // lex whole lines so tokens are not cut at the range boundary
          const start = view.state.doc.lineAt(from).from;
          const end = view.state.doc.lineAt(to).to;
          const text = view.state.sliceDoc(start, end);
          const r = this.lexer!.lex(text);
          for (let k = 0; k < r.ops.length; k++) {
            const op = r.ops[k] as BfOp;
            const s = start + r.pos[k];
            b.add(s, s + d.tokens[op].length, marks[op]);
          }
        }
        return b.finish();
      }
    },
    { decorations: (v) => v.decorations },
  );
}

export function createMeemeEditor(parent: HTMLElement, onUserChange: (text: string) => void): EditorView {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        theme,
        EditorView.lineWrapping,
        dialectField,
        errorLineField,
        tokenHighlighter(),
        whitespaceMode.of([]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          const programmatic = u.transactions.some((tr) => tr.annotation(programmaticAnnotation.type));
          onUserChange(u.state.doc.toString());
          if (!programmatic) userEditListeners.forEach((f) => f());
        }),
      ],
    }),
  });
}

const programmaticAnnotation = { type: Annotation.define<boolean>() };
const userEditListeners = new Set<() => void>();

export function onUserEdit(f: () => void) {
  userEditListeners.add(f);
}

export function setDocProgrammatically(view: EditorView, text: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    annotations: programmaticAnnotation.type.of(true),
  });
}

// Line-mode dialects (Whitefuck) are made of spaces and tabs: make them visible.
const whitespaceMode = new Compartment();
const whitespaceExt = [highlightWhitespace(), EditorView.editorAttributes.of({ class: 'ws-mode' })];

export function setEditorDialect(view: EditorView, d: Dialect) {
  view.dispatch({ effects: [setDialectEffect.of(d), whitespaceMode.reconfigure(d.lines ? whitespaceExt : [])] });
}
