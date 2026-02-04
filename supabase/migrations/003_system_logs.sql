-- ============================================
-- Migration: System Logs Table
-- Description: Таблица для хранения системных логов (ошибки, предупреждения)
-- ============================================

-- Создание таблицы system_logs
CREATE TABLE IF NOT EXISTS system_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error', 'fatal')),
  module TEXT NOT NULL,
  message TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  error_stack TEXT,
  user_id TEXT,
  request_id TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- Индексы для быстрого поиска
CREATE INDEX IF NOT EXISTS idx_system_logs_level ON system_logs(level);
CREATE INDEX IF NOT EXISTS idx_system_logs_module ON system_logs(module);
CREATE INDEX IF NOT EXISTS idx_system_logs_timestamp ON system_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_system_logs_user_id ON system_logs(user_id) WHERE user_id IS NOT NULL;

-- Составной индекс для фильтрации по уровню и времени
CREATE INDEX IF NOT EXISTS idx_system_logs_level_timestamp ON system_logs(level, timestamp DESC);

-- RLS политики
ALTER TABLE system_logs ENABLE ROW LEVEL SECURITY;

-- Политика для service_role (полный доступ)
CREATE POLICY "Service role can do everything on system_logs"
  ON system_logs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Политика для authenticated (только чтение)
CREATE POLICY "Authenticated users can read system_logs"
  ON system_logs
  FOR SELECT
  TO authenticated
  USING (true);

-- Функция для автоматической очистки старых логов (старше 30 дней)
CREATE OR REPLACE FUNCTION cleanup_old_logs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM system_logs
  WHERE timestamp < NOW() - INTERVAL '30 days';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- Комментарии
COMMENT ON TABLE system_logs IS 'Системные логи приложения (ошибки, предупреждения, информация)';
COMMENT ON COLUMN system_logs.level IS 'Уровень лога: debug, info, warn, error, fatal';
COMMENT ON COLUMN system_logs.module IS 'Модуль источник: telegram, ai, db, http, server';
COMMENT ON COLUMN system_logs.message IS 'Текст сообщения';
COMMENT ON COLUMN system_logs.data IS 'Дополнительные данные в формате JSON';
COMMENT ON COLUMN system_logs.error_stack IS 'Stack trace для ошибок';
COMMENT ON COLUMN system_logs.user_id IS 'ID пользователя (если применимо)';
COMMENT ON COLUMN system_logs.request_id IS 'ID запроса для трассировки';
COMMENT ON FUNCTION cleanup_old_logs() IS 'Удаляет логи старше 30 дней. Вызывать через pg_cron или вручную.';

-- Обновление analytics event_type constraint
ALTER TABLE analytics DROP CONSTRAINT IF EXISTS analytics_event_type_check;
ALTER TABLE analytics ADD CONSTRAINT analytics_event_type_check 
  CHECK (event_type IN (
    'message_sent', 
    'message_received', 
    'call_started', 
    'call_ended', 
    'ai_response', 
    'error',
    'warning',
    'settings_updated', 
    'prompt_updated',
    'rate_limit_exceeded',
    'api_request',
    'system_log'
  ));

-- Grants
GRANT SELECT, INSERT ON system_logs TO authenticated;
GRANT ALL ON system_logs TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_logs() TO service_role;
