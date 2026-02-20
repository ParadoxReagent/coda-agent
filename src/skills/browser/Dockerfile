# Browser automation sandbox image for coda-agent
# Based on the official Playwright Docker image (Chromium + all dependencies pre-installed)
#
# Build:  docker compose --profile browser-build build
# Image:  coda-browser-sandbox
#
# Security hardening is applied at runtime via docker run flags:
#   --cap-drop=ALL --security-opt=no-new-privileges --read-only --tmpfs /tmp --tmpfs /home/browser

FROM mcr.microsoft.com/playwright:v1.50.0-noble

# Install the Playwright MCP server (stdio transport)
RUN npm install -g @playwright/mcp@latest

# Create a dedicated non-root user with a home directory.
# The home dir will be overlaid by tmpfs at runtime (--tmpfs /home/browser).
RUN groupadd -r browser && useradd -r -g browser -m -d /home/browser browser

USER browser
WORKDIR /home/browser

# Playwright MCP server over stdio.
# The container receives MCP JSON-RPC messages on stdin and writes responses to stdout.
# --headless: run Chromium in headless mode (no display required)
CMD ["playwright-mcp", "--headless"]
