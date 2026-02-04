# Amina AI Bot

Telegram бот с AI ассистентом и голосовой телефонией.

## Архитектура

```
┌─────────────────┐     ┌─────────────────┐
│   Telegram      │     │   Voximplant    │
│   Bot API       │     │   Voice/WebRTC  │
└────────┬────────┘     └────────┬────────┘
         │                       │
         ▼                       ▼
┌─────────────────────────────────────────┐
│           Bot Backend (Render)          │
│  - Node.js + TypeScript                 │
│  - grammy (Telegram)                    │
│  - OpenRouter API (AI)                  │
│  - Vosk STT + Silero TTS (self-hosted)  │
└────────────────────┬────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────┐
│              Supabase                   │
│  - PostgreSQL                           │
│  - Auth                                 │
│  - Realtime                             │
└────────────────────┬────────────────────┘
                     │
                     ▲
┌────────────────────┴────────────────────┐
│         Admin Panel (Render)            │
│  - React + TypeScript + Vite            │
│  - Tailwind CSS                         │
│  - Supabase Auth                        │
└─────────────────────────────────────────┘
```

## Технологии

| Компонент | Технология |
|-----------|------------|
| Bot runtime | Node.js 20 + TypeScript |
| Telegram | grammy |
| HTTP сервер | Fastify |
| Admin frontend | React 18 + Vite |
| UI | Tailwind CSS |
| Forms | React Hook Form + Zod |
| State | React Query + Zustand |
| Auth | Supabase Auth |
| Database | Supabase (PostgreSQL) |
| AI | OpenRouter API |
| STT | Vosk (self-hosted) |
| TTS | Silero (self-hosted) |
| Telephony | Voximplant (работает в Беларуси) |

## Быстрый старт

### 1. Подготовка аккаунтов

1. **Telegram Bot** - создать бота через [@BotFather](https://t.me/botfather)
2. **OpenRouter** - получить API ключ на [openrouter.ai](https://openrouter.ai)
3. **Supabase** - создать проект на [supabase.com](https://supabase.com)
4. **Voximplant** (для звонков) - [voximplant.com](https://voximplant.com)
5. **Render** - [render.com](https://render.com) для хостинга

### 2. Настройка базы данных

Выполнить SQL миграцию в Supabase SQL Editor:

```bash
# Скопировать содержимое файла
cat supabase/migrations/001_initial_schema.sql
```

### 3. Запуск бота (локально)

```bash
cd bot
npm install

# Скопировать и заполнить .env
cp .env.example .env

# Запустить в dev режиме
npm run dev
```

### 4. Запуск админки (локально)

```bash
cd admin
npm install

# Скопировать и заполнить .env
cp .env.example .env

# Запустить
npm run dev
```

Админка будет доступна на http://localhost:3001

## Деплой на Render (всё в одном месте)

### Вариант 1: Blueprint (рекомендуется)

1. Перейти на [render.com/new](https://render.com/new)
2. Выбрать **Blueprint**
3. Подключить GitHub репозиторий
4. Render автоматически создаст оба сервиса из `render.yaml`
5. Добавить Environment Variables в Dashboard

### Вариант 2: Вручную

**Bot (Web Service):**
- Runtime: Node
- Root Directory: `bot`
- Build: `npm ci && npm run build`
- Start: `npm start`

**Admin (Static Site):**
- Root Directory: `admin`
- Build: `npm ci && npm run build`
- Publish: `dist`

### Environment Variables

**Bot:**
- `TELEGRAM_BOT_TOKEN`
- `OPENROUTER_API_KEY`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `VOXIMPLANT_ACCOUNT_ID` (опционально)
- `VOXIMPLANT_API_KEY` (опционально)
- `WEBHOOK_URL` = URL бота на Render

**Admin:**
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

## Голосовые модели

### Vosk STT

Скачать модель:
```bash
cd bot/models
wget https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip
unzip vosk-model-small-ru-0.22.zip
```

### Silero TTS

Модель загружается автоматически при первом использовании через PyTorch.

Требуется Python 3.8+ с установленными пакетами:
```bash
pip install torch torchaudio
```

## Структура проекта

```
Amina/
├── bot/                    # Backend на Render
│   ├── src/
│   │   ├── telegram/       # Telegram обработчики
│   │   ├── voice/          # Голосовой модуль
│   │   │   ├── stt/        # Vosk STT
│   │   │   ├── tts/        # Silero TTS
│   │   │   └── audio/      # Конвертеры
│   │   ├── ai/             # OpenRouter
│   │   ├── db/             # Supabase
│   │   └── config/         # Конфигурация
│   └── package.json
│
├── admin/                  # Админка на Render (Static Site)
│   ├── src/
│   │   ├── pages/          # Страницы
│   │   ├── components/     # Компоненты
│   │   ├── hooks/          # React хуки
│   │   └── api/            # API клиент
│   └── package.json
│
├── shared/                 # Общие типы
│   └── types/
│
└── supabase/
    └── migrations/         # SQL миграции
```

## API Endpoints (Bot)

| Endpoint | Метод | Описание |
|----------|-------|----------|
| `/health` | GET | Health check |
| `/ready` | GET | Readiness check |
| `/webhook/telegram` | POST | Telegram webhook |
| `/webhook/voximplant` | POST | Voximplant webhook |
| `/api/stats` | GET | Статистика (7 дней) |
| `/api/status` | GET | Статус сервисов |

## Тестирование

```bash
cd bot
npm test              # Запустить тесты
npm run test:coverage # С покрытием
```

## Лицензия

MIT
