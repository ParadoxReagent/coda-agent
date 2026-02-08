import { describe, it, expect, vi } from "vitest";
import { RestApi } from "../../src/interfaces/rest-api.js";
import { SkillHealthTracker } from "../../src/core/skill-health.js";
import { createMockLogger } from "../helpers/mocks.js";

describe("Graceful Degradation", () => {
  describe("health endpoint reflects service status", () => {
    it("reports ok when all services are healthy", async () => {
      const logger = createMockLogger();
      const mockRedis = {
        ping: vi.fn().mockResolvedValue("PONG"),
      };
      const healthTracker = new SkillHealthTracker();

      const api = new RestApi(logger, {
        redis: mockRedis as never,
        skillHealth: healthTracker,
      });

      // Use internal inject to test the route
      const response = await (api as unknown as { app: { inject: (opts: unknown) => Promise<{ json: () => unknown; statusCode: number }> } }).app.inject({
        method: "GET",
        url: "/health",
      });

      const body = response.json() as {
        status: string;
        services: Record<string, { status: string }>;
        uptime: number;
      };
      expect(body.status).toBe("ok");
      expect(body.services.core.status).toBe("running");
    });

    it("reports degraded when Redis is unavailable", async () => {
      const logger = createMockLogger();
      const mockRedis = {
        ping: vi.fn().mockRejectedValue(new Error("Connection refused")),
      };

      const api = new RestApi(logger, {
        redis: mockRedis as never,
      });

      const response = await (api as unknown as { app: { inject: (opts: unknown) => Promise<{ json: () => unknown }> } }).app.inject({
        method: "GET",
        url: "/health",
      });

      const body = response.json() as {
        status: string;
        services: Record<string, { status: string }>;
      };
      expect(body.status).toBe("degraded");
      expect(body.services.redis.status).toBe("disconnected");
    });

    it("reports degraded when skills are unavailable", async () => {
      const logger = createMockLogger();
      const healthTracker = new SkillHealthTracker();

      // Make a skill unavailable
      for (let i = 0; i < 10; i++) {
        healthTracker.recordFailure("email", new Error("fail"));
      }

      const api = new RestApi(logger, {
        skillHealth: healthTracker,
      });

      const response = await (api as unknown as { app: { inject: (opts: unknown) => Promise<{ json: () => unknown }> } }).app.inject({
        method: "GET",
        url: "/health",
      });

      const body = response.json() as {
        status: string;
        services: Record<string, { status: string }>;
      };
      expect(body.status).toBe("degraded");
      expect(body.services.skills.status).toBe("degraded");
    });

    it("reports error when all LLM providers are down", async () => {
      const logger = createMockLogger();
      const mockProviderManager = {
        listProviders: vi.fn().mockReturnValue([
          { name: "anthropic", models: ["claude-3"], capabilities: { tools: true } },
        ]),
        getProviderHealth: vi.fn().mockReturnValue("open"), // circuit breaker open = down
      };

      const api = new RestApi(logger, {
        providerManager: mockProviderManager as never,
      });

      const response = await (api as unknown as { app: { inject: (opts: unknown) => Promise<{ json: () => unknown }> } }).app.inject({
        method: "GET",
        url: "/health",
      });

      const body = response.json() as {
        status: string;
        services: Record<string, { status: string }>;
      };
      expect(body.status).toBe("error");
      expect(body.services.llm.status).toBe("unavailable");
    });
  });

  describe("skill health tracker degradation", () => {
    it("system continues when individual skill is unavailable", () => {
      const tracker = new SkillHealthTracker();

      // Email skill fails repeatedly
      for (let i = 0; i < 10; i++) {
        tracker.recordFailure("email", new Error("IMAP timeout"));
      }

      // Email is unavailable
      expect(tracker.isAvailable("email")).toBe(false);

      // Calendar is still healthy (independent)
      expect(tracker.isAvailable("calendar")).toBe(true);
      expect(tracker.getHealth("calendar").status).toBe("healthy");
    });
  });
});
