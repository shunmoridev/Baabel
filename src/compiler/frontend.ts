// JavaScript subset → Brainfuck.
//
// The program is parsed with acorn and compiled straight to Brainfuck using
// BfGen. Values are 8-bit unsigned integers (0–255, wrapping). Functions are
// inlined at every call site (no recursion). Arrays live in a dedicated tape
// region with a "walking" layout so they can be indexed by runtime values.

import { parse } from 'acorn';
import { BfGen } from './bfgen';
import { t as tr } from '../i18n';

// acorn's ESTree typings are precise but very noisy to narrow in a compiler
// that pattern-matches on shapes all the time, so AST nodes are loosely typed.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export class CompileError extends Error {
  constructor(
    message: string,
    public line?: number,
    public column?: number,
  ) {
    super(message);
  }
}

export interface CompileResult {
  bf: string;
  warnings: string[];
  cells: number;
}

type FuncDef = { params: N[]; body: N[]; name: string; scope: Scope };

type Sym =
  | { kind: 'var'; cell: number }
  | { kind: 'const'; value: number }
  | { kind: 'array'; base: number; length: number; isString: boolean }
  | { kind: 'func'; def: FuncDef };

class Scope {
  vars = new Map<string, Sym>();
  constructor(public parent: Scope | null) {}
  lookup(name: string): Sym | undefined {
    return this.vars.get(name) ?? this.parent?.lookup(name);
  }
}

interface FnCtx {
  retCell: number;
  retFlag: number | null;
}
interface LoopCtx {
  brk: number | null;
  cont: number | null;
}

interface Escapes {
  brk: boolean;
  cont: boolean;
  ret: boolean;
}

type PrintItem = { t: 'str'; s: string } | { t: 'num'; node: N } | { t: 'char'; node: N } | { t: 'cell'; cell: number; asChar: boolean };

const PRELUDE = `
function readInt() {
  let n = 0;
  let c = getchar();
  while (c == 32 || c == 10 || c == 13 || c == 9) c = getchar();
  while (c >= 48 && c <= 57) {
    n = n * 10 + c - 48;
    c = getchar();
  }
  return n;
}
`;

// Array layout: blocks of 4 cells [m, i, x, v]. Block 0 is the head used for
// walking; element k lives in block k+1 (value in its `v` cell).
const ARR_STRIDE = 4;
// Walk right while i != 0, carrying i-1 and x, leaving m=1 breadcrumbs.
const ARR_FWD = '[-[->>>>+<<<<]>[->>>>+<<<<]>>><+>]';
// At destination (on i): copy v into x, go to m.
const ARR_READ = '>>[-<+<+>>]<<[->>+<<]<';
// Walk back to the head carrying x.
const ARR_BACK_CARRY = '[->>[-<<<<+>>>>]<<<<<<]';
// At destination (on i): v = x, go to m.
const ARR_WRITE = '>>[-]<[->+<]<<';
// Walk back to the head.
const ARR_BACK = '[-<<<<]';

// Divmod for layout [0 0 0 n d 0 0 0 0] (head on n):
// result [0 0 0 0 d-n%d n%d n/d 0 0]. Requires d >= 2.
const DIVMOD = '[->-[>+>>]>[+[-<+>]>+>>]<<<<<]';

const utf8 = (s: string) => Array.from(new TextEncoder().encode(s));
const wrap = (n: number) => ((n % 256) + 256) % 256;

function stmtEscapes(node: N): Escapes {
  const e: Escapes = { brk: false, cont: false, ret: false };
  const walk = (n: N, inLoop: boolean) => {
    if (!n || typeof n !== 'object') return;
    switch (n.type) {
      case 'BreakStatement':
        if (!inLoop) e.brk = true;
        return;
      case 'ContinueStatement':
        if (!inLoop) e.cont = true;
        return;
      case 'ReturnStatement':
        e.ret = true;
        return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        return;
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'ForStatement':
      case 'ForOfStatement':
        walk(n.body, true);
        return;
      case 'BlockStatement':
        n.body.forEach((s: N) => walk(s, inLoop));
        return;
      case 'IfStatement':
        walk(n.consequent, inLoop);
        walk(n.alternate, inLoop);
        return;
      default:
        return;
    }
  };
  walk(node, false);
  return e;
}

function countReturns(body: N[]): number {
  let count = 0;
  const walk = (n: N) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n.type === 'ReturnStatement') count++;
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') return;
    for (const k of ['body', 'consequent', 'alternate']) if (n[k]) walk(n[k]);
  };
  walk(body);
  return count;
}

class Compiler {
  g = new BfGen();
  scope: Scope;
  global: Scope;
  fn: FnCtx | null = null;
  loops: LoopCtx[] = [];
  inlineStack: string[] = [];
  warnings: string[] = [];
  private warned = new Set<N>();

  constructor() {
    const prelude = new Scope(null);
    const ast = parse(PRELUDE, { ecmaVersion: 'latest' }) as N;
    this.global = new Scope(prelude);
    this.scope = prelude;
    this.hoist(ast.body);
    this.scope = this.global;
  }

  // ───────────────────────── errors / helpers ─────────────────────────

  err(node: N, msg: string): never {
    throw new CompileError(msg, node?.loc?.start.line, node?.loc?.start.column);
  }

  warn(node: N, msg: string) {
    if (this.warned.has(node)) return;
    this.warned.add(node);
    const line = node?.loc?.start.line;
    this.warnings.push(line ? tr('msg.line', { line, msg }) : msg);
  }

  // ───────────────────────── program / statements ─────────────────────────

  compileProgram(body: N[]) {
    this.hoist(body);
    this.compileStatements(body);
  }

  hoist(stmts: N[]) {
    for (const s of stmts) {
      if (s.type === 'FunctionDeclaration') {
        this.declareFunc(s.id.name, s, s.params, s.body.body);
      }
    }
  }

  declareFunc(name: string, node: N, params: N[], body: N[], fn: N = node) {
    if (fn.async || fn.generator) this.err(node, tr('err.asyncGenerator'));
    for (const p of params) if (p.type !== 'Identifier') this.err(p, tr('err.paramSimple'));
    if (this.scope.vars.has(name) && this.scope.vars.get(name)!.kind !== 'func') this.err(node, tr('err.redeclared', { name }));
    this.scope.vars.set(name, { kind: 'func', def: { name, params, body, scope: this.scope } });
  }

