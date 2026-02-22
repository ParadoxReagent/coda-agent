/**
 * PromptManager: Version-controlled prompt sections with A/B testing.
 *
 * Named prompt sections are stored in the DB. When a section has an active
 * version, buildSystemPrompt() uses it instead of the hardcoded default.
 * For light-tier requests, A/B variants may be randomly selected based on weight.
 */
import type { Database } from "../db/index.js";
import type { Logger } from "../utils/logger.js";
import { promptVersions } from "../db/schema.js";
import { eq, and, desc } from "drizzle-orm";

export interface PromptSectionResult {
  content: string;
  version: number;
  isAbVariant: boolean;
}

export class PromptManager {
  constructor(
    private db: Database,
    private logger: Logger
  ) {}

  /**
   * Get the active version of a named prompt section.
   * Returns null if no DB-backed version exists (caller uses hardcoded default).
   * For light tier: may randomly select an A/B variant based on ab_weight.
   */
  async getSection(sectionName: string, tier?: "light" | "heavy"): Promise<PromptSectionResult | null> {
    try {
      // Get all active versions for this section
      const rows = await this.db
        .select()
        .from(promptVersions)
        .where(and(
          eq(promptVersions.sectionName, sectionName),
          eq(promptVersions.isActive, true)
        ))
        .orderBy(desc(promptVersions.version))
        .limit(5);

      if (rows.length === 0) return null;

      // Check for A/B variants (only for light tier)
      if (tier === "light") {
        const variants = rows.filter(r => r.isAbVariant);
        const control = rows.find(r => !r.isAbVariant);

        if (variants.length > 0 && control) {
          const variant = variants[0]!;
          const weight = variant.abWeight ?? 0.5;
          if (Math.random() < weight) {
            return {
              content: variant.content,
              version: variant.version,
              isAbVariant: true,
            };
          }
        }
      }

      // Return primary active version (non-variant, highest version)
      const primary = rows.find(r => !r.isAbVariant) ?? rows[0]!;
      return {
        content: primary.content,
        version: primary.version,
        isAbVariant: false,
      };
    } catch (err) {
      this.logger.debug({ error: err, sectionName }, "prompt-manager.getSection failed");
      return null;
    }
  }

  /**
   * Create a new inactive prompt version. Does not activate it.
   */
  async createVersion(sectionName: string, content: string, sourceProposalId?: string): Promise<number> {
    // Get next version number
    const existing = await this.db
      .select({ version: promptVersions.version })
      .from(promptVersions)
      .where(eq(promptVersions.sectionName, sectionName))
      .orderBy(desc(promptVersions.version))
      .limit(1);

    const nextVersion = (existing[0]?.version ?? 0) + 1;

    await this.db.insert(promptVersions).values({
      sectionName,
      content,
      version: nextVersion,
      isActive: false,
      isAbVariant: false,
      sourceProposalId: sourceProposalId ?? null,
      createdBy: "system",
    });

    return nextVersion;
  }

  /**
   * Activate a specific version of a prompt section.
   * Deactivates all other versions for that section.
   */
  async activateVersion(sectionName: string, version: number): Promise<void> {
    // Deactivate all current active versions
    await this.db
      .update(promptVersions)
      .set({ isActive: false, retiredAt: new Date() })
      .where(and(
        eq(promptVersions.sectionName, sectionName),
        eq(promptVersions.isActive, true)
      ));

    // Activate the specified version
    await this.db
      .update(promptVersions)
      .set({ isActive: true, retiredAt: null })
      .where(and(
        eq(promptVersions.sectionName, sectionName),
        eq(promptVersions.version, version)
      ));

    this.logger.info({ sectionName, version }, "Activated prompt version");
  }

  /**
   * Roll back a prompt section to its previous active version.
   */
  async rollback(sectionName: string): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(promptVersions)
      .where(eq(promptVersions.sectionName, sectionName))
      .orderBy(desc(promptVersions.version))
      .limit(10);

    const current = rows.find(r => r.isActive);
    if (!current) {
      this.logger.warn({ sectionName }, "No active version to roll back from");
      return false;
    }

    // Find the previous non-active, non-retired version
    const previous = rows.find(r => r.version < current.version && !r.isActive);
    if (!previous) {
      this.logger.warn({ sectionName }, "No previous version to roll back to");
      return false;
    }

    await this.activateVersion(sectionName, previous.version);
    return true;
  }

  /**
   * Record a performance score for a section/version.
   * Updates running average.
   */
  async recordPerformance(sectionName: string, version: number, score: number): Promise<void> {
    try {
      const [existing] = await this.db
        .select({ performanceScore: promptVersions.performanceScore, sampleCount: promptVersions.sampleCount })
        .from(promptVersions)
        .where(and(
          eq(promptVersions.sectionName, sectionName),
          eq(promptVersions.version, version)
        ))
        .limit(1);

      if (!existing) return;

      const sampleCount = (existing.sampleCount ?? 0) + 1;
      const currentScore = existing.performanceScore ?? score;
      const newScore = currentScore + (score - currentScore) / sampleCount;

      await this.db
        .update(promptVersions)
        .set({ performanceScore: newScore, sampleCount })
        .where(and(
          eq(promptVersions.sectionName, sectionName),
          eq(promptVersions.version, version)
        ));
    } catch (err) {
      this.logger.debug({ error: err }, "prompt-manager.recordPerformance failed");
    }
  }
}
