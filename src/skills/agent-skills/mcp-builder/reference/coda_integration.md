# Coda-Agent Integration Guide

## Quick Reference

### Output Location
**Convention**: All MCP servers go in `src/integrations/mcp/servers/{name}/`

Example structure:
```
src/integrations/mcp/servers/
├── pdf/
│   ├── server.py
│   └── requirements.txt
└── context7/
    └── Dockerfile
```

### Deployment Mode Selection

| Mode | When to Use | Files Needed |
|------|-------------|--------------|
| **Script-only** | Pure Python/Node server, no system dependencies | `server.py` + `requirements.txt` OR `server.js` + `package.json` |
| **Docker** | System dependencies, version isolation, wrapping npm packages | `Dockerfile` (+ optional source files) |

**Decision Tree:**
- Does the server need system libraries (ImageMagick, ffmpeg, etc.)? → Docker
- Is it wrapping an existing npm package? → Docker
- Is it a pure Python/Node server with only language dependencies? → Script-only
- When in doubt → Docker (better isolation and reproducibility)

---

## Integration Artifacts

### 1. Hardened Dockerfile Templates

#### Python Multi-Stage (Non-Root)

For servers with Python code and dependencies:

```dockerfile
FROM python:3.12-slim AS builder
WORKDIR /build
COPY requirements.txt .
RUN pip install --no-cache-dir --user -r requirements.txt

FROM python:3.12-slim
RUN addgroup --system mcp && adduser --system --ingroup mcp mcp
WORKDIR /app
COPY --from=builder --chown=root:root /root/.local /usr/local
COPY --chown=root:root server.py .
USER mcp
CMD ["python", "server.py"]
```

**Security features:**
- Multi-stage build (smaller final image)
- Non-root user (`mcp`)
- Files owned by root (prevents tampering)
- `--no-cache-dir` (smaller image)

#### Node Multi-Stage (Non-Root)

For servers with TypeScript/JavaScript source code:

```dockerfile
FROM node:22-alpine AS builder
WORKDIR /build
COPY package*.json ./
RUN npm ci --production

FROM node:22-alpine
RUN addgroup -S mcp && adduser -S mcp -G mcp
WORKDIR /app
COPY --from=builder --chown=root:root /build/node_modules ./node_modules
COPY --chown=root:root . .
USER mcp
CMD ["node", "server.js"]
```

**Security features:**
- Alpine base (smaller image)
- `npm ci --production` (deterministic, no dev deps)
- Non-root user
- Files owned by root

#### Node Global Package Wrapper (Non-Root)

For wrapping existing npm packages (like `@upstash/context7-mcp`):

```dockerfile
FROM node:22-alpine
RUN addgroup -S mcp && adduser -S mcp -G mcp
RUN npm install -g @upstash/context7-mcp@latest
USER mcp
CMD ["context7-mcp"]
```

**Security features:**
- Non-root user
- Minimal layers
- Global install before USER directive (requires root)

**Key principle:** Always add the non-root user and switch with `USER` directive before `CMD`.

---

### 2. Config.yaml Snippets

#### Docker Mode

```yaml
mcp:
  servers:
    your-server-name:
      enabled: true
      transport:
        type: stdio
        command: docker
        args: ["run", "-i", "--rm", "coda-mcp-your-server-name"]
      description: "Brief description of what this server does"
      tool_timeout_ms: 60000  # Adjust based on expected operation time
```

**With environment variables:**

```yaml
mcp:
  servers:
    your-server-name:
      enabled: true
      transport:
        type: stdio
        command: docker
        args:
          - "run"
          - "-i"
          - "--rm"
          - "-e"
          - "API_KEY"
          - "coda-mcp-your-server-name"
        env:
          API_KEY: "${YOUR_API_KEY}"
      description: "Brief description"
      tool_timeout_ms: 60000
```

**Note:** Docker `-e` flag passes environment variables into the container. The `env` section defines the values to pass.

#### Script Mode (Python)

```yaml
mcp:
  servers:
    your-server-name:
      enabled: true
      transport:
        type: stdio
        command: python3
        args: ["src/integrations/mcp/servers/your-server-name/server.py"]
      description: "Brief description of what this server does"
      tool_timeout_ms: 60000
```

