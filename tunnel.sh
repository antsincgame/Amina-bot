#!/usr/bin/env bash
set -euo pipefail

# ============================================
#  Amina LM Studio Tunnel Supervisor
# ============================================
#
#  1. Убивает stale cloudflared перед стартом
#  2. Ждёт запуска LM Studio
#  3. Поднимает cloudflared quick tunnel (retry до 3 раз)
#  4. Регистрирует URL туннеля на боте
#  5. Мониторит: процесс + LM Studio + реальную доступность (healthy)
#  6. Рестартит при: процесс умер / LM Studio offline / URL протух
#

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

LMSTUDIO_PORT="${LMSTUDIO_PORT:-1234}"
BOT_API_URL="${BOT_API_URL:-https://amina-bot.onrender.com}"
LMSTUDIO_TUNNEL_TOKEN="${LMSTUDIO_TUNNEL_TOKEN:-}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-30}"
LMSTUDIO_WAIT_INTERVAL=3
TUNNEL_URL_TIMEOUT=30
RESTART_DELAY=5
START_RETRIES=3
UNHEALTHY_THRESHOLD=3

TUNNEL_PID=""
TUNNEL_LOG=""
CURRENT_URL=""
UNHEALTHY_COUNT=0

log()  { echo -e "${GREEN}[tunnel]${NC} $1"; }
warn() { echo -e "${YELLOW}[tunnel]${NC} $1"; }
err()  { echo -e "${RED}[tunnel]${NC} $1"; }
dim()  { echo -e "${DIM}[tunnel]${NC} $1"; }

# ============================================
#  Cleanup
# ============================================

kill_all_cloudflared() {
  pkill -f "cloudflared tunnel" 2>/dev/null || true
  sleep 1
}

cleanup() {
  log "Shutting down..."
  if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
    kill "$TUNNEL_PID" 2>/dev/null
    wait "$TUNNEL_PID" 2>/dev/null || true
    log "cloudflared stopped (PID $TUNNEL_PID)"
  fi
  if [ -n "$TUNNEL_LOG" ] && [ -f "$TUNNEL_LOG" ]; then
    rm -f "$TUNNEL_LOG"
  fi
  exit 0
}

trap cleanup SIGTERM SIGINT SIGHUP

# ============================================
#  Dependency Check
# ============================================

check_dependencies() {
  if ! command -v "$CLOUDFLARED_BIN" &>/dev/null; then
    err "cloudflared not found. Install:"
    err "  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared"
    exit 1
  fi
  if ! command -v curl &>/dev/null; then
    err "curl not found"
    exit 1
  fi
  if [ -z "$LMSTUDIO_TUNNEL_TOKEN" ]; then
    err "LMSTUDIO_TUNNEL_TOKEN is not set"
    exit 1
  fi
  log "cloudflared: $($CLOUDFLARED_BIN --version 2>&1 | head -1)"
}

# ============================================
#  LM Studio Health
# ============================================

check_lmstudio_ok() {
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$LMSTUDIO_PORT/api/v1/models" 2>/dev/null || echo "000")
  if [ "$status" = "200" ]; then return 0; fi
  status=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$LMSTUDIO_PORT/v1/models" 2>/dev/null || echo "000")
  [ "$status" = "200" ]
}

wait_for_lmstudio() {
  log "Waiting for LM Studio on port ${CYAN}$LMSTUDIO_PORT${NC}..."
  while true; do
    if check_lmstudio_ok; then
      log "LM Studio is running"
      return 0
    fi
    sleep "$LMSTUDIO_WAIT_INTERVAL"
  done
}

# ============================================
#  Tunnel URL Extraction
# ============================================

extract_tunnel_url() {
  local log_file="$1"
  local elapsed=0

  while [ "$elapsed" -lt "$TUNNEL_URL_TIMEOUT" ]; do
    if [ -f "$log_file" ]; then
      local url
      url=$(grep -oE 'https://[a-zA-Z0-9]+-[a-zA-Z0-9][-a-zA-Z0-9]*\.trycloudflare\.com' "$log_file" 2>/dev/null | head -1 || true)
      if [ -n "$url" ]; then
        echo "$url"
        return 0
      fi
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  return 1
}

# ============================================
#  Bot API Communication
# ============================================

send_register() {
  local url="$1"
  curl -s \
    -X POST "$BOT_API_URL/api/tunnel/register" \
    -H "Content-Type: application/json" \
    -H "X-Amina-Tunnel-Token: $LMSTUDIO_TUNNEL_TOKEN" \
    -d "{\"url\": \"$url\"}" \
    --max-time 20 2>/dev/null || echo ""
}

register_tunnel_url() {
  local url="$1"
  local response
  response=$(send_register "$url")

  if echo "$response" | grep -q '"success":true'; then
    return 0
  fi
  return 1
}

# Heartbeat: refresh status without rewriting lmstudio_url
send_heartbeat() {
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$BOT_API_URL/api/tunnel/heartbeat" \
    -H "Content-Type: application/json" \
    -H "X-Amina-Tunnel-Token: $LMSTUDIO_TUNNEL_TOKEN" \
    -d "{\"url\": \"$CURRENT_URL\"}" \
    --max-time 20 2>/dev/null || echo "000")

  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    echo "true"
  elif [ "$http_code" = "000" ]; then
    echo "null"
  else
    echo "false"
  fi
}

