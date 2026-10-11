// Small pure helpers behind the data-representation widgets. Used both at
// build time (for the first render) and in the browser.

export interface FloatParts {
  /** All 32 bits, most significant first. */
  bits: string;
  sign: string;
  exponent: string;
  kind: string;
  stored: string;
  error: string;
}

/** Breaks a number down as an IEEE 754 single-precision float. */
export function floatParts(input: number): FloatParts {
  const float = new Float32Array(1);
  const raw = new Uint32Array(float.buffer);
  float[0] = input;
  const bits = raw[0].toString(2).padStart(32, '0');
  const e = parseInt(bits.slice(1, 9), 2);
  const fraction = parseInt(bits.slice(9), 2);
  const stored = float[0];

  let kind = 'normal number';
  let exponent = `${e} − 127 = ${e - 127}, so × 2^${e - 127}`;
  if (e === 255) {
    kind = fraction ? 'NaN (not a number)' : 'infinity';
    exponent = 'all ones: a special value';
  } else if (e === 0) {
    kind = fraction ? 'subnormal (very close to zero)' : 'zero';
    exponent = 'all zeros: zero or subnormal';
  }

  const diff = stored - input;
  return {
    bits,
    sign: bits[0] === '0' ? '0, positive' : '1, negative',
    exponent,
    kind,
    stored: String(stored),
    error:
      Number.isNaN(input) || !Number.isFinite(stored)
        ? 'n/a'
        : diff === 0
          ? 'none: stored exactly'
          : Math.abs(diff) >= 0.001
            ? String(diff)
            : diff.toExponential(2).replace('e', ' × 10^'),
  };
}

export interface CharRow {
  char: string;
  codePoint: string;
  bytes: string[];
  utf16: number;
}

/** One row per Unicode code point, with its UTF-8 bytes. */
export function utf8Rows(text: string): CharRow[] {
  const encoder = new TextEncoder();
  return [...text].map((char) => ({
    char,
    codePoint: 'U+' + char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0'),
    bytes: [...encoder.encode(char)].map((b) => b.toString(16).toUpperCase().padStart(2, '0')),
    utf16: char.length,
  }));
}

/** Reads an n-bit pattern as a signed two's complement number. */
export function toSigned(value: number, bits: number): number {
  return value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
}

const ops: Record<string, (a: number, b: number) => number> = {
  and: (a, b) => a & b,
  or: (a, b) => a | b,
  xor: (a, b) => a ^ b,
  not: (a) => ~a,
  shl: (a) => a << 1,
  shr: (a) => a >>> 1,
};

/** Applies a bitwise operation to 8-bit values, keeping the result to 8 bits. */
export function bitwise(op: string, a: number, b: number): number {
  return ops[op](a, b) & 0xff;
}
