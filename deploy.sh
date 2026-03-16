#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

BOT_URL="https://amina.vibecoding.by"

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo "  AMINA DEPLOY SCRIPT (Coolify)"
echo "============================================"
echo ""

# --- Step 1: TypeScript check ---
echo "--- Step 1: TypeScript check (bot) ---"
cd "$ROOT/bot"
if npx tsc --noEmit 2>&1 | tail -5; then
  log "Bot: tsc OK"
else
  fail "Bot: TypeScript errors found"
fi

echo "--- Step 1b: TypeScript check (admin) ---"
cd "$ROOT/admin"
if npx tsc --noEmit 2>&1 | tail -5; then
  log "Admin: tsc OK"
else
  fail "Admin: TypeScript errors found"
fi
cd "$ROOT"

# --- Step 2: Git status ---
echo ""
echo "--- Step 2: Git status ---"
CHANGES=$(git status --porcelain)
if [ -z "$CHANGES" ]; then
  warn "No changes to commit"
else
  echo "$CHANGES"
  echo ""

  if [ "${1:-}" = "--auto" ]; then
    MSG="chore: auto-deploy $(date +%Y-%m-%d_%H:%M)"
  else
    read -rp "Commit message (or Enter for auto): " MSG
    if [ -z "$MSG" ]; then
      MSG="chore: deploy $(date +%Y-%m-%d_%H:%M)"
    fi
  fi

  git add -A
  git commit -m "$MSG"
  log "Committed: $MSG"
fi

# --- Step 3: Push (triggers Coolify auto-deploy via GitHub App) ---
echo ""
echo "--- Step 3: Push to origin ---"
git push origin main 2>&1
log "Pushed to origin/main — Coolify auto-deploy triggered"

# --- Step 4: Wait and verify ---
echo ""
echo "--- Step 4: Wait for deploy & verify ---"

MAX_ATTEMPTS=20
SLEEP_INTERVAL=15

for i in $(seq 1 $MAX_ATTEMPTS); do
  sleep $SLEEP_INTERVAL
  RESULT=$(curl -s "$BOT_URL/api/status" 2>/dev/null || echo '{"error":"unreachable"}')

  if echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if 'checks' in d else 1)" 2>/dev/null; then
    log "New version deployed! (attempt $i, ~$((i * SLEEP_INTERVAL))s)"
    echo ""
    echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"

    echo ""
    HEALTH=$(curl -s "$BOT_URL/health" 2>/dev/null)
    echo "Health: $HEALTH"

    # Reset Telegram webhook after deploy (may get 502 during restart)
    echo ""
    echo "--- Resetting Telegram webhook ---"
    TG_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
    if [ -n "$TG_TOKEN" ]; then
      curl -s "https://api.telegram.org/bot${TG_TOKEN}/deleteWebhook" > /dev/null
      sleep 1
      curl -s "https://api.telegram.org/bot${TG_TOKEN}/setWebhook?url=${BOT_URL}/webhook/${TG_TOKEN}" > /dev/null
      log "Webhook reset"
    else
      warn "TELEGRAM_BOT_TOKEN not set — reset webhook manually"
    fi

    log "Deploy complete!"
    exit 0
  fi

  echo "  [$i/$MAX_ATTEMPTS] waiting... ($((i * SLEEP_INTERVAL))s elapsed)"
done

warn "Deploy verification timed out after $((MAX_ATTEMPTS * SLEEP_INTERVAL))s"
warn "Check Coolify dashboard: https://coolify.vibecoding.by"
exit 1
