# Автозапуск LM Studio и туннеля

Запуск LM Studio и туннеля cloudflared при входе в систему.

---

## Windows

### Быстрая установка

```powershell
.\autostart\install-windows.ps1
```

Скрипт создаст задачи в Task Scheduler:
- **Amina-LMStudio** — запуск LM Studio при входе (GUI или headless)
- **Amina-Tunnel** — запуск `tunnel.ps1` (cloudflared quick tunnel)

### Ручной запуск туннеля

```powershell
.\tunnel.ps1
```

С кастомными параметрами:

```powershell
$env:LMSTUDIO_PORT = '8080'
$env:BOT_API_URL = 'https://your-bot.onrender.com'
.\tunnel.ps1
```

### Требования (Windows)

1. **cloudflared** — установить:
   ```powershell
   winget install Cloudflare.cloudflared
   ```
2. **LM Studio** — [lmstudio.ai](https://lmstudio.ai), включить сервер (Developer → Start Server)
3. **PowerShell 5.1+** — предустановлен в Windows 10/11

### Управление (Windows)

```powershell
# Статус задач
Get-ScheduledTask -TaskName "Amina-*"

# Запустить туннель
Start-ScheduledTask -TaskName "Amina-Tunnel"

# Остановить туннель
Stop-ScheduledTask -TaskName "Amina-Tunnel"

# Удалить автозапуск полностью
Unregister-ScheduledTask -TaskName "Amina-Tunnel" -Confirm:$false
Unregister-ScheduledTask -TaskName "Amina-LMStudio" -Confirm:$false
```

---

## Linux

### Быстрая установка

```bash
./autostart/install.sh
```

### Вариант A: GUI (LM Studio с интерфейсом)

1. **LM Studio** — добавь в автозапуск рабочего стола:
   ```bash
   cp autostart/lmstudio.desktop.example ~/.config/autostart/lmstudio.desktop
   nano ~/.config/autostart/lmstudio.desktop
   ```

2. **tunnel.sh** — systemd user service:
   ```bash
   ./autostart/install.sh
   ```

### Вариант B: Headless (LM Studio без GUI)

```bash
curl -fsSL https://lmstudio.ai/install.sh | bash

mkdir -p ~/.config/systemd/user
cp autostart/lmstudio-headless.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable lmstudio-headless
systemctl --user start lmstudio-headless
```

Затем:
```bash
./autostart/install.sh
```

### Требования (Linux)

1. **cloudflared**:
   ```bash
   curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
     -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared
   ```
2. **LM Studio** — AppImage или headless (lms CLI)

### Управление (Linux)

```bash
systemctl --user status amina-tunnel
systemctl --user start amina-tunnel
systemctl --user stop amina-tunnel
journalctl --user -u amina-tunnel -f
```

---

## Переменные окружения

| Переменная | По умолчанию | Описание |
|---|---|---|
| `LMSTUDIO_PORT` | `1234` | Порт LM Studio |
| `BOT_API_URL` | `https://amina-bot.onrender.com` | URL бота на Render |
| `CLOUDFLARED_BIN` | `cloudflared` | Путь к cloudflared |
| `HEALTH_INTERVAL` | `30` | Интервал проверки здоровья (секунды) |

## Как это работает

```
LM Studio (localhost:1234)
       │
       ├─── tunnel.sh / tunnel.ps1
       │        │
       │        ├── Ждёт запуска LM Studio
       │        ├── Поднимает cloudflared quick tunnel
       │        ├── Регистрирует URL на боте (POST /api/tunnel/register)
       │        ├── Мониторит tunnel + heartbeat каждые 30с
       │        └── Рестартит при падении
       │
       └─── cloudflared tunnel
                │
                └── https://random-name.trycloudflare.com
                         │
                         └── Render bot обращается сюда для LLM inference
```
