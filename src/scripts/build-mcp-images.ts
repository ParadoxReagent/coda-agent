#!/usr/bin/env node

/**
 * Build Docker images for MCP servers.
 *
 * Usage:
 *   npm run build:mcp-images                    # Build all MCP servers
 *   npm run build:mcp-images -- context7        # Build specific server
 *   npm run build:mcp-images -- --force         # Rebuild even if exists
 *   npm run build:mcp-images -- --dry-run       # Show what would be built
 *   npm run build:mcp-images -- --list          # List discovered servers
 *   npm run build:mcp-images -- --security-check # Check Dockerfiles for security issues
 *   npm run build:mcp-images -- context7 --force # Rebuild specific server
 */

import { execSync, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface BuildOptions {
  serverName?: string;
  force: boolean;
  dryRun: boolean;
  list: boolean;
  securityCheck: boolean;
}

function parseArgs(): BuildOptions {
  const args = process.argv.slice(2);
  const options: BuildOptions = {
    force: false,
    dryRun: false,
    list: false,
    securityCheck: false,
  };

  for (const arg of args) {
    if (arg === "--force") {
      options.force = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--list") {
      options.list = true;
    } else if (arg === "--security-check") {
      options.securityCheck = true;
    } else if (!arg.startsWith("-")) {
      options.serverName = arg;
    }
  }

  return options;
}

function imageExists(imageName: string): boolean {
  try {
    const output = execFileSync(
      "docker",
      ["images", "-q", imageName],
      {
        encoding: "utf-8",
        stdio: "pipe",
      }
    ).trim();
    return output.length > 0;
  } catch {
    return false;
  }
}

function buildImage(serverName: string, serverDir: string, logger: any): void {
  const imageName = `coda-mcp-${serverName}`;

  logger.info(
    { server: serverName, image: imageName, path: serverDir },
    "Building MCP server image"
  );

  try {
    execFileSync(
      "docker",
      ["build", "-t", imageName, serverDir],
      {
        stdio: "inherit",
      }
    );
    logger.info({ server: serverName, image: imageName }, "Successfully built image");
  } catch (error) {
    throw new Error(`Failed to build Docker image: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function discoverMcpServers(serversDir: string): string[] {
  if (!existsSync(serversDir)) {
    return [];
  }

  const entries = readdirSync(serversDir);
  const servers: string[] = [];

  for (const entry of entries) {
    const fullPath = join(serversDir, entry);
    const dockerfilePath = join(fullPath, "Dockerfile");

    if (statSync(fullPath).isDirectory() && existsSync(dockerfilePath)) {
      servers.push(entry);
    }
  }

  return servers;
}

interface SecurityCheckResult {
  serverName: string;
  hasUser: boolean;
  hasAddUser: boolean;
  warnings: string[];
}

function checkDockerfileSecurity(serverName: string, serverDir: string): SecurityCheckResult {
  const dockerfilePath = join(serverDir, "Dockerfile");
  const content = readFileSync(dockerfilePath, "utf-8");

  const result: SecurityCheckResult = {
    serverName,
    hasUser: false,
    hasAddUser: false,
    warnings: [],
  };

  // Check for USER directive
  if (/^USER\s+(?!root\b)/m.test(content)) {
    result.hasUser = true;
  }

  // Check for adduser/useradd/addgroup patterns
  if (/(adduser|useradd|addgroup)/.test(content)) {
    result.hasAddUser = true;
  }

  // Generate warnings
  if (!result.hasUser) {
    result.warnings.push("Missing USER directive (container may run as root)");
  }

  if (!result.hasAddUser && !result.hasUser) {
    result.warnings.push("No user creation found (adduser/useradd/addgroup)");
  }

  return result;
}

/**
 * Extra Docker images that are built alongside MCP server images.
 * Each entry maps a human-readable name to its build context dir and target image name.
 */
const EXTRA_IMAGES: Array<{ name: string; dir: string; image: string }> = [
  {
    name: "browser-sandbox",
    dir: join(__dirname, "..", "skills", "browser"),
    image: "coda-browser-sandbox",
  },
];

async function main() {
  const options = parseArgs();

  // Create logger
  const logger = createLogger("build-mcp-images");

  logger.info("Building MCP server Docker images");

  // Discover MCP servers
  const serversDir = join(__dirname, "..", "integrations", "mcp", "servers");
  const allServers = discoverMcpServers(serversDir);

  if (allServers.length === 0) {
    logger.warn("No MCP servers with Dockerfiles found");
    return;
  }

  // Handle --list flag
  if (options.list) {
    logger.info({ count: allServers.length, servers: allServers }, "Discovered MCP servers");
    for (const serverName of allServers) {
      const imageName = `coda-mcp-${serverName}`;
      const exists = imageExists(imageName);
      logger.info(
        { server: serverName, image: imageName, built: exists },
        exists ? "✓ Image exists" : "✗ Not built"
      );
    }
    return;
  }

  // Handle --security-check flag
  if (options.securityCheck) {
    logger.info({ count: allServers.length }, "Checking Dockerfiles for security issues");
    let passCount = 0;
    let warnCount = 0;

    for (const serverName of allServers) {
      const serverDir = join(serversDir, serverName);
      const result = checkDockerfileSecurity(serverName, serverDir);

      if (result.warnings.length === 0) {
        logger.info({ server: serverName }, "✓ Security check passed");
        passCount++;
      } else {
        logger.warn(
          { server: serverName, warnings: result.warnings },
          "⚠ Security issues found"
        );
        warnCount++;
      }
    }

    logger.info(
      { passed: passCount, warnings: warnCount, total: allServers.length },
      "Security check complete"
    );
    return;
  }

  // Filter servers
  const serversToBuild = options.serverName
    ? allServers.filter((s) => s === options.serverName)
    : allServers;

  if (options.serverName && serversToBuild.length === 0) {
    logger.error({ server: options.serverName }, "Server not found");
    process.exit(1);
  }

  logger.info(
    { count: serversToBuild.length, servers: serversToBuild },
    "MCP servers to build"
  );

  // Build images
  let built = 0;
  let skipped = 0;
  let failed = 0;

  for (const serverName of serversToBuild) {
    const serverDir = join(serversDir, serverName);
    const imageName = `coda-mcp-${serverName}`;

    if (options.dryRun) {
      logger.info(
        { server: serverName, image: imageName },
        "[DRY RUN] Would build image"
      );
      continue;
    }

    try {
      // Check if already exists
      if (!options.force && imageExists(imageName)) {
        logger.info(
          { server: serverName, image: imageName },
          "Image already exists, skipping (use --force to rebuild)"
        );
        skipped++;
        continue;
      }

      buildImage(serverName, serverDir, logger);
      built++;
    } catch (error) {
      logger.error(
        {
          server: serverName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to build MCP server image"
      );
      failed++;
    }
  }

  // Build extra images (browser sandbox, etc.) when not filtering by server name
  if (!options.serverName || EXTRA_IMAGES.some((e) => e.name === options.serverName)) {
    const extraToBuild = options.serverName
      ? EXTRA_IMAGES.filter((e) => e.name === options.serverName)
      : EXTRA_IMAGES;

    for (const extra of extraToBuild) {
      if (!existsSync(join(extra.dir, "Dockerfile"))) {
        logger.warn({ name: extra.name, dir: extra.dir }, "Extra image Dockerfile not found, skipping");
        continue;
      }

      if (options.list) {
        const exists = imageExists(extra.image);
        logger.info(
          { name: extra.name, image: extra.image, built: exists },
          exists ? "✓ Image exists" : "✗ Not built"
        );
        continue;
      }

      if (options.securityCheck) {
        const result = checkDockerfileSecurity(extra.name, extra.dir);
        if (result.warnings.length === 0) {
          logger.info({ name: extra.name }, "✓ Security check passed");
        } else {
          logger.warn({ name: extra.name, warnings: result.warnings }, "⚠ Security issues found");
        }
        continue;
      }

      if (options.dryRun) {
        logger.info({ name: extra.name, image: extra.image }, "[DRY RUN] Would build extra image");
        continue;
      }

      try {
        if (!options.force && imageExists(extra.image)) {
          logger.info({ name: extra.name, image: extra.image }, "Image already exists, skipping (use --force to rebuild)");
          skipped++;
          continue;
        }

        logger.info({ name: extra.name, image: extra.image, path: extra.dir }, "Building extra image");
        execFileSync("docker", ["build", "-t", extra.image, extra.dir], { stdio: "inherit" });
        logger.info({ name: extra.name, image: extra.image }, "Successfully built extra image");
        built++;
      } catch (error) {
        logger.error(
          { name: extra.name, error: error instanceof Error ? error.message : String(error) },
          "Failed to build extra image"
        );
        failed++;
      }
    }
  }

  // Summary
  logger.info(
    { built, skipped, failed, total: serversToBuild.length + EXTRA_IMAGES.length },
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
