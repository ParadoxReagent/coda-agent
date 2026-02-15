FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src/ ./src/
RUN pnpm run build

# --- Runtime ---
FROM node:22-alpine

RUN corepack enable && corepack prepare pnpm@9.15.0 --activate

# Install Docker CLI and su-exec for socket permission handling
RUN apk add --no-cache docker-cli su-exec

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist
COPY src/db/migrations ./db/migrations
COPY src/skills/agent-skills/ ./dist/skills/agent-skills/

ENV NODE_ENV=production
EXPOSE 3000

# Add entrypoint script to handle Docker socket permissions
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

ENTRYPOINT ["/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
