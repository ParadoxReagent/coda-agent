import Fastify from "fastify";
import type { Logger } from "../utils/logger.js";

interface HealthStatus {
  status: "ok" | "degraded" | "error";
  services: Record<string, { status: string; latency?: number }>;
  uptime: number;
}

export class RestApi {
  private app = Fastify({ logger: false });
  private logger: Logger;
  private startTime = Date.now();

  constructor(logger: Logger) {
    this.logger = logger;
    this.setupRoutes();
  }

  private setupRoutes(): void {
    this.app.get("/health", async () => {
      const status: HealthStatus = {
        status: "ok",
        services: {
          core: { status: "running" },
        },
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
