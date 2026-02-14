import { readFileSync, existsSync, readdirSync, statSync, realpathSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { createHash, createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { satisfies } from "semver";
import type { Skill } from "./base.js";
import type { Logger } from "../utils/logger.js";

const SDK_VERSION = "1.0.0";

const ManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string(),
  description: z.string(),
  entry: z.string(),
  requires: z
    .object({
      config: z.array(z.string()).default([]),
      services: z
        .array(z.enum(["redis", "postgres", "eventBus", "scheduler"]))
        .default([]),
    })
    .default({}),
  integrity: z
    .object({
      sha256: z.string(),
    })
    .optional(),
  publisher: z
    .object({
      id: z.string(),
      signingKeyId: z.string(),
      signature: z.string(),
    })
    .optional(),
  runsInWorker: z.boolean().default(false),
  coda_sdk_version: z.string().default("*"),
});

export type SkillManifest = z.infer<typeof ManifestSchema>;

interface SigningKey {
  id: string;
  publicKey: string;
}

interface ExternalPolicy {
  mode: "strict" | "dev";
  trusted_signing_keys: SigningKey[];
  allow_unsigned_local: boolean;
  allowed_local_unsigned_dirs: string[];
}

interface LoadedExternalSkill {
  manifest: SkillManifest;
  skill: Skill;
}

export class ExternalSkillLoader {
  private logger: Logger;
  private policy: ExternalPolicy;

  constructor(logger: Logger, policy: ExternalPolicy) {
    this.logger = logger;
    this.policy = policy;
  }

  /**
   * Verify Ed25519 signature on file hash.
   * Returns true if valid, false otherwise.
   */
  private verifySignature(
    manifest: SkillManifest,
    fileHash: string
  ): boolean {
    if (!manifest.publisher?.signature || !manifest.publisher?.signingKeyId) {
      return false;
    }

    // Find the trusted public key
    const trustedKey = this.policy.trusted_signing_keys.find(
      (k) => k.id === manifest.publisher!.signingKeyId
    );

    if (!trustedKey) {
      return false;
    }

    try {
      // Decode base64 signature and data
      const signature = Buffer.from(manifest.publisher.signature, "base64");
      const data = Buffer.from(fileHash, "base64");

      // Parse public key - supports both PEM format and raw base64
      let publicKeyObject;
      if (trustedKey.publicKey.includes("BEGIN PUBLIC KEY")) {
        // PEM format
        publicKeyObject = createPublicKey(trustedKey.publicKey);
      } else {
        // Raw base64 - assume Ed25519
        const keyBuffer = Buffer.from(trustedKey.publicKey, "base64");
        publicKeyObject = createPublicKey({
          key: keyBuffer,
          format: "der",
          type: "spki",
        });
      }

      // Verify signature
      return verify(null, data, publicKeyObject, signature);
    } catch (err) {
      this.logger.warn(
        { error: err, keyId: manifest.publisher.signingKeyId },
        "Signature verification failed"
      );
      return false;
    }
  }

  /** Scan configured directories and load all valid external skills. */
  async loadFromDirectories(
    dirs: string[]
  ): Promise<LoadedExternalSkill[]> {
    const loaded: LoadedExternalSkill[] = [];

    for (const dir of dirs) {
      const absDir = resolve(dir);
      if (!existsSync(absDir)) {
        this.logger.warn(
          { dir: absDir },
          "External skill directory does not exist"
        );
        continue;
      }

      const entries = readdirSync(absDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillDir = join(absDir, entry.name);
        try {
          const result = await this.loadSkill(skillDir);
          if (result) loaded.push(result);
        } catch (err) {
          this.logger.error(
            { skillDir, error: err },
            "Failed to load external skill"
          );
        }
      }
    }

    return loaded;
  }

