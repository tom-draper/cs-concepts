// Small simulations behind the computer-architecture widgets, shared by the build and the browser.

export type Gate = 'and' | 'or' | 'not' | 'nand' | 'nor' | 'xor';

export const gates: Record<Gate, { name: string; inputs: number; f: (a: boolean, b: boolean) => boolean }> = {
  and: { name: 'AND', inputs: 2, f: (a, b) => a && b },
  or: { name: 'OR', inputs: 2, f: (a, b) => a || b },
  not: { name: 'NOT', inputs: 1, f: (a) => !a },
  nand: { name: 'NAND', inputs: 2, f: (a, b) => !(a && b) },
  nor: { name: 'NOR', inputs: 2, f: (a, b) => !(a || b) },
  xor: { name: 'XOR', inputs: 2, f: (a, b) => a !== b },
};

const bodies: Record<Gate, string> = {
  and: 'M30,6 H50 A14,14 0 0 1 50,34 H30 Z',
  nand: 'M30,6 H50 A14,14 0 0 1 50,34 H30 Z',
  or: 'M28,6 C42,6 55,9 66,20 C55,31 42,34 28,34 C34,25 34,15 28,6 Z',
  nor: 'M28,6 C42,6 55,9 66,20 C55,31 42,34 28,34 C34,25 34,15 28,6 Z',
  xor: 'M32,6 C46,6 57,9 68,20 C57,31 46,34 32,34 C38,25 38,15 32,6 Z',
  not: 'M30,6 L58,20 L30,34 Z',
};
const outputAt: Record<Gate, number> = { and: 64, nand: 64, or: 66, nor: 66, xor: 68, not: 58 };

/** SVG markup for one gate in a 110 × 40 box, with its wires lit according to the inputs. */
export function gateSvg(gate: Gate, a: boolean, b: boolean): string {
  const { inputs, f } = gates[gate];
  const out = f(a, b);
  const bubble = gate === 'nand' || gate === 'nor' || gate === 'not';
  const end = outputAt[gate] + (bubble ? 8 : 0);
  const wire = (on: boolean) => `class="wire${on ? ' on' : ''}"`;
  const left = gate === 'or' || gate === 'nor' ? 32 : gate === 'xor' ? 36 : 30;
  return (
    (inputs === 2
      ? `<line ${wire(a)} x1="4" y1="13" x2="${left}" y2="13" /><line ${wire(b)} x1="4" y1="27" x2="${left}" y2="27" />`
      : `<line ${wire(a)} x1="4" y1="20" x2="30" y2="20" />`) +
    `<line ${wire(out)} x1="${end}" y1="20" x2="94" y2="20" />` +
    (gate === 'xor' ? '<path class="gate-extra" d="M26,6 C32,15 32,25 26,34" />' : '') +
    `<path class="gate-body" d="${bodies[gate]}" />` +
    (bubble ? `<circle class="gate-body" cx="${outputAt[gate] + 4}" cy="20" r="4" />` : '') +
    `<circle class="lamp${out ? ' on' : ''}" cx="101" cy="20" r="6" />`
  );
}

/** Adds two unsigned numbers bit by bit. `carries[i]` is the carry into bit i; the last entry is the carry out. */
export function rippleAdd(a: number, b: number, bits = 4): { sum: number; carries: number[] } {
  const carries = [0];
  let sum = 0;
  for (let i = 0; i < bits; i++) {
    const total = ((a >> i) & 1) + ((b >> i) & 1) + carries[i];
    sum |= (total & 1) << i;
    carries.push(total >> 1);
  }
  return { sum, carries };
}

export interface BranchRun {
  /** Whether each prediction was right. */
  correct: boolean[];
  accuracy: number;
}

/**
 * Runs a branch history ('T' taken, 'N' not taken) through a saturating-counter
 * predictor with the given number of bits (1 or 2).
 */
export function predictBranches(history: string, bits: 1 | 2): BranchRun {
  const max = 2 ** bits - 1;
  let state = bits === 2 ? 1 : 0;
  const correct = [...history].map((outcome) => {
    const taken = outcome === 'T';
    const predicted = state > max / 2;
    state = Math.max(0, Math.min(max, state + (taken ? 1 : -1)));
    return predicted === taken;
  });
  return { correct, accuracy: correct.length ? correct.filter(Boolean).length / correct.length : 0 };
}

export interface CacheLine {
  valid: boolean;
  tag: number;
}

export interface CacheAccess {
  address: number;
  tag: number;
  index: number;
  offset: number;
  hit: boolean;
  /** Why a miss happened. */
  reason: string;
}

