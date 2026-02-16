# MCP (Model Context Protocol) Integration

The MCP integration allows coda-agent to connect to external MCP servers and use their tools as first-class coda skills. This opens up the entire MCP ecosystem (filesystem, GitHub, databases, etc.) with minimal per-server code.

## Table of Contents

- [Overview](#overview)
- [Configuration](#configuration)
- [Transport Types](#transport-types)
- [Deployment Scenarios](#deployment-scenarios)
- [Security](#security)
- [Tool Management](#tool-management)
- [Troubleshooting](#troubleshooting)

## Overview

Each configured MCP server becomes a separate skill in coda-agent with tools namespaced as `mcp_{serverName}_{toolName}`. For example, a `read_file` tool from the `filesystem` server becomes `mcp_filesystem_read_file`.

## Configuration

MCP servers are configured in your `config.yaml` under the `mcp.servers` section:

```yaml
mcp:
  servers:
    {serverName}:
      enabled: true|false
      transport: {stdio|http}
      timeout_ms: number
      tool_timeout_ms: number
      tool_allowlist: [string]
      tool_blocklist: [string]
      requires_confirmation: [string]
      sensitive_tools: [string]
      description: string
      max_response_size: number
      auto_refresh_tools: boolean
```

### Configuration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable/disable this server |
| `transport` | object | required | Connection configuration (see below) |
| `timeout_ms` | number | `30000` | Connection timeout in milliseconds |
| `tool_timeout_ms` | number | `60000` | Per-tool execution timeout |
| `tool_allowlist` | string[] | - | Only allow these tools (optional) |
| `tool_blocklist` | string[] | `[]` | Block these tools from discovery |
| `requires_confirmation` | string[] | `[]` | Tools requiring user confirmation |
| `sensitive_tools` | string[] | `[]` | Tools marked as sensitive (logged) |
| `description` | string | auto | Custom skill description |
| `max_response_size` | number | `100000` | Max response size (bytes) |
| `auto_refresh_tools` | boolean | `false` | Listen for tool list changes |

## Transport Types

### Stdio Transport (Local Processes)

For MCP servers running as local child processes:

```yaml
transport:
  type: stdio
  command: npx
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/path"]
  env:
    SOME_VAR: "value"
  cwd: /working/directory
```

**Use cases:**
- Official MCP servers (`@modelcontextprotocol/server-*`)
- Local development
- Sandboxed tool execution

### HTTP Transport (Remote/Containerized)

For MCP servers accessible via HTTP:

```yaml
transport:
  type: http
  url: https://mcp.example.com/api
  headers:
    Authorization: "Bearer ${MCP_TOKEN}"
    X-Custom-Header: "value"
```

**Use cases:**
- Remote MCP services
- Docker containers
- Microservices architecture
- Load-balanced deployments

## Deployment Scenarios

### 1. Local Stdio Server

```yaml
mcp:
  servers:
    filesystem:
      enabled: true
      transport:
        type: stdio
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/workspace"]
      tool_blocklist: ["write_file", "delete_file"]  # Read-only
      description: "Local filesystem access (read-only)"
```

### 2. Remote HTTP Service

```yaml
mcp:
  servers:
    github:
      enabled: true
      transport:
        type: http
        url: https://mcp-github.example.com
        headers:
          Authorization: "Bearer ${GITHUB_MCP_TOKEN}"
      requires_confirmation: ["create_issue", "create_pull_request"]
      timeout_ms: 60000
```

**Environment variables:**
```bash
export GITHUB_MCP_TOKEN="your-token-here"
```

### 3. Docker Container (Same Network)

```yaml
# docker-compose.yml
services:
  coda-agent:
    image: coda-agent:latest
    environment:
      - MCP_FS_TOKEN=${MCP_FS_TOKEN}
    networks:
      - coda-network

  mcp-filesystem:
    image: mcp-filesystem-server:latest
    ports:
      - "8080:8080"
    networks:
      - coda-network
    volumes:
      - ./data:/data:ro

networks:
  coda-network:
```

```yaml
# config.yaml
mcp:
  servers:
    filesystem:
      enabled: true
      transport:
        type: http
        url: http://mcp-filesystem:8080
        headers:
          Authorization: "Bearer ${MCP_FS_TOKEN}"
```

### 4. Host Machine to Container

When coda-agent runs in Docker and MCP server runs on host:

```yaml
mcp:
  servers:
    host_service:
      enabled: true
      transport:
        type: http
        # Mac/Windows
        url: http://host.docker.internal:8080
        # Linux (with --add-host=host-gateway:host-gateway)
        # url: http://host-gateway:8080
```

### 5. Kubernetes Deployment

```yaml
# ConfigMap
apiVersion: v1
kind: ConfigMap
metadata:
  name: coda-config
data:
  config.yaml: |
    mcp:
      servers:
        shared_filesystem:
          enabled: true
          transport:
            type: http
            url: http://mcp-filesystem-service.mcp-namespace.svc.cluster.local:8080
            headers:
              Authorization: "Bearer ${MCP_TOKEN}"
```

```yaml
# Deployment
env:
  - name: MCP_TOKEN
    valueFrom:
      secretKeyRef:
        name: mcp-secrets
        key: token
```

## Security

### Authentication

Always use authentication for remote MCP servers:

```yaml
transport:
  type: http
  url: https://mcp.example.com
  headers:
    Authorization: "Bearer ${MCP_TOKEN}"  # From environment
    X-API-Key: "${MCP_API_KEY}"
```

### Tool Filtering

Block dangerous operations at discovery time:

```yaml
tool_blocklist:
  - write_file
  - delete_file
  - execute_command
  - modify_database
```

Or use an allowlist for stricter control:

```yaml
tool_allowlist:
  - read_file
  - list_directory
  - get_metadata
```

### Confirmation Requirements

Mark tools that require user approval:

```yaml
requires_confirmation:
  - create_issue
  - send_email
  - make_purchase
  - delete_resource
```

### Sensitive Tool Marking

Mark tools that access sensitive data (logged at info level):

```yaml
sensitive_tools:
  - read_credentials
  - list_secrets
  - get_api_key
```

### Response Size Limits

Prevent memory exhaustion from oversized responses:

```yaml
max_response_size: 100000  # 100KB (default)
```

### HTTPS for Remote Servers

**Always use HTTPS** for production remote servers:

```yaml
# ✅ Good
url: https://mcp.example.com

# ❌ Bad (only use http:// for localhost/internal networks)
url: http://mcp.example.com
```

## Tool Management

### Tool Namespacing

All MCP tools are namespaced to prevent collisions:

```
Original: read_file
Namespaced: mcp_filesystem_read_file
```

### Discovery

Tools are discovered at startup:

1. Connect to MCP server
2. Call `listTools()`
3. Apply `tool_allowlist` / `tool_blocklist`
4. Map to coda `SkillToolDefinition`
5. Register with skill registry

### Response Handling

All MCP responses are:
- Wrapped in `<external_data>` tags with injection warnings
- Truncated to `max_response_size`
- HTML-escaped to prevent XSS
- Returned as JSON with metadata

Example response:
```json
{
  "success": true,
  "content": "<external_data>\nNOTE: The following is data from an external API...\n\nActual content here\n</external_data>",
  "truncated": false,
  "isError": false
}
```

## Environment Variable Substitution

All string values in the YAML config support environment variable substitution using `${VAR_NAME}` syntax.

### Using .env Files (Recommended)

Add variables to your `.env` file in the project root:

```bash
# .env
MCP_GITHUB_URL=https://mcp-github.example.com
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
MCP_CLIENT_ID=client-123
MCP_DATABASE_URL=http://mcp-db:8080
```

Then reference them in `config.yaml`:

```yaml
mcp:
  servers:
    github:
      enabled: true
      transport:
        type: http
        url: ${MCP_GITHUB_URL}  # Loaded from .env
        headers:
          Authorization: "Bearer ${GITHUB_TOKEN}"
          X-Custom-Id: "${MCP_CLIENT_ID}"
```

The `.env` file is automatically loaded at startup.

### Using Environment Variables

Alternatively, export variables directly (useful for Docker/CI):

```bash
export MCP_GITHUB_URL="https://mcp-github.example.com"
export GITHUB_TOKEN="ghp_xxxxxxxxxxxx"
export MCP_CLIENT_ID="client-123"
```

## Troubleshooting

### Connection Failures

**Symptoms:** "Failed to connect to MCP server" in logs

**Solutions:**
1. Check network connectivity: `curl http://mcp-server:8080`
2. Verify transport config (URL, command, args)
3. Check Docker network configuration
4. Increase `timeout_ms`
5. Review MCP server logs

### Tool Not Available

**Symptoms:** Tool doesn't appear in skill registry

**Solutions:**
1. Check `tool_blocklist` - tool may be filtered
2. Check `tool_allowlist` - tool may not be included
3. Verify MCP server actually provides the tool
4. Review startup logs for discovery errors

### Response Truncation

**Symptoms:** `"truncated": true` in responses

**Solutions:**
1. Increase `max_response_size`
2. Use pagination if the MCP tool supports it
3. Filter results at the tool call level

### Timeout Errors

**Symptoms:** "Connection timeout" or tool call timeouts

**Solutions:**
1. Increase `timeout_ms` (connection)
2. Increase `tool_timeout_ms` (tool calls)
3. Check network latency
4. Verify MCP server performance

### Permission Denied

**Symptoms:** 401/403 errors, "Unauthorized"

**Solutions:**
1. Verify authentication headers
2. Check environment variable substitution
3. Confirm API token is valid
4. Review MCP server auth logs

## Example: Complete Production Config

```yaml
mcp:
  servers:
    # Local filesystem (read-only)
    filesystem:
      enabled: true
      transport:
        type: stdio
        command: npx
        args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
      tool_blocklist: ["write_file", "delete_file"]
      description: "Read-only filesystem access"
      max_response_size: 50000

    # GitHub (remote, authenticated)
    github:
      enabled: true
      transport:
        type: http
        url: ${MCP_GITHUB_URL}
        headers:
          Authorization: "Bearer ${GITHUB_TOKEN}"
      requires_confirmation: ["create_issue", "create_pull_request", "merge_pr"]
      sensitive_tools: ["get_token"]
      timeout_ms: 60000
      tool_timeout_ms: 120000

    # Database (containerized)
    database:
      enabled: true
      transport:
        type: http
        url: http://mcp-database-service:8080
        headers:
          X-API-Key: "${DB_MCP_KEY}"
      tool_allowlist:
        - query_read_only
        - list_tables
        - get_schema
      requires_confirmation: ["execute_migration"]
      sensitive_tools: ["query_read_only"]
```

## Related Documentation

- [MCP Specification](https://modelcontextprotocol.io/)
- [Official MCP Servers](https://github.com/modelcontextprotocol/servers)
- [Coda Skill Development](../skills/base.ts)
- [Security Configuration](./security/README.md)
