// A tiny expression language behind the programming language widgets: a lexer,
// a parser, a type checker, a constant folder, two code generators and a stack
// machine. Also the heap model for the garbage collection widget and the
// scripts for the ownership widget.

export class LangError extends Error {}

/* ---------- Lexing ---------- */

export type TokenKind = 'number' | 'string' | 'keyword' | 'name' | 'operator' | 'bracket';

export interface Token {
  kind: TokenKind;
  text: string;
  /** Offset of the first character in the source. */
  at: number;
}

const keywords = ['if', 'then', 'else', 'true', 'false'];

// One alternative per kind of token, tried in order at each position.
const patterns: [TokenKind | 'space', RegExp][] = [
  ['space', /\s+/y],
  ['number', /\d+(\.\d+)?/y],
  ['string', /"[^"]*"/y],
  ['name', /[A-Za-z_]\w*/y],
  ['operator', /==|[-+*/<]/y],
  ['bracket', /[()]/y],
];

export function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  scan: while (at < source.length) {
    for (const [kind, pattern] of patterns) {
      pattern.lastIndex = at;
      const text = pattern.exec(source)?.[0];
      if (!text) continue;
      if (kind !== 'space') {
        tokens.push({ kind: kind === 'name' && keywords.includes(text) ? 'keyword' : kind, text, at });
      }
      at += text.length;
      continue scan;
    }
    throw new LangError(
      source[at] === '"'
        ? `The string starting at position ${at + 1} is never closed.`
        : `No token starts with ${source[at]} (position ${at + 1}).`,
    );
  }
  return tokens;
}

/* ---------- Parsing ---------- */

export type Expr =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'name'; name: string }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'if'; test: Expr; then: Expr; else: Expr };

// Loosest first. Every operator groups to the left.
const levels = [['=='], ['<'], ['+', '-'], ['*', '/']];

/** Recursive descent, with one loop per level of precedence. */
export function parse(source: string): Expr {
  const tokens = lex(source);
  let at = 0;
  const peek = () => tokens[at]?.text;
  const expect = (text: string) => {
    if (peek() !== text) throw new LangError(`Expected ${text} but found ${peek() ?? 'the end of the input'}.`);
    at++;
  };
  const expr = (): Expr => {
    if (peek() !== 'if') return binary(0);
    at++;
    const test = expr();
    expect('then');
    const then = expr();
    expect('else');
    return { kind: 'if', test, then, else: expr() };
  };
  const binary = (level: number): Expr => {
    if (level === levels.length) return atom();
    let left = binary(level + 1);
    while (tokens[at]?.kind === 'operator' && levels[level].includes(peek())) {
      const op = tokens[at++].text;
      left = { kind: 'binary', op, left, right: binary(level + 1) };
    }
    return left;
  };
  const atom = (): Expr => {
    const token = tokens[at++];
    if (!token) throw new LangError('The expression stops where a value was expected.');
    if (token.kind === 'number') return { kind: 'number', value: Number(token.text) };
    if (token.kind === 'string') return { kind: 'string', value: token.text.slice(1, -1) };
    if (token.text === 'true' || token.text === 'false') return { kind: 'bool', value: token.text === 'true' };
    if (token.kind === 'name') return { kind: 'name', name: token.text };
    if (token.text === '(') {
      const inner = expr();
      expect(')');
      return inner;
    }
    throw new LangError(`Expected a value but found ${token.text}.`);
  };
  if (!tokens.length) throw new LangError('There is nothing to parse.');
  const result = expr();
  if (at < tokens.length) throw new LangError(`Expected an operator but found ${peek()}.`);
  return result;
}

/* ---------- Trees ---------- */

export interface TreeNode {
  label: string;
  /** Small text beside the node, such as its type. */
  note?: string;
  bad?: boolean;
  children: TreeNode[];
}

const literal = (value: number | string | boolean) =>
  typeof value === 'string' ? `"${value}"` : String(value);

export function toTree(expr: Expr): TreeNode {
  switch (expr.kind) {
    case 'name':
      return { label: expr.name, children: [] };
    case 'binary':
      return { label: expr.op, children: [toTree(expr.left), toTree(expr.right)] };
    case 'if':
      return { label: 'if', children: [toTree(expr.test), toTree(expr.then), toTree(expr.else)] };
    default:
      return { label: literal(expr.value), children: [] };
  }
}

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char]!);

