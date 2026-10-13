// Small models for the information and coding pages: symbol entropy, Huffman
// codes, LZ77 matching, three checksums and the Hamming(7,4) code.

import type { TreeNode } from './languages';

/** How a symbol is shown in a table or tree, so that a space is visible. */
export const show = (symbol: string) => (symbol === ' ' ? '␣' : symbol === '\n' ? '↵' : symbol);

/* ---------- Entropy ---------- */

export interface SymbolStat {
  symbol: string;
  count: number;
  /** The share of the text this symbol makes up. */
  p: number;
  /** Bits of information in one occurrence: -log2(p). */
  bits: number;
}

/** Counts each character, most frequent first. Ties keep their order of first appearance. */
export function frequencies(text: string): SymbolStat[] {
  const counts = new Map<string, number>();
  const symbols = [...text];
  for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  return [...counts]
    .map(([symbol, count]) => ({ symbol, count, p: count / symbols.length, bits: Math.log2(symbols.length / count) }))
    .sort((a, b) => b.count - a.count);
}

/** Average bits per character, treating each character as an independent draw. */
export const entropy = (text: string) => frequencies(text).reduce((sum, { p, bits }) => sum + p * bits, 0);

/* ---------- Huffman coding ---------- */

interface HuffmanNode {
  weight: number;
  /** Order of creation, used to break ties the same way every time. */
  order: number;
  symbol?: string;
  left?: HuffmanNode;
  right?: HuffmanNode;
}

export interface HuffmanStep {
  /** The two lightest nodes, as labels, and the weight of their parent. */
  a: string;
  b: string;
  weight: number;
}

export interface HuffmanResult {
  tree: TreeNode | null;
  codes: Map<string, string>;
  steps: HuffmanStep[];
  /** Length of the encoded text in bits, not counting the table. */
  encodedBits: number;
}

/** Builds a Huffman code by repeatedly joining the two lightest nodes. */
export function huffman(text: string): HuffmanResult {
  let order = 0;
  let nodes: HuffmanNode[] = frequencies(text).map(({ symbol, count }) => ({ weight: count, order: order++, symbol }));
  const steps: HuffmanStep[] = [];
  const label = (node: HuffmanNode) => (node.symbol === undefined ? String(node.weight) : `${show(node.symbol)} ${node.weight}`);
  while (nodes.length > 1) {
    nodes.sort((a, b) => a.weight - b.weight || a.order - b.order);
    const [a, b, ...rest] = nodes;
    const parent: HuffmanNode = { weight: a.weight + b.weight, order: order++, left: a, right: b };
    steps.push({ a: label(a), b: label(b), weight: parent.weight });
    nodes = [...rest, parent];
  }
  const codes = new Map<string, string>();
  const walk = (node: HuffmanNode, code: string): TreeNode => {
    if (node.symbol !== undefined) {
      // A text with one distinct symbol still needs one bit per symbol.
      codes.set(node.symbol, code || '0');
      return { label: label(node), children: [], note: code || '0' };
    }
    return { label: label(node), children: [walk(node.left!, `${code}0`), walk(node.right!, `${code}1`)] };
  };
  const tree = nodes.length ? walk(nodes[0], '') : null;
  const encodedBits = [...text].reduce((sum, symbol) => sum + codes.get(symbol)!.length, 0);
  return { tree, codes, steps, encodedBits };
}

export const huffmanEncode = (text: string, codes: Map<string, string>) => [...text].map((symbol) => codes.get(symbol)!);

/** Reads bits left to right, emitting a symbol whenever the bits so far are a complete code. */
export function huffmanDecode(bitString: string, codes: Map<string, string>): string {
  const symbols = new Map([...codes].map(([symbol, code]) => [code, symbol]));
  let text = '';
  let current = '';
  for (const bit of bitString) {
    current += bit;
    const symbol = symbols.get(current);
    if (symbol !== undefined) {
      text += symbol;
      current = '';
    }
  }
  return text;
}

/* ---------- LZ77 ---------- */

export type LzToken = { literal: string } | { offset: number; length: number; text: string };

