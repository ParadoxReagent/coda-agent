# Pre-built Docker Images for Agent Skills

## Context
Agent skills like PDF need Python/system packages (pypdf, poppler-utils, etc.) but the Docker executor runs ephemeral, read-only, network-disabled containers. Currently, the `dependencies` field in SKILL.md frontmatter is informational only — nothing installs them. This makes skills that need libraries broken by default. We'll add a build pipeline that creates per-skill Docker images with deps baked in.

## Changes

### 1. Structured dependency schema in frontmatter
**File: `src/skills/agent-skill-discovery.ts`**
- Replace `dependencies?: string[]` in `AgentSkillMetadata` with structured type:
  ```ts
  interface SkillDependencies { pip?: string[]; system?: string[] }
  ```
- Update frontmatter parsing (~line 316) to handle object form `{ pip: [...], system: [...] }`
- Keep backward compat: flat `string[]` treated as pip deps

### 2. Dockerfile template & build module (NEW)
**New file: `src/skills/docker-executor/skill-image-builder.ts`**
- `generateDockerfile(baseImage, deps)` — creates Dockerfile string with `apt-get install` + `pip install`
- `buildSkillImage(meta, logger)` — writes temp Dockerfile, runs `docker build -t coda-skill-<name>:latest`
- `getSkillImageName(name)` — returns `coda-skill-<name>:latest`
- `imageExists(name)` — checks if image exists locally via `docker image inspect`
- `skillNeedsBuild(meta)` — true if skill has pip or system deps

### 3. Build script (NEW)
**New file: `src/scripts/build-skill-images.ts`**
- CLI: `npm run build:skill-images [skill-name] [--force] [--dry-run]`
- Scans SKILL.md files, finds skills with dependencies, builds images
- Add npm script to `package.json`

### 4. Executor: allow skill images
**File: `src/skills/docker-executor/skill.ts`**
- Add `"coda-skill-*"` to default `allowed_images` array

**File: `src/utils/config.ts`**
- Add `"coda-skill-*"` to `allowed_images` default in `ExecutionConfigSchema`

### 5. Skill activation: resolve pre-built image
**File: `src/skills/agent-skills/skill.ts`**
- In `activateSkill()` (line 104): check if `coda-skill-<name>:latest` exists locally
- If yes: use it as `docker_image` and add "Dependencies are pre-installed — do NOT run pip install" to execution note
- If no: fall back to raw `docker_image` from frontmatter (current behavior)
- Make `activateSkill()` async (already returns via `execute()` which is `Promise<string>`)

### 6. Update PDF skill frontmatter
**File: `src/skills/agent-skills/pdf/SKILL.md`**
```yaml
dependencies:
  pip:
    - pypdf
    - pdfplumber
    - reportlab
    - pdf2image
    - pandas
    - openpyxl
    - pytesseract
  system:
    - poppler-utils
    - tesseract-ocr
```

### 7. Config & docs
- `config/config.example.yaml` — document `coda-skill-*` in allowed_images
- `skills_readme.md` — document dependency declaration and build process
- `roadmap.md` — mark feature as done

## File Summary
| File | Action |
|------|--------|
| `src/skills/agent-skill-discovery.ts` | Modify — structured deps type + parsing |
| `src/skills/docker-executor/skill-image-builder.ts` | **Create** — build logic |
| `src/scripts/build-skill-images.ts` | **Create** — CLI build script |
| `src/skills/agent-skills/skill.ts` | Modify — resolve pre-built image on activation |
| `src/skills/docker-executor/skill.ts` | Modify — add `coda-skill-*` to allowed images |
| `src/utils/config.ts` | Modify — add `coda-skill-*` to defaults |
| `src/skills/agent-skills/pdf/SKILL.md` | Modify — add structured dependencies |
| `package.json` | Modify — add build script |
| `config/config.example.yaml` | Modify — document new options |
| `skills_readme.md` | Modify — document dependency system |
| `roadmap.md` | Modify — mark done |

## Verification
1. `npm run build:skill-images -- --dry-run` — confirm it discovers PDF skill and shows deps
2. `npm run build:skill-images -- pdf` — builds `coda-skill-pdf:latest`
3. `docker image inspect coda-skill-pdf:latest` — confirm image exists with deps
4. Start the agent, activate PDF skill, verify execution note says "Dependencies are pre-installed"
5. Run a PDF operation (e.g., extract text) — should work without pip install, even with `network_enabled: false`
