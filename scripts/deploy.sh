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

# 2. Check for required environment variables
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
    echo "  DISCORD_BOT_TOKEN=xxx DISCORD_CHANNEL_ID=123 OPENROUTER_API_KEY=xxx ./scripts/deploy.sh"
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

# 5. Create .env file
echo -e "${YELLOW}Creating .env file...${NC}"

cat > .env << EOF
# Discord Configuration
DISCORD_BOT_TOKEN=${DISCORD_BOT_TOKEN}
DISCORD_CHANNEL_ID=${DISCORD_CHANNEL_ID}
${DISCORD_ALLOWED_USER_IDS:+DISCORD_ALLOWED_USER_IDS=${DISCORD_ALLOWED_USER_IDS}}

# Database Configuration (Docker overrides these)
DATABASE_URL=postgresql://coda:${PG_PASSWORD}@postgres:5432/coda
POSTGRES_PASSWORD=${PG_PASSWORD}
REDIS_URL=redis://redis:6379

# LLM Provider Configuration
${OPENROUTER_API_KEY:+OPENROUTER_API_KEY=${OPENROUTER_API_KEY}}
${ANTHROPIC_API_KEY:+ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}}
${OPENAI_API_KEY:+OPENAI_API_KEY=${OPENAI_API_KEY}}
${GOOGLE_API_KEY:+GOOGLE_API_KEY=${GOOGLE_API_KEY}}

# Optional Services
${MEMORY_API_KEY:+MEMORY_API_KEY=${MEMORY_API_KEY}}

# Email Configuration (Optional)
${GMAIL_OAUTH_CLIENT_ID:+GMAIL_OAUTH_CLIENT_ID=${GMAIL_OAUTH_CLIENT_ID}}
${GMAIL_OAUTH_CLIENT_SECRET:+GMAIL_OAUTH_CLIENT_SECRET=${GMAIL_OAUTH_CLIENT_SECRET}}
${GMAIL_OAUTH_REDIRECT_PORT:+GMAIL_OAUTH_REDIRECT_PORT=${GMAIL_OAUTH_REDIRECT_PORT}}
${GMAIL_USER:+GMAIL_USER=${GMAIL_USER}}

# Application Configuration
NODE_ENV=production
LOG_LEVEL=info
CONFIG_PATH=./config/config.yaml
EOF

echo -e "${GREEN}✓ .env file created${NC}"

# 6. Create config.yaml with appropriate LLM provider
echo -e "${YELLOW}Creating config.yaml...${NC}"

if [ ! -f config/config.example.yaml ]; then
    echo -e "${RED}❌ config/config.example.yaml not found${NC}"
    exit 1
fi

# Copy the example config
cp config/config.example.yaml config/config.yaml

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
