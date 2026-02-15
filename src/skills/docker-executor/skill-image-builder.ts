import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AgentSkillMetadata, SkillDependencies } from "../agent-skill-discovery.js";
import type { Logger } from "../../utils/logger.js";

const DEFAULT_BASE_IMAGE = "python:3.12-slim";

/**
 * Generate a Dockerfile string with system and pip dependencies baked in.
 */
export function generateDockerfile(
  baseImage: string,
  deps: SkillDependencies
): string {
  const lines: string[] = [
    `FROM ${baseImage}`,
    "",
    "# Install system dependencies",
  ];

  if (deps.system && deps.system.length > 0) {
    lines.push(
      "RUN apt-get update && \\",
      `    apt-get install -y ${deps.system.join(" ")} && \\`,
      "    rm -rf /var/lib/apt/lists/*",
      ""
    );
  } else {
    lines.push("# No system dependencies", "");
  }

  lines.push("# Install Python dependencies");
  if (deps.pip && deps.pip.length > 0) {
    lines.push(
      `RUN pip install --no-cache-dir ${deps.pip.join(" ")}`,
      ""
    );
  } else {
    lines.push("# No pip dependencies", "");
  }

  lines.push("# Set working directory", "WORKDIR /workspace");

  return lines.join("\n");
}

/**
 * Get the standardized image name for a skill.
 */
export function getSkillImageName(skillName: string): string {
  return `coda-skill-${skillName}:latest`;
}

/**
 * Check if a Docker image exists locally.
 */
export function imageExists(imageName: string): boolean {
  try {
    execSync(`docker image inspect ${imageName}`, {
      stdio: "ignore",
      encoding: "utf-8",
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Determine if a skill needs a pre-built image (has dependencies).
 */
export function skillNeedsBuild(meta: AgentSkillMetadata): boolean {
  if (!meta.dependencies) return false;

  // Flat array form
  if (Array.isArray(meta.dependencies)) {
    return meta.dependencies.length > 0;
  }

  // Structured form
  const deps = meta.dependencies as SkillDependencies;
  return (deps.pip?.length ?? 0) > 0 || (deps.system?.length ?? 0) > 0;
}

/**
 * Extract SkillDependencies from metadata, normalizing flat arrays to structured form.
 */
export function extractDependencies(meta: AgentSkillMetadata): SkillDependencies | null {
  if (!meta.dependencies) return null;

  // Flat array - treat as pip dependencies
  if (Array.isArray(meta.dependencies)) {
    if (meta.dependencies.length === 0) return null;
    return { pip: meta.dependencies };
  }

  // Structured form
  const deps = meta.dependencies as SkillDependencies;
  if (!deps.pip && !deps.system) return null;
  if ((deps.pip?.length ?? 0) === 0 && (deps.system?.length ?? 0) === 0) {
    return null;
  }

  return deps;
}

/**
 * Build a Docker image for a skill with its dependencies baked in.
 * Returns the image name on success.
 */
export function buildSkillImage(
  meta: AgentSkillMetadata,
  logger: Logger,
  force = false
): string {
  const imageName = getSkillImageName(meta.name);

  // Check if image already exists
  if (!force && imageExists(imageName)) {
    logger.info({ skill: meta.name, image: imageName }, "Skill image already exists");
    return imageName;
  }

  const deps = extractDependencies(meta);
  if (!deps) {
    throw new Error(`Skill "${meta.name}" has no dependencies to build`);
  }

  // Determine base image
  const baseImage = meta.docker_image || DEFAULT_BASE_IMAGE;

  logger.info(
    { skill: meta.name, image: imageName, base: baseImage, deps },
    "Building skill Docker image"
  );

  // Create temporary directory for build context
  const buildDir = mkdtempSync(join(tmpdir(), `coda-skill-build-${meta.name}-`));

  try {
    // Generate and write Dockerfile
    const dockerfile = generateDockerfile(baseImage, deps);
    const dockerfilePath = join(buildDir, "Dockerfile");
    writeFileSync(dockerfilePath, dockerfile, "utf-8");

    logger.debug({ dockerfile }, "Generated Dockerfile");

    // Build the image
    execSync(`docker build -t ${imageName} ${buildDir}`, {
      stdio: "inherit",
      encoding: "utf-8",
    });

    logger.info({ skill: meta.name, image: imageName }, "Successfully built skill image");
    return imageName;
  } catch (error) {
    logger.error(
      { skill: meta.name, error: error instanceof Error ? error.message : String(error) },
      "Failed to build skill image"
    );
    throw error;
  } finally {
    // Clean up build directory
    try {
      rmSync(buildDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}
