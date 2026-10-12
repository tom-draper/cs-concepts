// Small simulations behind the operating-systems widgets, shared by the build and the browser.

export interface Process {
  name: string;
  arrival: number;
  burst: number;
}

export type Policy = 'fcfs' | 'sjf' | 'srtf' | 'rr';

export interface Schedule {
  /** Which process ran in each time unit, or '' when the CPU was idle. */
  timeline: string[];
  /** Per process: time spent ready but not running, and time from arrival to completion. */
  stats: { name: string; waiting: number; turnaround: number }[];
  averageWaiting: number;
  switches: number;
}

/** Simulates a single CPU one time unit at a time under the given policy. */
export function schedule(processes: Process[], policy: Policy, quantum = 2): Schedule {
  const remaining = new Map(processes.map((p) => [p.name, p.burst]));
  const finish = new Map<string, number>();
  const timeline: string[] = [];
  const queue: string[] = [];
  let current = '';
  let slice = 0;

  for (let time = 0; finish.size < processes.length && time < 500; time++) {
    for (const p of processes) if (p.arrival === time) queue.push(p.name);
    // A process whose time slice has run out goes to the back, behind new arrivals.
    if (current && policy === 'rr' && slice === quantum) {
      queue.push(current);
      current = '';
    }
    const left = (name: string) => remaining.get(name)!;
    if (policy === 'srtf' && current && queue.some((n) => left(n) < left(current))) {
      queue.push(current);
      current = '';
    }
    if (!current && queue.length) {
      const pick =
        policy === 'sjf' || policy === 'srtf'
          ? queue.reduce((best, n) => (left(n) < left(best) ? n : best))
          : queue[0];
      queue.splice(queue.indexOf(pick), 1);
      current = pick;
      slice = 0;
    }
    timeline.push(current);
    if (!current) continue;
    remaining.set(current, left(current) - 1);
    slice++;
    if (left(current) === 0) {
      finish.set(current, time + 1);
      current = '';
    }
  }

  const stats = processes.map((p) => {
    const turnaround = (finish.get(p.name) ?? 0) - p.arrival;
    return { name: p.name, waiting: turnaround - p.burst, turnaround };
  });
  return {
    timeline,
    stats,
    averageWaiting: stats.reduce((sum, s) => sum + s.waiting, 0) / stats.length,
    switches: timeline.filter((name, i) => i > 0 && name && timeline[i - 1] && name !== timeline[i - 1]).length,
  };
}

export type Replacement = 'fifo' | 'lru' | 'optimal';

export interface PagingRun {
  /** The frames after each reference. */
  frames: (number | null)[][];
  faults: boolean[];
  faultCount: number;
}

/** Replays a sequence of page references through a fixed number of frames. */
export function replacePages(references: number[], frameCount: number, policy: Replacement): PagingRun {
  const frames: (number | null)[] = new Array(frameCount).fill(null);
  const loadedAt = new Array(frameCount).fill(0);
  const usedAt = new Array(frameCount).fill(0);
  const history: (number | null)[][] = [];
  const faults: boolean[] = [];

  references.forEach((page, time) => {
    let slot = frames.indexOf(page);
    const fault = slot < 0;
    if (fault) {
      slot = frames.indexOf(null);
      if (slot < 0) {
        if (policy === 'fifo') slot = loadedAt.indexOf(Math.min(...loadedAt));
        else if (policy === 'lru') slot = usedAt.indexOf(Math.min(...usedAt));
        else {
          // Evict the page whose next use lies furthest in the future.
          const next = frames.map((p) => {
            const at = references.indexOf(p!, time + 1);
            return at < 0 ? Infinity : at;
          });
          slot = next.indexOf(Math.max(...next));
        }
      }
      frames[slot] = page;
      loadedAt[slot] = time;
    }
    usedAt[slot] = time;
    history.push([...frames]);
    faults.push(fault);
  });
  return { frames: history, faults, faultCount: faults.filter(Boolean).length };
}

export const PAGE_SIZE = 256;
/** A toy page table: virtual page number to physical frame, or null when the page is not in memory. */
export const pageTable: (number | null)[] = [3, 7, null, 1, null, 4, 0, null];

export interface Translation {
  page: number;
  offset: number;
  frame: number | null;
  physical: number | null;
  note: string;
}

export function translate(address: number): Translation {
  const page = Math.floor(address / PAGE_SIZE);
  const offset = address % PAGE_SIZE;
  if (page >= pageTable.length) {
    return { page, offset, frame: null, physical: null, note: 'That address is outside the program\'s address space. The program is stopped.' };
  }
  const frame = pageTable[page];
  return frame === null
    ? { page, offset, frame, physical: null, note: `Page ${page} is not in memory. This is a page fault: the operating system must load the page before the program can continue.` }
    : { page, offset, frame, physical: frame * PAGE_SIZE + offset, note: `Page ${page} is in frame ${frame}, so the physical address is ${frame} × ${PAGE_SIZE} + ${offset}.` };
}

export type Fit = 'first' | 'best';

/** A heap of equal-sized units. Each cell holds the id of the allocation using it, or '' if free. */
export class Heap {
  cells: string[];
  private next = 0;

  constructor(size = 32) {
    this.cells = new Array(size).fill('');
  }

  /** Runs of free cells, as [start, length]. */
  holes(): [number, number][] {
    const holes: [number, number][] = [];
    this.cells.forEach((cell, i) => {
      if (cell) return;
      const last = holes[holes.length - 1];
      if (last && last[0] + last[1] === i) last[1]++;
      else holes.push([i, 1]);
    });
    return holes;
  }

  allocate(size: number, fit: Fit): string | null {
    const fits = this.holes().filter(([, length]) => length >= size);
    if (!fits.length) return null;
    const [start] = fit === 'first' ? fits[0] : fits.reduce((best, hole) => (hole[1] < best[1] ? hole : best));
    const id = String.fromCharCode(65 + (this.next++ % 26));
    for (let i = start; i < start + size; i++) this.cells[i] = id;
    return id;
  }

  free(id: string) {
    this.cells = this.cells.map((cell) => (cell === id ? '' : cell));
  }

  get freeUnits() {
    return this.cells.filter((cell) => !cell).length;
  }

  get largestHole() {
    return Math.max(0, ...this.holes().map(([, length]) => length));
  }
}
