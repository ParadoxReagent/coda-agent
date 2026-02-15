# Pre-built Docker Images for Agent Skills

## Overview

Agent skills that require Python packages or system libraries can declare dependencies in their `SKILL.md` frontmatter. Pre-built Docker images can be created with these dependencies baked in, allowing skills to run in sandboxed containers with `network_enabled: false` (no network access) since dependencies are already installed.

**Benefits:**
- ✅ **Security**: Skills run without network access since dependencies are pre-installed
- ✅ **Performance**: No pip install overhead on each execution
- ✅ **Reliability**: Dependencies are guaranteed to be available
- ✅ **Reproducibility**: Same image used consistently across environments

## Quick Start

### 1. Declare Dependencies in SKILL.md

Add `docker_image` and `dependencies` to your skill's frontmatter:

```yaml
---
name: my-skill
description: "My awesome skill"
docker_image: python:3.12-slim
dependencies:
  pip:
    - pandas>=2.0.0
    - numpy>=1.24.0
  system:
    - poppler-utils
    - tesseract-ocr
---
```

**Dependency formats:**

**Structured format** (recommended):
```yaml
dependencies:
  pip:
    - package-name>=1.0.0
    - another-package
  system:
    - apt-package-name
    - another-apt-package
```

**Flat array format** (backward compatible, treated as pip dependencies):
```yaml
dependencies:
  - package-name>=1.0.0
  - another-package
```

### 2. Build the Image

```bash
# Build images for all skills with dependencies
npm run build:skill-images

# Build a specific skill
npm run build:skill-images -- my-skill

# Rebuild even if image exists
npm run build:skill-images -- my-skill --force

# Preview what would be built without building
npm run build:skill-images -- --dry-run
```

### 3. Use the Skill

When you activate a skill, the system automatically:
1. Checks if `coda-skill-<name>:latest` exists locally
2. If yes, uses the pre-built image
3. If no, falls back to the base `docker_image` from frontmatter

The LLM receives a note: "Dependencies are pre-installed in this image — do NOT run pip install or apt-get."

## Real-World Examples

### Example 1: PDF Processing Skill

**File**: `src/skills/agent-skills/pdf/SKILL.md`

```yaml
---
name: pdf
description: "Process PDF files"
docker_image: python:3.12-slim
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
---
```

**Build**:
```bash
npm run build:skill-images -- pdf
```

**Result**: Image `coda-skill-pdf:latest` (715 MB) with all dependencies

### Example 2: MCP Builder Skill

**File**: `src/skills/agent-skills/mcp-builder/SKILL.md`

```yaml
---
name: mcp-builder
description: "Create MCP servers"
docker_image: python:3.12-slim
dependencies:
  pip:
    - anthropic>=0.39.0
    - mcp>=1.1.0
---
```

**Build**:
```bash
npm run build:skill-images -- mcp-builder
```

**Result**: Image `coda-skill-mcp-builder:latest` (276 MB)

### Example 3: GIF Creator Skill

**File**: `src/skills/agent-skills/slack-gif-creator/SKILL.md`

```yaml
---
name: slack-gif-creator
description: "Create animated GIFs"
docker_image: python:3.12-slim
dependencies:
  pip:
    - pillow>=10.0.0
    - imageio>=2.31.0
    - imageio-ffmpeg>=0.4.9
    - numpy>=1.24.0
---
```

**Build**:
```bash
npm run build:skill-images -- slack-gif-creator
```

**Result**: Image `coda-skill-slack-gif-creator:latest` (418 MB)

## How It Works

### Build Process

When you run `npm run build:skill-images`, the system:

1. **Scans** all configured agent skill directories
2. **Filters** skills that have dependencies declared
3. **Generates** a Dockerfile for each skill:
   ```dockerfile
   FROM python:3.12-slim

   # Install system dependencies
   RUN apt-get update && \
       apt-get install -y poppler-utils tesseract-ocr && \
       rm -rf /var/lib/apt/lists/*

   # Install Python dependencies
   RUN pip install --no-cache-dir pypdf pdfplumber reportlab

   # Set working directory
   WORKDIR /workspace
   ```
4. **Builds** the image with tag `coda-skill-<name>:latest`
5. **Cleans up** temporary build files

