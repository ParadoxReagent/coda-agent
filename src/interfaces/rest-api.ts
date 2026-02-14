import Fastify from "fastify";
import type { Logger } from "../utils/logger.js";
import type { SkillHealthTracker } from "../core/skill-health.js";
import type { ProviderManager } from "../core/llm/manager.js";
import type Redis from "ioredis";

interface HealthStatus {
  status: "ok" | "degraded" | "error";
  services: Record<string, { status: string; latency?: number }>;
  uptime: number;
}

interface HealthDeps {
  redis?: Redis;
  skillHealth?: SkillHealthTracker;
  providerManager?: ProviderManager;
}

interface AuthOptions {
  apiKey?: string;
  requireAuthForHealth?: boolean;
}

export class RestApi {
  private app = Fastify({ logger: false });
  private logger: Logger;
  private startTime = Date.now();
  private deps: HealthDeps;
  private authOptions: AuthOptions;

  constructor(logger: Logger, deps?: HealthDeps, authOptions?: AuthOptions) {
    this.logger = logger;
    this.deps = deps ?? {};
    this.authOptions = authOptions ?? {};
    this.setupAuth();
    this.setupRoutes();
  }

  private setupAuth(): void {
    const { apiKey, requireAuthForHealth } = this.authOptions;
    if (!apiKey) return; // No API key configured — open access

    this.app.addHook("onRequest", async (request, reply) => {
      // Allow /health without auth unless requireAuthForHealth is true
      if (request.url === "/health" && !requireAuthForHealth) {
        return;
      }

      const authHeader = request.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${apiKey}`) {
        reply.code(401).send({ error: "Unauthorized" });
      }
    });
  }

  private setupRoutes(): void {
    this.app.get("/health", async () => {
      const services: Record<string, { status: string; latency?: number }> = {
        core: { status: "running" },
      };
      let overallStatus: "ok" | "degraded" | "error" = "ok";

      // Check Redis
      if (this.deps.redis) {
        try {
          const start = Date.now();
          await this.deps.redis.ping();
          services.redis = {
            status: "connected",
            latency: Date.now() - start,
          };
        } catch {
          services.redis = { status: "disconnected" };
          overallStatus = "degraded";
        }
      }

      // Check skill health
      if (this.deps.skillHealth) {
        const allHealth = this.deps.skillHealth.getAllHealth();
        let degradedCount = 0;
        let unavailableCount = 0;
        for (const [, health] of allHealth) {
          if (health.status === "degraded") degradedCount++;
          if (health.status === "unavailable") unavailableCount++;
        }
        services.skills = {
          status:
            unavailableCount > 0
              ? "degraded"
              : degradedCount > 0
                ? "partial"
                : "healthy",
        };
        if (unavailableCount > 0 && overallStatus === "ok") {
          overallStatus = "degraded";
        }
      }

      // Check LLM providers
      if (this.deps.providerManager) {
        const providers = this.deps.providerManager.listProviders();
        let availableCount = 0;
        for (const p of providers) {
          const health = this.deps.providerManager.getProviderHealth(p.name);
          if (health === "closed" || health === "half-open") {
            availableCount++;
          }
        }
        services.llm = {
          status:
            availableCount === 0
              ? "unavailable"
              : availableCount < providers.length
                ? "degraded"
                : "healthy",
        };
        if (availableCount === 0) {
          overallStatus = "error";
        } else if (availableCount < providers.length && overallStatus === "ok") {
          overallStatus = "degraded";
        }
      }

      const status: HealthStatus = {
        status: overallStatus,
        services,
        uptime: (Date.now() - this.startTime) / 1000,
      };
      return status;
    });
  }

  async start(port: number, host: string): Promise<void> {
    await this.app.listen({ port, host });
    this.logger.info({ port, host }, "REST API server started");
  }

  async stop(): Promise<void> {
    await this.app.close();
    this.logger.info("REST API server stopped");
  }
}
