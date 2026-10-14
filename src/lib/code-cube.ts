// Three-bit codes drawn on a cube. Each corner is a 3-bit word, and each edge
// joins two words that differ in exactly one bit, so the number of edges walked
// between two corners is their Hamming distance.

export type CodeId = 'none' | 'parity' | 'repeat';

export interface Code {
  id: CodeId;
  name: string;
  words: string[];
  distance: number;
  dataBits: number;
  summary: string;
}

export const corners = ['000', '001', '010', '011', '100', '101', '110', '111'];

export const codes: Record<CodeId, Code> = {
  none: {
    id: 'none',
    name: 'No redundancy',
    words: corners,
    distance: 1,
    dataBits: 3,
    summary: 'Every corner is a codeword. Any flip lands on another codeword, so nothing is noticed.',
  },
  parity: {
    id: 'parity',
    name: 'Parity bit',
    words: ['000', '011', '101', '110'],
    distance: 2,
    dataBits: 2,
    summary: 'Codewords have an even number of 1s. One flip always lands between codewords, so it is seen but cannot be placed.',
  },
  repeat: {
    id: 'repeat',
    name: 'Say it three times',
    words: ['000', '111'],
    distance: 3,
    dataBits: 1,
    summary: 'Two codewords at opposite corners. One flip stays closer to the word that was sent, so it can be undone.',
  },
};

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
  if (near.length > 1) {
    return {
      outcome: 'detected',
      decoded: null,
      text: `Error detected. ${near.join(', ')} are equally close, so the receiver cannot tell which was sent and must ask again.`,
    };
  }
  if (near[0] === sent) {
    return { outcome: 'corrected', decoded: sent, text: `Corrected. ${sent} is the only codeword one step away.` };
  }
  return {
    outcome: 'miscorrected',
    decoded: near[0],
    text: `Wrongly corrected to ${near[0]}. ${flips} flips carried the word closer to a different codeword.`,
  };
}

/** A shortest walk along cube edges from one word to another, one bit per step. */
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