/** A direct-mapped cache with 4 lines of 4 bytes each. */
export class DirectMappedCache {
  static readonly LINES = 4;
  static readonly BLOCK = 4;
  lines: CacheLine[] = Array.from({ length: DirectMappedCache.LINES }, () => ({ valid: false, tag: 0 }));
  log: CacheAccess[] = [];

  access(address: number): CacheAccess {
    const offset = address % DirectMappedCache.BLOCK;
    const block = Math.floor(address / DirectMappedCache.BLOCK);
    const index = block % DirectMappedCache.LINES;
    const tag = Math.floor(block / DirectMappedCache.LINES);
    const line = this.lines[index];
    const hit = line.valid && line.tag === tag;
    const reason = hit ? '' : line.valid ? `line ${index} held a different block, which is evicted` : `line ${index} was empty`;
    if (!hit) this.lines[index] = { valid: true, tag };
    const result = { address, tag, index, offset, hit, reason };
    this.log.push(result);
    return result;
  }

  /** The byte addresses held by a line, as "from-to". */
  range(index: number): string {
    const line = this.lines[index];
    if (!line.valid) return 'empty';
    const start = (line.tag * DirectMappedCache.LINES + index) * DirectMappedCache.BLOCK;
    return `${start} to ${start + DirectMappedCache.BLOCK - 1}`;
  }
}

export type Instruction = [op: 'LOAD' | 'ADD' | 'SUB' | 'STORE' | 'JNZ' | 'HALT', operand?: number];

export interface CpuStep {
  phase: 'start' | 'fetch' | 'decode' | 'execute' | 'halted';
  pc: number;
  ir: string;
  acc: number;
  memory: number[];
  /** Memory address read or written in this step, if any. */
  touched?: number;
  note: string;
}

export const program: Instruction[] = [
  ['LOAD', 10],
  ['ADD', 11],
  ['STORE', 10],
  ['LOAD', 11],
  ['SUB', 12],
  ['STORE', 11],
  ['JNZ', 0],
  ['HALT'],
];
/** Data lives after the program: address 10 is the running total, 11 the counter, 12 the constant 1. */
export const dataStart = 10;
export const initialData = [0, 3, 1];
export const dataNames = ['total', 'counter', 'one'];

export const show = ([op, operand]: Instruction) => (operand === undefined ? op : `${op} ${operand}`);

/** Runs the program on a one-register machine, recording each phase of each cycle. */
export function runCpu(): CpuStep[] {
  const memory = [...initialData];
  const steps: CpuStep[] = [];
  let pc = 0;
  let acc = 0;
  let ir = '';
  const snap = (phase: CpuStep['phase'], note: string, touched?: number) =>
    steps.push({ phase, pc, ir, acc, memory: [...memory], touched, note });
  const cell = (address: number) => address - dataStart;

  snap('start', 'The program counter starts at 0, so the instruction at address 0 runs first.');
  for (let guard = 0; guard < 200; guard++) {
    const instruction = program[pc];
    const at = pc;
    ir = show(instruction);
    pc++;
    snap('fetch', `Fetch: copy the instruction at address ${at} into the instruction register, and add 1 to the program counter.`, at);
    const [op, operand = 0] = instruction;
    const explain = {
      LOAD: `copy the value at address ${operand} into the accumulator`,
      ADD: `add the value at address ${operand} to the accumulator`,
      SUB: `subtract the value at address ${operand} from the accumulator`,
      STORE: `copy the accumulator into address ${operand}`,
      JNZ: `jump to address ${operand} if the accumulator is not zero`,
      HALT: 'stop',
    }[op];
    snap('decode', `Decode: ${ir} means "${explain}".`);
    if (op === 'HALT') {
      snap('halted', `Execute: the machine stops. The total, at address ${dataStart}, is ${memory[0]}.`);
      break;
    }
    if (op === 'LOAD') {
      acc = memory[cell(operand)];
      snap('execute', `Execute: the accumulator becomes ${acc}.`, operand);
    } else if (op === 'ADD' || op === 'SUB') {
      const before = acc;
      const value = memory[cell(operand)];
      acc = op === 'ADD' ? acc + value : acc - value;
      snap('execute', `Execute: ${before} ${op === 'ADD' ? '+' : '−'} ${value} = ${acc}.`, operand);
    } else if (op === 'STORE') {
      memory[cell(operand)] = acc;
      snap('execute', `Execute: address ${operand} now holds ${acc}.`, operand);
    } else if (acc !== 0) {
      pc = operand;
      snap('execute', `Execute: the accumulator is ${acc}, not zero, so the program counter is set to ${operand}. The loop runs again.`);
    } else {
      snap('execute', 'Execute: the accumulator is zero, so no jump. Carry on to the next instruction.');
    }
  }
  return steps;
}
