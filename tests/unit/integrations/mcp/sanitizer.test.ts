import { describe, it, expect } from "vitest";
import {
  sanitizeMcpResponse,
  truncateMcpResponse,
} from "../../../../src/integrations/mcp/sanitizer.js";

describe("sanitizer", () => {
  describe("sanitizeMcpResponse", () => {
    it("wraps content in external_data tags", () => {
      const result = sanitizeMcpResponse("MCP response content");

      expect(result).toContain("<external_data>");
      expect(result).toContain("</external_data>");
      expect(result).toContain("untrusted data");
    });

    it("escapes HTML in response", () => {
      const result = sanitizeMcpResponse("<script>alert('xss')</script>");

      expect(result).toContain("&lt;script&gt;");
      expect(result).not.toContain("<script>");
    });

    it("handles empty content", () => {
      const result = sanitizeMcpResponse("");

      expect(result).toBe("");
    });
  });

  describe("truncateMcpResponse", () => {
    it("does not truncate content within size limit", () => {
      const content = "A".repeat(1000);
      const result = truncateMcpResponse(content, 2000);

      expect(result.content).toBe(content);
      expect(result.truncated).toBe(false);
    });

    it("truncates content exceeding size limit", () => {
      const content = "A".repeat(2000);
      const result = truncateMcpResponse(content, 1000);

      expect(result.content).toHaveLength(1000);
      expect(result.truncated).toBe(true);
      expect(result.content).toBe("A".repeat(1000));
    });

    it("handles empty content", () => {
      const result = truncateMcpResponse("", 1000);

      expect(result.content).toBe("");
      expect(result.truncated).toBe(false);
    });

    it("handles exact size match", () => {
      const content = "A".repeat(1000);
      const result = truncateMcpResponse(content, 1000);

      expect(result.content).toBe(content);
      expect(result.truncated).toBe(false);
    });
  });
});