export const LZ_WINDOW = 2048;
export const LZ_MIN = 3;
export const LZ_MAX = 18;
/** A flag bit and eight bits of character. */
export const LITERAL_BITS = 9;
/** A flag bit, eleven bits of offset and four of length. */
export const MATCH_BITS = 16;

/** Greedy LZ77: at each position, take the longest match found in the text already seen. */
export function lz77(text: string, window = LZ_WINDOW): LzToken[] {
  const tokens: LzToken[] = [];
  let i = 0;
  while (i < text.length) {
    let best = 0;
    let bestOffset = 0;
    for (let start = Math.max(0, i - window); start < i; start++) {
      let length = 0;
      // The match may run past i into the text it is itself producing.
      while (length < LZ_MAX && i + length < text.length && text[start + length] === text[i + length]) length++;
      if (length >= best && length > 0) {
        best = length;
        bestOffset = i - start;
      }
    }
    if (best >= LZ_MIN) {
      tokens.push({ offset: bestOffset, length: best, text: text.slice(i, i + best) });
      i += best;
    } else {
      tokens.push({ literal: text[i] });
      i++;
    }
  }
  return tokens;
}

export function lzDecode(tokens: LzToken[]): string {
  let text = '';
  for (const token of tokens) {
    if ('literal' in token) text += token.literal;
    // Copy one character at a time, so an overlapping match can read what it has just written.
    else for (let k = 0; k < token.length; k++) text += text[text.length - token.offset];
  }
  return text;
}

export const lzBits = (tokens: LzToken[]) => tokens.reduce((sum, token) => sum + ('literal' in token ? LITERAL_BITS : MATCH_BITS), 0);

/* ---------- Checksums ---------- */

/** One bit: 1 if the number of 1 bits in the data is odd. */
export const parity = (bytes: number[]) => bytes.reduce((bit, byte) => bit ^ (byte.toString(2).split('1').length - 1), 0) & 1;

/** The bytes added together, keeping the low eight bits. */
export const sum8 = (bytes: number[]) => bytes.reduce((sum, byte) => (sum + byte) & 0xff, 0);

/** CRC-8 with the polynomial x^8 + x^2 + x + 1, one bit at a time. */
export function crc8(bytes: number[]): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
  }
  return crc;
}

/** CRC-32 as used by Ethernet, zip and PNG. */
export function crc32(bytes: number[]): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export const checks = [
  { name: 'Parity bit', width: 1, compute: parity },
  { name: 'Sum of bytes', width: 8, compute: sum8 },
  { name: 'CRC-8', width: 8, compute: crc8 },
] as const;

export type Damage = 'one-bit' | 'two-bits' | 'swap' | 'burst';

/** Applies a named kind of damage, chosen where it can to slip past the weaker checks. */
export function damage(bytes: number[], kind: Damage): number[] {
  const out = [...bytes];
  if (out.length < 2) return out;
  if (kind === 'one-bit') {
    out[1] ^= 0x01;
  } else if (kind === 'two-bits') {
    // Flip the same bit in two bytes where it differs, so one goes up by as much as the other goes down.
    for (let bit = 0; bit < 8; bit++) {
      for (let i = 0; i < out.length; i++) {
        const j = out.findIndex((other, at) => at > i && ((other ^ out[i]) >> bit) & 1);
        if (j > 0) {
          out[i] ^= 1 << bit;
          out[j] ^= 1 << bit;
          return out;
        }
      }
    }
  } else if (kind === 'swap') {
    const i = out.findIndex((byte, at) => at + 1 < out.length && byte !== out[at + 1]);
    if (i >= 0) [out[i], out[i + 1]] = [out[i + 1], out[i]];
  } else {
    // Five bits in a row, across a byte boundary.
    out[0] ^= 0x03;
    out[1] ^= 0xe0;
  }
  return out;
}

/* ---------- Hamming(7,4) ---------- */

/** Positions are numbered 1 to 7. Parity bits sit at 1, 2 and 4, data at 3, 5, 6 and 7. */
export const HAMMING_DATA = [3, 5, 6, 7];
export const HAMMING_PARITY = [1, 2, 4];

/** The positions each parity bit covers: every position whose number has that bit set. */
export const covers = (parityPosition: number) => [1, 2, 3, 4, 5, 6, 7].filter((position) => position & parityPosition);