/** The tree as SVG markup, so it can be drawn at build time and redrawn in the browser. */
export function treeSvg(root: TreeNode): string {
  const HEIGHT = 30;
  const ROW = 56;
  const PAD = 10;
  const boxes: string[] = [];
  const lines: string[] = [];
  let nextX = PAD;
  let depthMost = 0;
  const place = (node: TreeNode, depth: number): number => {
    const half = Math.round(Math.max(17, node.label.length * 4.2 + 9));
    // A note sits to the right of its node, so leaves leave room for it.
    const noteWidth = node.note ? node.note.length * 6.6 + 6 : 0;
    const y = PAD + HEIGHT / 2 + depth * ROW;
    depthMost = Math.max(depthMost, depth);
    let x: number;
    if (node.children.length) {
      const xs = node.children.map((child) => place(child, depth + 1));
      x = Math.round((xs[0] + xs[xs.length - 1]) / 2);
      for (const childX of xs) {
        lines.push(`<line class="v-edge" x1="${x}" y1="${y + HEIGHT / 2}" x2="${childX}" y2="${y + ROW - HEIGHT / 2}"/>`);
      }
    } else {
      x = Math.round(nextX + half);
      nextX = x + half + noteWidth + 12;
    }
    boxes.push(
      `<g class="v-node${node.bad ? ' alt' : ''}"><rect x="${x - half}" y="${y - HEIGHT / 2}" width="${half * 2}" height="${HEIGHT}" rx="15"/>` +
        `<text class="v-text" x="${x}" y="${y}">${escape(node.label)}</text>` +
        (node.note ? `<text class="v-small note" x="${x + half + 5}" y="${y}">${escape(node.note)}</text>` : '') +
        '</g>',
    );
    return x;
  };
  place(root, 0);
  const width = Math.ceil(nextX - 12 + PAD);
  const height = PAD * 2 + HEIGHT + depthMost * ROW;
  return `<svg class="viz-svg" viewBox="0 0 ${width} ${height}" style="width:clamp(${Math.round(width * 0.7)}px,100%,${width}px);height:auto" role="img" aria-label="Syntax tree">${lines.join('')}${boxes.join('')}</svg>`;
}

/* ---------- Type checking ---------- */

export type Type = 'number' | 'string' | 'boolean';

/** Names the widgets treat as already declared, with their run-time values. */
export const globals: Record<string, number | string | boolean> = { n: 5, s: 'tea', ok: true };

/**
 * Works out a type for every node, bottom up. The result is the syntax tree
 * with each node's type as its note, plus the first error found, if any.
 */
export function typeCheck(expr: Expr): { tree: TreeNode; type?: Type; error?: string } {
  let error: string | undefined;
  const visit = (node: Expr): [TreeNode, Type | undefined] => {
    const tree = toTree(node);
    const fail = (message: string): [TreeNode, undefined] => {
      error ??= message;
      return [{ ...tree, note: 'error', bad: true }, undefined];
    };
    const done = (type: Type | undefined): [TreeNode, Type | undefined] => [{ ...tree, note: type ?? '?' }, type];
    switch (node.kind) {
      case 'number':
        return done('number');
      case 'string':
        return done('string');
      case 'bool':
        return done('boolean');
      case 'name': {
        if (!(node.name in globals)) return fail(`${node.name} has not been declared.`);
        return done(typeof globals[node.name] as Type);
      }
      case 'binary': {
        const [left, a] = visit(node.left);
        const [right, b] = visit(node.right);
        tree.children = [left, right];
        // An error below has already been reported: do not pile another on top.
        if (!a || !b) return done(undefined);
        if (node.op === '==') return a === b ? done('boolean') : fail(`== compares two values of the same type, not a ${a} with a ${b}.`);
        if (node.op === '+' && a === 'string' && b === 'string') return done('string');
        if (a !== 'number' || b !== 'number') {
          return fail(`${node.op} needs two numbers${node.op === '+' ? ' or two strings' : ''}, but was given a ${a} and a ${b}.`);
        }
        return done(node.op === '<' ? 'boolean' : 'number');
      }
      case 'if': {
        const [test, t] = visit(node.test);
        const [then, a] = visit(node.then);
        const [other, b] = visit(node.else);
        tree.children = [test, then, other];
        if (!t || !a || !b) return done(undefined);
        if (t !== 'boolean') return fail(`The condition of an if must be a boolean, not a ${t}.`);
        if (a !== b) return fail(`Both branches of an if must have the same type, but these are a ${a} and a ${b}.`);
        return done(a);
      }
    }
  };
  const [tree, type] = visit(expr);
  return { tree, type, error };
}