### Runtime Behavior

When a skill is activated via `skill_activate`:

1. System checks if `coda-skill-<name>:latest` exists locally
2. If the pre-built image exists:
   - Sets `docker_image` to the pre-built image name
   - Adds execution note: "Dependencies are pre-installed — do NOT run pip install"
3. If not found:
   - Falls back to base `docker_image` from frontmatter
   - LLM may need to install dependencies at runtime (requires `network_enabled: true`)

### Image Naming Convention

All pre-built skill images follow the pattern:
```
coda-skill-<skill-name>:latest
```

Examples:
- `coda-skill-pdf:latest`
- `coda-skill-mcp-builder:latest`
- `coda-skill-slack-gif-creator:latest`

## Configuration

### Allowed Images

Pre-built skill images are automatically allowed by default. The executor configuration includes:

```yaml
execution:
  allowed_images:
    - "python:*"
    - "node:*"
    - "ubuntu:*"
    - "alpine:*"
    - "coda-skill-*"  # Pre-built skill images
```

You can customize this in `config/config.yaml` if needed.

### Base Images

Choose an appropriate base image for your skill:

| Base Image | Size | Use Case |
|------------|------|----------|
| `python:3.12-slim` | ~150 MB | Most Python skills (recommended) |
| `python:3.12-alpine` | ~50 MB | Minimal Python (some packages may fail to build) |
| `python:3.12` | ~1 GB | Full Python with build tools (rarely needed) |
| `node:22-slim` | ~200 MB | Node.js skills |
| `ubuntu:24.04` | ~77 MB | Custom multi-language skills |

**Recommendation**: Use `python:3.12-slim` for Python skills unless you have specific requirements.

## Best Practices

### 1. Pin Version Constraints

Use version constraints for reproducibility:

```yaml
# Good - predictable versions
dependencies:
  pip:
    - pandas>=2.0.0,<3.0.0
    - numpy>=1.24.0,<2.0.0

# Avoid - unpinned versions may break
dependencies:
  pip:
    - pandas
    - numpy
```

### 2. Minimize Dependencies

Only include packages your skill actually uses:

```yaml
# Good - only what's needed
dependencies:
  pip:
    - pypdf

# Avoid - unnecessary bloat
dependencies:
  pip:
    - pypdf
    - pandas
    - numpy
    - scikit-learn  # Not used
```

### 3. System Packages

Only add system packages if pip packages require them:

```yaml
# pdf2image needs poppler-utils
# pytesseract needs tesseract-ocr
dependencies:
  pip:
    - pdf2image
    - pytesseract
  system:
    - poppler-utils
    - tesseract-ocr
```

### 4. Rebuild After Changes

When you update dependencies in SKILL.md, rebuild the image:

```bash
npm run build:skill-images -- my-skill --force
```

### 5. Test Before Deployment

Test your skill with the pre-built image:

```bash
# Build the image
npm run build:skill-images -- my-skill

# Verify dependencies are installed
docker run --rm coda-skill-my-skill:latest pip list

# Test skill activation in coda
# (start coda and activate the skill to see it use the pre-built image)
```

## Troubleshooting

### Image Not Being Used

**Symptom**: Skill doesn't use pre-built image after building

**Checks**:
1. Verify image exists: `docker images | grep coda-skill-my-skill`
2. Check image name matches: `coda-skill-<exact-skill-name>:latest`
3. Restart coda if running

### Build Failures

**Symptom**: `npm run build:skill-images` fails

**Common causes**:

1. **Invalid package name**:
   ```
   ERROR: Could not find a version that satisfies the requirement invalid-pkg
   ```
   Fix: Check package name on PyPI

2. **System package not found**:
   ```
   E: Unable to locate package invalid-apt-pkg
   ```
   Fix: Check package name with `apt-cache search <name>`

3. **Conflicting dependencies**:
   ```
   ERROR: pip's dependency resolver does not currently take into account...
   ```
   Fix: Pin compatible versions or use fewer dependencies

### Large Image Sizes

**Symptom**: Image is unexpectedly large

**Solutions**:

1. **Use slim base image**: `python:3.12-slim` instead of `python:3.12`
2. **Remove build dependencies**: Don't include gcc, make, etc. unless needed
3. **Clean up apt cache**: Already done automatically in generated Dockerfiles
4. **Use `--no-cache-dir`**: Already done for pip installs

