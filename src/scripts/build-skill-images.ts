#!/usr/bin/env node

/**
 * Build pre-built Docker images for agent skills with dependencies.
 *
 * Usage:
 *   npm run build:skill-images                    # Build all skills with dependencies
 *   npm run build:skill-images -- pdf             # Build specific skill
 *   npm run build:skill-images -- --force         # Rebuild even if exists
 *   npm run build:skill-images -- --dry-run       # Show what would be built
 *   npm run build:skill-images -- pdf --force     # Rebuild specific skill
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentSkillDiscovery } from "../skills/agent-skill-discovery.js";
import {
  buildSkillImage,
  extractDependencies,
  getSkillImageName,
  imageExists,
  skillNeedsBuild,
} from "../skills/docker-executor/skill-image-builder.js";
import { loadConfig } from "../utils/config.js";
import { createLogger } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface BuildOptions {
  skillName?: string;
  force: boolean;
  dryRun: boolean;
}

function parseArgs(): BuildOptions {
  const args = process.argv.slice(2);
  const options: BuildOptions = {
    force: false,
    dryRun: false,
  };

  for (const arg of args) {
    if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (!arg.startsWith("-")) {
      options.skillName = arg;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();

  // Create logger
  const logger = createLogger("build-skill-images");

  logger.info("Building skill Docker images");

  // Load config
  const config = await loadConfig();

  // Set up skill discovery
  const builtinAgentSkillsDir = join(__dirname, "..", "skills", "agent-skills");
  const agentSkillDirs = [builtinAgentSkillsDir, ...config.skills.agent_skill_dirs];

  const discovery = new AgentSkillDiscovery(logger, config.skills.allow_executable_resources);
  discovery.scanDirectories(agentSkillDirs);

  const allSkills = discovery.getSkillMetadataList();

  if (allSkills.length === 0) {
    logger.warn("No agent skills found");
    return;
  }

  // Filter skills
  const skillsToBuild = allSkills.filter((skill) => {
    // If specific skill requested, only build that one
    if (options.skillName && skill.name !== options.skillName) {
      return false;
    }

    // Only build skills with dependencies
    return skillNeedsBuild(skill);
  });

  if (options.skillName && skillsToBuild.length === 0) {
    logger.error(
      { skill: options.skillName },
      "Skill not found or has no dependencies"
    );
    process.exit(1);
  }

  if (skillsToBuild.length === 0) {
    logger.info("No skills with dependencies found");
    return;
  }

  logger.info(
    { count: skillsToBuild.length, skills: skillsToBuild.map((s) => s.name) },
    "Skills to build"
  );

  // Build images
  let built = 0;
  let skipped = 0;
  let failed = 0;

  for (const skill of skillsToBuild) {
    const imageName = getSkillImageName(skill.name);
    const deps = extractDependencies(skill);

    if (!deps) {
      logger.warn({ skill: skill.name }, "Skill has no dependencies, skipping");
      skipped++;
      continue;
    }

    logger.info(
      { skill: skill.name, image: imageName, deps },
      "Processing skill"
    );

    if (options.dryRun) {
      logger.info(
        { skill: skill.name, image: imageName },
        "[DRY RUN] Would build image"
      );
      continue;
    }

    try {
      // Check if already exists
      if (!options.force && imageExists(imageName)) {
        logger.info({ skill: skill.name, image: imageName }, "Image already exists, skipping (use --force to rebuild)");
        skipped++;
        continue;
      }

      buildSkillImage(skill, logger, options.force);
      built++;
    } catch (error) {
      logger.error(
        {
          skill: skill.name,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to build skill image"
      );
      failed++;
    }
  }

  // Summary
  logger.info(
    { built, skipped, failed, total: skillsToBuild.length },
    options.dryRun ? "Dry run complete" : "Build complete"
  );

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
