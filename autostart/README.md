# Автозапуск LM Studio и туннеля

Запуск LM Studio и туннеля cloudflared при входе в систему.

---

## Windows

### Быстрая установка

```powershell
.\autostart\install-windows.ps1
```

Скрипт ставит **Amina Bridge** — единый Windows bootstrap, который:
- поднимает `lms daemon up`
- поднимает `lms server start`
- запускает `tunnel.ps1`

Сначала installer пытается создать задачу **Amina-Bridge** в Task Scheduler.
Если Windows не даёт создать задачу, installer автоматически ставит shortcut в **Startup folder**.

### Ручной запуск туннеля

```powershell
.\tunnel.ps1
```

### Ручной запуск всей связки

```bat
autostart\amina-bridge.bat
```

Этот `bat` запускает ту же utility-цепочку, что и автозапуск после логина:
`LM Studio daemon -> LM Studio server -> tunnel supervisor`.

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
2. **LM Studio** — [lmstudio.ai](https://lmstudio.ai), включить CLI:
   `Settings -> Developer -> Enable CLI`
3. **PowerShell 5.1+** — предустановлен в Windows 10/11
4. **LMSTUDIO_TUNNEL_TOKEN** — должен лежать либо в User environment, либо в локальном `.env`
5. **Node.js / npx** — нужен для автоматического fallback на `localtunnel`, если `trycloudflare` упирается в rate limit

### Permanent mode (без `trycloudflare`)

Если хочешь по-настоящему стабильное соединение без rate limit у quick tunnel, используй **named Cloudflare tunnel** и просто добавь в локальный `.env`:

```env
CLOUDFLARED_TUNNEL_ARGS=tunnel run --token <cloudflare_tunnel_token>
CLOUDFLARED_PUBLIC_URL=https://llm.example.com
```

`Amina Bridge` автоматически подхватит этот режим:
- перестанет создавать `trycloudflare` quick tunnel
- будет запускать `cloudflared` с твоими аргументами
- будет регистрировать в боте фиксированный публичный URL

### Auto fallback mode

По умолчанию bridge теперь работает в режиме `TUNNEL_PROVIDER=auto`:
- сначала пробует `cloudflared`
- если quick tunnel получает `429 / 1015`, автоматически переключается на `localtunnel`
- регистрирует новый рабочий URL в боте без ручного копипаста

Если хочешь зафиксировать провайдера явно, добавь в локальный `.env`:

```env
TUNNEL_PROVIDER=localtunnel
LOCALTUNNEL_ARGS=-y localtunnel@2.0.2 --port 1234
```

### Управление (Windows)

```powershell
# Статус bridge-задачи
Get-ScheduledTask -TaskName "Amina-Bridge"

# Запустить bridge сейчас
Start-ScheduledTask -TaskName "Amina-Bridge"

# Остановить bridge
Stop-ScheduledTask -TaskName "Amina-Bridge"

# Удалить автозапуск полностью
Unregister-ScheduledTask -TaskName "Amina-Bridge" -Confirm:$false
```

Если installer ушёл в fallback через Startup folder:

```powershell
Remove-Item "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup\Amina Bridge.lnk" -Force
```

### Логи (Windows)

```powershell
# bootstrap-утилита
notepad "$env:TEMP\amina-bridge.log"

# cloudflared / tunnel supervisor
Get-ChildItem $env:TEMP -Filter "amina-tunnel-*.log" | Sort-Object LastWriteTime -Descending
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
| `LMSTUDIO_TUNNEL_TOKEN` | — | Токен авторизации для `/api/tunnel/register` и `/api/tunnel/heartbeat` |
| `CLOUDFLARED_BIN` | `cloudflared` | Путь к cloudflared |
| `CLOUDFLARED_TUNNEL_ARGS` | quick tunnel args | Кастомный запуск `cloudflared`, например `tunnel run --token ...` |
| `CLOUDFLARED_PUBLIC_URL` | — | Фиксированный публичный URL для named tunnel |
| `TUNNEL_PROVIDER` | `auto` | `auto`, `cloudflare` или `localtunnel` |
| `LOCALTUNNEL_ARGS` | `-y localtunnel@2.0.2 --port 1234` | Аргументы для fallback через `npx localtunnel` |
| `HEALTH_INTERVAL` | `30` | Интервал проверки здоровья (секунды) |

## Как это работает

```
Amina Bridge (Windows bootstrap)
       │
       ├─── lms daemon up
       ├─── lms server start
       └─── tunnel.ps1
                │
                ├── Ждёт готовности LM Studio API
                ├── Поднимает cloudflared или localtunnel
                ├── Ждёт публичной готовности tunnel URL
                ├── Регистрирует URL на боте (POST /api/tunnel/register)
                ├── Делает self-healing через heartbeat/re-register
                └── Рестартит при падении
       
LM Studio (localhost:1234)
       │
       └─── active tunnel provider
                │
                ├── https://random-name.trycloudflare.com
                └── https://random-name.loca.lt
                         │
                         └── Render bot обращается сюда для LLM inference
```