  private async loadSkill(
    skillDir: string
  ): Promise<LoadedExternalSkill | null> {
    const manifestPath = join(skillDir, "coda-skill.json");

    // Check manifest exists
    if (!existsSync(manifestPath)) {
      this.logger.warn(
        { skillDir },
        "No coda-skill.json found, skipping"
      );
      return null;
    }

    // Check file permissions (reject world-writable)
    this.checkFilePermissions(manifestPath);

    // Parse and validate manifest
    const rawManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    const manifest = ManifestSchema.parse(rawManifest);

    // Check SDK version compatibility
    if (
      manifest.coda_sdk_version !== "*" &&
      !satisfies(SDK_VERSION, manifest.coda_sdk_version)
    ) {
      throw new Error(
        `Skill "${manifest.name}" requires coda SDK ${manifest.coda_sdk_version}, ` +
          `but current SDK is ${SDK_VERSION}`
      );
    }

    // Resolve entry path and check for traversal/symlink escape
    const entryPath = resolve(skillDir, manifest.entry);
    const realEntryPath = realpathSync(entryPath);
    const realSkillDir = realpathSync(skillDir);

    const rel = relative(realSkillDir, realEntryPath);
    if (rel.startsWith("..") || resolve(realSkillDir, rel) !== realEntryPath) {
      throw new Error(
        `Skill "${manifest.name}" entry path escapes skill directory (path traversal)`
      );
    }

    // Check entry file permissions
    this.checkFilePermissions(entryPath);

    // Verify integrity
    if (manifest.integrity?.sha256) {
      const fileContent = readFileSync(entryPath);
      const hash = createHash("sha256").update(fileContent).digest("base64");
      if (hash !== manifest.integrity.sha256) {
        throw new Error(
          `Skill "${manifest.name}" integrity check failed — ` +
            `expected SHA256 ${manifest.integrity.sha256}, got ${hash}`
        );
      }
    }

    // Enforce trust policy
    if (this.policy.mode === "strict") {
      if (!manifest.publisher?.signature) {
        throw new Error(
          `Skill "${manifest.name}" has no publisher signature (strict mode requires signing)`
        );
      }

      // Verify the signature
      const fileContent = readFileSync(entryPath);
      const fileHash = createHash("sha256").update(fileContent).digest("base64");

      if (!this.verifySignature(manifest, fileHash)) {
        throw new Error(
          `Skill "${manifest.name}" signature verification failed — ` +
            `invalid signature or untrusted signing key "${manifest.publisher.signingKeyId}"`
        );
      }

      this.logger.info(
        { skill: manifest.name, keyId: manifest.publisher.signingKeyId },
        "Skill signature verified successfully"
      );
    } else if (this.policy.mode === "dev") {
      if (!manifest.publisher?.signature) {
        // Check if the skill is in an allowed unsigned directory
        const isAllowed = this.policy.allowed_local_unsigned_dirs.some(
          (allowed) => {
            const absAllowed = resolve(allowed);
            return realSkillDir.startsWith(absAllowed);
          }
        );
        if (!isAllowed && !this.policy.allow_unsigned_local) {
          throw new Error(
            `Skill "${manifest.name}" is unsigned and not in an allowed local directory`
          );
        }
      }
    }

    // Dynamic import of the skill module
    const module = await import(entryPath);
    const SkillClass = module.default;

    if (!SkillClass || typeof SkillClass !== "function") {
      throw new Error(
        `Skill "${manifest.name}" does not default-export a class`
      );
    }

    const skill = new SkillClass() as Skill;

    // Validate that the loaded module implements the Skill interface
    if (
      typeof skill.name !== "string" ||
      typeof skill.description !== "string" ||
      typeof skill.getTools !== "function" ||
      typeof skill.execute !== "function" ||
      typeof skill.getRequiredConfig !== "function" ||
      typeof skill.startup !== "function" ||
      typeof skill.shutdown !== "function"
    ) {
      throw new Error(
        `Skill "${manifest.name}" does not implement the Skill interface`
      );
    }

    // Validate tool definitions
    const tools = skill.getTools();
    for (const tool of tools) {
      this.validateToolDefinition(manifest.name, tool);
    }

    this.logger.info(
      { skill: manifest.name, version: manifest.version },
      "External skill loaded"
    );

    return { manifest, skill };
  }

  private validateToolDefinition(
    skillName: string,
    tool: { name: string; description: string; input_schema: Record<string, unknown> }
  ): void {
    // Tool name must match pattern
    if (!/^[a-z][a-z0-9_]*$/.test(tool.name)) {
      throw new Error(
        `Skill "${skillName}" tool "${tool.name}" has an invalid name. ` +
          `Names must match /^[a-z][a-z0-9_]*$/`
      );
    }

    // Description must be non-empty and under 1000 chars
    if (!tool.description || tool.description.length === 0) {
      throw new Error(
        `Skill "${skillName}" tool "${tool.name}" has an empty description`
      );
    }
    if (tool.description.length > 1000) {
      throw new Error(
        `Skill "${skillName}" tool "${tool.name}" description exceeds 1000 characters`
      );
    }

    // input_schema must be an object with type "object"
    if (
      !tool.input_schema ||
      typeof tool.input_schema !== "object" ||
      tool.input_schema.type !== "object"
    ) {
      throw new Error(
        `Skill "${skillName}" tool "${tool.name}" input_schema must be an object with type: "object"`
      );
    }
  }

  private checkFilePermissions(filePath: string): void {
    const stat = statSync(filePath);
    const mode = stat.mode;

    // Check if world-writable (octal 002)
    if (mode & 0o002) {
      throw new Error(
        `File "${filePath}" is world-writable — refusing to load for security`
      );
    }
  }
}