export function hammingEncode(data: number[]): number[] {
  const word = Array<number>(8).fill(0);
  HAMMING_DATA.forEach((position, i) => (word[position] = data[i] & 1));
  for (const position of HAMMING_PARITY) {
    word[position] = covers(position).reduce((bit, covered) => bit ^ word[covered], 0);
  }
  return word.slice(1);
}

export function hammingDecode(received: number[]) {
  const word = [0, ...received];
  // Each failed check contributes its own position number, and the total is the position in error.
  const failed = HAMMING_PARITY.filter((position) => covers(position).reduce((bit, covered) => bit ^ word[covered], 0) === 1);
  const syndrome = failed.reduce((sum, position) => sum + position, 0);
  if (syndrome) word[syndrome] ^= 1;
  return { failed, syndrome, corrected: word.slice(1), data: HAMMING_DATA.map((position) => word[position]) };
}

/* ---------- Views, shared by the server render and the browser ---------- */

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const cell = (symbol: string) => `<code>${escapeHtml(show(symbol))}</code>`;
export const toBytes = (text: string) => [...new TextEncoder().encode(text)];

export function entropyView(text: string) {
  const stats = frequencies(text);
  const length = [...text].length;
  const h = entropy(text);
  const widest = Math.max(1, ...stats.map((stat) => stat.count));
  const rows = stats
    .map(
      ({ symbol, count, p, bits }) =>
        `<tr><td>${cell(symbol)}</td><td>${count}</td><td>${(p * 100).toFixed(1)}%</td><td>${bits.toFixed(2)}</td>` +
        `<td class="bar"><i style="width:${((count / widest) * 100).toFixed(1)}%"></i></td></tr>`,
    )
    .join('');
  return {
    rows,
    entropy: `${h.toFixed(2)} bits per character`,
    total: `${Math.ceil(h * length)} bits, against ${length * 8} at one byte each`,
    alphabet: `${stats.length} of ${length}`,
    status: !length
      ? 'Type some text.'
      : stats.length === 1
        ? 'Only one symbol ever appears, so the next character is never a surprise and carries no information at all.'
        : stats.every((stat) => stat.count === stats[0].count)
          ? `All ${stats.length} symbols are equally likely, which is the most uncertain a source with ${stats.length} symbols can be: log2(${stats.length}) = ${Math.log2(stats.length).toFixed(2)} bits each.`
          : `Common symbols carry few bits and rare ones carry many. This count ignores order, so it cannot see patterns such as repeated words.`,
  };
}

export function huffmanView(text: string) {
  const { codes, encodedBits, steps } = huffman(text);
  const stats = frequencies(text);
  const length = [...text].length;
  const fixed = Math.max(1, Math.ceil(Math.log2(Math.max(1, stats.length))));
  const rows = stats
    .map(({ symbol, count }) => `<tr><td>${cell(symbol)}</td><td>${count}</td><td><code>${codes.get(symbol)}</code></td><td>${count * codes.get(symbol)!.length}</td></tr>`)
    .join('');
  const encoded = huffmanEncode(text, codes)
    .map((code, i) => `<i${i % 2 ? ' class="hit"' : ''}>${code}</i>`)
    .join('');
  return {
    rows,
    encoded,
    size: `${encodedBits} bits, ${(encodedBits / Math.max(1, length)).toFixed(2)} per character`,
    fixed: `${length * fixed} bits at ${fixed} per character, ${length * 8} as bytes`,
    limit: `${(entropy(text) * length).toFixed(1)} bits`,
    status: !length
      ? 'Type some text.'
      : `Built in ${steps.length} joins, each taking the two lightest nodes. Follow the branches from the top, 0 to the left and 1 to the right, to read off a symbol's code.`,
  };
}

