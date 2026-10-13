// Simulations behind the theory of computation widgets: finite automata,
// regular expressions, a pushdown automaton, Turing machines, the lambda
// calculus and two brute-force searches.

/* ---------- Finite automata ---------- */

export interface Machine {
  /** State name to `[column, row]` on a grid; fractions are fine. */
  states: Record<string, [number, number]>;
  start: string;
  accept: string[];
  /**
   * `[from, to, symbols, bend?]`. Symbols are comma separated and `ε` moves
   * without reading. `bend` bows the arrow away from a straight line.
   */
  edges: [string, string, string, number?][];
  /** The symbols the reader may type. */
  alphabet?: string;
  /** What the machine accepts, in words. */
  accepts?: string;
}

export const machines = {
  'even-zeros': {
    states: { even: [0, 0], odd: [1.6, 0] },
    start: 'even',
    accept: ['even'],
    edges: [
      ['even', 'even', '1'],
      ['even', 'odd', '0'],
      ['odd', 'even', '0'],
      ['odd', 'odd', '1'],
    ],
    alphabet: '01',
    accepts: 'an even number of 0s',
  },
  'divisible-by-3': {
    states: { r0: [0, 0], r1: [1.6, 0], r2: [3.2, 0] },
    start: 'r0',
    accept: ['r0'],
    edges: [
      ['r0', 'r0', '0'],
      ['r0', 'r1', '1'],
      ['r1', 'r0', '1'],
      ['r1', 'r2', '0'],
      ['r2', 'r1', '0'],
      ['r2', 'r2', '1'],
    ],
    alphabet: '01',
    accepts: 'a binary number divisible by 3',
  },
  'ends-01': {
    states: { q0: [0, 0], q1: [1.6, 0], q2: [3.2, 0] },
    start: 'q0',
    accept: ['q2'],
    edges: [
      ['q0', 'q0', '0,1'],
      ['q0', 'q1', '0'],
      ['q1', 'q2', '1'],
    ],
    alphabet: '01',
    accepts: 'a string ending in 01',
  },
  'ends-01-dfa': {
    states: { A: [0, 0], B: [1.6, 0], C: [3.2, 0] },
    start: 'A',
    accept: ['C'],
    edges: [
      ['A', 'A', '1'],
      ['A', 'B', '0'],
      ['B', 'B', '0'],
      ['B', 'C', '1'],
      ['C', 'B', '0'],
      ['C', 'A', '1', 62],
    ],
    alphabet: '01',
    accepts: 'a string ending in 01',
  },
} satisfies Record<string, Machine>;

export type MachineName = keyof typeof machines;

const reads = (label: string, symbol: string) => label.split(',').includes(symbol);

/** Everything reachable from `states` by ε moves alone, in declaration order. */
export function closure(machine: Machine, states: string[]): string[] {
  const seen = new Set(states);
  const todo = [...states];
  while (todo.length) {
    const state = todo.pop()!;
    for (const [from, to, label] of machine.edges) {
      if (from === state && reads(label, 'ε') && !seen.has(to)) {
        seen.add(to);
        todo.push(to);
      }
    }
  }
  return Object.keys(machine.states).filter((state) => seen.has(state));
}

/**
 * The set of states the machine could be in after each prefix of `input`, so
 * the result has one more entry than the input has symbols. A deterministic
 * machine never has more than one state in a set.
 */
export function runMachine(machine: Machine, input: string): string[][] {
  const sets = [closure(machine, [machine.start])];
  for (const symbol of input) {
    const current = sets[sets.length - 1];
    const next = machine.edges
      .filter(([from, , label]) => current.includes(from) && reads(label, symbol))
      .map(([, to]) => to);
    sets.push(closure(machine, next));
  }
  return sets;
}

export const accepts = (machine: Machine, states: string[]) =>
  states.some((state) => machine.accept.includes(state));

/* ---------- Regular expressions ---------- */

type Ast =
  | { kind: 'empty' }
  | { kind: 'char'; char: string }
  | { kind: 'any' }
  | { kind: 'cat' | 'alt'; left: Ast; right: Ast }
  | { kind: 'star' | 'plus' | 'optional'; inner: Ast };

