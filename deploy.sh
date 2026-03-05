#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

BOT_URL="https://amina-bot.onrender.com"
RENDER_BOT_HOOK="${RENDER_BOT_DEPLOY_HOOK:-}"
RENDER_ADMIN_HOOK="${RENDER_ADMIN_DEPLOY_HOOK:-}"
RENDER_API_KEY="${RENDER_API_KEY:-}"
RENDER_BOT_SVC="srv-d61h8dh4tr6s73ektm1g"
RENDER_ADMIN_SVC="srv-d61h8dh4tr6s73ektm30"

log()  { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
fail() { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "============================================"
echo "  AMINA DEPLOY SCRIPT"
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

# --- Step 3: Push ---
echo ""
echo "--- Step 3: Push to origin ---"
git push origin main 2>&1
log "Pushed to origin/main"

# --- Step 4: Trigger Render deploy hooks ---
echo ""
echo "--- Step 4: Trigger Render deploy ---"

deploy_via_api() {
  local name="$1"
  local svc_id="$2"
  if [ -z "$RENDER_API_KEY" ]; then
    return 1
  fi
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "https://api.render.com/v1/services/$svc_id/deploys" \
    -H "Authorization: Bearer $RENDER_API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"clearCache":"clear"}')
  if [ "$status" = "201" ] || [ "$status" = "200" ]; then
    log "$name: deploy triggered via API (HTTP $status)"
    return 0
  else
    warn "$name: API returned HTTP $status"
    return 1
  fi
}

deploy_via_hook() {
  local name="$1"
  local hook="$2"
  if [ -z "$hook" ]; then
    return 1
  fi
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" "$hook")
  if [ "$status" = "200" ] || [ "$status" = "201" ]; then
    log "$name: deploy triggered via hook (HTTP $status)"
    return 0
  else
    warn "$name: deploy hook returned HTTP $status"
    return 1
  fi
}

trigger_deploy() {
  local name="$1"
  local svc_id="$2"
  local hook="$3"
  if deploy_via_api "$name" "$svc_id"; then
    return 0
  fi
  if deploy_via_hook "$name" "$hook"; then
    return 0
  fi
  warn "$name: no deploy method available"
  return 1
}

BOT_DEPLOYED=false
ADMIN_DEPLOYED=false

if trigger_deploy "amina-bot" "$RENDER_BOT_SVC" "$RENDER_BOT_HOOK"; then
  BOT_DEPLOYED=true
fi
if trigger_deploy "amina-admin" "$RENDER_ADMIN_SVC" "$RENDER_ADMIN_HOOK"; then
  ADMIN_DEPLOYED=true
fi

if [ "$BOT_DEPLOYED" = "false" ] && [ "$ADMIN_DEPLOYED" = "false" ]; then
  echo ""
  echo "Deploy methods (pick one):"
  echo ""
  echo "  Option A — Render API Key (recommended):"
  echo "    export RENDER_API_KEY='rnd_xxxxx'"
  echo "    Get key from: Render Dashboard > Account Settings > API Keys"
  echo ""
  echo "  Option B — Deploy Hooks:"
  echo "    export RENDER_BOT_DEPLOY_HOOK='https://api.render.com/deploy/srv-xxx?key=yyy'"
  echo "    export RENDER_ADMIN_DEPLOY_HOOK='https://api.render.com/deploy/srv-xxx?key=yyy'"
  echo "    Get URLs from: Render Dashboard > Service > Settings > Deploy Hook"
  echo ""
  echo "  Option C — Cursor IDE with Render MCP (no setup needed)"
fi

# --- Step 5: Wait and verify ---
echo ""
echo "--- Step 5: Wait for deploy & verify ---"

if [ "$BOT_DEPLOYED" = "false" ]; then
  warn "Bot deploy was not triggered — skipping verification"
  warn "Code is pushed. Use Render Dashboard for manual deploy."
  exit 0
fi

MAX_ATTEMPTS=20
SLEEP_INTERVAL=15

for i in $(seq 1 $MAX_ATTEMPTS); do
  sleep $SLEEP_INTERVAL
  RESULT=$(curl -s "$BOT_URL/api/lmstudio/health" 2>/dev/null || echo '{"error":"unreachable"}')

  if echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); sys.exit(0 if 'data' in d else 1)" 2>/dev/null; then
    log "New version deployed! (attempt $i, ~$((i * SLEEP_INTERVAL))s)"
    echo ""
    echo "$RESULT" | python3 -m json.tool 2>/dev/null || echo "$RESULT"

    echo ""
    HEALTH=$(curl -s "$BOT_URL/health" 2>/dev/null)
    echo "Health: $HEALTH"
    log "Deploy complete!"
    exit 0
  fi

  echo "  [$i/$MAX_ATTEMPTS] waiting... ($((i * SLEEP_INTERVAL))s elapsed)"
done

warn "Deploy verification timed out after $((MAX_ATTEMPTS * SLEEP_INTERVAL))s"
warn "Check Render dashboard manually: https://dashboard.render.com"
exit 1
