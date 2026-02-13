import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgentSkillDiscovery } from "../../../src/skills/agent-skill-discovery.js";
import { createMockLogger } from "../../helpers/mocks.js";

function createSkillDir(
  baseDir: string,
  name: string,
  frontmatter: string,
  body: string = "# Test\n\nBody content."
): string {
  const dir = join(baseDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `${frontmatter}\n${body}`);
  return dir;
}

describe("AgentSkillDiscovery", () => {
  let tempDir: string;
  let discovery: AgentSkillDiscovery;
  const logger = createMockLogger();

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "agent-skills-test-"));
    discovery = new AgentSkillDiscovery(logger);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("scanDirectories", () => {
    it("discovers valid skills with YAML frontmatter", () => {
      createSkillDir(
        tempDir,
        "hello-world",
        '---\nname: hello-world\ndescription: "Greet the user."\n---'
      );
      createSkillDir(
        tempDir,
        "pdf-tools",
        '---\nname: pdf-tools\ndescription: "Extract text from PDFs."\n---'
      );

      discovery.scanDirectories([tempDir]);

      const skills = discovery.getSkillMetadataList();
      expect(skills).toHaveLength(2);
      expect(skills.map((s) => s.name).sort()).toEqual(["hello-world", "pdf-tools"]);
    });

    it("skips directories without SKILL.md", () => {
      mkdirSync(join(tempDir, "no-skill-md"), { recursive: true });
      writeFileSync(join(tempDir, "no-skill-md", "README.md"), "# Not a skill");

      discovery.scanDirectories([tempDir]);
      expect(discovery.getSkillMetadataList()).toHaveLength(0);
    });

    it("skips SKILL.md files without frontmatter", () => {
      const dir = join(tempDir, "no-frontmatter");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "# Just a heading\n\nNo frontmatter here.");

      discovery.scanDirectories([tempDir]);
      expect(discovery.getSkillMetadataList()).toHaveLength(0);
    });

    it("rejects invalid skill names", () => {
      createSkillDir(
        tempDir,
        "Invalid-Name",
        '---\nname: Invalid-Name\ndescription: "Bad name."\n---'
      );

      discovery.scanDirectories([tempDir]);
      expect(discovery.getSkillMetadataList()).toHaveLength(0);
    });

    it("skips duplicate skill names", () => {
      const dir1 = mkdtempSync(join(tmpdir(), "agent-skills-dup1-"));
      const dir2 = mkdtempSync(join(tmpdir(), "agent-skills-dup2-"));

      try {
        createSkillDir(dir1, "same-name", '---\nname: same-name\ndescription: "First."\n---');
        createSkillDir(dir2, "same-name", '---\nname: same-name\ndescription: "Second."\n---');

        discovery.scanDirectories([dir1, dir2]);
        expect(discovery.getSkillMetadataList()).toHaveLength(1);
        expect(discovery.getSkillMetadataList()[0]!.description).toBe("First.");
      } finally {
        rmSync(dir1, { recursive: true, force: true });
        rmSync(dir2, { recursive: true, force: true });
      }
    });

    it("skips non-existent directories", () => {
      discovery.scanDirectories(["/nonexistent/path/xyz"]);
      expect(discovery.getSkillMetadataList()).toHaveLength(0);
    });
  });

  describe("activateSkill", () => {
    it("returns body without frontmatter", () => {
      createSkillDir(
        tempDir,
        "my-skill",
        '---\nname: my-skill\ndescription: "Test skill."\n---',
        "# My Skill\n\nInstructions here."
      );
      discovery.scanDirectories([tempDir]);

      const body = discovery.activateSkill("my-skill");
      expect(body).toBe("# My Skill\n\nInstructions here.");
      expect(body).not.toContain("---");
    });

    it("throws for unknown skill", () => {
      expect(() => discovery.activateSkill("nonexistent")).toThrow(
        'Unknown agent skill: "nonexistent"'
      );
    });

    it("tracks activation state", () => {
      createSkillDir(
        tempDir,
        "trackable",
        '---\nname: trackable\ndescription: "Test."\n---'
      );
      discovery.scanDirectories([tempDir]);

      expect(discovery.isActivated("trackable")).toBe(false);
      discovery.activateSkill("trackable");
      expect(discovery.isActivated("trackable")).toBe(true);
    });
  });

  describe("listResources / readResource", () => {
    it("finds files in allowed resource directories", () => {
      const skillDir = createSkillDir(
        tempDir,
        "resourceful",
        '---\nname: resourceful\ndescription: "Has resources."\n---'
      );
      mkdirSync(join(skillDir, "scripts"), { recursive: true });
      writeFileSync(join(skillDir, "scripts", "setup.sh"), "#!/bin/bash\necho hello");
      mkdirSync(join(skillDir, "references"), { recursive: true });
      writeFileSync(join(skillDir, "references", "api.md"), "# API docs");

      discovery.scanDirectories([tempDir]);

      const resources = discovery.listResources("resourceful");
      expect(resources).toContain("scripts/setup.sh");
      expect(resources).toContain("references/api.md");
    });

    it("reads resource content after activation", () => {
      const skillDir = createSkillDir(
        tempDir,
        "readable",
        '---\nname: readable\ndescription: "Readable."\n---'
      );
      mkdirSync(join(skillDir, "scripts"), { recursive: true });
      writeFileSync(join(skillDir, "scripts", "run.sh"), "#!/bin/bash\nrun");

      discovery.scanDirectories([tempDir]);
      discovery.activateSkill("readable");

      const content = discovery.readResource("readable", "scripts/run.sh");
      expect(content).toContain("#!/bin/bash");
    });

    it("rejects path traversal", () => {
      const skillDir = createSkillDir(
        tempDir,
        "secure",
        '---\nname: secure\ndescription: "Secure."\n---'
      );
      mkdirSync(join(skillDir, "scripts"), { recursive: true });
      writeFileSync(join(skillDir, "scripts", "ok.sh"), "ok");

      discovery.scanDirectories([tempDir]);
      discovery.activateSkill("secure");

      expect(() =>
        discovery.readResource("secure", "../../../etc/passwd")
      ).toThrow("Path traversal not allowed");
    });

    it("rejects disallowed file extensions", () => {
      const skillDir = createSkillDir(
        tempDir,
        "strict-ext",
        '---\nname: strict-ext\ndescription: "Strict."\n---'
      );
      mkdirSync(join(skillDir, "scripts"), { recursive: true });
      writeFileSync(join(skillDir, "scripts", "malware.exe"), "bad");

      discovery.scanDirectories([tempDir]);
      discovery.activateSkill("strict-ext");

      expect(() =>
        discovery.readResource("strict-ext", "scripts/malware.exe")
      ).toThrow('File extension ".exe" is not allowed');
    });

    it("requires activation before reading resources", () => {
      const skillDir = createSkillDir(
        tempDir,
        "guarded",
        '---\nname: guarded\ndescription: "Guarded."\n---'
      );
      mkdirSync(join(skillDir, "scripts"), { recursive: true });
      writeFileSync(join(skillDir, "scripts", "test.sh"), "test");

      discovery.scanDirectories([tempDir]);

      expect(() =>
        discovery.readResource("guarded", "scripts/test.sh")
      ).toThrow('Skill "guarded" must be activated before reading resources');
    });
  });
});
