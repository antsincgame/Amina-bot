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
