// A toy memory hierarchy: three levels of cache in front of RAM. Data moves in
// whole lines, each level keeps the lines it used most recently, and a read
// costs the latency of the nearest level that holds its line.

export const WORDS_PER_LINE = 4;
export const RAM_LINES = 16;

export interface Level {
  name: string;
  /** Lines it can hold. RAM holds every line. */
  lines: number;
  cycles: number;
}

// Latencies follow the table on the CPU caches page. Sizes are shrunk so every
// line fits on screen.
export const levels: Level[] = [
  { name: 'L1', lines: 2, cycles: 4 },
  { name: 'L2', lines: 4, cycles: 14 },
  { name: 'L3', lines: 8, cycles: 50 },
  { name: 'RAM', lines: RAM_LINES, cycles: 250 },
];

export const RAM = levels.length - 1;

export interface Fill {
  level: number;
  slot: number;
  evicted: number | null;
}

export interface Read {
  word: number;
  line: number;
  /** Index into `levels` of the level that answered. */
  servedBy: number;
  /** Where the line sits in that level. */
  slot: number;
  cycles: number;
  /** Copies made in the faster levels on the way back. */
  fills: Fill[];
}

export class Hierarchy {
  /** For each cache level, the line in each slot. */
  slots: (number | null)[][] = levels.slice(0, RAM).map((l) => Array(l.lines).fill(null));
  private used: number[][] = levels.slice(0, RAM).map((l) => Array(l.lines).fill(-1));
  private tick = 0;
  log: Read[] = [];

  read(word: number): Read {
    const line = Math.floor(word / WORDS_PER_LINE);
    this.tick++;
    let servedBy = RAM;
    let slot = line;
    for (let level = 0; level < RAM; level++) {
      const at = this.slots[level].indexOf(line);
      if (at !== -1) {
        servedBy = level;
        slot = at;
        this.used[level][at] = this.tick;
        break;
      }
    }
    const fills: Fill[] = [];
    for (let level = servedBy - 1; level >= 0; level--) {
      const into = this.victim(level);
      fills.push({ level, slot: into, evicted: this.slots[level][into] });
      this.slots[level][into] = line;
      this.used[level][into] = this.tick;
    }
    const read = { word, line, servedBy, slot, cycles: levels[servedBy].cycles, fills };
    this.log.push(read);
    return read;
  }

  /** An empty slot if there is one, otherwise the least recently used. */
  private victim(level: number): number {
    const empty = this.slots[level].indexOf(null);
    if (empty !== -1) return empty;
    const used = this.used[level];
    return used.indexOf(Math.min(...used));
  }
}

export interface Pattern {
  id: string;
  name: string;
  summary: string;
  words: number[];
}

const range = (n: number, f: (i: number) => number) => Array.from({ length: n }, (_, i) => f(i));

// Nodes of a linked list, scattered over memory by a fixed shuffle.
const listNodes = range(24, (i) => (i * 37 + 11) % 64);

export const patterns: Pattern[] = [
  {
    id: 'array',
    name: 'Walk an array',
    summary:
      'Read 32 words in order, then again. Each miss brings in the whole line, so the next three reads are hits. The second pass finds the array in L3.',
    words: [...range(32, (i) => i), ...range(32, (i) => i)],
  },
  {
    id: 'loop',
    name: 'Small loop',
    summary: 'Read the same four words over and over. They fit in L1, so after the first round every read is a hit.',
    words: range(24, (i) => [5, 6, 9, 10][i % 4]),
  },
  {
    id: 'list',
    name: 'Chase a linked list',
    summary:
      'Follow pointers to nodes scattered across memory. The neighbours that arrive with each line are never used.',
    words: listNodes,
  },
  {
    id: 'stride',
    name: 'Stride by a line',
    summary:
      'Read one word from every line, twice. That is 16 lines, more than L3 holds, so each line is gone before it is needed again.',
    words: [...range(16, (i) => i * WORDS_PER_LINE), ...range(16, (i) => i * WORDS_PER_LINE)],
  },
];

export function describe(read: Read): string {
  const { word, line, servedBy } = read;
  const where = `Word ${word} is in line ${line}.`;
  if (servedBy === 0) return `${where} L1 already holds it: ${levels[0].cycles} cycles.`;
  const missed = levels.slice(0, servedBy).map((l) => l.name);
  const missText = missed.length === 1 ? `${missed[0]} missed` : `${missed.slice(0, -1).join(', ')} and ${missed.at(-1)} missed`;
  const copied = read.fills.map((f) => levels[f.level].name);
  const copyText = copied.length === 1 ? copied[0] : `${copied.slice(0, -1).join(', ')} and ${copied.at(-1)}`;
  const from = servedBy === RAM ? 'it came from RAM' : `${levels[servedBy].name} had it`;
  return `${where} ${missText}, so ${from}: ${read.cycles} cycles. The whole line was copied into ${copyText}.`;
}

export interface Totals {
  reads: number;
  byLevel: number[];
  cycles: number;
}

export function totals(log: Read[]): Totals {
  const byLevel = levels.map(() => 0);
  let cycles = 0;
  for (const read of log) {
    byLevel[read.servedBy]++;
    cycles += read.cycles;
  }
  return { reads: log.length, byLevel, cycles };
}
