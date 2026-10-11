// Runs a sorting algorithm and records what it did, one step at a time, so the
// same trace can be drawn at build time and replayed in the browser.

export interface SortStep {
  values: number[];
  /** Indices being compared. */
  compare: number[];
  /** Indices just written to. */
  moved: number[];
  /** Indices known to be in their final place. */
  sorted: number[];
  /** The part of the array currently being worked on. */
  range?: [number, number];
  pivot?: number;
  note: string;
  comparisons: number;
  writes: number;
}

export type Algorithm = 'bubble' | 'insertion' | 'selection' | 'merge' | 'quick' | 'heap';

class Recorder {
  a: number[];
  steps: SortStep[] = [];
  sorted = new Set<number>();
  comparisons = 0;
  writes = 0;
  range?: [number, number];
  pivot?: number;

  constructor(values: number[]) {
    this.a = [...values];
    this.snap('The starting order.');
  }

  snap(note: string, compare: number[] = [], moved: number[] = []) {
    this.steps.push({
      values: [...this.a],
      compare,
      moved,
      sorted: [...this.sorted],
      range: this.range,
      pivot: this.pivot,
      note,
      comparisons: this.comparisons,
      writes: this.writes,
    });
  }

  swap(i: number, j: number) {
    [this.a[i], this.a[j]] = [this.a[j], this.a[i]];
    this.writes += 2;
  }

  finish() {
    this.a.forEach((_, i) => this.sorted.add(i));
    this.range = undefined;
    this.pivot = undefined;
    this.snap(`Sorted, after ${this.comparisons} comparisons and ${this.writes} writes.`);
    return this.steps;
  }
}

function bubble(r: Recorder) {
  const a = r.a;
  for (let end = a.length - 1; end > 0; end--) {
    let swapped = false;
    for (let i = 0; i < end; i++) {
      r.comparisons++;
      if (a[i] > a[i + 1]) {
        const [x, y] = [a[i], a[i + 1]];
        r.swap(i, i + 1);
        swapped = true;
        r.snap(`${x} is greater than ${y}, so swap them.`, [], [i, i + 1]);
      } else {
        r.snap(`${a[i]} and ${a[i + 1]} are in order. Move on.`, [i, i + 1]);
      }
    }
    r.sorted.add(end);
    if (!swapped) {
      r.snap('A full pass with no swaps: everything is in order, so stop early.');
      break;
    }
    r.snap(`${a[end]} has bubbled to its final place.`);
  }
}

function insertion(r: Recorder) {
  const a = r.a;
  r.range = [0, 0];
  for (let i = 1; i < a.length; i++) {
    const key = a[i];
    r.range = [0, i];
    let j = i;
    while (j > 0) {
      r.comparisons++;
      if (a[j - 1] > a[j]) {
        const left = a[j - 1];
        r.swap(j - 1, j);
        r.snap(`${key} is less than ${left}, so it moves one place left.`, [], [j - 1, j]);
        j--;
      } else {
        r.snap(`${key} is not less than ${a[j - 1]}, so it stays here.`, [j - 1, j]);
        break;
      }
    }
    if (j === 0) r.snap(`${key} has reached the front.`, [], [0]);
  }
}

function selection(r: Recorder) {
  const a = r.a;
  for (let i = 0; i < a.length - 1; i++) {
    let min = i;
    r.range = [i, a.length - 1];
    for (let j = i + 1; j < a.length; j++) {
      r.comparisons++;
      r.pivot = min;
      if (a[j] < a[min]) {
        min = j;
        r.pivot = min;
        r.snap(`${a[j]} is the smallest seen so far.`, [j]);
      } else {
        r.snap(`${a[j]} is not smaller than ${a[min]}.`, [j]);
      }
    }
    r.pivot = undefined;
    if (min !== i) {
      r.swap(i, min);
      r.sorted.add(i);
      r.snap(`Swap the smallest, ${a[i]}, into position ${i}.`, [], [i, min]);
    } else {
      r.sorted.add(i);
      r.snap(`${a[i]} is already the smallest. It stays in position ${i}.`);
    }
  }
}

