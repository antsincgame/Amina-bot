# 🔧 Применение SQL Миграции — Пошаговая Инструкция

## Вариант 1: Через Supabase Dashboard (Рекомендуется)

### Шаг 1: Открой SQL Editor

1. Перейди на https://supabase.com/dashboard
2. Выбери проект **Amina** (azdvlsznlvktxvmfswhq)
3. В боковом меню нажми **SQL Editor**
4. Нажми **New query**

### Шаг 2: Вставь SQL код

Скопируй и вставь следующий SQL:

```sql
-- Migration: Add atomic message append function
-- This function safely appends a message to a conversation's messages array
-- Prevents race conditions when multiple messages arrive simultaneously

CREATE OR REPLACE FUNCTION append_conversation_message(
  conversation_id UUID,
  new_message JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Update the conversation with the new message appended
  UPDATE conversations
  SET 
    messages = messages || new_message,
    updated_at = NOW()
  WHERE id = conversation_id;

  -- Check if conversation exists
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Conversation not found: %', conversation_id;
  END IF;
END;
$$;

-- Grant execute permission to authenticated users
GRANT EXECUTE ON FUNCTION append_conversation_message(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION append_conversation_message(UUID, JSONB) TO service_role;

-- Add comment
COMMENT ON FUNCTION append_conversation_message(UUID, JSONB) IS 
'Atomically appends a message to conversation messages array. Prevents race conditions.';
```

### Шаг 3: Запусти миграцию

1. Нажми кнопку **Run** (или Ctrl+Enter)
2. Дождись сообщения **Success. No rows returned**
3. ✅ Готово!

---

## Вариант 2: Через psql (Если есть доступ)

```bash
psql "postgresql://postgres:[YOUR-PASSWORD]@db.azdvlsznlvktxvmfswhq.supabase.co:5432/postgres" \
  -f supabase/migrations/002_atomic_message_append.sql
```

---

## Проверка Применения

После выполнения миграции проверь что функция создана:

```sql
SELECT 
  routine_name,
  routine_type,
  data_type
FROM information_schema.routines 
WHERE routine_name = 'append_conversation_message';
```

Должна вернуться строка:
```
routine_name              | routine_type | data_type
append_conversation_message | FUNCTION     | void
```

---

## Что Даёт Эта Миграция?

### До миграции ❌
```typescript
// Race condition: два сообщения могут затереть друг друга
const messages = [...currentMessages, newMessage]; // read
await update({ messages }); // write
```

### После миграции ✅
```typescript
// Атомарная операция на уровне PostgreSQL
await supabase.rpc('append_conversation_message', {
  conversation_id: conversationId,
  new_message: message
});
```

### Преимущества:
- ✅ Нет race condition
- ✅ Атомарность гарантирована PostgreSQL
- ✅ Быстрее (одна операция вместо двух)
- ✅ Автоматическое обновление `updated_at`

---

## Использование в Боте

Бот уже настроен использовать эту функцию:

```typescript
// bot/src/db/supabase.ts:253-267
async addMessage(conversationId: string, message: Message): Promise<void> {
  // Использует RPC если доступна
  const { error } = await getSupabase().rpc('append_conversation_message', {
    conversation_id: conversationId,
    new_message: message as unknown as Record<string, unknown>,
  });

  if (error) {
    // Fallback с retry если RPC недоступна
    return await this.addMessageFallback(conversationId, message);
  }
}
```

---

## Troubleshooting

### Ошибка: "function ... already exists"
Это нормально! `CREATE OR REPLACE` обновит существующую функцию.

### Ошибка: "permission denied"
Убедись что выполняешь SQL от имени `postgres` пользователя в Dashboard.

### Ошибка: "table conversations does not exist"
Сначала примени первую миграцию:
```bash
supabase/migrations/001_initial_schema.sql
```

---

**После применения миграции бот будет работать без race conditions!** ✅
