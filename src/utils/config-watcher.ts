/**
 * ConfigWatcher: Watches config.yaml for changes and hot-applies
 * non-structural settings without requiring a restart.
 *
 * Hot-reloadable:
 * - Alert rules and quiet hours
 * - Tier thresholds and patterns
 * - Rate limits (scheduler / subagent)
 * - Scheduler task cron overrides
 *
 * NOT hot-reloadable (require restart):
 * - Provider API keys / credentials
 * - Database and Redis URLs
 * - Discord/Slack tokens
 * - Skill registrations (external_dirs)
 */
import { watch, type FSWatcher } from "node:fs";
import { readFileSync, existsSync } from "node:fs";
import yaml from "js-yaml";
import { z } from "zod";
import type { Logger } from "./logger.js";
import type { EventBus } from "../core/events.js";

/** Subset of AppConfig that can be reloaded at runtime. */
export interface HotConfig {
  alerts?: {
    rules?: Record<string, unknown>;
    quiet_hours?: Record<string, unknown>;
  };
  llm?: {
    tiers?: {
      heavy_tools?: string[];
      heavy_patterns?: string[];
      heavy_message_length?: number;
    };
  };
  subagents?: {
    max_concurrent_per_user?: number;
    max_concurrent_global?: number;
    max_tool_calls_per_run?: number;
    spawn_rate_limit?: { max_requests?: number; window_seconds?: number };
  };
  scheduler?: {
    tasks?: Record<string, { cron?: string; enabled?: boolean }>;
  };
}

/** Minimal schema to extract just the hot-reloadable section. */
const HotConfigSchema = z.object({
  alerts: z.object({
    rules: z.record(z.unknown()).optional(),
    quiet_hours: z.record(z.unknown()).optional(),
  }).optional(),
  llm: z.object({
    tiers: z.object({
      heavy_tools: z.array(z.string()).optional(),
      heavy_patterns: z.array(z.string()).optional(),
      heavy_message_length: z.number().optional(),
    }).optional(),
  }).optional(),
  subagents: z.object({
    max_concurrent_per_user: z.number().optional(),
    max_concurrent_global: z.number().optional(),
    max_tool_calls_per_run: z.number().optional(),
    spawn_rate_limit: z.object({
      max_requests: z.number().optional(),
      window_seconds: z.number().optional(),
    }).optional(),
  }).optional(),
  scheduler: z.object({
    tasks: z.record(z.object({
      cron: z.string().optional(),
      enabled: z.boolean().optional(),
    })).optional(),
  }).optional(),
}).passthrough();

export type ConfigReloadedEvent = {
  previous: HotConfig;
  current: HotConfig;
};

export class ConfigWatcher {
  private watcher?: FSWatcher;
  private currentHotConfig: HotConfig = {};
  private debounceTimer?: ReturnType<typeof setTimeout>;
  private readonly DEBOUNCE_MS = 500;

  constructor(
    private configPath: string,
    private logger: Logger,
    private eventBus?: EventBus
  ) {
    // Load initial hot config
    this.currentHotConfig = this.parseHotConfig() ?? {};
  }

  /** Start watching the config file for changes. */
  start(): void {
    if (!existsSync(this.configPath)) {
      this.logger.warn(
        { path: this.configPath },
        "Config file not found — hot-reload disabled"
      );
      return;
    }

    this.watcher = watch(this.configPath, (_event) => {
      // Debounce rapid successive writes
      if (this.debounceTimer) clearTimeout(this.debounceTimer);
      this.debounceTimer = setTimeout(() => this.handleChange(), this.DEBOUNCE_MS);
    });

    this.logger.info({ path: this.configPath }, "Config hot-reload watcher started");
  }

  /** Stop watching. */
  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.watcher?.close();
    this.watcher = undefined;
    this.logger.debug("Config hot-reload watcher stopped");
  }

  /** Get the current hot-reloadable config snapshot. */
  getHotConfig(): HotConfig {
    return this.currentHotConfig;
  }

  private handleChange(): void {
    const previous = this.currentHotConfig;
    const next = this.parseHotConfig();

    if (next === null) {
      // Parse error — keep running config unchanged
      return;
    }

    this.currentHotConfig = next;
    this.logger.info("Config reloaded (hot sections updated)");

    // Publish event so subscribers (alert router, tier classifier, etc.) can react
    void this.eventBus?.publish({
      eventType: "config.reloaded",
      timestamp: new Date().toISOString(),
      sourceSkill: "config-watcher",
      payload: { previous, current: next } as unknown as Record<string, unknown>,
      severity: "low",
    });
  }

  private parseHotConfig(): HotConfig | null {
    try {
      if (!existsSync(this.configPath)) return null;
      const raw = readFileSync(this.configPath, "utf-8");
      const parsed = yaml.load(raw) as Record<string, unknown>;
      const result = HotConfigSchema.safeParse(parsed);
      if (!result.success) {
        this.logger.warn(
          { errors: result.error.flatten() },
          "Config reload parse error — keeping previous config"
        );
        return null;
      }
      return result.data as unknown as HotConfig;
    } catch (err) {
      this.logger.warn({ error: err }, "Config reload read error — keeping previous config");
      return null;
    }
  }
}
