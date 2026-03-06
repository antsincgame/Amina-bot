#!/usr/bin/env bash
# Установка автозапуска tunnel.sh и LM Studio
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AMINA_DIR="$(dirname "$SCRIPT_DIR")"
TUNNEL_SCRIPT="$AMINA_DIR/tunnel.sh"

echo "============================================"
echo "  Amina Autostart Installer"
echo "============================================"
echo ""

# --- 1. Tunnel (systemd user) ---
echo "1. Tunnel (tunnel.sh) — systemd user service"
mkdir -p ~/.config/systemd/user
SVC="$SCRIPT_DIR/amina-tunnel.service"
# Подставляем реальный путь к проекту
sed "s|@AMINA_DIR@|$AMINA_DIR|g" "$SVC" > ~/.config/systemd/user/amina-tunnel.service
echo "   → ~/.config/systemd/user/amina-tunnel.service"
systemctl --user daemon-reload
systemctl --user enable amina-tunnel
echo "   → enabled (стартует при логине)"
echo ""

# --- 2. LM Studio — выбор режима ---
echo "2. LM Studio — выбери режим:"
echo "   [1] GUI (AppImage) — автозапуск при входе в рабочий стол"
echo "   [2] Headless (lms CLI) — systemd, без GUI"
echo "   [3] Пропустить (запускаю LM Studio вручную)"
read -rp "   Номер (1/2/3): " choice

case "$choice" in
  1)
    mkdir -p ~/.config/autostart
    if [ -f "$SCRIPT_DIR/lmstudio.desktop.example" ]; then
      cp "$SCRIPT_DIR/lmstudio.desktop.example" ~/.config/autostart/lmstudio.desktop
      echo "   → ~/.config/autostart/lmstudio.desktop"
      echo "   ⚠ Отредактируй Exec= — укажи путь к своему LM-Studio-*.AppImage"
      echo "     Текущий: $(grep '^Exec=' ~/.config/autostart/lmstudio.desktop)"
    fi
    ;;
  2)
    if [ -x "$HOME/.lmstudio/bin/lms" ]; then
      mkdir -p ~/.config/systemd/user
      cp "$SCRIPT_DIR/lmstudio-headless.service" ~/.config/systemd/user/
      systemctl --user daemon-reload
      systemctl --user enable lmstudio-headless.service
      echo "   → lmstudio-headless.service enabled"
    else
      echo "   ⚠ lms не найден. Установи: curl -fsSL https://lmstudio.ai/install.sh | bash"
    fi
    ;;
  3)
    echo "   Пропущено."
    ;;
  *)
    echo "   Пропущено."
    ;;
esac
echo ""

echo "============================================"
echo "  Готово"
echo "============================================"
echo ""
echo "Команды:"
echo "  systemctl --user status amina-tunnel   # статус туннеля"
echo "  systemctl --user start amina-tunnel    # запустить сейчас"
echo "  systemctl --user stop amina-tunnel     # остановить"
echo "  journalctl --user -u amina-tunnel -f   # логи"
echo ""
echo "При следующем входе в систему tunnel.sh и LM Studio запустятся автоматически."
echo ""
