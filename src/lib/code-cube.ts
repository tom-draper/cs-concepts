// Short codes drawn as cubes. Each corner is a word, and each edge joins two
// words that differ in exactly one bit, so the number of edges walked between
// two corners is their Hamming distance. Three bits make a cube; four bits make
// a tesseract, two cubes joined corner to corner along the fourth bit.

export type CodeId = 'none' | 'parity' | 'repeat';
export type Bits = 3 | 4;

export interface Code {
  id: CodeId;
  bits: Bits;
  name: string;
  words: string[];
  distance: number;
  dataBits: number;
  summary: string;
}

/** Every word of n bits, in counting order. */
export function cornersOf(bits: number): string[] {
  return Array.from({ length: 2 ** bits }, (_, i) => i.toString(2).padStart(bits, '0'));
}

const weight = (word: string) => [...word].filter((b) => b === '1').length;

function build(bits: Bits): Record<CodeId, Code> {
  const all = cornersOf(bits);
  const zeros = '0'.repeat(bits);
  const ones = '1'.repeat(bits);
  const extra =
    bits === 3
      ? {
          none: 'Every corner is a codeword. Any flip lands on another codeword, so nothing is noticed.',
          parity:
            'Codewords have an even number of 1s. One flip always lands between codewords, so it is seen but cannot be placed.',
          repeat:
            'Two codewords at opposite corners. One flip stays closer to the word that was sent, so it can be undone.',
        }
      : {
          none: 'All 16 corners are codewords. Any flip lands on another codeword, so nothing is noticed.',
          parity:
            'Half the corners, those with an even number of 1s. As with three bits, one flip is seen but cannot be placed.',
          repeat:
            'Two codewords, four steps apart. One flip is corrected. Two land exactly halfway, so they are detected but not guessed at. Three are miscorrected.',
        };
  return {
    none: { id: 'none', bits, name: 'No redundancy', words: all, distance: 1, dataBits: bits, summary: extra.none },
    parity: {
      id: 'parity',
      bits,
      name: 'Parity bit',
      words: all.filter((w) => weight(w) % 2 === 0),
      distance: 2,
      dataBits: bits - 1,
      summary: extra.parity,
    },
    repeat: {
      id: 'repeat',
      bits,
      name: bits === 3 ? 'Say it three times' : 'Say it four times',
      words: [zeros, ones],
      distance: bits,
      dataBits: 1,
      summary: extra.repeat,
    },
  };
}

export const codes: Record<Bits, Record<CodeId, Code>> = { 3: build(3), 4: build(4) };

export function distance(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

export function flip(word: string, bit: number): string {
  return word.slice(0, bit) + (word[bit] === '0' ? '1' : '0') + word.slice(bit + 1);
}

/** The codewords at the smallest distance from a word. */
export function nearest(code: Code, word: string): string[] {
  const best = Math.min(...code.words.map((w) => distance(w, word)));
  return code.words.filter((w) => distance(w, word) === best);
}

/** The codeword the receiver would decode a word to, or null when it is a tie. */
export function decodesTo(code: Code, word: string): string | null {
  const near = nearest(code, word);
  return near.length === 1 ? near[0] : null;
}

export type Outcome = 'intact' | 'corrected' | 'detected' | 'undetected' | 'miscorrected';

/** How each outcome is coloured in a plate's verdict line. */
export const tone: Record<Outcome, string> = {
  intact: 'neutral',
  corrected: 'good',
  detected: 'warn',
  undetected: 'bad',
  miscorrected: 'bad',
};

export interface Verdict {
  outcome: Outcome;
  decoded: string | null;
  text: string;
}

const list = (items: string[]) =>
  items.length < 3 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

const steps = (n: number) => (n === 1 ? 'one step' : `${n} steps`);

export function judge(code: Code, sent: string, received: string): Verdict {
  const flips = distance(sent, received);
  const plural = flips === 1 ? 'bit' : 'bits';
  if (code.words.includes(received)) {
    if (received === sent) {
      return { outcome: 'intact', decoded: sent, text: 'Arrived as sent. Flip a bit to damage it in transit.' };
    }
    return {
      outcome: 'undetected',
      decoded: received,
      text: `${received} is itself a codeword, so the receiver accepts it. ${flips} flipped ${plural} went unnoticed.`,
    };
  }
  const near = nearest(code, received);
  const away = distance(near[0], received);
  if (near.length > 1) {
    return {
      outcome: 'detected',
      decoded: null,
      text: `Error detected. ${list(near)} are each ${steps(away)} away, so the receiver cannot tell which was sent and must ask again.`,
    };
  }
  if (near[0] === sent) {
    return {
      outcome: 'corrected',
      decoded: sent,
      text: `Corrected. ${sent} is the only codeword ${steps(away)} away.`,
    };
  }
  return {
    outcome: 'miscorrected',
    decoded: near[0],
    text: `Wrongly corrected to ${near[0]}. ${flips} flips carried the word closer to a different codeword.`,
  };
}

/** A shortest walk along edges from one word to another, one bit per step. */
export function walk(from: string, to: string): string[] {
  const path = [from];
  let at = from;
  for (let bit = 0; bit < from.length; bit++) {
    if (at[bit] !== to[bit]) {
      at = flip(at, bit);
      path.push(at);
    }
  }
  return path;
}
