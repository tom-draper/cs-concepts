// Working models behind the security widgets: SHA-256, HMAC, a toy block
// cipher with two modes, small-number RSA and Diffie-Hellman, password
// cracking estimates, a stack frame to overflow, a login query to inject into
// and a signed token.
import { runSql, type Table } from './databases';

/* ---------- SHA-256 ---------- */

const primes = (count: number) => {
  const found: number[] = [];
  for (let n = 2; found.length < count; n++) if (found.every((p) => n % p)) found.push(n);
  return found;
};
// The constants are the fractional parts of the square and cube roots of the first primes.
const fraction = (value: number) => Math.floor((value - Math.floor(value)) * 2 ** 32);
const INITIAL = primes(8).map((p) => fraction(Math.sqrt(p)));
const ROUND = primes(64).map((p) => fraction(Math.cbrt(p)));

const rotate = (value: number, by: number) => (value >>> by) | (value << (32 - by));

export function sha256(input: Uint8Array | string): Uint8Array {
  const message = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  // Pad to a multiple of 64 bytes: a 1 bit, zeros, then the length in bits.
  const padded = new Uint8Array((((message.length + 8) >> 6) + 1) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  new DataView(padded.buffer).setUint32(padded.length - 4, message.length * 8);
  const state = [...INITIAL];
  const words = new Array<number>(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const view = new DataView(padded.buffer, offset, 64);
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const a = words[i - 15];
      const b = words[i - 2];
      const s0 = rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3);
      const s1 = rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10);
      words[i] = (words[i - 16] + s0 + words[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let i = 0; i < 64; i++) {
      const s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
      const choose = (e & f) ^ (~e & g);
      const t1 = (h + s1 + choose + ROUND[i] + words[i]) | 0;
      const s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) | 0, c, b, a, (t1 + s0 + majority) | 0];
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => (state[i] = (state[i] + value) | 0));
  }
  const digest = new Uint8Array(32);
  state.forEach((value, i) => new DataView(digest.buffer).setUint32(i * 4, value));
  return digest;
}

export const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** One 0 or 1 for each bit of the bytes. */
export const bits = (bytes: Uint8Array) => [...bytes].flatMap((byte) => [...byte.toString(2).padStart(8, '0')].map(Number));

const concat = (...parts: Uint8Array[]) => {
  const joined = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
};

/** HMAC-SHA-256: a hash that can only be computed, or checked, by someone holding the key. */
export function hmac(key: string, message: string): Uint8Array {
  const encoder = new TextEncoder();
  let keyBytes = encoder.encode(key);
  if (keyBytes.length > 64) keyBytes = sha256(keyBytes);
  const block = new Uint8Array(64);
  block.set(keyBytes);
  const inner = sha256(concat(block.map((byte) => byte ^ 0x36), encoder.encode(message)));
  return sha256(concat(block.map((byte) => byte ^ 0x5c), inner));
}

/* ---------- A toy block cipher ---------- */

export const BLOCK = 4;

/** Encrypts one four-byte block with a small Feistel network. Fine for a demonstration, useless for secrets. */
function encryptBlock(block: Uint8Array, key: string): Uint8Array {
  let left = [block[0], block[1]];
  let right = [block[2], block[3]];
  for (let round = 0; round < 4; round++) {
    const mix = sha256(concat(new TextEncoder().encode(`${key}/${round}/`), Uint8Array.from(right)));
    [left, right] = [right, [left[0] ^ mix[0], left[1] ^ mix[1]]];
  }
  return Uint8Array.from([...right, ...left]);
}

export type BlockMode = 'ECB' | 'CBC';

/**
 * Encrypts text four bytes at a time. In ECB each block is encrypted alone. In
 * CBC each block is first combined with the ciphertext before it, starting
 * from the initialisation vector.
 */
