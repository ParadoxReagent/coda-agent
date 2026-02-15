import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';

/**
 * Manages temporary directories for file processing
 */
export class TempDirManager {
  /**
   * Create a temporary directory with given prefix
   * @param prefix Prefix for the temp directory name (e.g., 'coda-discord-')
   * @returns Absolute path to the created directory
   */
  static async create(prefix: string): Promise<string> {
    const tempPath = await mkdtemp(join(tmpdir(), prefix));
    logger.debug(`Created temp directory: ${tempPath}`);
    return tempPath;
  }

  /**
   * Cleanup (recursively remove) a temporary directory
   * @param path Absolute path to the directory to remove
   */
  static async cleanup(path: string): Promise<void> {
    try {
      await rm(path, { recursive: true, force: true });
      logger.debug(`Cleaned up temp directory: ${path}`);
    } catch (error) {
      logger.error(`Failed to cleanup temp directory ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
