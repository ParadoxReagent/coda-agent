import type { Database } from "./index.js";

let _db: Database | null = null;

/**
 * Initialize the shared database singleton.
 * Must be called once during startup before any skill accesses the DB.
 */
export function initializeDatabase(db: Database): void {
  _db = db;
}

/**
 * Get the shared database instance.
 * Throws if initializeDatabase() has not been called.
 */
export function getDatabase(): Database {
  if (!_db) {
    throw new Error(
      "Database not initialized. Call initializeDatabase() before accessing the database."
    );
  }
  return _db;
}
