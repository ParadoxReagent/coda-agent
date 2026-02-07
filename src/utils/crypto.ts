import { randomBytes } from "node:crypto";

/**
 * Generate a cryptographically random confirmation token.
 * Minimum 80 bits of entropy (16 base32 characters from 10 random bytes).
 */
export function generateConfirmationToken(): string {
  const bytes = randomBytes(10); // 80 bits of entropy
  return base32Encode(bytes);
}

/** RFC 4648 base32 encoding (no padding) */
function base32Encode(buffer: Buffer): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += alphabet[(value >>> bits) & 31]!;
    }
  }

  if (bits > 0) {
    output += alphabet[(value << (5 - bits)) & 31]!;
  }

  return output;
}
