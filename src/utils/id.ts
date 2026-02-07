import { randomBytes } from "node:crypto";

/**
 * Generate a compact, time-sortable event ID.
 * Format: base36(timestamp) + "-" + 8 hex chars of randomness.
 * No external dependencies needed.
 */
export function generateEventId(): string {
  const timePart = Date.now().toString(36);
  const randomPart = randomBytes(4).toString("hex");
  return `${timePart}-${randomPart}`;
}
