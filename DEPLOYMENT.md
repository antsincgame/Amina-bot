# 🚀 Deployment Complete — Amina Bot

## ✅ Status: Live and Running

### 🔗 URLs

**Bot Backend:**  
https://amina-bot.onrender.com

**Admin Panel:**  
https://amina-admin.onrender.com

**Telegram Bot:**  
@AIAMINABOT (t.me/AIAMINABOT)

---

## 🆓 Бесплатные Модели OpenRouter

### По умолчанию: `openrouter/free`

Этот роутер автоматически выбирает лучшую доступную бесплатную модель.

### Список Бесплатных Моделей

1. **Free Models Router** (`openrouter/free`)
   - Автоматический выбор лучшей модели
   - Рекомендуется по умолчанию

2. **StepFun Step 3.5 Flash** (`stepfun/step-3.5-flash:free`)
   - Context: 256k tokens
   - Быстрый ответ

3. **Arcee Trinity Large** (`arcee-ai/trinity-large-preview:free`)
   - Context: 131k tokens
   - Мощная модель

4. **Upstage Solar Pro 3** (`upstage/solar-pro-3:free`)
   - Context: 128k tokens
   - Сбалансированная

5. **LiquidAI LFM2.5 Thinking** (`liquid/lfm-2.5-1.2b-thinking:free`)
   - Context: 32k tokens
   - Reasoning focused

6. **LiquidAI LFM2.5 Instruct** (`liquid/lfm-2.5-1.2b-instruct:free`)
   - Context: 32k tokens
   - Instruction following

7. **AllenAI Molmo2 8B** (`allenai/molmo-2-8b:free`)
   - Context: 36k tokens
   - Compact and fast

### Премиум Модели (Платные)

Доступны в админке для переключения:
- Claude 3 Haiku / Sonnet / Opus
- GPT-4 Turbo / GPT-4o / GPT-4o Mini
- Gemini Pro / Flash 1.5
- Mistral Large
- Llama 3 70B
- Qwen3 Coder Next

---

## 📋 Проверка Статуса

### Bot API
```bash
curl https://amina-bot.onrender.com/api/status
```

Ответ:
```json
{
  "checks": {
    "telegram": {"ready": true, "engine": "grammy"},
    "ai": {"ready": true, "engine": "OpenRouter"},
    "database": {"ready": true, "engine": "Supabase"}
  },
  "timestamp": "2026-02-04T10:51:51.566Z"
}
```

---

## 🎛️ Настройка в Админке

1. Открой https://amina-admin.onrender.com
2. Войди с логином: `admin@amina.bot`
3. Пароль: (тот что создал в Supabase)
4. Перейди в раздел "Настройки"
5. Выбери модель из списка:
   - 🆓 Бесплатные модели (сверху)
   - 💎 Премиум модели (снизу)

---

## 🔄 Auto-Deploy

Оба сервиса настроены на автоматический деплой при push в `main`:

- ✅ Bot: автоматически деплоится
- ✅ Admin: автоматически деплоится

---

## 🔒 Безопасность

- ✅ HTTPS на всех сервисах
- ✅ Секреты в Render Environment Variables
- ✅ Rate limiting (TODO)
- ✅ Error boundaries
- ✅ SQL injection protection
- ✅ Input validation

---

## 📊 Мониторинг

### Health Check
```bash
curl https://amina-bot.onrender.com/health
```

### Stats API
```bash
curl https://amina-bot.onrender.com/api/stats
```

---

## 🛠️ Supabase Миграция

**Важно!** Примени миграцию для атомарности:

1. Открой Supabase Dashboard
2. Перейди в SQL Editor
3. Запусти:

```sql
-- Из файла: supabase/migrations/002_atomic_message_append.sql
CREATE OR REPLACE FUNCTION append_conversation_message(
  conversation_id UUID,
  new_message JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE conversations
  SET 
    messages = messages || new_message,
    updated_at = NOW()
  WHERE id = conversation_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found: %', conversation_id;
  END IF;
END;
$$;
```

---

## 🎉 Готово к Использованию!

Бот Amina теперь:
- ✅ Деплоен на Render
- ✅ Использует бесплатные модели по умолчанию
- ✅ Имеет админ-панель для управления
- ✅ Сохраняет диалоги в Supabase
- ✅ Полностью безопасен

**Telegram:** @AIAMINABOT  
**Admin:** https://amina-admin.onrender.com

---

*Последнее обновление: 2026-02-04*
