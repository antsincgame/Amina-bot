# Сборка на ПК (Windows + NVIDIA)

**Первый раз:** двойной клик **`INSTALL_RUNTIME.bat`** (ставит Python 3.12 и Docker Desktop через `winget`, нужен интернет; при отсутствии winget откройте подсказки в окне).

**Каждый раз:** **`START_AMINA.bat`**. Если Python только что поставился — запустите `START_AMINA.bat` ещё раз.

После запуска Docker откройте в браузере **веб-панель**: `http://127.0.0.1:8765/` (скрипт `start-windows.ps1` открывает её сам).

**Не открывается?** В PowerShell из `amina-avatar-local`:

1. `.\scripts\diagnose-panel.ps1` — проверит порт и Docker.
2. Запущен ли **Docker Desktop** (иконка в трее не серая)?
3. Без Docker: `.\scripts\start-panel-local.ps1` — панель на Python (для Wav2Lip на GPU всё равно нужен Docker).
4. В `.env` если `AVATAR_PORT` не 8765 — открывайте свой порт.

Пошаговый чеклист совпадает с планом в Cursor; здесь — пути и команды **из этого репозитория**.

## 0. Один раз

- Docker Desktop + WSL2, GPU в настройках Docker.
- Драйвер NVIDIA, при необходимости [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/).

## 1. Проверка окружения

```powershell
cd amina-avatar-local
.\scripts\verify-pc-setup.ps1
```

Без скачивания CUDA-образа для пробы GPU:

```powershell
.\scripts\verify-pc-setup.ps1 -SkipGpuProbe
```

## 2. Секреты

```powershell
.\scripts\init-local-env.ps1
```

Скопируйте выведенный секрет в мини-апп **Локальный PC**.

## 3. Лицо

Добавьте свой `assets\face.png` (см. [assets/README.md](assets/README.md)) или сгенерируйте **заглушку** для первого запуска:

```powershell
.\scripts\create-minimal-face-placeholder.ps1
```

Для качественного Wav2Lip замените файл на реальное фото лица.

В режиме **`AVATAR_ENGINE=ffmpeg`** ролик — вертикальный **720×1280** с обрезкой под лицо (см. `env.example`: `AVATAR_VIDEO_*`, `AVATAR_CRF=18` для более чистой картинки). Без нормального `face.png` результат останется слабым.

## 4. Сборка и запуск GPU

```powershell
.\scripts\run-gpu-stack.ps1
```

Или вручную:

```powershell
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
```

Ожидание по `/health`: `"engine":"wav2lip"`, `"cuda":"yes"`.

## 5. Туннель

В отдельном окне:

```powershell
.\scripts\start-tunnel.ps1
```

Или: `.\start-windows.ps1 -Gpu -Tunnel`.

## 6. Мини-апп

В Telegram: базовый URL туннеля (без хвостовых `/`) + тот же секрет, что в `.env`.

Полный API и переменные: [README.md](README.md).
