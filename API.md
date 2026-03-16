# Amina Bot API Documentation

## 🚀 Base URL

**Production:** `https://amina.vibecoding.by`

## 📡 REST API Endpoints

### 1. POST `/api/chat`

Отправить сообщение и получить ответ AI с сохранением контекста разговора.

**Request:**
```json
{
  "userId": "12345",
  "message": "Привет! Как дела?",
  "conversationId": "uuid-optional",
  "channel": "telegram"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "conversationId": "uuid",
    "response": "Привет! У меня всё отлично, спасибо!",
    "timestamp": "2026-02-04T11:20:00.000Z"
  }
}
```

**Parameters:**
- `userId` (string, required): ID пользователя
- `message` (string, required): Текст сообщения (1-10000 символов)
- `conversationId` (string, optional): UUID существующего разговора
- `channel` (string, optional): `"telegram"` | `"voice"` | `"all"` (default: `"telegram"`)

---

### 2. POST `/api/chat/completions`

OpenAI-compatible endpoint для прямого доступа к LLM без сохранения контекста.

**Request:**
```json
{
  "messages": [
    {
      "role": "system",
      "content": "Ты полезный ассистент"
    },
    {
      "role": "user",
      "content": "Напиши haiku про AI"
    }
  ],
  "model": "openrouter/free",
  "temperature": 0.7,
  "max_tokens": 2048
}
```

**Response:**
```json
{
  "id": "chatcmpl-1738670800000",
  "object": "chat.completion",
  "created": 1738670800,
  "model": "openrouter/free",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "Код и алгоритм,\nИскусственный разум растёт —\nНовая эра."
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 25,
    "completion_tokens": 15,
    "total_tokens": 40
  }
}
```

**Parameters:**
- `messages` (array, required): Массив сообщений с ролями `system`, `user`, `assistant`
- `model` (string, optional): ID модели (default: `"openrouter/free"`)
- `temperature` (number, optional): 0-2 (default: 0.7)
- `max_tokens` (number, optional): 1-16000 (default: 2048)

---

### 3. GET `/api/conversations/:conversationId`

Получить историю разговора.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "user_id": "12345",
    "channel": "telegram",
    "messages": [
      {
        "role": "user",
        "content": "Привет!",
        "timestamp": "2026-02-04T11:00:00.000Z"
      },
      {
        "role": "assistant",
        "content": "Привет! Чем могу помочь?",
        "timestamp": "2026-02-04T11:00:01.000Z"
      }
    ],
    "metadata": {
      "telegram_chat_id": 123456789,
      "language": "ru"
    },
    "created_at": "2026-02-04T11:00:00.000Z",
    "updated_at": "2026-02-04T11:00:01.000Z"
  }
}
```

---

### 4. DELETE `/api/conversations/:conversationId`

Очистить историю разговора (сбросить контекст).

**Response:**
```json
{
  "success": true,
  "message": "Conversation cleared successfully"
}
```

---

### 5. GET `/api/settings`

Получить текущие настройки AI.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "key": "openrouter_model",
      "value": "openrouter/free"
    },
    {
      "key": "custom_model_override",
      "value": ""
    },
    {
      "key": "max_tokens",
      "value": "2048"
    },
    {
      "key": "temperature",
      "value": "0.7"
    }
  ]
}
```

---

## 🔧 Health Checks

### GET `/health`

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-02-04T11:20:00.000Z",
  "version": "1.0.0"
}
```

### GET `/ready`

**Response:**
```json
{
  "status": "ready",
  "checks": {
    "database": true,
    "ai": true
  },
  "timestamp": "2026-02-04T11:20:00.000Z"
}
```

### GET `/api/status`

**Response:**
```json
{
  "checks": {
    "telegram": {
      "ready": true,
      "engine": "grammy"
    },
    "ai": {
      "ready": true,
      "engine": "OpenRouter"
    },
    "database": {
      "ready": true,
      "engine": "Appwrite"
    }
  },
  "timestamp": "2026-02-04T11:20:00.000Z"
}
```

---

## 🎯 Приоритет Выбора Модели

1. **`custom_model_override`** (настройка в БД) - **ВЫСШИЙ ПРИОРИТЕТ**
2. **`openrouter_model`** (настройка в БД)
3. **`OPENROUTER_MODEL`** (env переменная)
4. **`openrouter/free`** (fallback по умолчанию)

---

## 🔒 CORS

API поддерживает CORS для всех origins:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

---

## ⚠️ Error Handling

### Валидация (400 Bad Request)
```json
{
  "success": false,
  "error": "Invalid request",
  "details": [
    {
      "code": "too_small",
      "minimum": 1,
      "path": ["message"],
      "message": "String must contain at least 1 character(s)"
    }
  ]
}
```

### Не найдено (404 Not Found)
```json
{
  "success": false,
  "error": "Conversation not found"
}
```

### Внутренняя ошибка (500 Internal Server Error)
```json
{
  "success": false,
  "error": "Internal server error",
  "message": "Failed to connect to AI service"
}
```

---

## 📊 Rate Limiting

Текущие лимиты (Coolify (VPS)):
- **Requests per minute:** без ограничений на уровне приложения
- **Timeout:** 30 секунд на запрос
- **Max message length:** 10,000 символов
- **Max conversation messages:** 1,000 сообщений

---

## 🧪 Примеры Использования

### cURL

```bash
# Отправить сообщение
curl -X POST https://amina.vibecoding.by/api/chat \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "test-user",
    "message": "Напиши короткую историю про робота"
  }'

# OpenAI-compatible completions
curl -X POST https://amina.vibecoding.by/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "Что такое квантовые компьютеры?"}
    ]
  }'

# Получить разговор
curl https://amina.vibecoding.by/api/conversations/YOUR-UUID-HERE

# Очистить разговор
curl -X DELETE https://amina.vibecoding.by/api/conversations/YOUR-UUID-HERE
```

### JavaScript/TypeScript (fetch)

```typescript
// Отправить сообщение
const response = await fetch('https://amina.vibecoding.by/api/chat', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    userId: 'user-123',
    message: 'Привет!',
    channel: 'telegram'
  })
});

const data = await response.json();
console.log(data.data.response);
```

### Python (requests)

```python
import requests

response = requests.post(
    'https://amina.vibecoding.by/api/chat',
    json={
        'userId': 'user-123',
        'message': 'Привет!',
        'channel': 'telegram'
    }
)

data = response.json()
print(data['data']['response'])
```

---

## 📝 Логирование

Все запросы логируются с помощью `pino`:
- Request ID
- User ID
- Conversation ID
- Message length
- Response time
- AI model used
- Token usage

---

## 🚀 Деплой Статус

- **Бот (Backend API):** ✅ LIVE
- **Админка (Frontend):** ✅ LIVE
- **База данных:** ✅ Appwrite
- **AI:** ✅ OpenRouter API

---

**Документация обновлена:** 2026-02-04
