import { readFileSync, readdirSync, statSync, existsSync, type Stats } from "node:fs";
import { resolve, join, normalize, relative, extname } from "node:path";
import { homedir } from "node:os";
import yaml from "js-yaml";
import type { Logger } from "../utils/logger.js";

const NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

/** Directories within an agent skill that may contain supplementary resources. */
const RESOURCE_DIRS = ["scripts", "references", "assets"] as const;

/** File extensions allowed for resource reads. */
const ALLOWED_RESOURCE_EXTENSIONS = new Set([
  ".md", ".txt", ".json", ".yaml", ".yml",
  ".sh", ".py", ".js", ".ts",
  ".csv", ".toml", ".xml",
]);

export interface AgentSkillMetadata {
  name: string;
  description: string;
  /** Absolute path to the skill directory. */
  dirPath: string;
}

interface ParsedFrontmatter {
  name?: unknown;
  description?: unknown;
}

export class AgentSkillDiscovery {
  private skills = new Map<string, AgentSkillMetadata>();
  private activated = new Set<string>();
  private logger: Logger;
  private scannedDirs: string[] = [];

  constructor(logger: Logger) {
    this.logger = logger;
  }

  /**
   * Scan one or more directories for subdirectories containing SKILL.md files.
   * Each valid subdirectory is registered as an agent skill.
   */
  scanDirectories(dirs: string[]): void {
    this.scannedDirs = dirs;
    for (const raw of dirs) {
      const dir = resolve(raw.replace(/^~/, homedir()));

      if (!existsSync(dir)) {
        this.logger.warn({ dir }, "Agent skill directory does not exist, skipping");
        continue;
      }

      const stat = statSync(dir);
      if (!stat.isDirectory()) {
        this.logger.warn({ dir }, "Agent skill path is not a directory, skipping");
        continue;
      }

      // Reject world-writable directories
      if (this.isWorldWritable(stat)) {
        this.logger.warn({ dir }, "Agent skill directory is world-writable, skipping for security");
        continue;
      }

      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        this.logger.warn({ dir }, "Cannot read agent skill directory, skipping");
        continue;
      }

      for (const entry of entries) {
        const subDir = join(dir, entry);
        const skillMdPath = join(subDir, "SKILL.md");

        try {
          const subStat = statSync(subDir);
          if (!subStat.isDirectory()) continue;
        } catch {
          continue;
        }

        if (!existsSync(skillMdPath)) continue;

        try {
          this.registerSkill(skillMdPath, subDir);
        } catch (err) {
          this.logger.warn(
            { dir: subDir, error: err instanceof Error ? err.message : String(err) },
            "Skipping invalid agent skill"
          );
        }
      }
    }