/* ---------- Optimising ---------- */

const apply = (op: string, a: number | string | boolean, b: number | string | boolean) => {
  if (op === '==') {
    if (typeof a !== typeof b) throw new LangError(`Cannot compare a ${typeof a} with a ${typeof b}.`);
    return a === b;
  }
  if (op === '+' && typeof a === 'string' && typeof b === 'string') return a + b;
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new LangError(`${op} cannot be applied to a ${typeof a} and a ${typeof b}.`);
  }
  if (op === '/' && b === 0) throw new LangError('Division by zero.');
  return { '+': a + b, '-': a - b, '*': a * b, '/': a / b, '<': a < b }[op]!;
};

const constant = (value: number | string | boolean): Expr =>
  typeof value === 'number' ? { kind: 'number', value } : typeof value === 'string' ? { kind: 'string', value } : { kind: 'bool', value };

/** Constant folding, two identities and removal of branches that can never run. */
export function fold(expr: Expr): Expr {
  if (expr.kind === 'if') {
    const test = fold(expr.test);
    if (test.kind === 'bool') return fold(test.value ? expr.then : expr.else);
    return { kind: 'if', test, then: fold(expr.then), else: fold(expr.else) };
  }
  if (expr.kind !== 'binary') return expr;
  const left = fold(expr.left);
  const right = fold(expr.right);
  const known = (node: Expr): node is Extract<Expr, { value: unknown }> => 'value' in node;
  if (known(left) && known(right)) {
    try {
      return constant(apply(expr.op, left.value, right.value));
    } catch {
      // Leave anything that would fail to fail at run time.
    }
  }
  const is = (node: Expr, value: number) => node.kind === 'number' && node.value === value;
  if ((expr.op === '+' || expr.op === '-') && is(right, 0)) return left;
  if (expr.op === '+' && is(left, 0)) return right;
  if ((expr.op === '*' || expr.op === '/') && is(right, 1)) return left;
  if (expr.op === '*' && is(left, 1)) return right;
  return { ...expr, left, right };
}

export function unparse(expr: Expr): string {
  switch (expr.kind) {
    case 'name':
      return expr.name;
    case 'binary':
      return `(${unparse(expr.left)} ${expr.op} ${unparse(expr.right)})`;
    case 'if':
      return `if ${unparse(expr.test)} then ${unparse(expr.then)} else ${unparse(expr.else)}`;
    default:
      return literal(expr.value);
  }
}

/* ---------- Code generation ---------- */

/** Three-address code: every line does one operation and names its result. */
export function toThreeAddress(expr: Expr): string[] {
  const lines: string[] = [];
  let temps = 0;
  let labels = 0;
  const visit = (node: Expr): string => {
    if (node.kind === 'name') return node.name;
    if (node.kind === 'binary') {
      const left = visit(node.left);
      const right = visit(node.right);
      const temp = `t${++temps}`;
      lines.push(`${temp} = ${left} ${node.op} ${right}`);
      return temp;
    }
    if (node.kind === 'if') {
      const test = visit(node.test);
      const otherwise = `L${++labels}`;
      const end = `L${++labels}`;
      const result = `t${++temps}`;
      lines.push(`if not ${test} goto ${otherwise}`);
      lines.push(`${result} = ${visit(node.then)}`, `goto ${end}`, `${otherwise}:`);
      lines.push(`${result} = ${visit(node.else)}`, `${end}:`);
      return result;
    }
    return literal(node.value);
  };
  lines.push(`result = ${visit(expr)}`);
  return lines;
}

export type Instruction = [op: string, arg?: number | string | boolean];

const opcodes: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '<': 'less', '==': 'equal' };

/** Code for a stack machine: operands are pushed, and each operator pops two and pushes one. */
export function toStackCode(expr: Expr): Instruction[] {
  const code: Instruction[] = [];
  const visit = (node: Expr) => {
    if (node.kind === 'name') {
      code.push(['load', node.name]);
    } else if (node.kind === 'binary') {
      visit(node.left);
      visit(node.right);
      code.push([opcodes[node.op]]);
    } else if (node.kind === 'if') {
      visit(node.test);
      const skip: Instruction = ['jump_if_false'];
      code.push(skip);
      visit(node.then);
      const leave: Instruction = ['jump'];
      code.push(leave);
      // Jump targets are known only once the code in between has been emitted.
      skip[1] = code.length;
      visit(node.else);
      leave[1] = code.length;
    } else {
      code.push(['push', node.value]);
    }
  };
  visit(expr);
  return code;
}