function parseRegex(source: string): Ast {
  let at = 0;
  const alternation = (): Ast => {
    let left = sequence();
    while (source[at] === '|') {
      at++;
      left = { kind: 'alt', left, right: sequence() };
    }
    return left;
  };
  const sequence = (): Ast => {
    let left: Ast = { kind: 'empty' };
    while (at < source.length && source[at] !== '|' && source[at] !== ')') {
      const right = repeat();
      left = left.kind === 'empty' ? right : { kind: 'cat', left, right };
    }
    return left;
  };
  const repeat = (): Ast => {
    let inner = atom();
    for (;;) {
      const kind = ({ '*': 'star', '+': 'plus', '?': 'optional' } as const)[source[at]];
      if (!kind) return inner;
      at++;
      inner = { kind, inner };
    }
  };
  const atom = (): Ast => {
    const char = source[at++];
    if (char === '(') {
      const inner = alternation();
      if (source[at++] !== ')') throw new Error('A ( is never closed.');
      return inner;
    }
    if ('*+?'.includes(char)) throw new Error(`There is nothing before ${char} to repeat.`);
    if (char === '.') return { kind: 'any' };
    if (char === '\\') {
      if (at >= source.length) throw new Error('A \\ needs a character after it.');
      return { kind: 'char', char: source[at++] };
    }
    return { kind: 'char', char };
  };
  const ast = alternation();
  if (at < source.length) throw new Error('A ) has no matching (.');
  return ast;
}

/** An NFA with numbered states, built by Thompson's construction. */
export interface Nfa {
  start: number;
  end: number;
  /** ε moves out of each state. */
  free: number[][];
  /** Moves that read a character; `null` reads any character. */
  moves: [char: string | null, to: number][][];
}

export function compileRegex(source: string): Nfa {
  const free: number[][] = [];
  const moves: Nfa['moves'] = [];
  const state = () => {
    free.push([]);
    moves.push([]);
    return free.length - 1;
  };
  // Every fragment has one way in and one way out.
  const build = (ast: Ast): [number, number] => {
    const start = state();
    const end = state();
    switch (ast.kind) {
      case 'empty':
        free[start].push(end);
        break;
      case 'char':
        moves[start].push([ast.char, end]);
        break;
      case 'any':
        moves[start].push([null, end]);
        break;
      case 'cat': {
        const [a, b] = build(ast.left);
        const [c, d] = build(ast.right);
        free[start].push(a);
        free[b].push(c);
        free[d].push(end);
        break;
      }
      case 'alt': {
        const [a, b] = build(ast.left);
        const [c, d] = build(ast.right);
        free[start].push(a, c);
        free[b].push(end);
        free[d].push(end);
        break;
      }
      default: {
        const [a, b] = build(ast.inner);
        free[start].push(a);
        free[b].push(end);
        // Skipping is allowed for * and ?, going round again for * and +.
        if (ast.kind !== 'plus') free[start].push(end);
        if (ast.kind !== 'optional') free[b].push(a);
      }
    }
    return [start, end];
  };
  const [start, end] = build(parseRegex(source));
  return { start, end, free, moves };
}

function reach(nfa: Nfa, states: Iterable<number>): Set<number> {
  const seen = new Set(states);
  const todo = [...seen];
  while (todo.length) {
    for (const next of nfa.free[todo.pop()!]) {
      if (!seen.has(next)) {
        seen.add(next);
        todo.push(next);
      }
    }
  }
  return seen;
}

function advance(nfa: Nfa, states: Set<number>, char: string): Set<number> {
  const next: number[] = [];
  for (const state of states) {
    for (const [reads, to] of nfa.moves[state]) {
      if (reads === null || reads === char) next.push(to);
    }
  }
  return reach(nfa, next);
}

/** Does the whole of `text` match? Tracks every state the NFA could be in. */
export function regexMatches(nfa: Nfa, text: string): boolean {
  let states = reach(nfa, [nfa.start]);
  for (const char of text) states = advance(nfa, states, char);
  return states.has(nfa.end);
}

