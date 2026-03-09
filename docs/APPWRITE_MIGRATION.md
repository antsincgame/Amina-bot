# Миграция Supabase → AppWrite

## Текущая архитектура (Supabase)

### Таблицы (14 штук)

| Таблица | Суть | AppWrite эквивалент |
|---------|------|---------------------|
| `settings` | KV-хранилище настроек | Collection `settings` |
| `prompts` | Системные промпты | Collection `prompts` |
| `conversations` | Диалоги (messages[] в JSON) | Collection `conversations` |
| `analytics` | События аналитики | Collection `analytics` |
| `admin_users` | Администраторы | AppWrite Auth + Teams |
| `system_logs` | Системные логи | Collection `system_logs` |
| `user_profiles` | Профили пользователей | Collection `user_profiles` |
| `user_memory` | Память AI о пользователях | Collection `user_memory` |
| `user_logs` | Логи действий пользователей | Collection `user_logs` |
| `reminders` | Напоминания | Collection `reminders` |
| `notes` | Заметки пользователей | Collection `notes` |
| `todos` | Задачи пользователей | Collection `todos` |
| `user_preferences` | Настройки пользователей | Collection `user_preferences` |
| `voice_messages` | Голосовые сообщения | Collection + Storage bucket |

### RPC-функции PostgreSQL

| Функция | Замена в AppWrite |
|---------|-------------------|
| `append_conversation_message` | Server-side logic (Node.js) |
| `update_user_profile_on_message` | Server-side logic (Node.js) |
| `get_user_stats` | AppWrite Functions или query |
| `set_user_preference` | Direct document update |

### Хранилище

| Bucket | AppWrite |
|--------|----------|
| `voice-messages` | Storage bucket `voice-messages` |

---

## Подготовленные интерфейсы

Файл `shared/types/repositories.ts` содержит абстракции:

- `ISettingsRepo` — get/set/getAll/getMany
- `IPromptsRepo` — CRUD + setActive
- `IConversationsRepo` — getOrCreate/addMessage/getMessages
- `IAnalyticsRepo` — log/getStats
- `IRemindersRepo` — CRUD + getDue
- `INotesRepo` — CRUD
- `ITodosRepo` — CRUD + markDone
- `ISystemLogsRepo` — queue/flush/getLogs/getStats
- `IUserPrefsRepo` — getOrCreate/update
- `IStorageRepo` — upload/download/getSignedUrl/delete
- `IDatabaseProvider` — фабрика (settings, prompts, conversations, analytics, ping)

---

## План миграции (5 фаз)

### Фаза 1: Рефакторинг под интерфейсы (без смены БД)

1. `bot/src/db/supabase.ts` — реализовать `ISettingsRepo`, `IPromptsRepo`, `IConversationsRepo`, `IAnalyticsRepo`
2. Все `*-repo.ts` — реализовать соответствующие интерфейсы
3. `bot/src/memory/user-memory.ts` — выделить репозиторий из сервиса
4. `bot/src/config/db-logger.ts` — реализовать `ISystemLogsRepo`
5. Убрать прямые вызовы `getSupabase()` из бизнес-логики

**Результат:** код работает идентично, но через интерфейсы.

### Фаза 2: Создать AppWrite реализацию

1. Установить `node-appwrite`
2. Создать `bot/src/db/appwrite.ts` — реализация всех интерфейсов через AppWrite SDK
3. Создать AppWrite Database через Console/CLI:
   - 1 Database: `amina`
   - 14 Collections (по одной на таблицу)
   - Attributes и indexes по схеме миграций
4. Настроить AppWrite Auth (вместо `admin_users`)
5. Создать Storage bucket `voice-messages`

### Фаза 3: Абстракция провайдера

```typescript
// bot/src/db/provider.ts
import type { IDatabaseProvider } from '../../shared/types/repositories.js';

let provider: IDatabaseProvider;

export function setDatabaseProvider(p: IDatabaseProvider): void {
  provider = p;
}

export function getDB(): IDatabaseProvider {
  if (!provider) throw new Error('Database provider not initialized');
  return provider;
}
```

### Фаза 4: Переключение

```typescript
// bot/src/index.ts
import { createSupabaseProvider } from './db/supabase.js';
import { createAppWriteProvider } from './db/appwrite.js';

const dbBackend = process.env.DB_BACKEND || 'supabase';

if (dbBackend === 'appwrite') {
  setDatabaseProvider(createAppWriteProvider());
} else {
  setDatabaseProvider(createSupabaseProvider());
}
```

### Фаза 5: Миграция данных

1. Скрипт `scripts/migrate-supabase-to-appwrite.ts`
2. Перенос: settings → settings collection
3. Перенос: conversations → documents
4. Перенос: user data (profiles, memory, logs)
5. Перенос: voice messages (Storage)
6. Переключение `DB_BACKEND=appwrite`

---

## Ключевые различия Supabase vs AppWrite

| Аспект | Supabase | AppWrite |
|--------|----------|----------|
| **Запросы** | PostgREST (SQL-like) | Document queries (NoSQL-like) |
| **RPC** | PostgreSQL functions | AppWrite Functions (Deno/Node) |
| **Auth** | Supabase Auth (JWT) | AppWrite Auth (sessions/JWT) |
| **RLS** | Row Level Security (SQL) | Permissions (document-level) |
| **Realtime** | PostgreSQL LISTEN/NOTIFY | AppWrite Realtime (WebSocket) |
| **Storage** | S3-compatible | AppWrite Storage |
| **JSON columns** | Native JSONB | String attribute (JSON stringify) |
| **Array columns** | Native arrays | String attribute (JSON stringify) |
| **Upsert** | `.upsert({ onConflict })` | Check exists → create/update |
| **Batch insert** | `.insert([...])` | Loop + createDocument |

## Риски

1. **conversations.messages** — в Supabase это JSONB массив, в AppWrite нужно хранить как строку или отдельные документы
2. **Атомарность** — Supabase RPC `append_conversation_message` атомарна, в AppWrite нужен lock или отдельная коллекция messages
3. **Поиск** — Supabase поддерживает `.ilike()`, `.textSearch()`, AppWrite имеет fulltext search но с ограничениями
4. **Aggregate queries** — `getStats` в analytics использует агрегацию на клиенте, в AppWrite аналогично
5. **Admin Auth** — нужно мигрировать с Supabase Auth на AppWrite Auth

---

## Оценка трудозатрат

| Фаза | Время | Сложность |
|------|-------|-----------|
| Фаза 1: Рефакторинг | 2-3 дня | Средняя |
| Фаза 2: AppWrite impl | 3-5 дней | Высокая |
| Фаза 3: Провайдер | 0.5 дня | Низкая |
| Фаза 4: Переключение | 0.5 дня | Низкая |
| Фаза 5: Миграция данных | 1-2 дня | Средняя |
| **Итого** | **7-11 дней** | |

---

## Порядок действий (рекомендация)

1. **Сейчас:** Интерфейсы уже созданы (`shared/types/repositories.ts`)
2. **Далее:** Рефакторинг Supabase реализации под интерфейсы (Фаза 1)
3. **Потом:** Параллельно: AppWrite реализация + тесты
4. **Финал:** Постепенное переключение с feature flags
