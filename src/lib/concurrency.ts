// Small simulations behind the concurrency widgets: two threads whose steps
// can be interleaved by hand, a counting semaphore, a channel, and a trace of
// an event loop.

// ---------- Interleaving two threads ----------

export type Op =
  | { kind: 'read' | 'add' | 'write' | 'cas' }
  | { kind: 'lock' | 'unlock'; lock: string };

export interface Scenario {
  /** Whether the threads share a counter. */
  counter: boolean;
  locks: string[];
  /** One program per thread. */
  programs: Op[][];
}

const increment: Op[] = [{ kind: 'read' }, { kind: 'add' }, { kind: 'write' }];
const take = (...locks: string[]): Op[] => locks.map((lock) => ({ kind: 'lock', lock }));
const drop = (...locks: string[]): Op[] => locks.map((lock) => ({ kind: 'unlock', lock }));

export const scenarios = {
  race: { counter: true, locks: [], programs: [increment, increment] },
  mutex: {
    counter: true,
    locks: ['m'],
    programs: [
      [...take('m'), ...increment, ...drop('m')],
      [...take('m'), ...increment, ...drop('m')],
    ],
  },
  cas: {
    counter: true,
    locks: [],
    programs: [
      [{ kind: 'read' }, { kind: 'add' }, { kind: 'cas' }],
      [{ kind: 'read' }, { kind: 'add' }, { kind: 'cas' }],
    ],
  },
  deadlock: {
    counter: false,
    locks: ['a', 'b'],
    programs: [
      [...take('a', 'b'), ...drop('b', 'a')],
      [...take('b', 'a'), ...drop('a', 'b')],
    ],
  },
  ordered: {
    counter: false,
    locks: ['a', 'b'],
    programs: [
      [...take('a', 'b'), ...drop('b', 'a')],
      [...take('a', 'b'), ...drop('b', 'a')],
    ],
  },
} satisfies Record<string, Scenario>;

export type ScenarioName = keyof typeof scenarios;

export interface ThreadState {
  /** Index of the next step to run. */
  pc: number;
  /** The value this thread read, and the value it has computed from it. */
  seen: number | null;
  local: number | null;
  /** How many times a compare-and-swap failed and sent it back to the start. */
  retries: number;
}

export interface State {
  counter: number;
  /** Lock name to the thread holding it. */
  owner: Record<string, number | null>;
  threads: ThreadState[];
}

export function start(scenario: Scenario): State {
  return {
    counter: 0,
    owner: Object.fromEntries(scenario.locks.map((lock) => [lock, null])),
    threads: scenario.programs.map(() => ({ pc: 0, seen: null, local: null, retries: 0 })),
  };
}

export const finished = (scenario: Scenario, state: State, t: number) =>
  state.threads[t].pc >= scenario.programs[t].length;

/** The lock thread `t` is stuck waiting for, if any. */
export function waitingFor(scenario: Scenario, state: State, t: number): string | null {
  const op = scenario.programs[t][state.threads[t].pc];
  if (op?.kind !== 'lock') return null;
  const owner = state.owner[op.lock];
  return owner !== null && owner !== t ? op.lock : null;
}

export const canStep = (scenario: Scenario, state: State, t: number) =>
  !finished(scenario, state, t) && waitingFor(scenario, state, t) === null;

export const allFinished = (scenario: Scenario, state: State) =>
  state.threads.every((_, t) => finished(scenario, state, t));

/** Nobody can move, and somebody still has work to do. */
export const deadlocked = (scenario: Scenario, state: State) =>
  !allFinished(scenario, state) && state.threads.every((_, t) => !canStep(scenario, state, t));

/** Run the next step of thread `t`, returning a new state. */
export function step(scenario: Scenario, state: State, t: number): State {
  if (!canStep(scenario, state, t)) return state;
  const next: State = {
    counter: state.counter,
    owner: { ...state.owner },
    threads: state.threads.map((thread) => ({ ...thread })),
  };
  const thread = next.threads[t];
  const op = scenario.programs[t][thread.pc];
  thread.pc++;
  switch (op.kind) {
    case 'read':
      thread.seen = next.counter;
      thread.local = next.counter;
      break;
    case 'add':
      thread.local = thread.local! + 1;
      break;
    case 'write':
      next.counter = thread.local!;
      break;
    case 'cas':
      if (next.counter === thread.seen) {
        next.counter = thread.local!;
      } else {
        thread.pc = 0;
        thread.seen = null;
        thread.local = null;
        thread.retries++;
      }
      break;
    case 'lock':
      next.owner[op.lock] = t;
      break;
    case 'unlock':
      next.owner[op.lock] = null;
      break;
  }
  return next;
}

export interface Outcomes {
  /** Number of distinct orders the steps can run in. */
  schedules: number;
  /** How many of them end with each counter value. */
  counters: Record<number, number>;
  deadlocks: number;
}

