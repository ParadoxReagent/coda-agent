import { describe, it, expect } from "vitest";
import { formatUserFacingError } from "../../../src/interfaces/user-facing-error.js";

describe("formatUserFacingError", () => {
  it("maps affordability/budget failures", () => {
    const err = Object.assign(
      new Error(
        "This request requires more credits, or fewer max_tokens. You requested up to 4096 tokens, but can only afford 1778."
      ),
      { status: 402 }
    );

    expect(formatUserFacingError(err)).toContain("token budget");
  });

  it("maps provider rate limits", () => {
    const err = new Error("429 Too Many Requests");
    expect(formatUserFacingError(err)).toContain("rate limit");
  });

  it("maps auth failures", () => {
    const err = Object.assign(new Error("Unauthorized"), { status: 401 });
    expect(formatUserFacingError(err)).toContain("authenticate");
  });

  it("maps provider connectivity failures", () => {
    const err = new Error("Provider \"openrouter\" circuit breaker is open — provider temporarily unavailable");
    expect(formatUserFacingError(err)).toContain("trouble reaching");
  });

  it("falls back to generic safe message", () => {
    const err = new Error("unexpected unknown issue");
    expect(formatUserFacingError(err)).toBe(
      "Sorry, I encountered an error processing your message. Please try again."
    );
  });
});
