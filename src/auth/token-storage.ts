import { eq, and } from "drizzle-orm";
import { oauthTokens } from "../db/schema.js";
import type { Database } from "../db/index.js";

export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  expiryDate: Date;
  scope: string;
}

export class TokenStorage {
  constructor(private db: Database) {}

  async getTokens(service: string, userId: string): Promise<StoredTokens | null> {
    const rows = await this.db
      .select()
      .from(oauthTokens)
      .where(and(eq(oauthTokens.service, service), eq(oauthTokens.userId, userId)))
      .limit(1);

    if (rows.length === 0) return null;

    const row = rows[0]!;
    return {
      accessToken: row.accessToken,
      refreshToken: row.refreshToken,
      tokenType: row.tokenType,
      expiryDate: row.expiryDate,
      scope: row.scope,
    };
  }

  async saveTokens(service: string, userId: string, tokens: StoredTokens): Promise<void> {
    await this.db
      .insert(oauthTokens)
      .values({
        service,
        userId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        tokenType: tokens.tokenType,
        expiryDate: tokens.expiryDate,
        scope: tokens.scope,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [oauthTokens.service, oauthTokens.userId],
        set: {
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          tokenType: tokens.tokenType,
          expiryDate: tokens.expiryDate,
          scope: tokens.scope,
          updatedAt: new Date(),
        },
      });
  }

  async deleteTokens(service: string, userId: string): Promise<void> {
    await this.db
      .delete(oauthTokens)
      .where(and(eq(oauthTokens.service, service), eq(oauthTokens.userId, userId)));
  }
}
