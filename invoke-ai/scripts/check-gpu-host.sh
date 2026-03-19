#!/usr/bin/env bash
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok() { echo -e "${GREEN}[ok]${NC} $1"; }
warn() { echo -e "${YELLOW}[!!]${NC} $1"; }
fail() { echo -e "${RED}[fail]${NC} $1"; exit 1; }

echo "=== Amina / InvokeAI — проверка GPU-хоста (Linux) ==="
echo ""

command -v docker >/dev/null 2>&1 || fail "docker не найден. Установите Docker Engine."
ok "docker: $(docker --version)"

docker compose version >/dev/null 2>&1 || fail "docker compose (v2 plugin) не найден."
ok "docker compose: $(docker compose version)"

if ! docker info 2>/dev/null | grep -qi 'Runtimes:.*nvidia'; then
  if docker info 2>/dev/null | grep -q 'nvidia'; then
    ok "Docker: упоминание nvidia в docker info"
  else
    warn "NVIDIA Container Toolkit может быть не подключён (в docker info нет nvidia runtime)."
    warn "Инструкция: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
  fi
else
  ok "Docker runtime: nvidia виден в docker info"
fi

if command -v nvidia-smi >/dev/null 2>&1; then
  ok "nvidia-smi:"
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader || true
else
  warn "nvidia-smi не найден (драйвер NVIDIA не установлен или это не GPU-сервер)."
fi

echo ""
echo "Пробный запуск CUDA в контейнере (может занять при первом pull):"
if docker run --rm --gpus all nvidia/cuda:12.0.0-base-ubuntu22.04 nvidia-smi 2>/dev/null; then
  ok "Контейнер с --gpus all видит GPU."
else
  fail "docker run --gpus all не удался. Проверьте nvidia-container-toolkit и перезапуск docker."
fi

ok "Хост готов к: cd invoke-ai && docker compose up -d"