    this.logger.info(
      { count: this.skills.size },
      "Agent skill discovery complete"
    );
  }

  /**
   * Clear discovered skills and re-scan the same directories.
   * Preserves the activated set so already-activated skills remain usable
   * if they still exist on disk.
   */
  rescan(): { added: string[]; removed: string[] } {
    const previousNames = new Set(this.skills.keys());
    this.skills.clear();
    this.scanDirectories(this.scannedDirs);

    const currentNames = new Set(this.skills.keys());
    const added = [...currentNames].filter(n => !previousNames.has(n));
    const removed = [...previousNames].filter(n => !currentNames.has(n));

    // Clean up activated set for skills that no longer exist
    for (const name of this.activated) {
      if (!currentNames.has(name)) {
        this.activated.delete(name);
      }
    }

    this.logger.info({ added, removed }, "Agent skill rescan complete");
    return { added, removed };
  }

  /** Return metadata for all discovered skills (for system prompt injection). */
  getSkillMetadataList(): AgentSkillMetadata[] {
    return Array.from(this.skills.values());
  }

  /**
   * Activate a skill: returns the full SKILL.md body (without frontmatter)
   * and marks it as activated for resource access.
   */
  activateSkill(name: string): string {
    const meta = this.skills.get(name);
    if (!meta) {
      throw new Error(`Unknown agent skill: "${name}"`);
    }

    this.activated.add(name);

    const raw = readFileSync(join(meta.dirPath, "SKILL.md"), "utf-8");
    return this.stripFrontmatter(raw);
  }

  /** Check if a skill has been activated in this session. */
  isActivated(name: string): boolean {
    return this.activated.has(name);
  }

  /** List supplementary resource files available within an activated skill. */
  listResources(name: string): string[] {
    const meta = this.skills.get(name);
    if (!meta) {
      throw new Error(`Unknown agent skill: "${name}"`);
    }

    const resources: string[] = [];
    for (const resourceDir of RESOURCE_DIRS) {
      const dirPath = join(meta.dirPath, resourceDir);
      if (!existsSync(dirPath)) continue;

      try {
        const entries = readdirSync(dirPath);
        for (const entry of entries) {
          const fullPath = join(dirPath, entry);
          try {
            const stat = statSync(fullPath);
            if (stat.isFile() && ALLOWED_RESOURCE_EXTENSIONS.has(extname(entry).toLowerCase())) {
              resources.push(`${resourceDir}/${entry}`);
            }
          } catch {
            // skip unreadable files
          }
        }
      } catch {
        // skip unreadable dirs
      }
    }

    return resources;
  }

  /** Read a supplementary resource file from an activated skill. */
  readResource(name: string, resourcePath: string): string {
    const meta = this.skills.get(name);
    if (!meta) {
      throw new Error(`Unknown agent skill: "${name}"`);
    }

    if (!this.activated.has(name)) {
      throw new Error(`Skill "${name}" must be activated before reading resources`);
    }

    // Validate resource path: prevent traversal
    const normalized = normalize(resourcePath);
    if (normalized.startsWith("..") || normalized.includes("..")) {
      throw new Error("Path traversal not allowed");
    }

    // Must be in an allowed resource directory
    const parts = normalized.split("/");
    if (parts.length < 2 || !RESOURCE_DIRS.includes(parts[0] as typeof RESOURCE_DIRS[number])) {
      throw new Error(`Resource must be in one of: ${RESOURCE_DIRS.join(", ")}`);
    }

    // Validate extension
    const ext = extname(normalized).toLowerCase();
    if (!ALLOWED_RESOURCE_EXTENSIONS.has(ext)) {
      throw new Error(`File extension "${ext}" is not allowed`);
    }

    const fullPath = resolve(meta.dirPath, normalized);

    // Double-check it's still within the skill directory
    const relativeFromSkill = relative(meta.dirPath, fullPath);
    if (relativeFromSkill.startsWith("..")) {
      throw new Error("Path traversal not allowed");
    }

    if (!existsSync(fullPath)) {
      throw new Error(`Resource not found: ${resourcePath}`);
    }

    return readFileSync(fullPath, "utf-8");
  }

  // ---- Private ----

  private registerSkill(skillMdPath: string, dirPath: string): void {
    const raw = readFileSync(skillMdPath, "utf-8");
    const frontmatter = this.parseFrontmatter(raw);

    if (!frontmatter) {
      throw new Error("SKILL.md missing YAML frontmatter");
    }

    const name = frontmatter.name;
    const description = frontmatter.description;

    if (typeof name !== "string") {
      throw new Error("Frontmatter 'name' must be a string");
    }
    if (typeof description !== "string") {
      throw new Error("Frontmatter 'description' must be a string");
    }

    // Validate name format
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`Skill name "${name}" must match ${NAME_PATTERN}`);
    }
    if (name.length > MAX_NAME_LENGTH) {
      throw new Error(`Skill name exceeds ${MAX_NAME_LENGTH} characters`);
    }

    // Validate description length
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`Skill description exceeds ${MAX_DESCRIPTION_LENGTH} characters`);
    }

    // Check for duplicates
    if (this.skills.has(name)) {
      this.logger.warn(
        { name, dir: dirPath, existingDir: this.skills.get(name)!.dirPath },
        "Duplicate agent skill name, skipping later occurrence"
      );
      return;
    }

    this.skills.set(name, { name, description, dirPath });
    this.logger.info({ name, dir: dirPath }, "Discovered agent skill");
  }

  private parseFrontmatter(raw: string): ParsedFrontmatter | null {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;

    try {
      return yaml.load(match[1]!) as ParsedFrontmatter;
    } catch {
      return null;
    }
  }

  private stripFrontmatter(raw: string): string {
    return raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n*/, "").trim();
  }

  private isWorldWritable(stat: Stats): boolean {
    // Check if "others" have write permission (mode & 0o002)
    return (stat.mode & 0o002) !== 0;
  }
}