export const showInstruction = ([op, arg]: Instruction) =>
  arg === undefined ? op : `${op} ${op === 'push' ? literal(arg) : arg}`;

export interface VmFrame {
  /** Index of the instruction about to run, or the code length once finished. */
  pc: number;
  stack: string[];
  note: string;
  error?: boolean;
}

/** Runs stack code, recording the machine before each instruction and at the end. */
export function runStackCode(code: Instruction[]): VmFrame[] {
  const stack: (number | string | boolean)[] = [];
  const frames: VmFrame[] = [];
  const snap = (pc: number, note: string, error?: boolean) =>
    frames.push({ pc, stack: stack.map(literal), note, error });
  const symbol = Object.fromEntries(Object.entries(opcodes).map(([sign, name]) => [name, sign]));
  let pc = 0;
  snap(0, 'The stack starts empty.');
  while (pc < code.length && frames.length < 200) {
    const [op, arg] = code[pc];
    let note: string;
    try {
      if (op === 'push') {
        stack.push(arg!);
        note = `Push ${literal(arg!)}.`;
      } else if (op === 'load') {
        if (!((arg as string) in globals)) throw new LangError(`There is no variable called ${arg}.`);
        stack.push(globals[arg as string]);
        note = `Look up ${arg} and push its value, ${literal(globals[arg as string])}.`;
      } else if (op === 'jump') {
        pc = (arg as number) - 1;
        note = `Jump to instruction ${arg}.`;
      } else if (op === 'jump_if_false') {
        const test = stack.pop();
        if (typeof test !== 'boolean') throw new LangError(`An if needs a boolean, not a ${typeof test}.`);
        note = test ? 'Pop true. Carry on with the next instruction.' : `Pop false. Jump to instruction ${arg}.`;
        if (!test) pc = (arg as number) - 1;
      } else {
        const right = stack.pop()!;
        const left = stack.pop()!;
        const result = apply(symbol[op], left, right);
        stack.push(result);
        note = `Pop ${literal(right)} and ${literal(left)}, push ${literal(left)} ${symbol[op]} ${literal(right)} = ${literal(result)}.`;
      }
    } catch (error) {
      snap(pc, `Run-time error. ${(error as Error).message}`, true);
      return frames;
    }
    pc++;
    snap(pc, note);
  }
  frames[frames.length - 1].note += ` Finished: the answer is ${literal(stack[stack.length - 1])}.`;
  return frames;
}

/* ---------- Garbage collection ---------- */

export const heap = {
  /** Variable name to the object it refers to. */
  roots: { x: 'A', y: 'E' } as Record<string, string>,
  objects: { A: [1, 0.5], B: [2, 0], C: [2, 1], D: [3, 1], E: [1, 2], F: [2, 2] } as Record<string, [number, number]>,
  refs: [
    ['A', 'B'],
    ['A', 'C'],
    ['B', 'D'],
    ['C', 'D'],
    ['E', 'F'],
    ['F', 'E'],
    ['F', 'D'],
  ] as [string, string][],
  rootAt: { x: [0, 0.5], y: [0, 2] } as Record<string, [number, number]>,
};

/** Objects that can be reached by following references from the given variables. */
export function reachable(roots: string[]): Set<string> {
  const seen = new Set<string>();
  const todo = roots.map((root) => heap.roots[root]);
  while (todo.length) {
    const object = todo.pop()!;
    if (seen.has(object)) continue;
    seen.add(object);
    for (const [from, to] of heap.refs) if (from === object) todo.push(to);
  }
  return seen;
}

/** How many references point at each object, from live variables and unfreed objects. */
export function refCounts(roots: string[], freed: Set<string>): Record<string, number> {
  const counts = Object.fromEntries(Object.keys(heap.objects).map((name) => [name, 0]));
  for (const root of roots) counts[heap.roots[root]]++;
  for (const [from, to] of heap.refs) if (!freed.has(from)) counts[to]++;
  return counts;
}

