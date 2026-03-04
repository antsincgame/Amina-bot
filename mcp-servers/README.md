# MCP Серверы для Amina

MCP (Model Context Protocol) серверы для интеграции Cursor с Render, Supabase и Perplexity (поиск в интернете).

## Установка

```bash
cd mcp-servers
npm install
```

## Настройка переменных окружения

Создайте файл `.env` в корне проекта или экспортируйте переменные:

```bash
# Render
export RENDER_API_KEY="rnd_xxxxxxxxxxxxxx"

# Supabase  
export SUPABASE_URL="https://xxxxx.supabase.co"
export SUPABASE_SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR..."

# Perplexity (поиск в интернете, модель sonar — самая дешёвая)
export PERPLEXITY_API_KEY="pplx-xxxxxxxxxxxx"
```

### Где найти ключи

| Сервис | Где найти |
|--------|-----------|
| **Render** | Dashboard → Account Settings → API Keys |
| **Supabase** | Project Settings → API → service_role key |
| **Perplexity** | https://www.perplexity.ai/settings/api |

## Подключение в Cursor

### Способ 1: Через файл конфигурации (автоматически)

Файл `.cursor/mcp.json` уже создан в проекте. Cursor должен подхватить его автоматически.

### Способ 2: Через настройки Cursor

1. Откройте **Cursor Settings** (Cmd/Ctrl + ,)
2. Найдите раздел **MCP** или **Model Context Protocol**
3. Нажмите **Add Server**
4. Заполните для каждого сервера:

**Render:**
```
Name: render
Command: node
Args: /полный/путь/к/mcp-servers/render-server.js
Environment: RENDER_API_KEY=ваш_ключ
```

**Supabase:**
```
Name: supabase
Command: node
Args: /полный/путь/к/mcp-servers/supabase-server.js
Environment: 
  SUPABASE_URL=https://xxx.supabase.co
  SUPABASE_SERVICE_KEY=ваш_ключ
```

**Perplexity:**
```
Name: perplexity
Command: node
Args: /полный/путь/к/mcp-servers/perplexity-server.js
Environment: PERPLEXITY_API_KEY=pplx-ваш_ключ
```

## Проверка работы

После подключения серверов, в Cursor появятся новые инструменты. Попробуйте:

```
Покажи список сервисов на Render
```

```
Выбери последние 10 записей из таблицы analytics в Supabase
```

```
Найди в интернете: последние новости про ИИ за сегодня
```
(инструмент Perplexity)

## Доступные инструменты

### Render (8 инструментов)
- `render_list_services` — список сервисов
- `render_get_service` — детали сервиса
- `render_deploy_service` — запустить деплой
- `render_get_deploys` — история деплоев
- `render_get_env_vars` — переменные окружения
- `render_set_env_vars` — установить env vars
- `render_get_logs` — логи
- `render_restart_service` — перезапуск

### Supabase (10 инструментов)
- `supabase_select` — SELECT запрос
- `supabase_insert` — INSERT данных
- `supabase_update` — UPDATE данных
- `supabase_delete` — DELETE данных
- `supabase_list_tables` — список таблиц
- `supabase_list_users` — пользователи Auth
- `supabase_get_user` — данные пользователя
- `supabase_storage_list` — файлы Storage
- `supabase_rpc` — вызов функций
- `supabase_query` — raw SQL (ограничен)

### Perplexity (1 инструмент)
- `perplexity_search` — ответ на вопрос с поиском в интернете (модель sonar, самая дешёвая)

## Отладка

Запустите сервер вручную для проверки:

```bash
RENDER_API_KEY=xxx node render-server.js
```

Если видите `Render MCP server started` — сервер работает.

## Структура

```
mcp-servers/
├── package.json
├── README.md
├── render-server.js       # Render MCP Server
├── supabase-server.js     # Supabase MCP Server
└── perplexity-server.js  # Perplexity MCP Server (поиск в интернете)
```
