// Step-by-step traces of string algorithms, drawn by <MatchDemo> and <EditDistanceDemo>.

export interface MatchStep {
  /** Where the pattern is lined up against the text. */
  offset: number;
  /** Pattern characters already known to match without comparing. */
  known: number;
  /** Pattern characters matched in total at this alignment. */
  matched: number;
  /** Pattern index that failed to match, or -1. */
  mismatch: number;
  found: boolean;
  /** Extra text shown beside the window, such as a hash value. */
  tag?: string;
  note: string;
}

export type MatchAlgorithm = 'naive' | 'kmp' | 'rabin-karp';

/** For each prefix of the pattern, the length of its longest proper prefix that is also a suffix. */
export function failureTable(pattern: string): number[] {
  const table = [0];
  let k = 0;
  for (let i = 1; i < pattern.length; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = table[k - 1];
    if (pattern[i] === pattern[k]) k++;
    table.push(k);
  }
  return table;
}

function naive(text: string, pattern: string): MatchStep[] {
  const steps: MatchStep[] = [];
  let comparisons = 0;
  for (let offset = 0; offset + pattern.length <= text.length; offset++) {
    let j = 0;
    while (j < pattern.length && text[offset + j] === pattern[j]) j++;
    const found = j === pattern.length;
    comparisons += found ? j : j + 1;
    steps.push({
      offset,
      known: 0,
      matched: j,
      mismatch: found ? -1 : j,
      found,
      note: found
        ? `Every character matches. Found at index ${offset}, after ${comparisons} comparisons in total.`
        : `${j ? `${j} matched, then ` : ''}${text[offset + j]} is not ${pattern[j]}. Slide the pattern one place right and start again from its first character.`,
    });
    if (found) break;
  }
  return steps;
}

function kmp(text: string, pattern: string): MatchStep[] {
  const table = failureTable(pattern);
  const steps: MatchStep[] = [];
  let comparisons = 0;
  let i = 0;
  let j = 0;
  while (i < text.length) {
    const offset = i - j;
    const known = j;
    while (j < pattern.length && i < text.length && text[i] === pattern[j]) {
      i++;
      j++;
      comparisons++;
    }
    if (j === pattern.length) {
      steps.push({
        offset,
        known,
        matched: j,
        mismatch: -1,
        found: true,
        note: `Every character matches. Found at index ${offset}, after ${comparisons} comparisons in total.`,
      });
      break;
    }
    if (i >= text.length) break;
    comparisons++;
    const fallback = j > 0 ? table[j - 1] : 0;
    steps.push({
      offset,
      known,
      matched: j,
      mismatch: j,
      found: false,
      note:
        j === 0
          ? `${text[i]} is not ${pattern[0]}. Nothing had matched, so move on by one.`
          : fallback > 0
            ? `${text[i]} is not ${pattern[j]}. But the ${j} matched characters end with "${pattern.slice(0, fallback)}", which is also how the pattern starts. Slide so those line up, and carry on from the same text position.`
            : `${text[i]} is not ${pattern[j]}. No end of the matched part is also a start of the pattern, so jump past all of it.`,
    });
    if (j === 0) i++;
    else j = fallback;
  }
  return steps;
}

function rabinKarp(text: string, pattern: string, modulus = 13): MatchStep[] {
  const steps: MatchStep[] = [];
  const hash = (s: string) => [...s].reduce((h, d) => (h * 10 + Number(d)) % modulus, 0);
  const target = hash(pattern);
  // The weight of the leading digit, needed to remove it when the window slides.
  let high = 1;
  for (let i = 1; i < pattern.length; i++) high = (high * 10) % modulus;
  let h = hash(text.slice(0, pattern.length));
  for (let offset = 0; offset + pattern.length <= text.length; offset++) {
    if (offset > 0) {
      const leaving = Number(text[offset - 1]);
      const arriving = Number(text[offset + pattern.length - 1]);
      h = (((h - leaving * high) % modulus) + modulus) % modulus;
      h = (h * 10 + arriving) % modulus;
    }
    const window = text.slice(offset, offset + pattern.length);
    const equal = h === target;
    const found = equal && window === pattern;
    let j = 0;
    while (j < pattern.length && window[j] === pattern[j]) j++;
    steps.push({
      offset,
      known: 0,
      matched: equal ? j : 0,
      mismatch: equal && !found ? j : -1,
      found,
      tag: `hash ${h}`,
      note: !equal
        ? `The window hashes to ${h}, not ${target}. It cannot be a match, so no characters are compared.`
        : found
          ? `The window hashes to ${target}, the same as the pattern. Check the characters: they match. Found at index ${offset}.`
          : `The window hashes to ${target}, the same as the pattern. Check the characters: they differ. A false alarm, called a spurious hit.`,
    });
  }
  return steps;
}

export function traceMatch(algorithm: MatchAlgorithm, text: string, pattern: string): MatchStep[] {
  if (algorithm === 'kmp') return kmp(text, pattern);
  if (algorithm === 'rabin-karp') return rabinKarp(text, pattern);
  return naive(text, pattern);
}

export interface EditResult {
  /** table[i][j] is the distance between the first i characters of a and the first j of b. */
  table: number[][];
  /** Cells on one cheapest route from the top-left to the bottom-right, as "i,j". */
  route: string[];
  /** The edits along that route, in order. */
  edits: string[];
}

export function editDistance(a: string, b: string): EditResult {
  const table = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      table[i][j] =
        a[i - 1] === b[j - 1]
          ? table[i - 1][j - 1]
          : 1 + Math.min(table[i - 1][j - 1], table[i - 1][j], table[i][j - 1]);
    }
  }
  const route: string[] = [];
  const edits: string[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    route.unshift(`${i},${j}`);
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      i--;
      j--;
    } else if (i > 0 && j > 0 && table[i][j] === table[i - 1][j - 1] + 1) {
      edits.unshift(`replace ${a[i - 1]} with ${b[j - 1]}`);
      i--;
      j--;
    } else if (i > 0 && table[i][j] === table[i - 1][j] + 1) {
      edits.unshift(`delete ${a[i - 1]}`);
      i--;
    } else {
      edits.unshift(`insert ${b[j - 1]}`);
      j--;
    }
  }
  route.unshift('0,0');
  return { table, route, edits };
}