**Check image sizes**:
```bash
docker images | grep coda-skill
```

## Advanced Usage

### Custom Dockerfile

If you need more control, you can create a custom Dockerfile in your skill directory:

**File**: `src/skills/agent-skills/my-skill/Dockerfile`

```dockerfile
FROM python:3.12-slim

# Custom system setup
RUN apt-get update && \
    apt-get install -y git curl && \
    rm -rf /var/lib/apt/lists/*

# Custom Python setup
RUN pip install --no-cache-dir \
    pandas>=2.0.0 \
    numpy>=1.24.0

# Custom scripts
COPY scripts/ /opt/scripts/
ENV PATH="/opt/scripts:$PATH"

WORKDIR /workspace
```

Build manually:
```bash
docker build -t coda-skill-my-skill:latest src/skills/agent-skills/my-skill/
```

### Multi-stage Builds

For complex builds, use multi-stage Dockerfiles:

```dockerfile
# Builder stage
FROM python:3.12 AS builder
RUN pip install --no-cache-dir --user pandas numpy

# Runtime stage
FROM python:3.12-slim
COPY --from=builder /root/.local /root/.local
ENV PATH=/root/.local/bin:$PATH
WORKDIR /workspace
```

### Sharing Images

Push images to a registry to share across environments:

```bash
# Tag for registry
docker tag coda-skill-pdf:latest myregistry.io/coda-skill-pdf:latest

# Push
docker push myregistry.io/coda-skill-pdf:latest

# Pull on another machine
docker pull myregistry.io/coda-skill-pdf:latest
docker tag myregistry.io/coda-skill-pdf:latest coda-skill-pdf:latest
```

## Reference

### Build Script Options

```bash
npm run build:skill-images [options] [skill-name]

Options:
  --force      Rebuild even if image exists
  --dry-run    Show what would be built without building

Examples:
  npm run build:skill-images
  npm run build:skill-images -- pdf
  npm run build:skill-images -- pdf --force
  npm run build:skill-images -- --dry-run
```

### Frontmatter Schema

```yaml
name: string              # Required: skill name (lowercase, alphanumeric + hyphens)
description: string       # Required: skill description
docker_image?: string     # Optional: base Docker image (default: none)
dependencies?: Deps       # Optional: dependencies to install

# Deps can be:
# - string[] (flat array, treated as pip)
# - { pip?: string[], system?: string[] } (structured)
```

### Generated Dockerfile Template

```dockerfile
FROM {baseImage}

# Install system dependencies
{#if systemDeps}
RUN apt-get update && \
    apt-get install -y {systemDeps.join(' ')} && \
    rm -rf /var/lib/apt/lists/*
{/if}

# Install Python dependencies
{#if pipDeps}
RUN pip install --no-cache-dir {pipDeps.join(' ')}
{/if}

# Set working directory
WORKDIR /workspace
```

## Migration Guide

### Migrating Existing Skills

If you have existing skills with `requirements.txt` or `scripts/requirements.txt`:

1. **Read the requirements file**:
   ```bash
   cat src/skills/agent-skills/my-skill/requirements.txt
   ```

2. **Add to SKILL.md frontmatter**:
   ```yaml
   dependencies:
     pip:
       - package1>=1.0.0
       - package2>=2.0.0
   ```

3. **Build the image**:
   ```bash
   npm run build:skill-images -- my-skill
   ```

4. **Optional**: Remove old requirements.txt (keep for reference if desired)

### Example Migration

**Before** (`requirements.txt`):
```
anthropic>=0.39.0
mcp>=1.1.0
```

**After** (`SKILL.md`):
```yaml
---
name: mcp-builder
description: "Create MCP servers"
docker_image: python:3.12-slim
dependencies:
  pip:
    - anthropic>=0.39.0
    - mcp>=1.1.0
---
```

**Build**:
```bash
npm run build:skill-images -- mcp-builder
```

## See Also

- [skills_readme.md](../skills_readme.md) - Agent skills overview
- [integrations_readme.md](../integrations_readme.md) - Integration features
- [Docker Executor Skill](../skills_readme.md#docker-executor) - Code execution documentation
