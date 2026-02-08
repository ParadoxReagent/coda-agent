import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLogger } from "../utils/logger.js";
import type { Database } from "./index.js";

const logger = createLogger();

export async function runMigrations(db: Database): Promise<void> {
  logger.info("Running database migrations...");
  await migrate(db, { migrationsFolder: "./db/migrations" });
  logger.info("Database migrations complete");
}