/** The leftmost, then longest, stretch of `text` that matches, as `[from, to)`. */
export function regexFind(nfa: Nfa, text: string): [number, number] | null {
  for (let from = 0; from <= text.length; from++) {
    let states = reach(nfa, [nfa.start]);
    let best = states.has(nfa.end) ? from : -1;
    for (let to = from; to < text.length && states.size; to++) {
      states = advance(nfa, states, text[to]);
      if (states.has(nfa.end)) best = to + 1;
    }
    if (best >= 0) return [from, best];
  }
  return null;
}

/**
 * How many states the equivalent DFA has, by the subset construction. Counts
 * the reachable sets of NFA states, leaving out the dead (empty) one, and gives
 * up at `limit`.
 */
export function dfaSize(nfa: Nfa, limit = 5000): number {
  const alphabet = new Set<string>();
  for (const list of nfa.moves) for (const [char] of list) alphabet.add(char ?? '\0');
  const name = (states: Set<number>) => [...states].sort((a, b) => a - b).join(',');
  const first = reach(nfa, [nfa.start]);
  const seen = new Set([name(first)]);
  const todo = [first];
  while (todo.length && seen.size < limit) {
    const states = todo.pop()!;
    for (const char of alphabet) {
      const next = advance(nfa, states, char);
      if (next.size && !seen.has(name(next))) {
        seen.add(name(next));
        todo.push(next);
      }
    }
  }
  return seen.size;
}

/* ---------- Pushdown automaton ---------- */

export interface PdaFrame {
  /** How many symbols have been read. */
  read: number;
  /** Bottom of the stack first. */
  stack: string[];
  note: string;
  verdict?: 'accept' | 'reject';
}

const closers: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** A pushdown automaton for balanced brackets, one frame per symbol read. */
export function pdaTrace(input: string): PdaFrame[] {
  const stack: string[] = [];
  const frames: PdaFrame[] = [{ read: 0, stack: [], note: 'Start with an empty stack.' }];
  for (let i = 0; i < input.length; i++) {
    const symbol = input[i];
    const frame = (note: string, verdict?: PdaFrame['verdict']) =>
      frames.push({ read: i + 1, stack: [...stack], note, verdict });
    if (Object.values(closers).includes(symbol)) {
      stack.push(symbol);
      frame(`Read ${symbol}, an opener. Push it.`);
    } else if (!(symbol in closers)) {
      frame(`${symbol} is not a bracket. There is no move for it, so the machine rejects.`, 'reject');
      return frames;
    } else if (stack[stack.length - 1] === closers[symbol]) {
      stack.pop();
      frame(`Read ${symbol}. The top of the stack is its partner ${closers[symbol]}, so pop it.`);
    } else {
      const top = stack[stack.length - 1];
      frame(
        top
          ? `Read ${symbol}, but the top of the stack is ${top}. They do not pair, so the machine rejects.`
          : `Read ${symbol}, but the stack is empty. Nothing is open to close, so the machine rejects.`,
        'reject',
      );
      return frames;
    }
  }
  const last = frames[frames.length - 1];
  frames.push({
    read: input.length,
    stack: [...stack],
    ...(stack.length
      ? { note: `The input is finished but ${stack.join(' ')} ${stack.length === 1 ? 'is' : 'are'} still on the stack, unclosed. Reject.`, verdict: 'reject' }
      : { note: 'The input is finished and the stack is empty. Every bracket found its partner. Accept.', verdict: 'accept' }),
  });
  // An empty input has nothing to show between the start and the verdict.
  if (last.read === 0 && !input.length) frames.shift();
  return frames;
}

/* ---------- Turing machines ---------- */

export const BLANK = '_';

type Rule = [write: string, move: 'L' | 'R', next: string];

export interface TuringMachine {
  title: string;
  start: string;
  input: string;
  /** Other inputs worth trying. */
  tries: string[];
  /** `rules[state][symbol]`. A state with no rule for the symbol halts there. */
  rules: Record<string, Record<string, Rule>>;
}