/** Try every possible interleaving and tally how each one ends. */
export function outcomes(scenario: Scenario): Outcomes {
  const result: Outcomes = { schedules: 0, counters: {}, deadlocks: 0 };
  const visit = (state: State) => {
    if (allFinished(scenario, state)) {
      result.schedules++;
      result.counters[state.counter] = (result.counters[state.counter] ?? 0) + 1;
      return;
    }
    if (deadlocked(scenario, state)) {
      result.schedules++;
      result.deadlocks++;
      return;
    }
    state.threads.forEach((_, t) => {
      if (canStep(scenario, state, t)) visit(step(scenario, state, t));
    });
  };
  visit(start(scenario));
  return result;
}

// ---------- Counting semaphore ----------

export class Semaphore {
  permits: number;
  /** Workers currently inside. */
  holders: number[] = [];
  /** Workers blocked in `acquire`, oldest first. */
  queue: number[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  acquire(worker: number) {
    if (this.holders.includes(worker) || this.queue.includes(worker)) return;
    if (this.permits > 0) {
      this.permits--;
      this.holders.push(worker);
    } else {
      this.queue.push(worker);
    }
  }

  release(worker: number) {
    if (!this.holders.includes(worker)) return;
    this.holders = this.holders.filter((id) => id !== worker);
    const next = this.queue.shift();
    // The permit goes straight to the longest waiter, if there is one.
    if (next === undefined) this.permits++;
    else this.holders.push(next);
  }
}

// ---------- Channel ----------

export class Channel {
  capacity: number;
  buffer: number[] = [];
  /** Values held by senders blocked in `send`, oldest first. */
  senders: number[] = [];
  /** Number of receivers blocked in `receive`. */
  receivers = 0;
  received: number[] = [];
  sent = 0;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  /** Send the next value. Returns a sentence describing what happened. */
  send(): string {
    const value = ++this.sent;
    if (this.receivers > 0) {
      this.receivers--;
      this.received.push(value);
      return `A receiver was waiting, so ${value} is handed straight to it and both carry on.`;
    }
    if (this.buffer.length < this.capacity) {
      this.buffer.push(value);
      return `There is room in the buffer, so ${value} goes in and the sender carries on.`;
    }
    this.senders.push(value);
    return this.capacity === 0
      ? `Nobody is receiving, so the sender of ${value} blocks until somebody does.`
      : `The buffer is full, so the sender of ${value} blocks until there is room.`;
  }

  receive(): string {
    if (this.buffer.length > 0) {
      const value = this.buffer.shift()!;
      this.received.push(value);
      const waiting = this.senders.shift();
      if (waiting === undefined) return `The receiver takes ${value} from the buffer.`;
      this.buffer.push(waiting);
      return `The receiver takes ${value}. That frees a slot, so the blocked sender of ${waiting} puts its value in and wakes up.`;
    }
    const waiting = this.senders.shift();
    if (waiting !== undefined) {
      this.received.push(waiting);
      return `A sender was waiting, so ${waiting} is handed straight over and both carry on.`;
    }
    this.receivers++;
    return 'There is nothing to take, so the receiver blocks until something is sent.';
  }
}

// ---------- Event loop ----------

export const loopProgram = [
  "console.log('A');",
  "setTimeout(() => console.log('B'), 0);",
  "Promise.resolve().then(() => console.log('C'));",
  "console.log('D');",
];

export interface LoopFrame {
  /** Line of `loopProgram` being run, if any. */
  line: number | null;
  stack: string[];
  microtasks: string[];
  tasks: string[];
  output: string[];
  note: string;
}

const B = "() => log('B')";
const C = "() => log('C')";

export const loopTrace: LoopFrame[] = [
  { line: null, stack: ['script'], microtasks: [], tasks: [], output: [], note: 'The script itself is the first task. It starts running on the call stack.' },
  { line: 0, stack: ['script', "log('A')"], microtasks: [], tasks: [], output: ['A'], note: 'An ordinary call. It runs at once and prints A.' },
  { line: 1, stack: ['script', 'setTimeout(…)'], microtasks: [], tasks: [B], output: ['A'], note: 'setTimeout does not run the callback. It asks for it to be queued as a task once the timer expires, which with a delay of 0 is immediately.' },
  { line: 2, stack: ['script', 'then(…)'], microtasks: [C], tasks: [B], output: ['A'], note: 'The promise is already resolved, so its callback is queued as a microtask.' },
  { line: 3, stack: ['script', "log('D')"], microtasks: [C], tasks: [B], output: ['A', 'D'], note: 'Another ordinary call. D is printed before B and C, even though it comes later in the source.' },
  { line: null, stack: [], microtasks: [C], tasks: [B], output: ['A', 'D'], note: 'The script ends and the call stack is empty. Only now can the loop pick something from a queue.' },
  { line: null, stack: [C], microtasks: [], tasks: [B], output: ['A', 'D', 'C'], note: 'Microtasks go first. The loop empties the whole microtask queue before it takes another task. C is printed.' },
  { line: null, stack: [B], microtasks: [], tasks: [], output: ['A', 'D', 'C', 'B'], note: 'With no microtasks left, the loop takes the next task: the timer callback. B is printed.' },
  { line: null, stack: [], microtasks: [], tasks: [], output: ['A', 'D', 'C', 'B'], note: 'Both queues are empty. The loop waits for the next event.' },
];
