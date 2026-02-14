/**
 * Proactive self-healing service.
 * Detects error patterns, runs periodic recovery checks, and provides diagnostics.
 */
import type { Logger } from "../../utils/logger.js";
import type { EventBus } from "../events.js";
import type { SkillHealthTracker } from "../skill-health.js";
import type { ProviderManager } from "../llm/manager.js";
import { ErrorClassifier, type ClassifiedError } from "./error-classifier.js";
import { ErrorStore } from "./error-store.js";

export interface DoctorConfig {
  enabled: boolean;
  patternWindowMs: number;
  patternThreshold: number;
  skillRecoveryIntervalMs: number;
  maxErrorHistory: number;
}

export interface DetectedPattern {
  signature: string;
  category: string;
  source: string;
  count: number;
  recommendation: string;
}

export interface DiagnosticReport {
  timestamp: string;
  skills: Array<{
    name: string;
    status: string;
    consecutiveFailures: number;
    totalSuccesses: number;
    totalFailures: number;
    successRate: string;
  }>;
  providers: Array<{
    name: string;
    circuitBreakerState: string;
  }>;
  recentErrors: Array<{
    timestamp: string;
    category: string;
    source: string;
    message: string;
  }>;
  patterns: DetectedPattern[];
  recommendations: string[];
}

const DEFAULT_CONFIG: DoctorConfig = {
  enabled: true,
  patternWindowMs: 300_000,
  patternThreshold: 10,
  skillRecoveryIntervalMs: 60_000,
  maxErrorHistory: 500,
};

const EVENT_COOLDOWN_MS = 600_000; // 10 minutes

export class DoctorService {
  private config: DoctorConfig;
  private errorStore: ErrorStore;
  private errorClassifier: ErrorClassifier;
  private recoveryTimer?: ReturnType<typeof setInterval>;
  private logger: Logger;
  private eventBus?: EventBus;
  private skillHealthTracker?: SkillHealthTracker;
  private providerManager?: ProviderManager;
  private lastEventPublished: Map<string, number> = new Map();

  constructor(
    logger: Logger,
    config?: Partial<DoctorConfig>,
    deps?: {
      eventBus?: EventBus;
      skillHealthTracker?: SkillHealthTracker;
      providerManager?: ProviderManager;
      errorClassifier?: ErrorClassifier;
    }
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.errorStore = new ErrorStore(this.config.maxErrorHistory);
    this.errorClassifier = deps?.errorClassifier ?? new ErrorClassifier();
    this.logger = logger;
    this.eventBus = deps?.eventBus;
    this.skillHealthTracker = deps?.skillHealthTracker;
    this.providerManager = deps?.providerManager;
  }

  get classifier(): ErrorClassifier {
    return this.errorClassifier;
  }

  get store(): ErrorStore {
    return this.errorStore;
  }

  start(): void {
    if (!this.config.enabled) return;

    this.recoveryTimer = setInterval(
      () => this.runRecoveryCheck(),
      this.config.skillRecoveryIntervalMs
    );

    this.logger.info("DoctorService started");
  }

