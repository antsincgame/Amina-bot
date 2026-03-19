# Amina Avatar Local (ПК как сервер)

**Первый раз на ПК:** **`INSTALL_RUNTIME.bat`** (ставит Python и Docker через winget, нужен интернет), затем **`START_AMINA.bat`**. Подробности: [BUILD-PC.md](BUILD-PC.md).

**Веб-интерфейс (панель на ПК):** после `docker compose up` откройте **`http://127.0.0.1:8765/`** (не https). Если не открывается: `scripts/diagnose-panel.ps1` или `scripts/start-panel-local.ps1` без Docker. `start-windows.ps1` сам открывает браузер.

Сервис для мини-приложения Telegram: принимает **аудио (base64)** и склеивает с **портретом** `assets/face.png` в **MP4**.

## Два режима

| Режим | Образ | Железо | Описание |
|--------|--------|--------|-----------|
| `ffmpeg` | `Dockerfile` | CPU | Статичное лицо + звук (быстро, без липсинка). |
| `wav2lip` | `Dockerfile.gpu` | **NVIDIA GPU** | Нейро-липсинк ([Wav2Lip](https://github.com/Rudrabha/Wav2Lip), **некоммерческая** лицензия проекта). |

**Civitai** ([civitai.com/models](https://civitai.com/models)) — источник **стиля/персонажа**: сгенерируйте или выберите квадратный портрет и сохраните как `assets/face.png`. С сайта «одной кнопкой» готовой говорящей головы не существует — нужен этот референс.

## Быстрый старт (CPU)

```bash
cd amina-avatar-local
cp env.example .env
# Задайте AMINA_AVATAR_SECRET
docker compose up -d --build
curl -s http://127.0.0.1:8765/health
```

## GPU (Wav2Lip)

Требования: **Docker Desktop** / Linux + **NVIDIA Container Toolkit**, драйвер NVIDIA.

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d --build
curl -s http://127.0.0.1:8765/health
# Ожидается: "engine":"wav2lip", "cuda":"yes"
```

**Windows (PowerShell):**

```powershell
.\start-windows.ps1 -Gpu
# С туннелем в той же консоли:
.\start-windows.ps1 -Gpu -Tunnel
```

Положите портрет (~512×512, одно лицо крупно) в **`assets/face.png`**. Иначе Wav2Lip вернёт ошибку; CPU-режим без файла рисует заглушку.

### Веса

При сборке `Dockerfile.gpu` скачиваются:

- `wav2lip_gan.pth` (зеркало на Hugging Face)
- `s3fd.pth` для детекции лица

Проверьте **лицензии** весов и датасетов под ваш сценарий.

## Туннель (мини-апп в Telegram)

Мини-приложение ходит на ваш **HTTPS** URL:

```bash
cloudflared tunnel --url http://127.0.0.1:8765
```

Скопируйте выданный `https://….trycloudflare.com` в настройки мини-аппа (**Локальный PC**) и тот же секрет, что в `.env`. Не публикуйте URL и не коммитьте `.env`.

## API

- `GET /` — веб-панель в браузере.
- `GET /api/ui-status` — JSON для панели (флаги готовности, без секрета).
- `GET /health` — без авторизации (`engine`, при wav2lip — `cuda`).
- `POST /v1/still-video` — `Authorization: Bearer <AMINA_AVATAR_SECRET>`, тело:

```json
{
  "audio_base64": "...",
  "audio_mime": "audio/mpeg"
}
```

Ответ: `{ "video_base64": "...", "video_mime": "video/mp4" }`.

## Переменные среды

См. [`env.example`](./env.example): `AMINA_AVATAR_SECRET`, `AVATAR_PORT`, `AVATAR_ENGINE`, опционально `WAV2LIP_*` для тюнинга.
