import { createHash, randomUUID } from "node:crypto";

const UINT32_RANGE = 0x1_0000_0000;

/**
 * Seed strings are trimmed and normalized before hashing so equivalent Unicode
 * input produces the same opening on every supported operating system.
 */
export const normalizeGameSeed = (seed: string): string =>
  seed.trim().normalize("NFC");

/**
 * SHA-256 + sfc32. Both stages use explicitly defined byte/integer operations,
 * making the generated sequence independent of OS and CPU architecture.
 */
export function createSeededRng(seed: string): () => number {
  const normalized = normalizeGameSeed(seed);
  if (!normalized) {
    throw new Error("Seed 不能为空。");
  }

  const digest = createHash("sha256").update(normalized, "utf8").digest();
  let a = digest.readUInt32LE(0);
  let b = digest.readUInt32LE(4);
  let c = digest.readUInt32LE(8);
  let d = digest.readUInt32LE(12);

  return () => {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const result = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11) | 0;
    c = (c + result) | 0;
    return (result >>> 0) / UINT32_RANGE;
  };
}

export const generateGameSeed = (): string =>
  `MX-${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
