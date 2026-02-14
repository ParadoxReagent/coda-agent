/**
 * Ring buffer of recent classified errors for pattern detection.
 */
import type { ErrorCategory, ErrorStrategy } from "./error-classifier.js";

export interface ErrorRecord {
  timestamp: number;
  category: ErrorCategory;
  strategy: ErrorStrategy;
  source: string;
  signature: string;
  message: string;
  resolved: boolean;
}

const DEDUP_WINDOW_MS = 60_000; // 1 minute
const DEDUP_THRESHOLD = 10;

export class ErrorStore {
  private buffer: ErrorRecord[];
  private head = 0;
  private count = 0;
  private recentSignatures: Map<string, number[]> = new Map();

  constructor(private maxSize = 500) {
    this.buffer = new Array<ErrorRecord>(maxSize);
  }

  push(record: Omit<ErrorRecord, "timestamp" | "resolved">): void {
    // Deduplication: skip if we've seen this signature too many times recently
    const attempts = this.recentSignatures.get(record.signature) ?? [];
    const now = Date.now();
    const recent = attempts.filter(t => now - t < DEDUP_WINDOW_MS);

    if (recent.length >= DEDUP_THRESHOLD) {
      // Already saw this signature 10+ times in the last minute, skip
      return;
    }

    recent.push(now);
    this.recentSignatures.set(record.signature, recent);

    const entry: ErrorRecord = {
      ...record,
      message: ErrorStore.sanitize(record.message),
      timestamp: Date.now(),
      resolved: false,
    };
    this.buffer[this.head] = entry;
    this.head = (this.head + 1) % this.maxSize;
    if (this.count < this.maxSize) this.count++;
  }

  /** Sanitize error messages to prevent credential leakage. */
  static sanitize(message: string): string {
    return message
      // Redact long tokens/keys (20+ alphanumeric/dashes/underscores)
      .replace(/\b([a-zA-Z0-9_-]{20,})\b/g, "<REDACTED_TOKEN>")
      // Redact URLs with credentials (user:pass@host)
      .replace(/([a-z]+:\/\/[^:]+:[^@]+@[^\s]+)/gi, "<REDACTED_CREDENTIAL>")
      // Redact standalone credentials patterns (username:password not in URL)
      .replace(/(['"]?)([a-zA-Z0-9_-]+):([a-zA-Z0-9_!@#$%^&*()+=]+)@/g, "$1<REDACTED_CREDENTIAL>@")
      // Redact IP addresses
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<IP>")
      // Redact API key patterns
      .replace(/api[_-]?key['":\s=]+[a-zA-Z0-9_-]+/gi, "api_key=<REDACTED>")
      // Truncate to 200 chars
      .substring(0, 200);
  }

  getRecent(windowMs = 300_000): ErrorRecord[] {
    const cutoff = Date.now() - windowMs;
    return this.allEntries().filter((r) => r.timestamp >= cutoff);
  }

  getBySignature(signature: string, windowMs = 300_000): ErrorRecord[] {
    const cutoff = Date.now() - windowMs;
    return this.allEntries().filter(
      (r) => r.signature === signature && r.timestamp >= cutoff
    );
  }

  getBySource(source: string, windowMs = 300_000): ErrorRecord[] {
    const cutoff = Date.now() - windowMs;
    return this.allEntries().filter(
      (r) => r.source === source && r.timestamp >= cutoff
    );
  }

  getSize(): number {
    return this.count;
  }

  /** Build a normalized signature for grouping errors. */
  static buildSignature(category: ErrorCategory, source: string, message: string): string {
    const normalized = message
      .replace(/[0-9a-f]{8,}/gi, "<id>") // hex IDs
      .replace(/\d{10,}/g, "<ts>")        // timestamps
      .replace(/\d+\.\d+\.\d+\.\d+/g, "<ip>") // IPs
      .replace(/:\d+/g, ":<port>")        // ports
      .substring(0, 100);
    return `${category}:${source}:${normalized}`;
  }

  private allEntries(): ErrorRecord[] {
    const results: ErrorRecord[] = [];
    for (let i = 0; i < this.count; i++) {
      const idx = (this.head - this.count + i + this.maxSize) % this.maxSize;
      const entry = this.buffer[idx];
      if (entry) results.push(entry);
    }
    return results;
  }
}