export const turingMachines = {
  increment: {
    title: 'Add one in binary',
    start: 'right',
    input: '1011',
    tries: ['1011', '111', '0'],
    rules: {
      right: { 0: ['0', 'R', 'right'], 1: ['1', 'R', 'right'], _: ['_', 'L', 'carry'] },
      carry: { 1: ['0', 'L', 'carry'], 0: ['1', 'L', 'done'], _: ['1', 'L', 'done'] },
    },
  },
  equal: {
    title: 'Same number of 0s then 1s',
    start: 'mark',
    input: '0011',
    tries: ['0011', '01', '0010', '011'],
    rules: {
      mark: { 0: ['X', 'R', 'find'], Y: ['Y', 'R', 'check'], _: ['_', 'R', 'accept'] },
      find: { 0: ['0', 'R', 'find'], Y: ['Y', 'R', 'find'], 1: ['Y', 'L', 'back'] },
      back: { 0: ['0', 'L', 'back'], Y: ['Y', 'L', 'back'], X: ['X', 'R', 'mark'] },
      check: { Y: ['Y', 'R', 'check'], _: ['_', 'R', 'accept'] },
    },
  },
  bounce: {
    title: 'Halts on some inputs only',
    start: 'walk',
    input: '000',
    tries: ['000', '0010', '1'],
    rules: {
      walk: { 0: ['0', 'R', 'walk'], 1: ['1', 'L', 'walk'], _: ['_', 'R', 'done'] },
    },
  },
} satisfies Record<string, TuringMachine>;

export type TuringName = keyof typeof turingMachines;

export interface TuringFrame {
  tape: string[];
  head: number;
  state: string;
  /** The rule about to fire, or undefined once the machine has halted. */
  rule?: Rule;
}

/** Every configuration from the start until the machine halts or `limit` steps pass. */
export function runTuring(machine: TuringMachine, input: string, limit = 200): TuringFrame[] {
  const tape = input.length ? [...input] : [BLANK];
  let head = 0;
  let state = machine.start;
  const frames: TuringFrame[] = [];
  for (;;) {
    const rule = machine.rules[state]?.[tape[head]];
    frames.push({ tape: [...tape], head, state, rule });
    if (!rule || frames.length > limit) return frames;
    tape[head] = rule[0];
    state = rule[2];
    head += rule[1] === 'R' ? 1 : -1;
    // The tape is endless in both directions: grow it wherever the head goes.
    if (head < 0) {
      tape.unshift(BLANK);
      head = 0;
    }
    if (head === tape.length) tape.push(BLANK);
  }
}

/* ---------- Lambda calculus ---------- */

export type Term =
  | { kind: 'var'; name: string }
  | { kind: 'lam'; param: string; body: Term }
  | { kind: 'app'; fn: Term; arg: Term };

