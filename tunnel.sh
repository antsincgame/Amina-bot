#!/usr/bin/env bash
set -euo pipefail

# ============================================
#  Amina LM Studio Tunnel Supervisor
# ============================================
#
#  Автоматически:
#  1. Ждёт запуска LM Studio
#  2. Поднимает cloudflared quick tunnel
#  3. Регистрирует URL туннеля на боте
#  4. Мониторит tunnel — рестарт при падении
#
#  Использование:
#    ./tunnel.sh
#    LMSTUDIO_PORT=8080 ./tunnel.sh
#    systemctl --user start amina-tunnel
#

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
DIM='\033[2m'
NC='\033[0m'

LMSTUDIO_PORT="${LMSTUDIO_PORT:-1234}"
BOT_API_URL="${BOT_API_URL:-https://amina-bot.onrender.com}"
CLOUDFLARED_BIN="${CLOUDFLARED_BIN:-cloudflared}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-30}"
LMSTUDIO_WAIT_INTERVAL=3
TUNNEL_URL_TIMEOUT=30
RESTART_DELAY=5

TUNNEL_PID=""
TUNNEL_LOG=""
CURRENT_URL=""

log()  { echo -e "${GREEN}[tunnel]${NC} $1"; }
warn() { echo -e "${YELLOW}[tunnel]${NC} $1"; }
err()  { echo -e "${RED}[tunnel]${NC} $1"; }
dim()  { echo -e "${DIM}[tunnel]${NC} $1"; }

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
  log "cloudflared: $($CLOUDFLARED_BIN --version 2>&1 | head -1)"
}

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

extract_tunnel_url() {
  local log_file="$1"
  local elapsed=0

  while [ "$elapsed" -lt "$TUNNEL_URL_TIMEOUT" ]; do
    if [ ! -f "$log_file" ]; then
      sleep 1
      elapsed=$((elapsed + 1))
      continue
    fi
    local url
    url=$(grep -oE 'https://[a-zA-Z0-9]+-[a-zA-Z0-9][-a-zA-Z0-9]*\.trycloudflare\.com' "$log_file" 2>/dev/null | head -1 || true)
    if [ -n "$url" ]; then
      echo "$url"
      return 0
    fi
    sleep 1
    elapsed=$((elapsed + 1))
  done

  return 1
}

register_tunnel_url() {
  local url="$1"
  local response
  local http_code

  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$BOT_API_URL/api/tunnel/register" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"$url\"}" 2>/dev/null || echo "000")

  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    return 0
  fi

  warn "POST /api/tunnel/register returned HTTP $http_code, trying PUT fallback..."
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X PUT "$BOT_API_URL/api/settings/lmstudio_url" \
    -H "Content-Type: application/json" \
    -d "{\"value\": \"$url\"}" 2>/dev/null || echo "000")

  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    return 0
  fi

  warn "PUT /api/settings/lmstudio_url returned HTTP $http_code"
  return 1
}

send_heartbeat() {
  # /tunnel/register работает и внутренне вызывает recordHeartbeat()
  curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$BOT_API_URL/api/tunnel/register" \
    -H "Content-Type: application/json" \
    -d "{\"url\": \"$CURRENT_URL\"}" 2>/dev/null || true
}

start_tunnel() {
  TUNNEL_LOG=$(mktemp /tmp/amina-tunnel-XXXXXX.log)

  log "Starting cloudflared tunnel -> localhost:$LMSTUDIO_PORT"
  "$CLOUDFLARED_BIN" tunnel --url "http://localhost:$LMSTUDIO_PORT" >"$TUNNEL_LOG" 2>&1 &
  TUNNEL_PID=$!
  dim "cloudflared PID: $TUNNEL_PID"

  sleep 1
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    err "cloudflared exited immediately. Log:"
    tail -20 "$TUNNEL_LOG" 2>/dev/null || true
    return 1
  fi

  log "Extracting tunnel URL (up to ${TUNNEL_URL_TIMEOUT}s)..."
  local url
  url=$(extract_tunnel_url "$TUNNEL_LOG") || {
    err "Failed to extract tunnel URL. Last cloudflared output:"
    tail -20 "$TUNNEL_LOG" 2>/dev/null || true
    err "Tip: if you have ~/.cloudflared/config.yaml, remove or rename it (quick tunnels don't work with config)"
    kill "$TUNNEL_PID" 2>/dev/null || true
    wait "$TUNNEL_PID" 2>/dev/null || true
    TUNNEL_PID=""
    return 1
  }

  CURRENT_URL="$url"
  log "Tunnel URL: ${CYAN}$url${NC}"

  log "Registering URL with bot at $BOT_API_URL..."
  if register_tunnel_url "$url"; then
    log "URL registered successfully"
  else
    warn "Failed to register URL (bot may be offline). Will retry on next health check."
  fi

  return 0
}

monitor_tunnel() {
  log "Monitoring tunnel (health check every ${HEALTH_INTERVAL}s)..."
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

    if [ -z "$TUNNEL_PID" ] || ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
      warn "cloudflared process died. Restarting in ${RESTART_DELAY}s..."
      TUNNEL_PID=""
      sleep "$RESTART_DELAY"
      return 1
    fi

    if ! check_lmstudio_ok; then
      warn "LM Studio went offline. Stopping tunnel..."
      kill "$TUNNEL_PID" 2>/dev/null || true
      wait "$TUNNEL_PID" 2>/dev/null || true
      TUNNEL_PID=""
      return 2
    fi

    send_heartbeat
    dim "$(date +%H:%M:%S) tunnel: ok | lmstudio: ok"
  done
}

main() {
  echo ""
  echo -e "${CYAN}============================================${NC}"
  echo -e "${CYAN}  Amina LM Studio Tunnel Supervisor${NC}"
  echo -e "${CYAN}============================================${NC}"
  echo ""

  check_dependencies

  while true; do
    wait_for_lmstudio

    if start_tunnel; then
      monitor_tunnel
      local exit_reason=$?

      if [ "$exit_reason" -eq 2 ]; then
        log "LM Studio offline — waiting for it to come back..."
        if [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null; then
          kill "$TUNNEL_PID" 2>/dev/null || true
          wait "$TUNNEL_PID" 2>/dev/null || true
        fi
        TUNNEL_PID=""
        continue
      fi

      warn "Tunnel crashed — restarting..."
    else
      warn "Failed to start tunnel — retrying in ${RESTART_DELAY}s..."
      sleep "$RESTART_DELAY"
    fi
  done
}

main