export function encryptBlocks(text: string, key: string, mode: BlockMode, iv: number): { plain: string[]; cipher: string[] } {
  const bytes = new TextEncoder().encode(text.padEnd(Math.ceil(text.length / BLOCK) * BLOCK || BLOCK, ' '));
  const plain: string[] = [];
  const cipher: string[] = [];
  let previous = Uint8Array.from([iv >>> 24, iv >>> 16, iv >>> 8, iv]);
  for (let at = 0; at < bytes.length; at += BLOCK) {
    const block = bytes.slice(at, at + BLOCK);
    const input = mode === 'CBC' ? block.map((byte, i) => byte ^ previous[i]) : block;
    previous = encryptBlock(input, key);
    plain.push(new TextDecoder().decode(block));
    cipher.push(hex(previous));
  }
  return { plain, cipher };
}

/* ---------- RSA and Diffie-Hellman with small numbers ---------- */

export function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  base %= modulus;
  // Square and multiply: one step for each bit of the exponent.
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

const gcd = (a: bigint, b: bigint): bigint => (b ? gcd(b, a % b) : a);

/** The number d with (e × d) mod m = 1, by the extended Euclidean algorithm. */
function inverse(e: bigint, m: bigint): bigint {
  let [oldR, r, oldS, s] = [e, m, 1n, 0n];
  while (r) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % m) + m) % m;
}

export const primePairs: [number, number][] = [
  [11, 13],
  [61, 53],
  [101, 113],
  [1009, 1013],
];

export function rsaKeys(p: number, q: number) {
  const n = BigInt(p) * BigInt(q);
  const phi = BigInt(p - 1) * BigInt(q - 1);
  let e = 3n;
  while (gcd(e, phi) !== 1n) e += 2n;
  return { n, phi, e, d: inverse(e, phi) };
}

/** Finds a factor of n by trying every candidate, and reports how many it tried. */
export function factor(n: bigint): { p: bigint; tries: number } {
  let tries = 0;
  for (let p = 2n; p * p <= n; p++) {
    tries++;
    if (n % p === 0n) return { p, tries };
  }
  return { p: n, tries };
}

/** A message digest squeezed into the range of a small RSA modulus. */
export const digestNumber = (text: string, n: bigint) => BigInt(new DataView(sha256(text).buffer).getUint32(0)) % n;

/** Public parameters for Diffie-Hellman: a prime and a generator. */
export const dhGroups: [p: number, g: number][] = [
  [23, 5],
  [467, 2],
  [7919, 7],
];

/** Solves g^x = target (mod p) by trying every x, as an eavesdropper would have to. */
export function discreteLog(g: number, target: bigint, p: number): { x: number; tries: number } {
  let value = 1n;
  for (let x = 0; x < p; x++) {
    if (value === target) return { x, tries: x + 1 };
    value = (value * BigInt(g)) % BigInt(p);
  }
  return { x: -1, tries: p };
}

/* ---------- Passwords ---------- */

const common = ['password', '123456', '12345678', 'qwerty', 'abc123', 'letmein', 'monkey', 'dragon', 'iloveyou', 'admin', 'welcome', 'football', 'sunshine', 'princess', 'password1', 'hunter2'];

/** Guesses a second: a fast hash on a rack of graphics cards, and a deliberately slow password hash. */
export const FAST_RATE = 1e10;
export const SLOW_RATE = 1e4;

export function passwordStrength(password: string) {
  const pool =
    (/[a-z]/.test(password) ? 26 : 0) +
    (/[A-Z]/.test(password) ? 26 : 0) +
    (/[0-9]/.test(password) ? 10 : 0) +
    (/[^a-zA-Z0-9]/.test(password) ? 33 : 0);
  const listed = common.includes(password.toLowerCase());
  // On average the answer turns up halfway through the search.
  const guesses = listed ? 1 : pool ** password.length / 2;
  return { pool, listed, guesses, bitsOfEntropy: password.length * Math.log2(pool || 1) };
}