**With environment variables:**

```yaml
mcp:
  servers:
    your-server-name:
      enabled: true
      transport:
        type: stdio
        command: python3
        args: ["src/integrations/mcp/servers/your-server-name/server.py"]
        env:
          API_KEY: "${YOUR_API_KEY}"
      description: "Brief description"
      tool_timeout_ms: 60000
```

#### Script Mode (Node)

```yaml
mcp:
  servers:
    your-server-name:
      enabled: true
      transport:
        type: stdio
        command: node
        args: ["src/integrations/mcp/servers/your-server-name/server.js"]
      description: "Brief description of what this server does"
      tool_timeout_ms: 60000
```

**Environment variable passthrough:** For script mode, env vars are passed directly to the process (no `-e` flag needed).

---

### 3. Docker-Compose Entry (Docker Mode Only)

Add to `docker-compose.yml` under the `services` section:

```yaml
services:
  # ... existing services ...

  # MCP Server Images (build-only, never started)
  your-server-name-mcp:
    build:
      context: ./src/integrations/mcp/servers/your-server-name
    image: coda-mcp-your-server-name
    profiles:
      - mcp-build
```

**Important:**
- Image name must match the one used in `config.yaml` args
- Profile `mcp-build` ensures it's only built, never started
- Context path points to the server directory containing the Dockerfile

**To build all MCP images:**
```bash
docker-compose --profile mcp-build build
```

Or use the build script:
```bash
npm run build:mcp-images
```

---

## Build & Verify Steps

### For Docker Mode

**1. Create directory structure:**
```bash
mkdir -p src/integrations/mcp/servers/your-server-name
cd src/integrations/mcp/servers/your-server-name
```

**2. Create files:**
- `Dockerfile` (using hardened template above)
- Any source files needed (e.g., `server.py`, `package.json`)

**3. Build the image:**
```bash
# Option 1: Direct build
docker build -t coda-mcp-your-server-name .

# Option 2: Using build script
npm run build:mcp-images -- your-server-name

# Option 3: Using docker-compose
docker-compose --profile mcp-build build your-server-name-mcp
```

**4. Verify the image:**
```bash
# Check it was created
docker images | grep coda-mcp-your-server-name

# Verify it runs as non-root
docker run --rm coda-mcp-your-server-name whoami
# Should output: mcp (not root)

# Test the server manually
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | \
  docker run -i --rm coda-mcp-your-server-name
```

**5. Add config snippet to `config/config.yaml`**

**6. Start coda-agent and verify:**
```bash
npm run dev

# Check logs for:
# - "Registered MCP tool: your_server_tool_name"
# - No initialization errors
```

**7. Test a tool:**
Use the agent CLI to invoke one of your server's tools and verify it works.

---

### For Script Mode

**1. Create directory structure:**
```bash
mkdir -p src/integrations/mcp/servers/your-server-name
cd src/integrations/mcp/servers/your-server-name
```

**2. Create files:**
- **Python**: `server.py` + `requirements.txt`
- **Node**: `server.js` + `package.json`

**3. Verify the script:**
```bash
# Python
python3 server.py  # Should start and wait for JSON-RPC input
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | python3 server.py

# Node
node server.js  # Should start and wait for JSON-RPC input
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}' | node server.js
```

**4. Add config snippet to `config/config.yaml`**

**5. Start coda-agent and verify:**
```bash
npm run dev

# Check logs for:
# - "Registered MCP tool: your_server_tool_name"
# - No initialization errors
```

**6. Test a tool:**
Use the agent CLI to invoke one of your server's tools and verify it works.

---

## Environment Variables

### Docker Mode: Two-Stage Passthrough

Environment variables in Docker mode require two steps:

**Step 1:** Define the variable in the `env` section of `config.yaml`:
```yaml
transport:
  env:
    API_KEY: "${YOUR_API_KEY}"
```

**Step 2:** Pass it to Docker with `-e` flag in `args`:
```yaml
transport:
  args:
    - "run"
    - "-i"
    - "--rm"
    - "-e"
    - "API_KEY"
    - "coda-mcp-your-server-name"
```

