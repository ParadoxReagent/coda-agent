#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[info]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ok]${NC}    $*"; }
err()   { echo -e "${RED}[error]${NC} $*"; }

# ── 1. Postgres password secret ──────────────────────────────────────
if [ ! -f secrets/pg_password.txt ]; then
  mkdir -p secrets
  openssl rand -base64 24 | tr -d '\n' > secrets/pg_password.txt
  ok "Generated secrets/pg_password.txt"
else
  ok "secrets/pg_password.txt already exists"
fi

PG_PASSWORD="$(cat secrets/pg_password.txt)"

# ── 2. .env file ─────────────────────────────────────────────────────
if [ ! -f .env ]; then
  cp .env.example .env
  # Sync the postgres password into .env
  sed -i.bak "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PG_PASSWORD}|" .env
  sed -i.bak "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://coda:${PG_PASSWORD}@localhost:5432/coda|" .env
  rm -f .env.bak
  ok "Created .env from .env.example (postgres password synced)"
  echo ""
  warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  warn "  .env was just created. You need to fill in your credentials:"
  warn ""
  warn "  Required:"
  warn "    DISCORD_BOT_TOKEN"
  warn "    DISCORD_CHANNEL_ID"
  warn ""
  warn "  At least one LLM provider:"
  warn "    ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY"
  warn ""
  warn "  Then re-run:  ./scripts/quickstart.sh"
  warn "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  exit 0
fi

ok ".env exists"

# ── 3. config.yaml ───────────────────────────────────────────────────
if [ ! -f config/config.yaml ]; then
  cp config/config.example.yaml config/config.yaml
  ok "Created config/config.yaml from config.example.yaml"
else
  ok "config/config.yaml already exists"
fi

# ── 4. Validate required credentials ────────────────────────────────
source .env 2>/dev/null || true

MISSING=()

if [ -z "${DISCORD_BOT_TOKEN:-}" ]; then
  MISSING+=("DISCORD_BOT_TOKEN")
fi
if [ -z "${DISCORD_CHANNEL_ID:-}" ]; then
  MISSING+=("DISCORD_CHANNEL_ID")
fi

HAS_LLM=false
for key in ANTHROPIC_API_KEY GOOGLE_API_KEY OPENAI_API_KEY OPENROUTER_API_KEY; do
  if [ -n "${!key:-}" ]; then
    HAS_LLM=true
    break
  fi
done

if [ "$HAS_LLM" = false ]; then
  MISSING+=("At least one LLM API key (ANTHROPIC_API_KEY, GOOGLE_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY)")
fi

if [ ${#MISSING[@]} -gt 0 ]; then
  err "Missing required credentials in .env:"
  for m in "${MISSING[@]}"; do
    echo "    - $m"
  done
  echo ""
  info "Edit .env and re-run:  ./scripts/quickstart.sh"
  exit 1
fi

ok "Credentials validated"

# ── 5. Build and start containers ────────────────────────────────────
info "Starting containers (this may take a few minutes on first build)..."
docker compose up --build -d

# ── 6. Wait for health check ────────────────────────────────────────
info "Waiting for coda-core to become healthy..."
TIMEOUT=60
ELAPSED=0
INTERVAL=3

while [ $ELAPSED -lt $TIMEOUT ]; do
  if curl -sf http://localhost:3000/health > /dev/null 2>&1; then
    echo ""
    ok "coda-core is healthy!"
    echo ""
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${GREEN}  coda-agent is running!${NC}"
    echo ""
    echo "  Useful commands:"
    echo "    docker compose logs -f coda-core    # follow logs"
    echo "    docker compose ps                   # container status"
    echo "    curl localhost:3000/health           # health check"
    echo "    docker compose down                 # stop all containers"
    echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    exit 0
  fi
  printf "."
  sleep $INTERVAL
  ELAPSED=$((ELAPSED + INTERVAL))
done

echo ""
err "Timed out waiting for coda-core to become healthy (${TIMEOUT}s)"
echo ""
info "Check the logs for errors:"
echo "    docker compose logs coda-core"
exit 1
