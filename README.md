# Amina Bot - Simple Telegram AI Bot

**Простой чат-бот с AI (OpenRouter) для Telegram**

## 🚀 Функции (v1.0 - Минимальная версия)

- ✅ Текстовый чат с AI через OpenRouter
- ✅ Поддержка контекста диалога (до 20 сообщений)
- ✅ Health check API для мониторинга
- ✅ Graceful shutdown

## 🛠️ Технологии

- **Bot**: grammy (Telegram Bot Framework)
- **AI**: OpenRouter API (любые модели)
- **Server**: Fastify
- **Language**: TypeScript
- **Runtime**: Node.js 20+
- **Deployment**: Render

## 📦 Установка

```bash
# 1. Клонировать репозиторий
git clone https://github.com/antsincgame/Amina-bot.git
cd Amina-bot/bot

# 2. Установить зависимости
npm install

# 3. Настроить .env
cp .env.example .env
# Добавить TELEGRAM_BOT_TOKEN и OPENROUTER_API_KEY

# 4. Запустить
npm run dev
```

## 🔧 Конфигурация

Переменные окружения:

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL=anthropic/claude-3-haiku
PORT=3000
HOST=0.0.0.0
NODE_ENV=production
LOG_LEVEL=info
```

## 🎯 API Endpoints

- `GET /health` - Health check
- `GET /api/status` - Service status (bot, OpenRouter)

## 📝 Команды бота

- `/start` - Начать диалог
- `/help` - Показать справку
- `/clear` - Очистить историю диалога

## 🚀 Деплой на Render

```bash
# 1. Push в GitHub
git add .
git commit -m "Deploy simple bot"
git push origin main

# 2. Создать Web Service на Render из GitHub
# 3. Добавить Environment Variables:
#    - TELEGRAM_BOT_TOKEN
#    - OPENROUTER_API_KEY
```

## 📊 Архитектура

```
bot/
├── src/
│   ├── index-simple.ts          # Main entry (без БД)
│   ├── config/
│   │   ├── index-simple.ts      # Configuration
│   │   └── logger-simple.ts     # Logging
│   ├── ai/
│   │   └── openrouter-simple.ts # AI client (только OpenRouter)
│   └── telegram/
│       └── bot-simple.ts        # Bot handlers (только текст)
├── package.json
└── .env.example
```

## 📈 Roadmap

- [ ] Admin Panel (React + Render Static Site)
- [ ] Supabase Database (history, analytics)
- [ ] Voice messages support
- [ ] Multi-language support

## 📄 License

MIT

## 🤝 Contributing

PRs welcome!