function merge(r: Recorder) {
  const a = r.a;
  const sort = (lo: number, hi: number) => {
    if (lo >= hi) return;
    const mid = Math.floor((lo + hi) / 2);
    sort(lo, mid);
    sort(mid + 1, hi);
    r.range = [lo, hi];
    const left = a.slice(lo, mid + 1);
    const right = a.slice(mid + 1, hi + 1);
    r.snap(`Merge two sorted runs: ${left.join(' ')} and ${right.join(' ')}.`);
    let i = 0;
    let j = 0;
    for (let k = lo; k <= hi; k++) {
      let note: string;
      if (i < left.length && j < right.length) {
        r.comparisons++;
        const takeLeft = left[i] <= right[j];
        note = `${left[i]} or ${right[j]}? Take ${takeLeft ? left[i] : right[j]}.`;
        a[k] = takeLeft ? left[i++] : right[j++];
      } else if (i < left.length) {
        note = `The right run is used up. Take ${left[i]}.`;
        a[k] = left[i++];
      } else {
        note = `The left run is used up. Take ${right[j]}.`;
        a[k] = right[j++];
      }
      r.writes++;
      r.snap(note, [], [k]);
    }
  };
  sort(0, a.length - 1);
}

function quick(r: Recorder) {
  const a = r.a;
  const sort = (lo: number, hi: number) => {
    if (lo > hi) return;
    if (lo === hi) {
      r.sorted.add(lo);
      return;
    }
    r.range = [lo, hi];
    r.pivot = hi;
    const pivot = a[hi];
    r.snap(`Choose the last element, ${pivot}, as the pivot.`);
    let boundary = lo;
    for (let j = lo; j < hi; j++) {
      r.comparisons++;
      if (a[j] < pivot) {
        if (j !== boundary) {
          r.swap(boundary, j);
          r.snap(`${a[boundary]} is less than ${pivot}: swap it into the left part.`, [], [boundary, j]);
        } else {
          r.snap(`${a[j]} is less than ${pivot}: it joins the left part.`, [j]);
        }
        boundary++;
      } else {
        r.snap(`${a[j]} is not less than ${pivot}: leave it on the right.`, [j]);
      }
    }
    if (boundary !== hi) r.swap(boundary, hi);
    r.pivot = undefined;
    r.sorted.add(boundary);
    r.snap(`Put the pivot between the two parts. ${pivot} is now in its final place.`, [], [boundary]);
    sort(lo, boundary - 1);
    sort(boundary + 1, hi);
  };
  sort(0, a.length - 1);
}

function heap(r: Recorder) {
  const a = r.a;
  const siftDown = (start: number, size: number) => {
    let i = start;
    for (;;) {
      const left = 2 * i + 1;
      const right = left + 1;
      let largest = i;
      if (left < size) {
        r.comparisons++;
        if (a[left] > a[largest]) largest = left;
      }
      if (right < size) {
        r.comparisons++;
        if (a[right] > a[largest]) largest = right;
      }
      if (largest === i) {
        if (left < size) r.snap(`${a[i]} is at least as large as its children. It stays.`, [i]);
        return;
      }
      r.swap(i, largest);
      r.snap(`${a[largest]} is smaller than its child ${a[i]}: swap them.`, [], [i, largest]);
      i = largest;
    }
  };
  r.range = [0, a.length - 1];
  r.snap('First, rearrange the array into a max-heap.');
  for (let i = Math.floor(a.length / 2) - 1; i >= 0; i--) siftDown(i, a.length);
  r.snap(`It is now a max-heap: the largest value, ${a[0]}, is at the front.`);
  for (let end = a.length - 1; end > 0; end--) {
    r.swap(0, end);
    r.sorted.add(end);
    r.range = [0, end - 1];
    r.snap(`Swap the largest, ${a[end]}, to the end of the heap. It is in its final place.`, [], [0, end]);
    siftDown(0, end);
  }
}

const algorithms: Record<Algorithm, (r: Recorder) => void> = {
  bubble,
  insertion,
  selection,
  merge,
  quick,
  heap,
};

export function trace(algorithm: Algorithm, values: number[]): SortStep[] {
  const recorder = new Recorder(values);
  algorithms[algorithm](recorder);
  return recorder.finish();
}
