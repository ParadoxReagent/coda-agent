#!/usr/bin/env node

/**
 * Build Docker images for MCP servers.
 *
 * Usage:
 *   npm run build:mcp-images                    # Build all MCP servers
 *   npm run build:mcp-images -- context7        # Build specific server
 *   npm run build:mcp-images -- --force         # Rebuild even if exists
 *   npm run build:mcp-images -- --dry-run       # Show what would be built
 *   npm run build:mcp-images -- context7 --force # Rebuild specific server
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "../utils/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface BuildOptions {
  serverName?: string;
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
      options.serverName = arg;
    }
  }

  return options;
}

function imageExists(imageName: string): boolean {
  try {
    execSync(`docker images -q ${imageName}`, { stdio: "pipe" });
    const output = execSync(`docker images -q ${imageName}`, {
      encoding: "utf-8",
      stdio: "pipe"
    }).trim();
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
    execSync(`docker build -t ${imageName} ${serverDir}`, {
      stdio: "inherit",
    });
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

  // Summary
  logger.info(
    { built, skipped, failed, total: serversToBuild.length },
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
