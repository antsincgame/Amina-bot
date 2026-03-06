# Автозапуск LM Studio и туннеля

Запуск LM Studio и tunnel.sh при входе в систему.

## Вариант A: GUI (LM Studio с интерфейсом)

1. **LM Studio** — добавь в автозапуск рабочего стола:
   ```bash
   # Скопируй и отредактируй путь к AppImage
   cp autostart/lmstudio.desktop.example ~/.config/autostart/lmstudio.desktop
   # Отредактируй Exec= — укажи путь к своему LM-Studio-*.AppImage
   nano ~/.config/autostart/lmstudio.desktop
   ```

2. **tunnel.sh** — systemd user service:
   ```bash
   ./autostart/install.sh
   ```

## Вариант B: Headless (LM Studio без GUI)

Если установлен `lms` CLI (headless):

```bash
# Установка headless (если ещё не установлен)
curl -fsSL https://lmstudio.ai/install.sh | bash

# Копируй и включи сервис
mkdir -p ~/.config/systemd/user
cp autostart/lmstudio-headless.service ~/.config/systemd/user/
# Отредактируй путь к lms и username
nano ~/.config/systemd/user/lmstudio-headless.service

systemctl --user daemon-reload
systemctl --user enable lmstudio-headless
systemctl --user start lmstudio-headless
```

Затем установи tunnel:
```bash
./autostart/install.sh
```

## Управление

```bash
# Статус туннеля
systemctl --user status amina-tunnel

# Логи
journalctl --user -u amina-tunnel -f

# Остановить
systemctl --user stop amina-tunnel

# Запустить
systemctl --user start amina-tunnel
```
