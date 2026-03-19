# Amina Bot

Telegram AI-бот с поддержкой OpenRouter и Appwrite.

## Возможности

- Чат с AI через OpenRouter (любые модели)
- Сохранение истории диалогов в Appwrite
- Память о пользователях (профили, факты, предпочтения)
- Дайджест новостей (гибридный пайплайн)
- Голосовые сообщения (транскрипция + хранение)
- Напоминания, заметки, задачи
- LM Studio через Cloudflare Tunnel (локальные модели)
- IP-телефония через LiraX
- Аналитика использования
- Админ-панель для настройки

## Архитектура

```
Telegram (@AIAMINABOT)
       │
       v
Bot Backend (Coolify / VPS)
  Node.js + TypeScript
  - grammy (Telegram Bot)
  - OpenRouter API (AI)
  - Appwrite (Database + Storage)
  - Fastify (HTTP Server)
       │
       v
Appwrite (appwrite.vibecoding.by)
  - Database: amina
  - Storage: voice-messages, tel-recordings
```

## Деплой

Автоматический: push в `main` → Coolify GitHub App → Docker build → deploy.

```bash
# Или через скрипт (tsc check + push + verify)
./deploy.sh
```

После деплоя проверить webhook:
```bash
curl -s "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
```

## LM Studio Tunnel

Для подключения локальной модели через Cloudflare Tunnel:

**Windows:**
```powershell
# Создайте .env рядом с tunnel.ps1:
# BOT_API_URL=https://amina.vibecoding.by
# LMSTUDIO_TUNNEL_TOKEN=<token>
.\tunnel.ps1
```

**Linux:**
```bash
export BOT_API_URL=https://amina.vibecoding.by
export LMSTUDIO_TUNNEL_TOKEN=<token>
./tunnel.sh
```

## Telegram мини-приложение «Амина»

В чате с ботом доступны кнопка **✨ Амина** (клавиатура и быстрое меню) и пункт **«Амина»** в **меню чата** (квадрат с четырьмя точками / скрепкой — зависит от клиента). Открывается простая веб-страница с подсказками.

**Нужно в проде:** переменная **`BOT_URL`** (или **`WEBHOOK_URL`**) = тот же **https**-хост, куда ходит вебхук (например `https://amina.vibecoding.by`). В **[@BotFather](https://t.me/BotFather)** для бота выполните **`/setdomain`** и укажите **только домен без пути** (например `amina.vibecoding.by`). Страница отдаётся с `/mini-app/index.html` (шаблон в репозитории: `bot/src/telegram/mini-app-web.html`).

**Диалог и озвучка из мини-аппа:** `POST /api/mini-app/message` с телом `{ "initData", "message", "withAudio": true }` — на сервере проверяется подпись Telegram Web App (`initData`), ответ включает текст и при необходимости MP3 (base64). Нужен настроенный **токен бота** (как для grammy).

**Видео с вашего ПК:** каталог **[amina-avatar-local/](amina-avatar-local/README.md)** — **двойной клик `amina-avatar-local/START_AMINA.bat`** или корневой **`START_AMINA.bat`**. Дальше: [BUILD-PC.md](amina-avatar-local/BUILD-PC.md). URL туннеля и секрет — в мини-аппе (localStorage), не коммитятся.

## InvokeAI (локальная генерация на вашем GPU)

Docker Compose и инструкции — каталог **[invoke-ai/](invoke-ai/README.md)**:

- проверка хоста: `invoke-ai/scripts/check-gpu-host.sh`;
- доступ с Windows без «открытого» порта: `invoke-ai/scripts/tunnel-invoke-from-windows.ps1`.

## Разработка

```bash
cd bot && npm install && npm run dev
cd admin && npm install && npm run dev
```

## Технологии

- **Runtime**: Node.js 20+, TypeScript
- **Bot**: grammy
- **HTTP**: Fastify
- **Database**: Appwrite (node-appwrite SDK)
- **AI**: OpenRouter, Groq, Perplexity, LM Studio
- **Admin**: React, Vite, Tailwind CSS
- **Deploy**: Coolify (Docker), GitHub auto-deploy
