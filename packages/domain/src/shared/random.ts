/** Injected randomness so security-relevant generation is testable and never uses Math.random. */
export type RandomSource = (byteLength: number) => Uint8Array;

export const cryptoRandom: RandomSource = (byteLength) => {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
};

/** Uniform integer in [0, maxExclusive) using rejection sampling (no modulo bias). */
export function randomInt(maxExclusive: number, random: RandomSource = cryptoRandom): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > 256) {
    throw new RangeError('randomInt supports 1..256 buckets');
  }
  const limit = 256 - (256 % maxExclusive);
  for (;;) {
    const [byte] = random(1);
    if (byte === undefined) throw new Error('RandomSource returned no bytes');
    if (byte < limit) return byte % maxExclusive;
  }
}