  stop(): void {
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = undefined;
    }
  }

  /** Classify and record an error. Returns the classification. */
  recordError(error: unknown, source: string): ClassifiedError {
    const classified = this.errorClassifier.classify(error, { source });

    const signature = ErrorStore.buildSignature(
      classified.category,
      source,
      classified.original.message
    );

    this.errorStore.push({
      category: classified.category,
      strategy: classified.strategy,
      source,
      signature,
      message: classified.original.message,
    });

    // Check for patterns after recording
    this.checkPatterns(signature, classified, source);

    return classified;
  }

  /** Get a full diagnostic report. */
  getDiagnostics(focus?: "all" | "skills" | "providers" | "errors" | "patterns"): DiagnosticReport {
    const showAll = !focus || focus === "all";

    const report: DiagnosticReport = {
      timestamp: new Date().toISOString(),
      skills: [],
      providers: [],
      recentErrors: [],
      patterns: [],
      recommendations: [],
    };

    // Skills health
    if (showAll || focus === "skills") {
      if (this.skillHealthTracker) {
        const allHealth = this.skillHealthTracker.getAllHealth();
        for (const [name, health] of allHealth) {
          const total = health.totalSuccesses + health.totalFailures;
          const rate = total > 0 ? ((health.totalSuccesses / total) * 100).toFixed(1) : "N/A";
          report.skills.push({
            name,
            status: health.status,
            consecutiveFailures: health.consecutiveFailures,
            totalSuccesses: health.totalSuccesses,
            totalFailures: health.totalFailures,
            successRate: `${rate}%`,
          });

          // Generate recommendations for unhealthy skills
          if (health.status === "unavailable") {
            report.recommendations.push(
              `Skill "${name}" is unavailable (${health.consecutiveFailures} consecutive failures). Consider using doctor_reset_skill to reset it.`
            );
          } else if (health.status === "degraded") {
            report.recommendations.push(
              `Skill "${name}" is degraded (${health.consecutiveFailures} consecutive failures). Monitor closely.`
            );
          }

          if (total > 10 && health.totalSuccesses / total < 0.5) {
            report.recommendations.push(
              `Skill "${name}" has a ${rate}% success rate — investigate root cause.`
            );
          }
        }
      }
    }

    // Provider health
    if (showAll || focus === "providers") {
      if (this.providerManager) {
        for (const provider of this.providerManager.listProviders()) {
          report.providers.push({
            name: provider.name,
            circuitBreakerState: this.providerManager.getProviderHealth(provider.name),
          });
        }
      }
    }

    // Recent errors
    if (showAll || focus === "errors") {
      const recent = this.errorStore.getRecent(this.config.patternWindowMs);
      report.recentErrors = recent.slice(-10).reverse().map((r) => ({
        timestamp: new Date(r.timestamp).toISOString(),
        category: r.category,
        source: r.source,
        message: r.message.substring(0, 200),
      }));
    }

    // Detected patterns
    if (showAll || focus === "patterns") {
      report.patterns = this.detectPatterns();
    }

    return report;
  }

  private checkPatterns(signature: string, classified: ClassifiedError, source: string): void {
    const matches = this.errorStore.getBySignature(signature, this.config.patternWindowMs);

    if (matches.length >= this.config.patternThreshold) {
      this.logger.warn(
        { signature, count: matches.length, category: classified.category, source },
        "Error pattern detected"
      );

      if (classified.category === "auth_expired" && this.eventBus) {
        // Throttle event publication to prevent spam
        const eventKey = `${classified.category}:${source}`;
        const lastPublished = this.lastEventPublished.get(eventKey) ?? 0;
        const now = Date.now();

        if (now - lastPublished < EVENT_COOLDOWN_MS) {
          this.logger.debug({ eventKey, cooldownRemaining: EVENT_COOLDOWN_MS - (now - lastPublished) }, "Event publication throttled");
          return;
        }

        this.lastEventPublished.set(eventKey, now);

        this.eventBus.publish({
          eventType: "doctor.auth_refresh_needed",
          timestamp: new Date().toISOString(),
          sourceSkill: source,
          payload: { signature, count: matches.length },
          severity: "high",
        }).catch(() => {});
      }
    }
  }

  private detectPatterns(): DetectedPattern[] {
    const recent = this.errorStore.getRecent(this.config.patternWindowMs);
    const signatureGroups = new Map<string, typeof recent>();

    for (const record of recent) {
      const group = signatureGroups.get(record.signature) ?? [];
      group.push(record);
      signatureGroups.set(record.signature, group);
    }

    const patterns: DetectedPattern[] = [];
    for (const [signature, records] of signatureGroups) {
      if (records.length >= this.config.patternThreshold) {
        const first = records[0]!;
        let recommendation = `${first.category} errors from "${first.source}" occurring ${records.length} times in the last ${Math.round(this.config.patternWindowMs / 60_000)} minutes.`;

        switch (first.category) {
          case "auth_expired":
            recommendation += " Check credentials or token refresh.";
            break;
          case "transient":
            recommendation += " The service may be experiencing instability.";
            break;
          case "malformed_output":
            recommendation += " The LLM may need prompt adjustments for this tool.";
            break;
          case "rate_limited":
            recommendation += " Consider reducing request frequency.";
            break;
        }

        patterns.push({
          signature,
          category: first.category,
          source: first.source,
          count: records.length,
          recommendation,
        });
      }
    }

    return patterns;
  }

  private runRecoveryCheck(): void {
    if (!this.skillHealthTracker) return;

    const allHealth = this.skillHealthTracker.getAllHealth();
    for (const [name, health] of allHealth) {
      if (health.status !== "degraded" && health.status !== "unavailable") continue;

      // Check if enough time has passed since last failure
      if (!health.lastFailure) continue;
      const elapsed = Date.now() - health.lastFailure.getTime();
      if (elapsed < this.config.skillRecoveryIntervalMs) continue;

      this.logger.info(
        { skill: name, status: health.status, elapsedMs: elapsed },
        "DoctorService: skill eligible for recovery probe"
      );
    }
  }
}
