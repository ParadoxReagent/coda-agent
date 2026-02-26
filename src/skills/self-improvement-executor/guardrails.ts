/**
 * Guardrails for the self-improvement executor.
 * All path checks are defense-in-depth — the code surgeon also enforces these.
 */
import { resolve as resolvePath } from "node:path";

/**
 * Check if a file path is within at least one allowed path prefix
 * AND not within any forbidden path prefix.
 *
 * Paths are matched by prefix after resolving to absolute paths relative
 * to the project root.
 */
export function isPathAllowed(
  filePath: string,
  allowedPaths: string[],
  forbiddenPaths: string[],
  projectRoot: string = process.cwd()
): boolean {
  const resolved = resolvePath(projectRoot, filePath);

  // Check forbidden paths first (higher priority)
  for (const forbidden of forbiddenPaths) {
    const forbiddenResolved = resolvePath(projectRoot, forbidden);
    if (resolved === forbiddenResolved || resolved.startsWith(forbiddenResolved + "/")) {
      return false;
    }
  }

  // Must be within at least one allowed path
  for (const allowed of allowedPaths) {
    const allowedResolved = resolvePath(projectRoot, allowed);
    if (resolved === allowedResolved || resolved.startsWith(allowedResolved + "/")) {
      return true;
    }
  }

  return false;
}

/**
 * Check if the blast radius (number of affected files) is within the limit.
 */
export function isBlastRadiusAcceptable(fileCount: number, limit: number): boolean {
  return fileCount <= limit;
}

/**
 * Check if the number of proposed changes is within the limit.
 */
export function isChangeCountAcceptable(changeCount: number, maxFiles: number): boolean {
  return changeCount <= maxFiles;
}

/**
 * Auto-merge is always false — defense in depth.
 * This function exists so callers never accidentally enable it via config.
 */
export function canAutoMerge(): false {
  return false;
}

/**
 * Validate all file changes in a surgeon output against path guardrails.
 * Returns an array of violation messages (empty = all clear).
 */
export function validateChangePaths(
  files: string[],
  allowedPaths: string[],
  forbiddenPaths: string[],
  projectRoot?: string
): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (!isPathAllowed(file, allowedPaths, forbiddenPaths, projectRoot)) {
      violations.push(
        `File "${file}" is not in allowed paths or is in a forbidden path`
      );
    }
  }
  return violations;
}
