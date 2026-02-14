#!/bin/bash

# Coda Agent - One-Liner Docker Deployment Script
# Usage: DISCORD_BOT_TOKEN=xxx DISCORD_CHANNEL_ID=123 OPENROUTER_API_KEY=xxx ./scripts/deploy.sh

set -e  # Exit on any error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}🤖 Coda Agent Docker Deployment${NC}"
echo ""

# 1. Check prerequisites
echo -e "${YELLOW}Checking prerequisites...${NC}"

if ! command -v docker &> /dev/null; then
    echo -e "${RED}❌ Docker is not installed. Please install Docker Desktop first.${NC}"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo -e "${RED}❌ Docker daemon is not running. Please start Docker Desktop.${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Docker is running${NC}"

# 2. Load existing .env file if it exists
if [ -f .env ]; then
    echo -e "${YELLOW}Loading existing .env file...${NC}"

    # Save shell environment variables (these take priority)
    SHELL_DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"
    SHELL_DISCORD_CHANNEL_ID="${DISCORD_CHANNEL_ID:-}"
    SHELL_DISCORD_ALLOWED_USER_IDS="${DISCORD_ALLOWED_USER_IDS:-}"
    SHELL_OPENROUTER_API_KEY="${OPENROUTER_API_KEY:-}"
    SHELL_ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
    SHELL_OPENAI_API_KEY="${OPENAI_API_KEY:-}"
    SHELL_GOOGLE_API_KEY="${GOOGLE_API_KEY:-}"
    SHELL_MEMORY_API_KEY="${MEMORY_API_KEY:-}"
    SHELL_GMAIL_OAUTH_CLIENT_ID="${GMAIL_OAUTH_CLIENT_ID:-}"
    SHELL_GMAIL_OAUTH_CLIENT_SECRET="${GMAIL_OAUTH_CLIENT_SECRET:-}"
    SHELL_GMAIL_OAUTH_REDIRECT_PORT="${GMAIL_OAUTH_REDIRECT_PORT:-}"
    SHELL_GMAIL_USER="${GMAIL_USER:-}"

    # Source .env file safely (don't crash if malformed)
    set +e
    source .env 2>/dev/null
    SOURCE_RESULT=$?
    set -e

    if [ $SOURCE_RESULT -eq 0 ]; then
        echo -e "${GREEN}✓ Loaded existing .env file${NC}"
    else
        echo -e "${YELLOW}⚠️  Warning: .env exists but could not be sourced${NC}"
    fi

    # Restore shell environment variables (they override .env)
    [ -n "$SHELL_DISCORD_BOT_TOKEN" ] && DISCORD_BOT_TOKEN="$SHELL_DISCORD_BOT_TOKEN"
    [ -n "$SHELL_DISCORD_CHANNEL_ID" ] && DISCORD_CHANNEL_ID="$SHELL_DISCORD_CHANNEL_ID"
    [ -n "$SHELL_DISCORD_ALLOWED_USER_IDS" ] && DISCORD_ALLOWED_USER_IDS="$SHELL_DISCORD_ALLOWED_USER_IDS"
    [ -n "$SHELL_OPENROUTER_API_KEY" ] && OPENROUTER_API_KEY="$SHELL_OPENROUTER_API_KEY"
    [ -n "$SHELL_ANTHROPIC_API_KEY" ] && ANTHROPIC_API_KEY="$SHELL_ANTHROPIC_API_KEY"
    [ -n "$SHELL_OPENAI_API_KEY" ] && OPENAI_API_KEY="$SHELL_OPENAI_API_KEY"
    [ -n "$SHELL_GOOGLE_API_KEY" ] && GOOGLE_API_KEY="$SHELL_GOOGLE_API_KEY"
    [ -n "$SHELL_MEMORY_API_KEY" ] && MEMORY_API_KEY="$SHELL_MEMORY_API_KEY"
    [ -n "$SHELL_GMAIL_OAUTH_CLIENT_ID" ] && GMAIL_OAUTH_CLIENT_ID="$SHELL_GMAIL_OAUTH_CLIENT_ID"
    [ -n "$SHELL_GMAIL_OAUTH_CLIENT_SECRET" ] && GMAIL_OAUTH_CLIENT_SECRET="$SHELL_GMAIL_OAUTH_CLIENT_SECRET"
    [ -n "$SHELL_GMAIL_OAUTH_REDIRECT_PORT" ] && GMAIL_OAUTH_REDIRECT_PORT="$SHELL_GMAIL_OAUTH_REDIRECT_PORT"
    [ -n "$SHELL_GMAIL_USER" ] && GMAIL_USER="$SHELL_GMAIL_USER"

    echo -e "${GREEN}✓ Variables merged (shell overrides .env)${NC}"