/** Accepts `λ` or `\` for lambda. Names are runs of letters, digits and primes. */
export function parseLambda(source: string): Term {
  const tokens = source.match(/[λ\\.()]|[A-Za-z0-9_']+/g) ?? [];
  let at = 0;
  const term = (): Term => {
    let left: Term | undefined;
    while (at < tokens.length && tokens[at] !== ')') {
      const next = atom();
      left = left ? { kind: 'app', fn: left, arg: next } : next;
    }
    if (!left) throw new Error('A term is missing.');
    return left;
  };
  const atom = (): Term => {
    const token = tokens[at++];
    if (token === '(') {
      const inner = term();
      if (tokens[at++] !== ')') throw new Error('A ( is never closed.');
      return inner;
    }
    if (token === 'λ' || token === '\\') {
      const param = tokens[at++];
      if (!param || !/^[A-Za-z0-9_']+$/.test(param)) throw new Error('A λ needs a parameter name.');
      if (tokens[at++] !== '.') throw new Error(`Expected a . after λ${param}.`);
      // The body runs as far to the right as it can.
      return { kind: 'lam', param, body: term() };
    }
    if (token === '.') throw new Error('A . appears without a λ before it.');
    return { kind: 'var', name: token };
  };
  const result = term();
  if (at < tokens.length) throw new Error('A ) has no matching (.');
  return result;
}

export function printLambda(term: Term): string {
  if (term.kind === 'var') return term.name;
  if (term.kind === 'lam') return `λ${term.param}.${printLambda(term.body)}`;
  const fn = term.fn.kind === 'lam' ? `(${printLambda(term.fn)})` : printLambda(term.fn);
  const arg = term.arg.kind === 'var' ? term.arg.name : `(${printLambda(term.arg)})`;
  return `${fn} ${arg}`;
}

function freeVars(term: Term, out = new Set<string>(), bound: string[] = []): Set<string> {
  if (term.kind === 'var') {
    if (!bound.includes(term.name)) out.add(term.name);
  } else if (term.kind === 'lam') {
    freeVars(term.body, out, [...bound, term.param]);
  } else {
    freeVars(term.fn, out, bound);
    freeVars(term.arg, out, bound);
  }
  return out;
}

/** `term` with every free `name` replaced by `value`, renaming to avoid capture. */
function substitute(term: Term, name: string, value: Term): Term {
  if (term.kind === 'var') return term.name === name ? value : term;
  if (term.kind === 'app') {
    return { kind: 'app', fn: substitute(term.fn, name, value), arg: substitute(term.arg, name, value) };
  }
  if (term.param === name) return term;
  const free = freeVars(value);
  if (!free.has(term.param)) return { ...term, body: substitute(term.body, name, value) };
  // The parameter would capture a free variable of the value: rename it first.
  const taken = new Set([...free, ...freeVars(term.body)]);
  let fresh = term.param;
  while (taken.has(fresh)) fresh += "'";
  const body = substitute(term.body, term.param, { kind: 'var', name: fresh });
  return { kind: 'lam', param: fresh, body: substitute(body, name, value) };
}

/** One beta reduction of the leftmost, outermost redex, or null in normal form. */
function reduceOnce(term: Term): Term | null {
  if (term.kind === 'var') return null;
  if (term.kind === 'lam') {
    const body = reduceOnce(term.body);
    return body && { ...term, body };
  }
  if (term.fn.kind === 'lam') return substitute(term.fn.body, term.fn.param, term.arg);
  const fn = reduceOnce(term.fn);
  if (fn) return { ...term, fn };
  const arg = reduceOnce(term.arg);
  return arg && { ...term, arg };
}

/** The term and each reduct in turn. `done` is false if `limit` ran out first. */
export function reduceLambda(source: string, limit = 25): { steps: string[]; done: boolean } {
  let term: Term | null = parseLambda(source);
  const steps = [printLambda(term)];
  while (steps.length <= limit) {
    term = reduceOnce(term);
    if (!term) return { steps, done: true };
    steps.push(printLambda(term));
  }
  return { steps, done: false };
}

/* ---------- Search problems ---------- */

/**
 * Brute-force subset sum: tries subsets in counting order and reports how many
 * it looked at before finding one that adds up to `target`.
 */
export function findSubset(numbers: number[], target: number) {
  const total = 2 ** numbers.length;
  for (let mask = 1; mask < total; mask++) {
    const picked = numbers.map((_, i) => i).filter((i) => mask & (1 << i));
    if (picked.reduce((sum, i) => sum + numbers[i], 0) === target) {
      return { picked, checked: mask, total: total - 1 };
    }
  }
  return { picked: null, checked: total - 1, total: total - 1 };
}

/** A clause is a list of literals: `2` means variable 2, `-2` means not variable 2. */
export type Clause = number[];

export const clauseHolds = (clause: Clause, values: boolean[]) =>
  clause.some((literal) => values[Math.abs(literal) - 1] === literal > 0);

/** Tries every assignment in counting order. */
export function solveSat(clauses: Clause[], variables: number) {
  const total = 2 ** variables;
  for (let mask = 0; mask < total; mask++) {
    const values = Array.from({ length: variables }, (_, i) => Boolean(mask & (1 << i)));
    if (clauses.every((clause) => clauseHolds(clause, values))) {
      return { values, tried: mask + 1, total };
    }
  }
  return { values: null, tried: total, total };
}

export const literalName = (literal: number) =>
  (literal < 0 ? '¬' : '') + 'abcdefgh'[Math.abs(literal) - 1];
