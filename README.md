# Amina Bot

Telegram AI-бот с поддержкой OpenRouter и Supabase.

## 🚀 Возможности

- 💬 Чат с AI через OpenRouter (любые модели)
- 📊 Сохранение истории диалогов в Supabase
- 📈 Аналитика использования
- ⚙️ Админ-панель для настройки
- 🔄 Контекст диалога (до 20 сообщений)

## 🏗️ Архитектура

```
┌─────────────────────────────────────────────────────┐
│                    Telegram                          │
│                   @AIAMINABOT                        │
└──────────────────────┬──────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────┐
│              Bot Backend (Render)                    │
│              Node.js + tsx                           │
│  - grammy (Telegram Bot)                            │
│  - OpenRouter API (AI)                              │
│  - Supabase (Database)                              │
│  - Fastify (HTTP Server)                            │
└──────────────────────┬──────────────────────────────┘
                       │
                       v
┌─────────────────────────────────────────────────────┐
│             Supabase Database                        │
│  - settings (настройки)                             │
│  - prompts (системные промпты)                      │
│  - conversations (диалоги)                          │
│  - analytics (аналитика)                            │
└─────────────────────────────────────────────────────┘
                       ^
                       │
┌──────────────────────┴──────────────────────────────┐
│            Admin Panel (Render Static)               │
│            React + Vite + Tailwind                   │
│  - Dashboard                                        │
│  - Settings                                         │
│  - Prompts                                          │
│  - Analytics                                        │
└─────────────────────────────────────────────────────┘
```

## 📦 Структура проекта

```
amina-bot/
├── bot/                    # Telegram бот (Node.js)
│   ├── src/
│   │   ├── index.ts       # Точка входа
│   │   ├── config/        # Конфигурация
│   │   ├── telegram/      # Telegram handlers
│   │   ├── ai/            # OpenRouter интеграция
│   │   └── db/            # Supabase репозитории
│   └── package.json
├── admin/                  # Админ-панель (React)
│   ├── src/
│   │   ├── pages/         # Страницы
│   │   ├── components/    # Компоненты
│   │   ├── hooks/         # React hooks
│   │   └── api/           # Supabase клиент
│   └── package.json
├── shared/                 # Общие типы TypeScript
│   └── types/index.ts
├── supabase/              # Миграции БД
│   └── migrations/
├── render.yaml            # Render Blueprint
└── README.md
```

## 🛠️ Технологии

**Backend:**
- Node.js 20+
- TypeScript
- grammy (Telegram Bot Framework)
- Fastify (HTTP Server)
- OpenRouter API (AI)
- Supabase (PostgreSQL)
- pino (Logging)

**Frontend:**
- React 18
- Vite
- Tailwind CSS
- React Query
- Zustand
- React Hook Form + Zod

**Deployment:**
- Render (Bot + Admin)
- Supabase (Database)

## 🚀 Быстрый старт

### 1. Клонирование

```bash
git clone https://github.com/antsincgame/Amina-bot.git
cd Amina-bot
```

### 2. Настройка бота

```bash
cd bot
cp .env.example .env
# Заполните переменные в .env
npm install
npm run dev
```

### 3. Настройка админки

```bash
cd admin
cp .env.example .env
# Заполните переменные в .env
npm install
npm run dev
```

## 🔧 Переменные окружения

### Bot (.env)

```env
TELEGRAM_BOT_TOKEN=your_token
OPENROUTER_API_KEY=your_key
OPENROUTER_MODEL=anthropic/claude-3-haiku
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=your_service_key
PORT=3000
NODE_ENV=development
```

### Admin (.env)

```env
VITE_SUPABASE_URL=https://xxx.supabase.co
VITE_SUPABASE_ANON_KEY=your_anon_key
```

## 📡 API Endpoints

| Endpoint | Описание |
|----------|----------|
| `GET /health` | Health check |
| `GET /ready` | Readiness check (DB + AI) |
| `GET /api/status` | Статус сервисов |
| `GET /api/stats` | Статистика за 7 дней |

## 🤖 Команды бота

| Команда | Описание |
|---------|----------|
| `/start` | Начать диалог |
| `/help` | Справка |
| `/clear` | Очистить историю |

## 🚀 Деплой

### Render Blueprint

1. Форкните репозиторий
2. Создайте Blueprint на Render
3. Подключите репозиторий
4. Добавьте секреты:
   - `TELEGRAM_BOT_TOKEN`
   - `OPENROUTER_API_KEY`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_KEY`

### URLs

- **Bot:** https://amina-bot.onrender.com
- **Admin:** https://amina-admin.onrender.com
- **Telegram:** https://t.me/AIAMINABOT

## 📄 Лицензия

MIT

## 👤 Автор

Created with ❤️