/** Frees every object whose count is zero, and whatever that releases in turn. */
export function releaseUnreferenced(roots: string[], freed: Set<string>): Set<string> {
  const result = new Set(freed);
  for (;;) {
    const counts = refCounts(roots, result);
    const dead = Object.keys(counts).filter((name) => counts[name] === 0 && !result.has(name));
    if (!dead.length) return result;
    dead.forEach((name) => result.add(name));
  }
}

/* ---------- Ownership ---------- */

export interface OwnershipStep {
  /** Index of the line about to be checked. */
  line: number;
  /** Variable, what it holds or why it cannot be used, and a tone for the display. */
  vars: [name: string, state: string, tone?: 'ok' | 'gone' | 'borrowed'][];
  note: string;
  error?: boolean;
}

export interface OwnershipScript {
  code: string[];
  steps: OwnershipStep[];
}

export const ownershipScripts = {
  move: {
    code: ['let a = String::from("hi");', 'let b = a;', 'println!("{}", a);'],
    steps: [
      { line: 0, vars: [['a', 'owns the string', 'ok']], note: 'a owns the string. When a goes out of scope, the string is freed.' },
      {
        line: 1,
        vars: [['a', 'moved from, unusable', 'gone'], ['b', 'owns the string', 'ok']],
        note: 'Assigning moves ownership to b. Nothing is copied, and a is no longer valid.',
      },
      {
        line: 2,
        vars: [['a', 'moved from, unusable', 'gone'], ['b', 'owns the string', 'ok']],
        note: 'Compile error: borrow of moved value a. The compiler knows a gave its string away on the line before.',
        error: true,
      },
    ],
  },
  shared: {
    code: ['let a = String::from("hi");', 'let r1 = &a;', 'let r2 = &a;', 'println!("{} {}", r1, r2);'],
    steps: [
      { line: 0, vars: [['a', 'owns the string', 'ok']], note: 'a owns the string.' },
      {
        line: 1,
        vars: [['a', 'owner, lent out to read', 'borrowed'], ['r1', 'shared borrow of a', 'ok']],
        note: 'r1 borrows a. It can read the string but does not own it.',
      },
      {
        line: 2,
        vars: [['a', 'owner, lent out to read', 'borrowed'], ['r1', 'shared borrow of a', 'ok'], ['r2', 'shared borrow of a', 'ok']],
        note: 'A second shared borrow is fine. Any number of readers may exist together.',
      },
      {
        line: 3,
        vars: [['a', 'owns the string', 'ok']],
        note: 'Both borrows are used for the last time here, so they end. This compiles.',
      },
    ],
  },
  mutable: {
    code: ['let mut a = String::from("hi");', 'let r = &a;', "a.push('!');", 'println!("{}", r);'],
    steps: [
      { line: 0, vars: [['a', 'owns the string', 'ok']], note: 'a owns the string and is declared mutable.' },
      {
        line: 1,
        vars: [['a', 'owner, lent out to read', 'borrowed'], ['r', 'shared borrow of a', 'ok']],
        note: 'r borrows a for reading. The borrow lasts until r is last used, on line 4.',
      },
      {
        line: 2,
        vars: [['a', 'owner, lent out to read', 'borrowed'], ['r', 'shared borrow of a', 'ok']],
        note: 'Compile error: cannot borrow a as mutable because it is also borrowed as immutable. Pushing might move the string in memory and leave r pointing at freed space.',
        error: true,
      },
    ],
  },
  dangling: {
    code: ['let r;', '{', '    let a = String::from("hi");', '    r = &a;', '}', 'println!("{}", r);'],
    steps: [
      { line: 0, vars: [['r', 'declared, not yet set']], note: 'r is declared in the outer scope.' },
      { line: 2, vars: [['r', 'declared, not yet set'], ['a', 'owns the string', 'ok']], note: 'a owns the string, inside the inner scope.' },
      {
        line: 3,
        vars: [['r', 'shared borrow of a', 'ok'], ['a', 'owner, lent out to read', 'borrowed']],
        note: 'r borrows a. But r will outlive a.',
      },
      {
        line: 4,
        vars: [['r', 'would point at freed memory', 'gone'], ['a', 'dropped, string freed', 'gone']],
        note: 'Compile error: a does not live long enough. The scope ends and a is dropped while r still borrows it.',
        error: true,
      },
    ],
  },
} satisfies Record<string, OwnershipScript>;

export type OwnershipName = keyof typeof ownershipScripts;
