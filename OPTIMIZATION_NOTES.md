# Узкие места и рекомендации по оптимизации

По результатам анализа логов и кода (04.02.2026).

## Исправленные проблемы

### 1. Fallback при Groq без ключа
**Проблема:** При выбранной модели `groq/whisper-large-v3` и отсутствии `GROQ_API_KEY` бот падал с 400: "groq/whisper-large-v3 is not a valid model ID" — в OpenRouter передавался ID модели Groq.

**Решение:** При fallback на OpenRouter используется `OPENROUTER_FALLBACK_AUDIO_MODEL` (`openai/gpt-audio-mini`), а не `groq/whisper-large-v3`.

### 2. Модуль логов "unknown"
**Проблема:** В админке все логи отображались с `module: "unknown"`.

**Решение:** В хуке pino передаётся `module` из bindings логгера (`this.bindings()`). В `index.ts` для старта приложения используется `appLogger` (module: 'app'), для сервера — `serverLogger` (module: 'server').

### 3. Уровень логов при старте
**Проблема:** Информационные сообщения при старте могли уходить в БД как warn из-за отсутствия модуля.

**Решение:** Использование `appLogger` и `serverLogger` даёт корректный модуль; уровень по-прежнему задаётся вызовом (info/warn/error).

---

## Узкие места (рекомендации)

### 1. getLogStats — загрузка всех строк
**Файл:** `bot/src/config/db-logger.ts`

**Сейчас:** Выбираются все записи за период (`select('level', 'module')`) и агрегация делается в JS.

**Риск:** При большом объёме логов (тысячи записей за 30 дней) — лишняя нагрузка на сеть и память.

**Рекомендация:** Добавить `.limit(10000)` или перенести агрегацию в БД (RPC или raw SQL с `GROUP BY level, module`).

### 2. getLogs — лимит на стороне API
**Файл:** `bot/src/api/routes.ts` (вызов getLogs с limit).

**Сейчас:** Лимит 200 записей по умолчанию — ок.

**Рекомендация:** Оставить как есть; при необходимости увеличить лимит или добавить пагинацию (offset/limit в API).

### 3. Очередь логов (db-logger)
**Файл:** `bot/src/config/db-logger.ts`

**Сейчас:** Flush раз в 5 с или при 100 записях. При падении процесса возможна потеря последних логов.

**Рекомендация:** На критичных путях (fatal) уже вызывается `flushLogs()` сразу. Для важных error можно добавить опциональный немедленный flush (флаг в queueLog).

### 4. getMultimodalConfig / getAIConfig
**Файл:** `bot/src/ai/multimodal.ts`, `bot/src/ai/openrouter.ts`

**Сейчас:** При каждом запросе (фото, голос, текст) идёт обращение к БД за настройками.

**Рекомендация:** Для высокой нагрузки — кэш на 1–5 минут (in-memory с TTL), с инвалидацией при изменении настроек в админке. Сейчас объём запросов не требует обязательной оптимизации.

### 5. Memory / user_logs
**Файл:** `bot/src/memory/user-memory.ts`

**Сейчас:** При каждом сообщении — обновление профиля, добавление в user_logs, построение контекста памяти.

**Рекомендация:** При росте числа пользователей стоит ограничить длину истории в `getUserMemoryContext` и добавить индексы по `user_id` и `created_at` (проверить миграции).

---

## Автотесты

Добавлены/проверены:

- **bot/src/config/db-logger.test.ts** — createLogFromPino (module, level, error_stack), queueLog не падает.
- **bot/src/ai/multimodal.test.ts** — константы OPENROUTER_FALLBACK_AUDIO_MODEL, VISION_MODELS, AUDIO_MODELS.

Запуск: `cd bot && npm run test`.

---

## Безопасность и стиль

- Секреты не логируются (redact в pino: apiKey, token, secret).
- Ошибки логируются с контекстом (module, userId где применимо).
- Архитектура (разделение bot / api / ai / db / config) сохранена, изменения точечные.