# ============================================
#  Tunnel Lifecycle
# ============================================

start_single_attempt() {
  TUNNEL_LOG=$(mktemp /tmp/amina-tunnel-XXXXXX.log)

  "$CLOUDFLARED_BIN" tunnel --url "http://localhost:$LMSTUDIO_PORT" >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  dim "cloudflared PID: $TUNNEL_PID"

  sleep 3
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    warn "cloudflared exited immediately"
    TUNNEL_PID=""
    return 1
  fi

  local url
  url=$(extract_tunnel_url "$TUNNEL_LOG") || {
    warn "Failed to extract tunnel URL"
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
    TUNNEL_PID=""
    return 1
  }

  CURRENT_URL="$url"
  return 0
}

start_tunnel() {
  log "Starting cloudflared tunnel -> localhost:$LMSTUDIO_PORT"

  kill_all_cloudflared

  local attempt
  for attempt in $(seq 1 "$START_RETRIES"); do
    log "Attempt $attempt/$START_RETRIES..."

    if start_single_attempt; then
      UNHEALTHY_COUNT=0
      log "Tunnel URL: ${CYAN}$CURRENT_URL${NC}"

      log "Registering URL with bot at $BOT_API_URL..."
      if register_tunnel_url "$CURRENT_URL"; then
        log "URL registered successfully"
      else
        warn "Registration failed (bot may be offline). Will retry via heartbeat."
      fi
      return 0
    fi

    if [ "$attempt" -lt "$START_RETRIES" ]; then
      warn "Retrying in ${RESTART_DELAY}s..."
      kill_all_cloudflared
      sleep "$RESTART_DELAY"
    fi
  done

  err "Failed to start tunnel after $START_RETRIES attempts"
  return 1
}

# ============================================
#  Monitoring (exit: 1=crashed, 2=lm_offline, 3=url_dead)
# ============================================

monitor_tunnel() {
  log "Monitoring (health every ${HEALTH_INTERVAL}s, restart after ${UNHEALTHY_THRESHOLD} unhealthy)..."
  echo ""
  log "=== Tunnel active ==="
  log "  LM Studio:  http://localhost:$LMSTUDIO_PORT"
  log "  Tunnel URL:  ${CYAN}$CURRENT_URL${NC}"
  log "  Bot API:     $BOT_API_URL"
  log "  Press Ctrl+C to stop"
  echo ""

  while true; do
    sleep "$HEALTH_INTERVAL" &
    local sleep_pid=$!
    wait "$sleep_pid" 2>/dev/null || true

    # 1. cloudflared alive?
    if [ -z "$TUNNEL_PID" ] || ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      warn "cloudflared process died"
      TUNNEL_PID=""
      return 1
    fi

    # 2. LM Studio alive?
    if ! check_lmstudio_ok; then
      warn "LM Studio went offline"
      kill "$TUNNEL_PID" 2>/dev/null || true
      wait "$TUNNEL_PID" 2>/dev/null || true
      TUNNEL_PID=""
      return 2
    fi

    # 3. Heartbeat + healthy check
    local healthy
    healthy=$(send_heartbeat)
    local ts
    ts=$(date +%H:%M:%S)

    if [ "$healthy" = "true" ]; then
      UNHEALTHY_COUNT=0
      dim "$ts tunnel: ok | lmstudio: ok | render: ok"
    elif [ "$healthy" = "false" ]; then
      UNHEALTHY_COUNT=$((UNHEALTHY_COUNT + 1))
      warn "$ts tunnel: ok | lmstudio: ok | render: UNHEALTHY ($UNHEALTHY_COUNT/$UNHEALTHY_THRESHOLD)"

      if [ "$UNHEALTHY_COUNT" -ge "$UNHEALTHY_THRESHOLD" ]; then
        err "Tunnel URL unreachable from Render for $UNHEALTHY_THRESHOLD checks — restarting"
        kill "$TUNNEL_PID" 2>/dev/null || true
        wait "$TUNNEL_PID" 2>/dev/null || true
        TUNNEL_PID=""
        return 3
      fi
    else
      dim "$ts tunnel: ok | lmstudio: ok | render: no response"
    fi
  done
}

# ============================================
#  Main Loop
# ============================================

main() {
  echo ""
  echo -e "${CYAN}============================================${NC}"
  echo -e "${CYAN}  Amina LM Studio Tunnel Supervisor${NC}"
  echo -e "${CYAN}============================================${NC}"
  echo ""

  check_dependencies
  kill_all_cloudflared

  while true; do
    wait_for_lmstudio

    if start_tunnel; then
      monitor_tunnel
      local exit_reason=$?

      case $exit_reason in
        2)
          log "LM Studio offline — waiting for it to come back..."
          ;;
        3)
          warn "Tunnel URL expired — getting new one..."
          sleep "$RESTART_DELAY"
          ;;
        *)
          warn "Tunnel crashed — restarting in ${RESTART_DELAY}s..."
          sleep "$RESTART_DELAY"
          ;;
      esac
    else
      warn "Failed to start tunnel — retrying in ${RESTART_DELAY}s..."
      sleep "$RESTART_DELAY"
    fi
  done
}

main