**How it works:**
1. Coda-agent reads `env.API_KEY` and resolves `${YOUR_API_KEY}` from system environment
2. Passes resolved value to Docker process
3. Docker's `-e API_KEY` forwards it into the container
4. Server inside container reads from `process.env.API_KEY` or `os.environ["API_KEY"]`

### Script Mode: Direct Passthrough

Script mode is simpler - just define in `env`:
```yaml
transport:
  env:
    API_KEY: "${YOUR_API_KEY}"
```

The environment variables are passed directly to the script process.

---

## Troubleshooting

### "Server failed to initialize"

**Cause:** Server not responding to JSON-RPC initialize request

**Fix:**
- Test the server manually with the initialize payload
- Check that the server is reading from stdin
- Verify all dependencies are installed
- For Docker: ensure the image was built and exists

### "Permission denied" errors in Docker

**Cause:** Files or operations requiring root access

**Fix:**
- Ensure files are owned by root: `COPY --chown=root:root`
- Global npm installs must happen before `USER mcp`
- Write operations should target `/tmp` or user-writable directories

### Tools not appearing

**Cause:** Server initialized but tools not registered

**Fix:**
- Check server logs for tool registration
- Verify tool names follow naming conventions (snake_case with prefix)
- Ensure tools are properly exported in the server code

### "Image not found" when using Docker mode

**Cause:** Docker image not built

**Fix:**
```bash
# Build the specific image
npm run build:mcp-images -- your-server-name

# Or build all MCP images
npm run build:mcp-images
```

---

## Examples

### Example 1: PDF Server (Script-Only, Python)

**Directory:** `src/integrations/mcp/servers/pdf/`

**Files:**
- `server.py` - FastMCP server with PDF tools
- `requirements.txt` - Python dependencies

**Config snippet:**
```yaml
mcp:
  servers:
    pdf:
      enabled: true
      transport:
        type: stdio
        command: python3
        args: ["src/integrations/mcp/servers/pdf/server.py"]
      description: "PDF processing tools (merge, split, extract text/tables, rotate)"
      tool_timeout_ms: 120000
      max_response_size: 500000
```

**No Docker needed** - pure Python with no system dependencies.

---

### Example 2: Context7 Server (Docker, npm Package)

**Directory:** `src/integrations/mcp/servers/context7/`

**Files:**
- `Dockerfile` - Wraps `@upstash/context7-mcp` npm package

**Dockerfile:**
```dockerfile
FROM node:22-alpine
RUN addgroup -S mcp && adduser -S mcp -G mcp
RUN npm install -g @upstash/context7-mcp@latest
USER mcp
CMD ["context7-mcp"]
```

**docker-compose.yml entry:**
```yaml
services:
  context7-mcp:
    build:
      context: ./src/integrations/mcp/servers/context7
    image: coda-mcp-context7
    profiles:
      - mcp-build
```

**Config snippet:**
```yaml
mcp:
  servers:
    context7:
      enabled: true
      transport:
        type: stdio
        command: docker
        args: ["run", "-i", "--rm", "coda-mcp-context7"]
      description: "Context7 - Up-to-date documentation and code examples for libraries"
      tool_timeout_ms: 60000
```

**Why Docker?** Wrapping an external npm package that users shouldn't modify.

---

## Summary Checklist

Before considering integration complete:

- [ ] Server files placed in `src/integrations/mcp/servers/{name}/`
- [ ] Dockerfile created (if Docker mode) with non-root user
- [ ] docker-compose.yml entry added (if Docker mode)
- [ ] Docker image builds successfully
- [ ] Docker container runs as non-root user (verified with `whoami`)
- [ ] config.yaml snippet added with correct paths/image names
- [ ] Server initializes without errors
- [ ] All tools appear in agent logs
- [ ] At least one tool tested successfully via agent CLI
- [ ] Environment variables (if needed) properly passed through
- [ ] README or documentation updated (if adding to a shared repository)

---

## Additional Resources

- **Build Script**: `src/scripts/build-mcp-images.ts` - Discovers and builds all MCP server Docker images
- **Config Schema**: `src/utils/config.ts` (McpServerConfigSchema) - Defines all valid config fields
- **MCP Factory**: `src/integrations/mcp/factory.ts` - Creates MCP client instances from config
- **MCP Manager**: `src/integrations/mcp/manager.ts` - Handles lazy/eager server lifecycle