  pushScope() {
    this.scope = new Scope(this.scope);
  }

  popScope() {
    for (const sym of this.scope.vars.values()) this.releaseSym(sym);
    this.scope = this.scope.parent!;
  }

  releaseSym(sym: Sym) {
    if (sym.kind === 'var') this.g.release(sym.cell);
    else if (sym.kind === 'array') {
      for (let k = 0; k < sym.length; k++) this.g.clear(this.elemCell(sym, k));
      for (let c = 0; c < ARR_STRIDE * (sym.length + 1); c++) this.g.free(sym.base + c);
    }
  }

  compileScoped(stmt: N) {
    this.pushScope();
    const body = stmt.type === 'BlockStatement' ? stmt.body : [stmt];
    this.hoist(body);
    this.compileStatements(body);
    this.popScope();
  }

  compileStatements(stmts: N[]) {
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      this.compileStatement(s);
      const rest = stmts.slice(i + 1).filter((r) => r.type !== 'FunctionDeclaration' && r.type !== 'EmptyStatement');
      if (!rest.length) return;
      const e = stmtEscapes(s);
      if (!e.brk && !e.cont && !e.ret) continue;
      // The statement may have jumped: run the rest only if no flag is set.
      const flags: number[] = [];
      const loop = this.loops[this.loops.length - 1];
      if (e.ret && this.fn?.retFlag != null) flags.push(this.fn.retFlag);
      if (e.brk && loop?.brk != null) flags.push(loop.brk);
      if (e.cont && loop?.cont != null) flags.push(loop.cont);
      if (!flags.length) return; // unconditional jump: rest is unreachable
      const g = this.notAny(flags);
      this.g.loop(g, () => {
        this.g.add(g, -1);
        this.compileStatements(rest);
      });
      this.g.free(g);
      return;
    }
  }

  compileStatement(s: N) {
    switch (s.type) {
      case 'EmptyStatement':
      case 'FunctionDeclaration':
        return;
      case 'VariableDeclaration':
        return this.compileVarDecl(s);
      case 'ExpressionStatement':
        return this.evalEffect(s.expression);
      case 'BlockStatement':
        return this.compileScoped(s);
      case 'IfStatement':
        return this.compileIf(s);
      case 'WhileStatement':
        return this.compileLoop({
          test: () => this.condTemp(s.test),
          body: s.body,
        });
      case 'DoWhileStatement':
        return this.compileLoop({
          test: () => this.condTemp(s.test),
          body: s.body,
          doWhile: true,
        });
      case 'ForStatement': {
        this.pushScope();
        if (s.init) {
          if (s.init.type === 'VariableDeclaration') this.compileVarDecl(s.init);
          else this.evalEffect(s.init);
        }
        this.compileLoop({
          test: s.test ? () => this.condTemp(s.test) : null,
          body: s.body,
          update: s.update ? () => this.evalEffect(s.update) : undefined,
        });
        this.popScope();
        return;
      }
      case 'ForOfStatement':
        return this.compileForOf(s);
      case 'BreakStatement':
      case 'ContinueStatement': {
        if (s.label) this.err(s, tr('err.labeled'));
        const loop = this.loops[this.loops.length - 1];
        if (!loop) this.err(s, tr('err.jumpOutsideLoop', { kw: s.type === 'BreakStatement' ? 'break' : 'continue' }));
        const flag = s.type === 'BreakStatement' ? loop.brk : loop.cont;
        this.g.add(flag!, 1);
        return;
      }
      case 'ReturnStatement': {
        if (!this.fn) this.err(s, tr('err.returnOutsideFn'));
        if (s.argument) {
          const t = this.evalExpr(s.argument);
          this.g.moveAdd(t, [[this.fn.retCell, 1]]);
          this.g.free(t);
        }
        if (this.fn.retFlag != null) this.g.add(this.fn.retFlag, 1);
        return;
      }
      default:
        this.err(s, tr('err.unsupportedStmt', { type: s.type }));
    }
  }

  compileVarDecl(s: N) {
    for (const d of s.declarations) {
      if (d.id.type !== 'Identifier') this.err(d, tr('err.destructuring'));
      const name: string = d.id.name;
      if (this.scope.vars.has(name)) this.err(d, tr('err.redeclared', { name }));
      const init = d.init;
      if (init && (init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression')) {
        const body = init.body.type === 'BlockStatement' ? init.body.body : [{ type: 'ReturnStatement', argument: init.body, loc: init.body.loc }];
        this.declareFunc(name, d, init.params, body, init);
        continue;
      }
      const arr = init && this.arrayInit(init);
      if (arr) {
        this.declareArray(name, arr.values, arr.isString);
        continue;
      }
      if (s.kind === 'const' && init) {
        const v = this.constValue(init);
        if (v !== null) {
          this.scope.vars.set(name, { kind: 'const', value: v });
          continue;
        }
      }
      const cell = this.g.alloc();
      if (init) {
        const t = this.evalExpr(init);
        this.g.moveAdd(t, [[cell, 1]]);
        this.g.free(t);
      }
      this.scope.vars.set(name, { kind: 'var', cell });
    }
  }

  /** Recognise array initialisers: [..], "string", Array(n), new Array(n).fill(v). */
  arrayInit(init: N): { values: Array<N | number>; isString: boolean } | null {
    if (init.type === 'ArrayExpression') {
      for (const e of init.elements) if (!e || e.type === 'SpreadElement') this.err(init, tr('err.arrayHoles'));
      return { values: init.elements, isString: false };
    }
    if (init.type === 'Literal' && typeof init.value === 'string') {
      return { values: utf8(init.value), isString: true };
    }
    let fill: N | null = null;
    let ctor = init;
    if (init.type === 'CallExpression' && init.callee.type === 'MemberExpression' && !init.callee.computed && init.callee.property.name === 'fill') {
      fill = init.arguments[0] ?? null;
      ctor = init.callee.object;
    }
    if ((ctor.type === 'NewExpression' || ctor.type === 'CallExpression') && ctor.callee.type === 'Identifier' && ctor.callee.name === 'Array') {
      if (ctor.arguments.length !== 1) this.err(ctor, tr('err.arrayLenArg'));
      const n = this.constValueRaw(ctor.arguments[0]);
      if (n === null || n < 0) this.err(ctor, tr('err.arrayLenConst'));
      if (n > 1000) this.err(ctor, tr('err.arrayLenMax'));
      const fv = fill ? this.constValue(fill) : 0;
      if (fv === null) this.err(fill, tr('err.fillConst'));
      return { values: new Array(n).fill(fv), isString: false };
    }
    return null;
  }

  declareArray(name: string, values: Array<N | number>, isString: boolean) {
    const length = values.length;
    const base = this.g.allocBlock(ARR_STRIDE * (length + 1));
    const sym: Sym = { kind: 'array', base, length, isString };
    values.forEach((v, k) => {
      const cell = this.elemCell(sym, k);
      if (typeof v === 'number') this.g.addConst(cell, v);
      else {
        const t = this.evalExpr(v);
        this.g.moveAdd(t, [[cell, 1]]);
        this.g.free(t);
      }
    });
    this.scope.vars.set(name, sym);
  }

  elemCell(sym: Extract<Sym, { kind: 'array' }>, k: number): number {
    return sym.base + ARR_STRIDE * (k + 1) + 3;
  }

  compileIf(s: N) {
    const cv = this.constValue(s.test);
    if (cv !== null) {
      if (cv) this.compileScoped(s.consequent);
      else if (s.alternate) this.compileScoped(s.alternate);
      return;
    }
    const c = this.condTemp(s.test);
    if (s.alternate) {
      const e = this.g.alloc();
      this.g.add(e, 1);
      this.g.loop(c, () => {
        this.g.clear(c);
        this.g.add(e, -1);
        this.compileScoped(s.consequent);
      });
      this.g.loop(e, () => {
        this.g.add(e, -1);
        this.compileScoped(s.alternate);
      });
      this.g.free(e);
    } else {
      this.g.loop(c, () => {
        this.g.clear(c);
        this.compileScoped(s.consequent);
      });
    }
    this.g.free(c);
  }

  compileLoop(opts: { test: (() => number) | null; body: N; update?: () => void; doWhile?: boolean; beforeBody?: () => void }) {
    const esc = stmtEscapes(opts.body);
    const brk = esc.brk ? this.g.alloc() : null;
    const cont = esc.cont ? this.g.alloc() : null;
    const stop: number[] = [];
    if (brk != null) stop.push(brk);
    if (esc.ret && this.fn?.retFlag != null) stop.push(this.fn.retFlag);
    const c = this.g.alloc();

    const guarded = (f: () => void) => {
      if (!stop.length) return f();
      const g = this.notAny(stop);
      this.g.loop(g, () => {
        this.g.add(g, -1);
        f();
      });
      this.g.free(g);
    };
    const computeCond = () =>
      guarded(() => {
        if (!opts.test) return this.g.add(c, 1);
        const t = opts.test();
        this.g.moveAdd(t, [[c, 1]]);
        this.g.free(t);
      });

    if (opts.doWhile) this.g.add(c, 1);
    else computeCond();
    this.loops.push({ brk, cont });
    this.g.loop(c, () => {
      this.g.clear(c);
      if (cont != null) this.g.clear(cont);
      this.pushScope();
      opts.beforeBody?.();
      const body = opts.body.type === 'BlockStatement' ? opts.body.body : [opts.body];
      this.hoist(body);
      this.compileStatements(body);
      this.popScope();
      if (opts.update) guarded(opts.update);
      computeCond();
    });
    this.loops.pop();
    this.g.free(c);
    if (brk != null) this.g.release(brk);
    if (cont != null) this.g.release(cont);
  }

  compileForOf(s: N) {
    if (s.left.type !== 'VariableDeclaration' || s.left.declarations[0].id.type !== 'Identifier') this.err(s, tr('err.forOfForm'));
    const name = s.left.declarations[0].id.name;
    this.pushScope();
    let arr: Sym | undefined;
    if (s.right.type === 'Identifier') arr = this.scope.lookup(s.right.name);
    else if (s.right.type === 'Literal' && typeof s.right.value === 'string') {
      this.declareArray('%forof', utf8(s.right.value), true);
      arr = this.scope.vars.get('%forof');
    } else if (s.right.type === 'ArrayExpression') {
      const lit = this.arrayInit(s.right)!;
      this.declareArray('%forof', lit.values, false);
      arr = this.scope.vars.get('%forof');
    }
    if (!arr || arr.kind !== 'array') this.err(s.right, tr('err.forOfTarget'));
    const a = arr;
    const idx = this.g.alloc();
    this.scope.vars.set('%idx', { kind: 'var', cell: idx });
    this.compileLoop({
      test: () => {
        const t = this.g.copy(idx);
        const n = this.constTemp(a.length);
        return this.lt(t, n);
      },
      beforeBody: () => {
        const cell = this.g.alloc();
        const v = this.arrayRead(a, this.g.copy(idx));
        this.g.moveAdd(v, [[cell, 1]]);
        this.g.free(v);
        this.scope.vars.set(name, { kind: 'var', cell });
      },
      body: s.body,
      update: () => this.g.add(idx, 1),
    });
    this.popScope();
  }

  /** g = 1 if every flag is 0 (flags are preserved). */
  notAny(flags: number[]): number {
    const g = this.g.alloc();
    this.g.add(g, 1);
    for (const f of flags) {
      const t = this.g.copy(f);
      this.g.loop(t, () => {
        this.g.clear(t);
        this.g.clear(g);
      });
      this.g.free(t);
    }
    return g;
  }

  // ───────────────────────── constants ─────────────────────────

  /** Constant value without 8-bit wrapping (used for lengths). */
  constValueRaw(node: N): number | null {
    if (node.type === 'Literal' && typeof node.value === 'number') return Math.trunc(node.value);
    if (node.type === 'Identifier') {
      const s = this.scope.lookup(node.name);
      if (s?.kind === 'const') return s.value;
    }
    return this.constValue(node);
  }

  constValue(node: N): number | null {
    switch (node.type) {
      case 'Literal': {
        if (typeof node.value === 'boolean') return node.value ? 1 : 0;
        if (typeof node.value === 'number') {
          let v = node.value;
          if (!Number.isInteger(v)) {
            this.warn(node, tr('warn.truncated', { v }));
            v = Math.trunc(v);
          }
          if (v > 255) this.warn(node, tr('warn.wrapped', { v, w: wrap(v) }));
          return wrap(v);
        }
        return null;
      }
      case 'Identifier': {
        if (node.name === 'undefined') return 0;
        const s = this.scope.lookup(node.name);
        return s?.kind === 'const' ? s.value : null;
      }
      case 'UnaryExpression': {
        const v = this.constValue(node.argument);
        if (v === null) return null;
        switch (node.operator) {
          case '-':
            return wrap(-v);
          case '+':
            return v;
          case '!':
            return v ? 0 : 1;
          case '~':
            return wrap(~v);
        }
        return null;
      }
      case 'BinaryExpression': {
        const a = this.constValue(node.left);
        const b = this.constValue(node.right);
        if (a === null || b === null) return null;
        return this.foldBinary(node.operator, a, b);
      }
      case 'LogicalExpression': {
        const a = this.constValue(node.left);
        if (a === null) return null;
        if (node.operator === '&&') return a ? this.constValue(node.right) : a;
        if (node.operator === '||') return a ? a : this.constValue(node.right);
        return null;
      }
      case 'ConditionalExpression': {
        const t = this.constValue(node.test);
        if (t === null) return null;
        return this.constValue(t ? node.consequent : node.alternate);
      }
      case 'MemberExpression': {
        if (!node.computed && node.property.name === 'length') {
          if (node.object.type === 'Literal' && typeof node.object.value === 'string') return utf8(node.object.value).length;
          if (node.object.type === 'Identifier') {
            const s = this.scope.lookup(node.object.name);
            if (s?.kind === 'array') return s.length;
          }
        }
        if (node.computed && node.object.type === 'Literal' && typeof node.object.value === 'string') {
          const k = this.constValue(node.property);
          if (k !== null) return utf8(node.object.value)[k] ?? 0;
        }
        return null;
      }
      case 'CallExpression': {
        const c = node.callee;
        if (c.type === 'MemberExpression' && !c.computed && c.property.name === 'charCodeAt' && c.object.type === 'Literal' && typeof c.object.value === 'string') {
          const k = node.arguments[0] ? this.constValue(node.arguments[0]) : 0;
          if (k === null) return null;
          return utf8(c.object.value)[k] ?? 0;
        }
        return null;
      }
    }
    return null;
  }

  foldBinary(op: string, a: number, b: number): number | null {
    switch (op) {
      case '+':
        return wrap(a + b);
      case '-':
        return wrap(a - b);
      case '*':
        return wrap(a * b);
      case '/':
        return b === 0 ? 0 : Math.floor(a / b);
      case '%':
        return b === 0 ? 0 : a % b;
      case '==':
      case '===':
        return a === b ? 1 : 0;
      case '!=':
      case '!==':
        return a !== b ? 1 : 0;
      case '<':
        return a < b ? 1 : 0;
      case '>':
        return a > b ? 1 : 0;
      case '<=':
        return a <= b ? 1 : 0;
      case '>=':
        return a >= b ? 1 : 0;
      case '&':
        return a & b;
      case '|':
        return a | b;
      case '^':
        return a ^ b;
      case '<<':
        return wrap(a << b);
      case '>>':
      case '>>>':
        return a >> b;
    }
    return null;
  }

  constTemp(v: number): number {
    const t = this.g.alloc();
    this.g.addConst(t, v);
    return t;
  }

  // ───────────────────────── expressions ─────────────────────────

  /** Evaluate for side effects only. */
  evalEffect(node: N) {
    switch (node.type) {
      case 'AssignmentExpression':
        return void this.assign(node, false);
      case 'UpdateExpression':
        return void this.update(node, false);
      case 'CallExpression':
        return void this.call(node, false);
      case 'SequenceExpression':
        return node.expressions.forEach((e: N) => this.evalEffect(e));
      default: {
        const t = this.evalExpr(node);
        this.g.release(t);
      }
    }
  }

  /** Evaluate a condition; the result is truthy/falsy but not normalised. */
  condTemp(node: N): number {
    if (node.type === 'BinaryExpression' && (node.operator === '!=' || node.operator === '!==')) {
      return this.diff(node.left, node.right);
    }
    return this.evalExpr(node);
  }

  diff(l: N, r: N): number {
    const cr = this.constValue(r);
    if (cr !== null) {
      const t = this.evalExpr(l);
      this.g.addConst(t, -cr);
      return t;
    }
    const cl = this.constValue(l);
    if (cl !== null) {
      const t = this.evalExpr(r);
      this.g.addConst(t, -cl);
      return t;
    }
    const a = this.evalExpr(l);
    const b = this.evalExpr(r);
    this.g.moveAdd(b, [[a, -1]]);
    this.g.free(b);
    return a;
  }

  /** Evaluate into a freshly allocated temp cell owned by the caller. */
  evalExpr(node: N): number {
    const cv = this.constValue(node);
    if (cv !== null) return this.constTemp(cv);
    switch (node.type) {
      case 'Identifier': {
        const s = this.scope.lookup(node.name);
        if (!s) this.err(node, tr('err.undefined', { name: node.name }));
        if (s.kind === 'var') return this.g.copy(s.cell);
        if (s.kind === 'array') this.err(node, tr('err.arrayAsNumber', { name: node.name }));
        this.err(node, tr('err.fnAsValue', { name: node.name }));
        break;
      }
      case 'Literal':
        if (typeof node.value === 'string') this.err(node, tr('err.stringValue'));
        if (node.value === null) return this.g.alloc();
        this.err(node, tr('err.unsupportedLiteral', { raw: node.raw }));
        break;
      case 'TemplateLiteral':
        this.err(node, tr('err.templateOnlyOutput'));
        break;
      case 'UnaryExpression': {
        const op = node.operator;
        if (op === '+') return this.evalExpr(node.argument);
        if (op === '!') return this.not(this.evalExpr(node.argument));
        if (op === '-' || op === '~') {
          const t = this.evalExpr(node.argument);
          const r = this.g.alloc();
          if (op === '~') this.g.add(r, 255);
          this.g.moveAdd(t, [[r, -1]]);
          this.g.free(t);
          return r;
        }
        if (op === 'void') {
          this.evalEffect(node.argument);
          return this.g.alloc();
        }
        this.err(node, tr('err.unsupportedOperator', { op }));
        break;
      }
      case 'BinaryExpression':
        return this.binary(node.operator, node.left, node.right, node);
      case 'LogicalExpression':
        return this.logical(node);
      case 'ConditionalExpression': {
        const r = this.g.alloc();
        const c = this.condTemp(node.test);
        const e = this.g.alloc();
        this.g.add(e, 1);
        this.g.loop(c, () => {
          this.g.clear(c);
          this.g.add(e, -1);
          const v = this.evalExpr(node.consequent);
          this.g.moveAdd(v, [[r, 1]]);
          this.g.free(v);
        });
        this.g.loop(e, () => {
          this.g.add(e, -1);
          const v = this.evalExpr(node.alternate);
          this.g.moveAdd(v, [[r, 1]]);
          this.g.free(v);
        });
        this.g.free(e);
        this.g.free(c);
        return r;
      }
      case 'AssignmentExpression':
        return this.assign(node, true)!;
      case 'UpdateExpression':
        return this.update(node, true)!;
      case 'CallExpression':
        return this.call(node, true)!;
      case 'SequenceExpression': {
        node.expressions.slice(0, -1).forEach((e: N) => this.evalEffect(e));
        return this.evalExpr(node.expressions[node.expressions.length - 1]);
      }
      case 'MemberExpression': {
        const lv = this.lvalue(node);
        return this.readLV(lv);
      }
      case 'ParenthesizedExpression':
        return this.evalExpr(node.expression);
    }
    this.err(node, tr('err.unsupportedExpr', { type: node.type }));
  }

  binary(op: string, l: N, r: N, node: N): number {
    const cr = this.constValue(r);
    const cl = this.constValue(l);
    if (cr !== null) return this.binaryConst(op, this.evalExpr(l), cr, node);
    if (cl !== null && ['+', '*', '==', '===', '!=', '!=='].includes(op)) return this.binaryConst(op, this.evalExpr(r), cl, node);
    if (cl !== null && op === '-') {
      const t = this.evalExpr(r);
      const res = this.constTemp(cl);
      this.g.moveAdd(t, [[res, -1]]);
      this.g.free(t);
      return res;
    }
    const a = this.evalExpr(l);
    const b = this.evalExpr(r);
    return this.binaryCells(op, a, b, node);
  }

  binaryConst(op: string, a: number, c: number, node: N): number {
    const g = this.g;
    switch (op) {
      case '+':
        g.addConst(a, c);
        return a;
      case '-':
        g.addConst(a, -c);
        return a;
      case '*': {
        const r = g.alloc();
        let f = wrap(c);
        if (f > 128) f -= 256;
        if (f !== 0) g.moveAdd(a, [[r, f]]);
        g.release(a);
        return r;
      }
      case '/':
      case '%': {
        if (c === 0) this.err(node, tr('err.divByZero'));
        const { q, r } = this.divmodConst(a, c);
        const [keep, drop] = op === '/' ? [q, r] : [r, q];
        g.release(drop);
        return keep;
      }
      case '==':
      case '===':
        g.addConst(a, -c);
        return this.not(a);
      case '!=':
      case '!==':
        g.addConst(a, -c);
        return this.toBool(a);
      case '&':
        if ((c & (c + 1)) === 0) return this.binaryConst('%', a, c + 1, node);
        break;
      case '<<':
        return this.binaryConst('*', a, wrap(1 << Math.min(c, 8)), node);
      case '>>':
      case '>>>':
        if (c >= 8) {
          g.release(a);
          return g.alloc();
        }
        return this.binaryConst('/', a, 1 << c, node);
    }
    return this.binaryCells(op, a, this.constTemp(c), node);
  }

  binaryCells(op: string, a: number, b: number, node: N): number {
    const g = this.g;
    switch (op) {
      case '+':
        g.moveAdd(b, [[a, 1]]);
        g.free(b);
        return a;
      case '-':
        g.moveAdd(b, [[a, -1]]);
        g.free(b);
        return a;
      case '*': {
        const r = g.alloc();
        const t = g.alloc();
        g.loop(a, () => {
          g.add(a, -1);
          g.moveAdd(b, [
            [r, 1],
            [t, 1],
          ]);
          g.moveAdd(t, [[b, 1]]);
        });
        g.free(t);
        g.release(b);
        g.free(a);
        return r;
      }
      case '/':
      case '%': {
        const { q, r } = this.divmodDyn(a, b);
        const [keep, drop] = op === '/' ? [q, r] : [r, q];
        g.release(drop);
        return keep;
      }
      case '==':
      case '===':
        g.moveAdd(b, [[a, -1]]);
        g.free(b);
        return this.not(a);
      case '!=':
      case '!==':
        g.moveAdd(b, [[a, -1]]);
        g.free(b);
        return this.toBool(a);
      case '<':
        return this.lt(a, b);
      case '>':
        return this.lt(b, a);
      case '<=':
        return this.not(this.lt(b, a));
      case '>=':
        return this.not(this.lt(a, b));
    }
    this.err(node, tr('err.unsupportedBinary', { op }));
  }

  /** r = !t (t consumed). */
  not(t: number): number {
    const r = this.g.alloc();
    this.g.add(r, 1);
    this.g.loop(t, () => {
      this.g.clear(t);
      this.g.add(r, -1);
    });
    this.g.free(t);
    return r;
  }

  /** r = t ? 1 : 0 (t consumed). */
  toBool(t: number): number {
    const r = this.g.alloc();
    this.g.loop(t, () => {
      this.g.clear(t);
      this.g.add(r, 1);
    });
    this.g.free(t);
    return r;
  }

  /** r = a < b (both consumed). */
  lt(a: number, b: number): number {
    const g = this.g;
    const r = g.alloc();
    const s = g.alloc();
    const e = g.alloc();
    g.loop(b, () => {
      g.add(b, -1);
      g.moveAdd(a, [[s, 1]]);
      g.add(e, 1);
      g.loop(s, () => {
        g.add(s, -1);
        g.moveAdd(s, [[a, 1]]);
        g.add(e, -1);
      });
      g.loop(e, () => {
        g.add(e, -1);
        g.clear(r);
        g.add(r, 1);
      });
    });
    g.release(a);
    g.free(b);
    g.free(s);
    g.free(e);
    return r;
  }

  /** Divide n (consumed) by d (consumed, must be >= 2 at runtime). */
  divmodCells(n: number, d: number): { q: number; r: number } {
    const g = this.g;
    const B = g.allocBlock(9);
    g.moveAdd(n, [[B + 3, 1]]);
    g.free(n);
    g.moveAdd(d, [[B + 4, 1]]);
    g.free(d);
    g.dynamic(B + 3, DIVMOD, B + 3);
    g.clear(B + 4);
    for (const k of [0, 1, 2, 3, 4, 7, 8]) g.free(B + k);
    return { q: B + 6, r: B + 5 };
  }

  divmodConst(n: number, c: number): { q: number; r: number } {
    if (c === 1) return { q: n, r: this.g.alloc() };
    return this.divmodCells(n, this.constTemp(c));
  }

  /** Division by a runtime value; x/0 = 0 and x%0 = 0. */
  divmodDyn(n: number, d: number): { q: number; r: number } {
    const g = this.g;
    const q = g.alloc();
    const r = g.alloc();
    // big = d >= 2
    const t = g.copy(d);
    const big = g.alloc();
    g.loop(t, () => {
      g.add(t, -1);
      g.loop(t, () => {
        g.clear(t);
        g.add(big, 1);
      });
    });
    g.free(t);
    const e = g.alloc();
    g.add(e, 1);
    g.loop(big, () => {
      g.add(big, -1);
      g.add(e, -1);
      const res = this.divmodCells(n, d);
      g.moveAdd(res.q, [[q, 1]]);
      g.moveAdd(res.r, [[r, 1]]);
      g.free(res.q);
      g.free(res.r);
    });
    g.loop(e, () => {
      g.add(e, -1);
      // d is 0 or 1: q = n * d
      g.loop(d, () => {
        g.clear(d);
        g.moveAdd(n, [[q, 1]]);
      });
    });
    g.free(e);
    g.free(big);
    g.release(n);
    g.release(d);
    return { q, r };
  }

  logical(node: N): number {
    const g = this.g;
    if (node.operator === '&&') {
      const r = g.alloc();
      const a = this.condTemp(node.left);
      g.loop(a, () => {
        g.clear(a);
        const b = this.evalExpr(node.right);
        g.moveAdd(b, [[r, 1]]);
        g.free(b);
      });
      g.free(a);
      return r;
    }
    if (node.operator === '||' || node.operator === '??') {
      const r = this.evalExpr(node.left);
      if (node.operator === '??') return r;
      const c = g.copy(r);
      const e = g.alloc();
      g.add(e, 1);
      g.loop(c, () => {
        g.clear(c);
        g.add(e, -1);
      });
      g.free(c);
      g.loop(e, () => {
        g.add(e, -1);
        const b = this.evalExpr(node.right);
        g.moveAdd(b, [[r, 1]]);
        g.free(b);
      });
      g.free(e);
      return r;
    }
    this.err(node, tr('err.unsupportedOperator', { op: node.operator }));
  }

  // ───────────────────────── lvalues / arrays ─────────────────────────

  lvalue(node: N): { cell: number } | { arr: Extract<Sym, { kind: 'array' }>; idx: number } {
    if (node.type === 'Identifier') {
      const s = this.scope.lookup(node.name);
      if (!s) this.err(node, tr('err.undefined', { name: node.name }));
      if (s.kind === 'const') this.err(node, tr('err.assignConst', { name: node.name }));
      if (s.kind !== 'var') this.err(node, tr('err.notAssignable', { name: node.name }));
      return { cell: s.cell };
    }
    if (node.type === 'MemberExpression' && node.computed) {
      if (node.object.type !== 'Identifier') this.err(node, tr('err.arrayByName'));
      const s = this.scope.lookup(node.object.name);
      if (!s || s.kind !== 'array') this.err(node.object, tr('err.notArray', { name: node.object.name }));
      const k = this.constValueRaw(node.property);
      if (k !== null) {
        if (k < 0 || k >= s.length) this.err(node.property, tr('err.indexOutOfRange', { k, len: s.length }));
        return { cell: this.elemCell(s, k) };
      }
      return { arr: s, idx: this.evalExpr(node.property) };
    }
    this.err(node, tr('err.badAssignTarget'));
  }

  readLV(lv: ReturnType<Compiler['lvalue']>): number {
    if ('cell' in lv) return this.g.copy(lv.cell);
    return this.arrayRead(lv.arr, lv.idx);
  }

  arrayRead(arr: Extract<Sym, { kind: 'array' }>, idx: number): number {
    const g = this.g;
    const head = arr.base;
    g.add(idx, 1);
    g.moveAdd(idx, [[head + 1, 1]]);
    g.free(idx);
    g.dynamic(head + 1, ARR_FWD + ARR_READ + ARR_BACK_CARRY, head);
    const r = g.alloc();
    g.moveAdd(head + 2, [[r, 1]]);
    return r;
  }

  arrayWrite(arr: Extract<Sym, { kind: 'array' }>, idx: number, val: number) {
    const g = this.g;
    const head = arr.base;
    g.add(idx, 1);
    g.moveAdd(idx, [[head + 1, 1]]);
    g.free(idx);
    g.moveAdd(val, [[head + 2, 1]]);
    g.free(val);
    g.dynamic(head + 1, ARR_FWD + ARR_WRITE + ARR_BACK, head);
  }

  assign(node: N, want: boolean): number | null {
    const g = this.g;
    const op: string = node.operator;
    const lv = this.lvalue(node.left);
    if ('cell' in lv) {
      const cell = lv.cell;
      const cv = this.constValue(node.right);
      if (op === '=') {
        const t = cv !== null ? null : this.evalExpr(node.right);
        g.clear(cell);
        if (t === null) g.addConst(cell, cv!);
        else {
          g.moveAdd(t, [[cell, 1]]);
          g.free(t);
        }
      } else if ((op === '+=' || op === '-=') && cv !== null) {
        g.addConst(cell, op === '+=' ? cv : -cv);
      } else if (op === '+=' || op === '-=') {
        const t = this.evalExpr(node.right);
        g.moveAdd(t, [[cell, op === '+=' ? 1 : -1]]);
        g.free(t);
      } else {
        const bop = op.slice(0, -1);
        const cur = g.copy(cell);
        const t = cv !== null ? this.binaryConst(bop, cur, cv, node) : this.binaryCells(bop, cur, this.evalExpr(node.right), node);
        g.clear(cell);
        g.moveAdd(t, [[cell, 1]]);
        g.free(t);
      }
      return want ? g.copy(cell) : null;
    }
    // array element with runtime index
    let val: number;
    if (op === '=') val = this.evalExpr(node.right);
    else {
      const bop = op.slice(0, -1);
      const cur = this.arrayRead(lv.arr, g.copy(lv.idx));
      const cv = this.constValue(node.right);
      val = cv !== null ? this.binaryConst(bop, cur, cv, node) : this.binaryCells(bop, cur, this.evalExpr(node.right), node);
    }
    const out = want ? g.copy(val) : null;
    this.arrayWrite(lv.arr, lv.idx, val);
    return out;
  }

  update(node: N, want: boolean): number | null {
    const g = this.g;
    const delta = node.operator === '++' ? 1 : -1;
    const lv = this.lvalue(node.argument);
    if ('cell' in lv) {
      let before: number | null = null;
      if (want && !node.prefix) before = g.copy(lv.cell);
      g.add(lv.cell, delta);
      if (want && node.prefix) return g.copy(lv.cell);
      return before;
    }
    const cur = this.arrayRead(lv.arr, g.copy(lv.idx));
    const before = want && !node.prefix ? g.copy(cur) : null;
    g.add(cur, delta);
    const after = want && node.prefix ? g.copy(cur) : null;
    this.arrayWrite(lv.arr, lv.idx, cur);
    return before ?? after;
  }

  // ───────────────────────── calls / builtins ─────────────────────────

  call(node: N, want: boolean): number | null {
    const g = this.g;
    const c = node.callee;
    const args: N[] = node.arguments;
    const none = () => (want ? g.alloc() : null);

    if (c.type === 'Identifier') {
      switch (c.name) {
        case 'getchar': {
          const t = g.alloc();
          g.input(t);
          return want ? t : (g.release(t), null);
        }
        case 'putchar':
          this.printItems([{ t: 'char', node: args[0] }]);
          return none();
        case 'print':
          this.printArgs(args, '', '');
          return none();
      }
      const s = this.scope.lookup(c.name);
      if (s?.kind === 'func') {
        const r = this.inline(s.def, args, node);
        if (want) return r;
        g.release(r);
        return null;
      }
      this.err(c, tr('err.undefined', { name: c.name }));
    }

    if (c.type === 'MemberExpression' && !c.computed) {
      const obj = c.object.type === 'Identifier' ? c.object.name : c.object.type === 'MemberExpression' && !c.object.computed ? `${c.object.object.name}.${c.object.property.name}` : null;
      const prop = c.property.name;
      if (obj === 'console' && (prop === 'log' || prop === 'info')) {
        this.printArgs(args, ' ', '\n');
        return none();
      }
      if (obj === 'process.stdout' && prop === 'write') {
        this.printArgs(args, '', '');
        return none();
      }
      if (obj === 'String' && prop === 'fromCharCode') return want ? this.evalExpr(args[0]) : (this.evalEffect(args[0]), null);
      if (obj === 'Math') {
        if (['floor', 'ceil', 'round', 'trunc', 'abs'].includes(prop)) return want ? this.evalExpr(args[0]) : (this.evalEffect(args[0]), null);
        if (prop === 'min' || prop === 'max') {
          if (args.length !== 2) this.err(node, tr('err.mathArgs', { fn: prop }));
          const a = this.evalExpr(args[0]);
          const b = this.evalExpr(args[1]);
          const less = this.lt(g.copy(a), g.copy(b));
          // min: less ? a : b   max: less ? b : a
          const [ifLess, otherwise] = prop === 'min' ? [a, b] : [b, a];
          const r = g.alloc();
          const e = g.alloc();
          g.add(e, 1);
          g.loop(less, () => {
            g.add(less, -1);
            g.add(e, -1);
            g.moveAdd(ifLess, [[r, 1]]);
          });
          g.loop(e, () => {
            g.add(e, -1);
            g.moveAdd(otherwise, [[r, 1]]);
          });
          g.free(e);
          g.free(less);
          g.release(a);
          g.release(b);
          return want ? r : (g.release(r), null);
        }
      }
      if (prop === 'charCodeAt' && c.object.type === 'Identifier') {
        const s = this.scope.lookup(c.object.name);
        if (s?.kind === 'array') {
          const lv = this.lvalue({ type: 'MemberExpression', computed: true, object: c.object, property: args[0] ?? { type: 'Literal', value: 0 }, loc: node.loc });
          const r = this.readLV(lv);
          return want ? r : (g.release(r), null);
        }
      }
      this.err(node, tr('err.unsupportedMethod', { name: `${obj ?? '?'}.${prop}` }));
    }
    this.err(node, tr('err.unsupportedCall'));
  }

  inline(def: FuncDef, args: N[], node: N): number {
    if (this.inlineStack.includes(def.name)) this.err(node, tr('err.recursion', { chain: [...this.inlineStack, def.name].join(' → ') }));
    if (this.inlineStack.length > 32) this.err(node, tr('err.tooDeep'));
    const bindings: Array<[string, Sym]> = [];
    def.params.forEach((p: N, i: number) => {
      const a = args[i];
      if (a?.type === 'Identifier') {
        const s = this.scope.lookup(a.name);
        if (s?.kind === 'array') return bindings.push([p.name, s]);
      }
      const cell = a ? this.evalExpr(a) : this.g.alloc();
      bindings.push([p.name, { kind: 'var', cell }]);
    });
    for (let i = def.params.length; i < args.length; i++) this.evalEffect(args[i]);

    const retCell = this.g.alloc();
    const nret = countReturns(def.body);
    const tail = def.body[def.body.length - 1]?.type === 'ReturnStatement';
    const retFlag = nret - (tail ? 1 : 0) > 0 ? this.g.alloc() : null;

    const saved = { scope: this.scope, fn: this.fn, loops: this.loops };
    this.scope = new Scope(def.scope);
    for (const [name, sym] of bindings) this.scope.vars.set(name, sym);
    this.fn = { retCell, retFlag };
    this.loops = [];
    this.inlineStack.push(def.name);
    this.pushScope();
    this.hoist(def.body);
    this.compileStatements(def.body);
    this.popScope();
    this.inlineStack.pop();
    for (const [, sym] of bindings) if (sym.kind === 'var') this.g.release(sym.cell);
    if (retFlag != null) this.g.release(retFlag);
    Object.assign(this, saved);
    return retCell;
  }

  // ───────────────────────── output ─────────────────────────

  printArgs(args: N[], sep: string, end: string) {
    const items: PrintItem[] = [];
    args.forEach((a, i) => {
      if (i > 0 && sep) items.push({ t: 'str', s: sep });
      this.printable(a, items);
    });
    if (end) items.push({ t: 'str', s: end });
    this.printItems(items);
  }

  isStringy(n: N): boolean {
    if (n.type === 'Literal' && typeof n.value === 'string') return true;
    if (n.type === 'TemplateLiteral') return true;
    if (n.type === 'BinaryExpression' && n.operator === '+') return this.isStringy(n.left) || this.isStringy(n.right);
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.name === 'String') return true;
    if (n.type === 'Identifier') {
      const s = this.scope.lookup(n.name);
      return s?.kind === 'array' && s.isString;
    }
    return false;
  }

  printable(n: N, items: PrintItem[]) {
    if (n.type === 'Literal') {
      if (typeof n.value === 'string') return items.push({ t: 'str', s: n.value });
      if (typeof n.value === 'boolean') return items.push({ t: 'str', s: String(n.value) });
    }
    if (n.type === 'TemplateLiteral') {
      n.quasis.forEach((q: N, i: number) => {
        items.push({ t: 'str', s: q.value.cooked ?? '' });
        if (i < n.expressions.length) this.printable(n.expressions[i], items);
      });
      return;
    }
    if (n.type === 'BinaryExpression' && n.operator === '+' && this.isStringy(n)) {
      this.printable(n.left, items);
      this.printable(n.right, items);
      return;
    }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.name === 'String' && n.callee.property.name === 'fromCharCode') {
      for (const a of n.arguments) items.push({ t: 'char', node: a });
      return;
    }
    if (n.type === 'Identifier') {
      const s = this.scope.lookup(n.name);
      if (s?.kind === 'array') {
        for (let k = 0; k < s.length; k++) {
          if (!s.isString && k > 0) items.push({ t: 'str', s: ',' });
          items.push({ t: 'cell', cell: this.elemCell(s, k), asChar: s.isString });
        }
        return;
      }
    }
    const cv = this.constValue(n);
    if (cv !== null) return items.push({ t: 'str', s: String(cv) });
    items.push({ t: 'num', node: n });
  }

  printItems(items: PrintItem[]) {
    const g = this.g;
    let bytes: number[] = [];
    const flush = () => {
      if (!bytes.length) return;
      const t = g.alloc();
      let cur = 0;
      for (const b of bytes) {
        g.addConst(t, b - cur);
        g.output(t);
        cur = b;
      }
      g.release(t);
      bytes = [];
    };
    for (const it of items) {
      if (it.t === 'str') {
        bytes.push(...utf8(it.s));
        continue;
      }
      flush();
      if (it.t === 'char') {
        const cv = this.constValue(it.node);
        if (cv !== null) {
          bytes.push(cv);
          continue;
        }
        const t = this.evalExpr(it.node);
        g.output(t);
        g.release(t);
      } else if (it.t === 'cell') {
        if (it.asChar) g.output(it.cell);
        else this.printNumber(g.copy(it.cell));
      } else {
        this.printNumber(this.evalExpr(it.node));
      }
    }
    flush();
  }

  /** Print t (consumed) in decimal. */
  printNumber(t: number) {
    const g = this.g;
    const a = this.divmodConst(t, 10); // a.r = ones
    const b = this.divmodConst(a.q, 10); // b.r = tens, b.q = hundreds
    const shown = g.alloc();
    g.loop(b.q, () => {
      g.addConst(b.q, 48);
      g.output(b.q);
      g.clear(b.q);
      g.add(shown, 1);
    });
    g.free(b.q);
    const tc = g.copy(b.r);
    g.loop(tc, () => {
      g.clear(tc);
      g.clear(shown);
      g.add(shown, 1);
    });
    g.free(tc);
    g.loop(shown, () => {
      g.clear(shown);
      g.addConst(b.r, 48);
      g.output(b.r);
    });
    g.free(shown);
    g.release(b.r);
    g.addConst(a.r, 48);
    g.output(a.r);
    g.release(a.r);
  }
}

/** Remove no-op pairs such as `<>` and `+-` produced by naive emission. */
function peephole(bf: string): string {
  const out: string[] = [];
  const inverse: Record<string, string> = { '+': '-', '-': '+', '<': '>', '>': '<' };
  for (const ch of bf) {
    if (out.length && inverse[ch] === out[out.length - 1]) out.pop();
    else out.push(ch);
  }
  return out.join('');
}

export function compileJs(src: string): CompileResult {
  let ast: N;
  try {
    ast = parse(src, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
  } catch (e) {
    const err = e as { message: string; loc?: { line: number; column: number } };
    throw new CompileError(tr('err.syntax', { msg: err.message }), err.loc?.line, err.loc?.column);
  }
  const c = new Compiler();
  c.compileProgram(ast.body);
  return { bf: peephole(c.g.code()), warnings: c.warnings, cells: c.g.maxCell + 1 };
}