export function lzView(text: string) {
  const tokens = lz77(text);
  const matches = tokens.filter((token) => 'offset' in token).length;
  const html = tokens
    .map((token) =>
      'literal' in token
        ? `<i>${escapeHtml(show(token.literal))}</i>`
        : `<i class="blocked" title="${escapeHtml(token.text)}">back ${token.offset}, copy ${token.length}</i>`,
    )
    .join('');
  const size = lzBits(tokens);
  return {
    html,
    tokens: `${tokens.length - matches} literals and ${matches} references`,
    size: `${size} bits, against ${text.length * 8} uncompressed`,
    status: !text.length
      ? 'Type some text.'
      : !matches
        ? 'Nothing repeats, so every character is sent as a literal. Each literal costs a flag bit on top of its eight, so the output is larger than the input.'
        : size < text.length * 8
          ? 'Each orange token points back into text the decoder has already produced. Hover over one to see what it copies.'
          : 'There are repeats, but too few to pay for the flag bit that every literal carries.',
  };
}

export function checksumView(sent: number[], received: number[]) {
  const hex = (byte: number) => byte.toString(16).padStart(2, '0');
  const bytes = (list: number[], other: number[]) => list.map((byte, i) => `<i${byte !== other[i] ? ' class="blocked"' : ''}>${hex(byte)}</i>`).join('');
  const changed = sent.some((byte, i) => byte !== received[i]);
  let missed = 0;
  const rows = checks
    .map(({ name, width, compute }) => {
      const a = compute(sent);
      const b = compute(received);
      const format = (value: number) => (width === 1 ? String(value) : hex(value));
      if (changed && a === b) missed++;
      const verdict = !changed ? 'nothing to detect' : a === b ? 'missed' : 'detected';
      return `<tr${changed && a === b ? ' class="hit"' : ''}><td>${name}</td><td><code>${format(a)}</code></td><td><code>${format(b)}</code></td><td>${verdict}</td></tr>`;
    })
    .join('');
  return {
    sent: bytes(sent, sent),
    received: bytes(received, sent),
    text: String.fromCharCode(...received.map((byte) => (byte >= 32 && byte < 127 ? byte : 0xb7))),
    rows,
    status: !changed
      ? 'The receiver recomputes each check over the bytes that arrived and compares it with the value sent alongside.'
      : missed
        ? `${missed} of the 3 checks came out the same for the damaged bytes, so a receiver relying on it would accept them.`
        : 'All three checks changed, so each would reject the damaged bytes.',
  };
}

export function hammingView(data: number[], flipped: number[]) {
  const sent = hammingEncode(data);
  const received = sent.map((bit, i) => (flipped.includes(i + 1) ? bit ^ 1 : bit));
  const { failed, syndrome, data: decoded } = hammingDecode(received);
  const kind = (position: number) => (HAMMING_PARITY.includes(position) ? 'parity' : 'data');
  const cells = received
    .map(
      (bit, i) =>
        `<button type="button" data-position="${i + 1}" data-kind="${kind(i + 1)}" aria-pressed="${flipped.includes(i + 1)}"${syndrome === i + 1 ? ' data-blamed' : ''}>` +
        `<small>${i + 1}</small><b>${bit}</b><small>${kind(i + 1) === 'parity' ? `p${i + 1}` : `d${HAMMING_DATA.indexOf(i + 1) + 1}`}</small></button>`,
    )
    .join('');
  const rows = HAMMING_PARITY.map((position) => {
    const covered = covers(position);
    const bad = failed.includes(position);
    return `<tr${bad ? ' class="hit"' : ''}><td>p${position}</td><td>${covered.join(', ')}</td><td><code>${covered.map((at) => received[at - 1]).join(' ')}</code></td><td>${bad ? 'odd, fails' : 'even, passes'}</td></tr>`;
  }).join('');
  const right = decoded.join('') === data.join('');
  return {
    cells,
    rows,
    sent: sent.join(''),
    syndrome: syndrome ? `${failed.join(' + ') || 0} = ${syndrome}, so flip position ${syndrome}` : '0, no error found',
    decoded: `${decoded.join('')}, ${right ? 'correct' : `wrong, the data was ${data.join('')}`}`,
    status:
      flipped.length === 0
        ? 'Click any of the seven bits to flip it in transit.'
        : flipped.length === 1
          ? `The failed checks add up to ${syndrome}, the position that was flipped. The receiver flips it back.`
          : right
            ? 'The flips cancelled out by luck.'
            : `With ${flipped.length} bits flipped the checks point at the wrong position${syndrome ? '' : ', or at none'}, and the receiver ends up with wrong data without knowing. This code corrects one error and no more.`,
  };
}
