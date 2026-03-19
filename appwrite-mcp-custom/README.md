# Appwrite MCP Admin

Кастомный MCP-сервер для Appwrite с Console-уровневым доступом + брендированная страница входа.

## MCP Server

Полный доступ к Appwrite через Cursor: создание проектов, баз данных, коллекций, пользователей, API ключей и т.д.

### Cursor Config (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "appwrite-admin": {
      "command": "node",
      "args": ["/path/to/appwrite-mcp-custom/src/index.js"],
      "env": {
        "APPWRITE_ENDPOINT": "https://appwrite.vibecoding.by/v1",
        "APPWRITE_EMAIL": "your-admin@email.com",
        "APPWRITE_PASSWORD": "your-password"
      }
    }
  }
}
```

### Возможности

- **Проекты**: создание, удаление, управление
- **API Keys**: создание ключей с нужными scopes
- **Platforms**: добавление web/mobile платформ
- **Базы данных**: CRUD баз, коллекций, атрибутов, индексов
- **Документы**: CRUD документов
- **Пользователи**: создание, удаление, поиск
- **Storage**: бакеты, файлы

## Login Page

Кастомная страница входа с VibeCoding-брендингом. Деплоится как отдельный сервис в Coolify.

### Деплой в Coolify

1. Добавить как Docker-приложение из этого репо
2. Base Directory: `login-page`
3. Env: `APPWRITE_ENDPOINT=https://appwrite.vibecoding.by/v1`
4. Домен: `https://console.vibecoding.by`
