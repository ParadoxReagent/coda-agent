/**
 * Tracks skill health based on success/failure patterns.
 * Skills degrade after repeated failures and auto-recover after a cooldown.
 */

export type SkillHealthStatus = "healthy" | "degraded" | "unavailable";

export interface SkillHealth {
  status: SkillHealthStatus;
  consecutiveFailures: number;
  lastFailure: Date | null;
  lastSuccess: Date | null;
  totalFailures: number;
  totalSuccesses: number;
}

interface SkillHealthConfig {
  degradedThreshold: number;
  unavailableThreshold: number;
  recoveryWindowMs: number;
}

const DEFAULT_CONFIG: SkillHealthConfig = {
  degradedThreshold: 3,
  unavailableThreshold: 10,
  recoveryWindowMs: 60_000,
};

export class SkillHealthTracker {
  private health: Map<string, SkillHealth> = new Map();
  private config: SkillHealthConfig;

  constructor(config?: Partial<SkillHealthConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  recordSuccess(skillName: string): void {
    const h = this.getOrCreate(skillName);
    h.consecutiveFailures = 0;
    h.lastSuccess = new Date();
    h.totalSuccesses++;
    h.status = "healthy";
  }

  recordFailure(skillName: string, _error: Error): void {
    const h = this.getOrCreate(skillName);
    h.consecutiveFailures++;
    h.lastFailure = new Date();
    h.totalFailures++;

    if (h.consecutiveFailures >= this.config.unavailableThreshold) {
      h.status = "unavailable";
    } else if (h.consecutiveFailures >= this.config.degradedThreshold) {
      h.status = "degraded";
    }
  }

  getHealth(skillName: string): SkillHealth {
    return this.getOrCreate(skillName);
  }

  getAllHealth(): Map<string, SkillHealth> {
    return new Map(this.health);
  }

  /** Reset a skill back to healthy (used by doctor for manual resets). */
  resetSkill(skillName: string): void {
    const h = this.getOrCreate(skillName);
    h.status = "healthy";
    h.consecutiveFailures = 0;
  }

  /** Returns false if skill is unavailable AND still within recovery window. */
  isAvailable(skillName: string): boolean {
    const h = this.health.get(skillName);
    if (!h) return true;

    if (h.status !== "unavailable") return true;

    // Check if recovery window has elapsed
    if (h.lastFailure) {
      const elapsed = Date.now() - h.lastFailure.getTime();
      if (elapsed >= this.config.recoveryWindowMs) {
        // Allow a probe attempt — reset to degraded
        h.status = "degraded";
        h.consecutiveFailures = this.config.degradedThreshold;
        return true;
      }
    }

    return false;
  }

  private getOrCreate(skillName: string): SkillHealth {
    let h = this.health.get(skillName);
    if (!h) {
      h = {
        status: "healthy",
        consecutiveFailures: 0,
        lastFailure: null,
        lastSuccess: null,
        totalFailures: 0,
        totalSuccesses: 0,
      };
      this.health.set(skillName, h);
    }
    return h;
  }
}