export function duration(seconds: number): string {
  if (seconds < 1) return 'under a second';
  const units: [string, number][] = [['second', 60], ['minute', 60], ['hour', 24], ['day', 365.25], ['year', 1e3], ['thousand years', 1e3], ['million years', 1e3], ['billion years', 1e3]];
  let value = seconds;
  for (const [name, size] of units) {
    if (value < size) {
      const rounded = value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
      return `${rounded} ${name}${rounded === 1 || name.includes(' ') ? '' : 's'}`;
    }
    value /= size;
  }
  return 'far longer than the age of the universe';
}

/* ---------- Buffer overflow ---------- */

export type Protection = 'none' | 'bounds' | 'canary';

export interface StackCell {
  region: 'buffer' | 'canary' | 'flag' | 'return';
  value: number;
  /** Overwritten by the input when it should not have been. */
  smashed: boolean;
}

const BUFFER = 8;
const RETURN = [0x00, 0x40, 0x1a, 0x2c];
const CANARY = [0x5e, 0xc7];

/** Copies `input` into an eight-byte buffer on the stack, the way C's strcpy would, and reports the damage. */
export function overflow(input: string, protection: Protection) {
  const layout: StackCell[] = [
    ...Array.from({ length: BUFFER }, (): StackCell => ({ region: 'buffer', value: 0, smashed: false })),
    ...(protection === 'canary' ? CANARY.map((value): StackCell => ({ region: 'canary', value, smashed: false })) : []),
    { region: 'flag', value: 0, smashed: false },
    ...RETURN.map((value): StackCell => ({ region: 'return', value, smashed: false })),
  ];
  // strcpy copies every byte and then a terminating zero. A bounds check stops at the buffer's size.
  let bytes = [...new TextEncoder().encode(input), 0];
  if (protection === 'bounds') bytes = [...bytes.slice(0, BUFFER - 1), 0];
  bytes.slice(0, layout.length).forEach((byte, i) => {
    layout[i].smashed = layout[i].region !== 'buffer';
    layout[i].value = byte;
  });
  const region = (name: StackCell['region']) => layout.filter((cell) => cell.region === name);
  return {
    layout,
    truncated: protection === 'bounds' && input.length > BUFFER - 1,
    canaryDead: region('canary').some((cell) => cell.smashed),
    authorised: region('flag')[0].value !== 0,
    returnChanged: region('return').some((cell) => cell.smashed),
    returnAddress: `0x${hex(Uint8Array.from(region('return').map((cell) => cell.value)))}`,
  };
}

/* ---------- SQL injection ---------- */

export const users: Table = {
  columns: ['id', 'name', 'password', 'role'],
  rows: [
    { id: 1, name: 'alice', password: 'sunshine', role: 'user' },
    { id: 2, name: 'admin', password: 'tr0ub4dor', role: 'admin' },
    { id: 3, name: 'bob', password: 'hunter2', role: 'user' },
  ],
};

/** A login check, built by pasting the inputs into the query or by passing them as parameters. */
export function login(name: string, password: string, parameterised: boolean) {
  if (parameterised) {
    return {
      query: 'SELECT id, name, role FROM users WHERE name = ? AND password = ?',
      rows: users.rows.filter((row) => row.name === name && row.password === password).map((row) => [row.id, row.name, row.role]),
    };
  }
  const query = `SELECT id, name, role FROM users WHERE name = '${name}' AND password = '${password}'`;
  try {
    return { query, rows: runSql(query, { users }).rows };
  } catch (error) {
    return { query, error: (error as Error).message };
  }
}

/* ---------- Signed tokens ---------- */

export const SERVER_SECRET = 'kept-on-the-server-only';

const base64url = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** The signature a server would attach to a payload, shortened for display. */
export const signToken = (payload: string, secret = SERVER_SECRET) => hex(hmac(secret, payload)).slice(0, 24);

export const tokenText = (payload: string, signature: string) => `${base64url(payload)}.${signature}`;
