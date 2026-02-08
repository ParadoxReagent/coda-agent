/**
 * Manages user preferences for DND, quiet hours, and alert suppression.
 */
import { eq } from "drizzle-orm";
import { userPreferences } from "../db/schema.js";
import type { Database } from "../db/index.js";
import type { Logger } from "../utils/logger.js";

export interface UserPrefs {
  userId: string;
  dndEnabled: boolean;
  alertsOnly: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  timezone: string;
}

const DEFAULT_PREFS: Omit<UserPrefs, "userId"> = {
  dndEnabled: false,
  alertsOnly: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  timezone: "America/New_York",
};

export class PreferencesManager {
  private cache: Map<string, UserPrefs> = new Map();

  constructor(
    private db: Database,
    private logger: Logger
  ) {}

  async getPreferences(userId: string): Promise<UserPrefs> {
    // Check cache first
    const cached = this.cache.get(userId);
    if (cached) return cached;

    try {
      const rows = await this.db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, userId))
        .limit(1);

      if (rows.length > 0) {
        const row = rows[0]!;
        const prefs: UserPrefs = {
          userId: row.userId,
          dndEnabled: row.dndEnabled,
          alertsOnly: row.alertsOnly,
          quietHoursStart: row.quietHoursStart,
          quietHoursEnd: row.quietHoursEnd,
          timezone: row.timezone,
        };
        this.cache.set(userId, prefs);
        return prefs;
      }
    } catch (err) {
      this.logger.error({ error: err, userId }, "Failed to fetch preferences");
    }

    return { userId, ...DEFAULT_PREFS };
  }

  async setDnd(userId: string, enabled: boolean): Promise<void> {
    await this.upsert(userId, { dndEnabled: enabled });
    this.invalidateCache(userId);
  }

  async setQuietHours(
    userId: string,
    start: string,
    end: string
  ): Promise<void> {
    await this.upsert(userId, {
      quietHoursStart: start,
      quietHoursEnd: end,
    });
    this.invalidateCache(userId);
  }

  async shouldSuppressAlert(
    userId: string,
    severity: string
  ): Promise<boolean> {
    const prefs = await this.getPreferences(userId);

    // DND suppresses everything except system alerts
    if (prefs.dndEnabled && severity !== "system") {
      return true;
    }

    return false;
  }

  private async upsert(
    userId: string,
    updates: Partial<{
      dndEnabled: boolean;
      alertsOnly: boolean;
      quietHoursStart: string;
      quietHoursEnd: string;
      timezone: string;
    }>
  ): Promise<void> {
    try {
      // Try update first
      const result = await this.db
        .update(userPreferences)
        .set({ ...updates, updatedAt: new Date() })
        .where(eq(userPreferences.userId, userId))
        .returning();

      if (result.length === 0) {
        // Insert new row
        await this.db.insert(userPreferences).values({
          userId,
          dndEnabled: updates.dndEnabled ?? false,
          alertsOnly: updates.alertsOnly ?? false,
          quietHoursStart: updates.quietHoursStart ?? null,
          quietHoursEnd: updates.quietHoursEnd ?? null,
          timezone: updates.timezone ?? "America/New_York",
        });
      }
    } catch (err) {
      this.logger.error(
        { error: err, userId },
        "Failed to upsert preferences"
      );
      throw err;
    }
  }

  private invalidateCache(userId: string): void {
    this.cache.delete(userId);
  }
}
