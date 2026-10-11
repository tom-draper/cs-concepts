// Pure helpers behind the discrete-maths widgets, shared by the build and the browser.

export const logicRows: [name: string, symbol: string, f: (a: boolean, b: boolean) => boolean][] = [
  ['NOT A', '¬A', (a) => !a],
  ['A AND B', 'A ∧ B', (a, b) => a && b],
  ['A OR B', 'A ∨ B', (a, b) => a || b],
  ['A XOR B', 'A ⊕ B', (a, b) => a !== b],
  ['A NAND B', '¬(A ∧ B)', (a, b) => !(a && b)],
  ['A NOR B', '¬(A ∨ B)', (a, b) => !(a || b)],
  ['A implies B', 'A → B', (a, b) => !a || b],
  ['A equals B', 'A ↔ B', (a, b) => a === b],
];

/** The mathematical remainder: always between 0 and n - 1, even for negative a. */
export function mod(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/** SVG markup for a ring of n positions with position r marked. */
export function modRing(n: number, r: number): string {
  const size = 220;
  const centre = size / 2;
  const radius = 84;
  const dot = n > 16 ? 11 : 14;
  let out = `<circle class="ring" cx="${centre}" cy="${centre}" r="${radius}" />`;
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * 2 * Math.PI - Math.PI / 2;
    const x = (centre + radius * Math.cos(angle)).toFixed(1);
    const y = (centre + radius * Math.sin(angle)).toFixed(1);
    out +=
      `<g class="v-node ${i === r ? 'alt' : ''}">` +
      `<rect x="${Number(x) - dot}" y="${Number(y) - dot}" width="${dot * 2}" height="${dot * 2}" rx="${dot}" />` +
      `<text class="v-text" x="${x}" y="${y}">${i}</text></g>`;
  }
  return out;
}

const factorial = (n: bigint): bigint => (n <= 1n ? 1n : n * factorial(n - 1n));
const choose = (n: bigint, k: bigint): bigint =>
  k < 0n || k > n ? 0n : factorial(n) / (factorial(k) * factorial(n - k));

/** Large numbers with thousands separators, or in scientific form when very long. */
export function format(value: bigint): string {
  const digits = value.toString();
  if (digits.length > 21) return `about ${digits[0]}.${digits.slice(1, 3)} × 10^${digits.length - 1}`;
  return digits.replace(/\B(?=(\d{3})+$)/g, ',');
}

/** The standard ways to count selections of k items from n. */
export function countings(n: number, k: number): Record<string, string> {
  const N = BigInt(n);
  const K = BigInt(k);
  return {
    factorial: format(factorial(N)),
    sequences: format(N ** K),
    arrangements: format(k > n ? 0n : factorial(N) / factorial(N - K)),
    combinations: format(choose(N, K)),
    multisets: format(n === 0 ? (k === 0 ? 1n : 0n) : choose(N + K - 1n, K)),
  };
}

/** Chance that at least two of `people` share one of `days` equally likely values. */
export function sharedChance(people: number, days = 365): number {
  let allDifferent = 1;
  for (let i = 0; i < people; i++) allDifferent *= Math.max(0, days - i) / days;
  return 1 - allDifferent;
}