else
    echo -e "${YELLOW}No existing .env found - will create new one${NC}"
fi

# 3. Check for required environment variables
MISSING_VARS=()

if [ -z "$DISCORD_BOT_TOKEN" ]; then
    MISSING_VARS+=("DISCORD_BOT_TOKEN")
fi

if [ -z "$DISCORD_CHANNEL_ID" ]; then
    MISSING_VARS+=("DISCORD_CHANNEL_ID")
fi

if [ -z "$OPENROUTER_API_KEY" ] && [ -z "$ANTHROPIC_API_KEY" ] && [ -z "$OPENAI_API_KEY" ] && [ -z "$GOOGLE_API_KEY" ]; then
    MISSING_VARS+=("OPENROUTER_API_KEY (or another LLM provider key)")
fi

if [ ${#MISSING_VARS[@]} -ne 0 ]; then
    echo -e "${RED}❌ Missing required environment variables:${NC}"
    for var in "${MISSING_VARS[@]}"; do
        echo -e "   - $var"
    done
    echo ""
    echo -e "${YELLOW}Usage:${NC}"
    echo "  First run (provide all required variables):"
    echo "    DISCORD_BOT_TOKEN=xxx DISCORD_CHANNEL_ID=123 OPENROUTER_API_KEY=xxx ./scripts/deploy.sh"
    echo ""
    echo "  Subsequent runs (reads from existing .env):"
    echo "    ./scripts/deploy.sh"
    echo ""
    echo "  Override specific variables:"
    echo "    DISCORD_CHANNEL_ID=456 ./scripts/deploy.sh"
    echo ""
    echo -e "${YELLOW}Or for interactive setup, use:${NC}"
    echo "  ./scripts/quickstart.sh"
    exit 1
fi

echo -e "${GREEN}✓ Required environment variables present${NC}"

# 3. Setup secrets directory
echo -e "${YELLOW}Setting up secrets directory...${NC}"
mkdir -p secrets

# 4. Generate/reuse PostgreSQL password
if [ ! -f secrets/pg_password.txt ]; then
    echo -e "${YELLOW}Generating PostgreSQL password...${NC}"
    openssl rand -base64 32 > secrets/pg_password.txt
    echo -e "${GREEN}✓ PostgreSQL password generated${NC}"
else
    echo -e "${GREEN}✓ Using existing PostgreSQL password${NC}"
fi

PG_PASSWORD=$(cat secrets/pg_password.txt)

# 5. Update .env file
echo -e "${YELLOW}Updating .env file...${NC}"

# Function to update or append a variable
update_env_var() {
    local key="$1"
    local value="$2"
    local file=".env"

    if [ -z "$value" ]; then
        return  # Skip empty values
    fi

    if grep -q "^${key}=" "$file" 2>/dev/null; then
        # Update existing line
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' "s|^${key}=.*|${key}=${value}|" "$file"
        else
            sed -i "s|^${key}=.*|${key}=${value}|" "$file"
        fi
    else
        # Append new variable
        echo "${key}=${value}" >> "$file"
    fi
}

# Create .env from example if it doesn't exist
if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo -e "${GREEN}✓ Created .env from .env.example${NC}"
    else
        touch .env
        echo -e "${GREEN}✓ Created blank .env${NC}"
    fi
fi

# Update required values
update_env_var "DISCORD_BOT_TOKEN" "${DISCORD_BOT_TOKEN}"
update_env_var "DISCORD_CHANNEL_ID" "${DISCORD_CHANNEL_ID}"
update_env_var "DATABASE_URL" "postgresql://coda:${PG_PASSWORD}@postgres:5432/coda"
update_env_var "POSTGRES_PASSWORD" "${PG_PASSWORD}"
update_env_var "REDIS_URL" "redis://redis:6379"

# Update optional values only if set
[ -n "${DISCORD_ALLOWED_USER_IDS:-}" ] && update_env_var "DISCORD_ALLOWED_USER_IDS" "${DISCORD_ALLOWED_USER_IDS}"
[ -n "${OPENROUTER_API_KEY:-}" ] && update_env_var "OPENROUTER_API_KEY" "${OPENROUTER_API_KEY}"
[ -n "${ANTHROPIC_API_KEY:-}" ] && update_env_var "ANTHROPIC_API_KEY" "${ANTHROPIC_API_KEY}"
[ -n "${OPENAI_API_KEY:-}" ] && update_env_var "OPENAI_API_KEY" "${OPENAI_API_KEY}"
[ -n "${GOOGLE_API_KEY:-}" ] && update_env_var "GOOGLE_API_KEY" "${GOOGLE_API_KEY}"
[ -n "${MEMORY_API_KEY:-}" ] && update_env_var "MEMORY_API_KEY" "${MEMORY_API_KEY}"
[ -n "${GMAIL_OAUTH_CLIENT_ID:-}" ] && update_env_var "GMAIL_OAUTH_CLIENT_ID" "${GMAIL_OAUTH_CLIENT_ID}"
[ -n "${GMAIL_OAUTH_CLIENT_SECRET:-}" ] && update_env_var "GMAIL_OAUTH_CLIENT_SECRET" "${GMAIL_OAUTH_CLIENT_SECRET}"
[ -n "${GMAIL_OAUTH_REDIRECT_PORT:-}" ] && update_env_var "GMAIL_OAUTH_REDIRECT_PORT" "${GMAIL_OAUTH_REDIRECT_PORT}"
[ -n "${GMAIL_USER:-}" ] && update_env_var "GMAIL_USER" "${GMAIL_USER}"

# Ensure application config is set
update_env_var "NODE_ENV" "production"
update_env_var "LOG_LEVEL" "info"
update_env_var "CONFIG_PATH" "./config/config.yaml"

echo -e "${GREEN}✓ .env file updated${NC}"

# 6. Create config.yaml with appropriate LLM provider
echo -e "${YELLOW}Creating config.yaml...${NC}"

if [ ! -f config/config.example.yaml ]; then
    echo -e "${RED}❌ config/config.example.yaml not found${NC}"
    exit 1
fi

# Only copy example config if config.yaml doesn't exist yet
if [ -f config/config.yaml ]; then
    echo -e "${GREEN}✓ Using existing config.yaml (not overwriting)${NC}"
else
    cp config/config.example.yaml config/config.yaml
fi

# Update default provider based on what API key is provided
if [ -n "$OPENROUTER_API_KEY" ]; then
    # Set OpenRouter as default
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' 's/default_provider: "anthropic"/default_provider: "openrouter"/' config/config.yaml
        sed -i '' 's/default_model: "claude-sonnet-4-5-20250514"/default_model: "anthropic\/claude-sonnet-4.5"/' config/config.yaml
    else
        # Linux
        sed -i 's/default_provider: "anthropic"/default_provider: "openrouter"/' config/config.yaml
        sed -i 's/default_model: "claude-sonnet-4-5-20250514"/default_model: "anthropic\/claude-sonnet-4.5"/' config/config.yaml
    fi
    echo -e "${GREEN}✓ config.yaml created (using OpenRouter)${NC}"
elif [ -n "$ANTHROPIC_API_KEY" ]; then
    echo -e "${GREEN}✓ config.yaml created (using Anthropic)${NC}"
elif [ -n "$OPENAI_API_KEY" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' 's/default_provider: "anthropic"/default_provider: "openai"/' config/config.yaml
        sed -i '' 's/default_model: "claude-sonnet-4-5-20250514"/default_model: "gpt-4-turbo"/' config/config.yaml
    else
        sed -i 's/default_provider: "anthropic"/default_provider: "openai"/' config/config.yaml
        sed -i 's/default_model: "claude-sonnet-4-5-20250514"/default_model: "gpt-4-turbo"/' config/config.yaml
    fi
    echo -e "${GREEN}✓ config.yaml created (using OpenAI)${NC}"
elif [ -n "$GOOGLE_API_KEY" ]; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' 's/default_provider: "anthropic"/default_provider: "google"/' config/config.yaml
        sed -i '' 's/default_model: "claude-sonnet-4-5-20250514"/default_model: "gemini-1.5-pro"/' config/config.yaml
    else
        sed -i 's/default_provider: "anthropic"/default_provider: "google"/' config/config.yaml
        sed -i 's/default_model: "claude-sonnet-4-5-20250514"/default_model: "gemini-1.5-pro"/' config/config.yaml
    fi
    echo -e "${GREEN}✓ config.yaml created (using Google)${NC}"
fi

# 7. Build and start containers
echo ""
echo -e "${BLUE}🚀 Building and starting containers...${NC}"
echo -e "${YELLOW}This may take a few minutes on first run...${NC}"
echo ""

docker compose up --build -d

# 8. Wait for health check
echo ""
echo -e "${YELLOW}⏳ Waiting for health check...${NC}"

HEALTH_CHECK_PASSED=false
for i in {1..60}; do
    if curl -f -s http://localhost:3000/health > /dev/null 2>&1; then
        HEALTH_CHECK_PASSED=true
        echo -e "${GREEN}✅ Health check passed!${NC}"
        break
    fi
    echo -n "."
    sleep 1
done

echo ""

if [ "$HEALTH_CHECK_PASSED" = false ]; then
    echo -e "${YELLOW}⚠️  Health check timed out after 60 seconds${NC}"
    echo -e "${YELLOW}Containers may still be starting. Check logs with:${NC}"
    echo "  docker compose logs -f coda-core"
fi

# 9. Display helpful info
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✅ Deployment Complete!${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BLUE}📊 Container Status:${NC}"
docker compose ps
echo ""
echo -e "${BLUE}📝 Useful Commands:${NC}"
echo -e "  ${YELLOW}View logs:${NC}        docker compose logs -f coda-core"
echo -e "  ${YELLOW}Check health:${NC}     curl localhost:3000/health"
echo -e "  ${YELLOW}Stop services:${NC}    docker compose down"
echo -e "  ${YELLOW}Restart:${NC}          docker compose restart coda-core"
echo -e "  ${YELLOW}View all logs:${NC}    docker compose logs -f"
echo ""
echo -e "${BLUE}🔍 Your bot is now running!${NC}"
echo -e "  It will respond to messages in Discord channel: ${GREEN}${DISCORD_CHANNEL_ID}${NC}"
if [ -n "$DISCORD_ALLOWED_USER_IDS" ]; then
    echo -e "  Allowed users: ${GREEN}${DISCORD_ALLOWED_USER_IDS}${NC}"
else
    echo -e "  ${YELLOW}⚠️  All users can interact (DISCORD_ALLOWED_USER_IDS not set)${NC}"
fi
echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
