// Hashing and the probabilistic structures built on it, shared by the build and the browser.

const encoder = new TextEncoder();

/** A well-mixed 32-bit hash of a string, varied by `seed`. */
export function hash32(text: string, seed = 0): number {
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (const byte of encoder.encode(text)) h = Math.imul(h ^ byte, 0x01000193) >>> 0;
  // A final scramble so that similar strings land far apart.
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** The k bit positions an item maps to in a Bloom filter of `size` bits. */
export function bloomPositions(item: string, size: number, k: number): number[] {
  return Array.from({ length: k }, (_, i) => hash32(item, i + 1) % size);
}

/** The counter an item maps to in each row of a count-min sketch. */
export function sketchColumns(item: string, width: number, depth: number): number[] {
  return Array.from({ length: depth }, (_, row) => hash32(item, row + 11) % width);
}

/** A HyperLogLog counter with 2^bits registers. */
export class HyperLogLog {
  readonly registers: number[];
  readonly bits: number;

  constructor(bits = 6) {
    this.bits = bits;
    this.registers = new Array(2 ** bits).fill(0);
  }

  add(item: string) {
    const h = hash32(item, 99);
    const index = h >>> (32 - this.bits);
    // Position of the first 1 bit in what remains, counting from 1.
    const rest = (h << this.bits) >>> 0;
    const rank = rest === 0 ? 32 - this.bits + 1 : Math.clz32(rest) + 1;
    if (rank > this.registers[index]) this.registers[index] = rank;
  }

  estimate(): number {
    const m = this.registers.length;
    const alpha = 0.7213 / (1 + 1.079 / m);
    const raw = (alpha * m * m) / this.registers.reduce((sum, r) => sum + 2 ** -r, 0);
    const empty = this.registers.filter((r) => r === 0).length;
    // With few items, counting the empty registers is more accurate.
    return Math.round(raw <= 2.5 * m && empty > 0 ? m * Math.log(m / empty) : raw);
  }
}
