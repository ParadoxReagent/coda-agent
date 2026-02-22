FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
# Skip Playwright browser downloads — browsers live in the browser-sandbox image, not here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

# --- Runtime ---
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Install system dependencies
RUN apk add --no-cache docker-cli su-exec python3 py3-pip

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
# Skip Playwright browser downloads — browsers live in the browser-sandbox image, not here.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY src/db/migrations ./db/migrations
COPY src/skills/agent-skills/ ./dist/skills/agent-skills/

# Copy MCP server files and install Python dependencies
COPY src/integrations/mcp/servers/ ./src/integrations/mcp/servers/
RUN pip3 install --no-cache-dir --break-system-packages \
  --timeout 120 --retries 5 \
  -r src/integrations/mcp/servers/pdf/requirements.txt

ENV NODE_ENV=production
EXPOSE 3000

# Add entrypoint script to handle Docker socket permissions
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
