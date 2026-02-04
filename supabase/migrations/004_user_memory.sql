-- ============================================
-- Migration: User Memory System
-- Description: Персональная память и логи по каждому пользователю
-- ============================================

-- --------------------------------------------
-- 1. User Profiles - профили пользователей
-- --------------------------------------------

CREATE TABLE IF NOT EXISTS user_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT UNIQUE NOT NULL,  -- Telegram user ID
  
  -- Базовая информация
  username TEXT,
  first_name TEXT,
  last_name TEXT,
  language_code TEXT DEFAULT 'ru',
  
  -- Статистика
  total_messages INTEGER DEFAULT 0,
  total_voice_messages INTEGER DEFAULT 0,
  total_images INTEGER DEFAULT 0,
  total_tokens_used BIGINT DEFAULT 0,
  
  -- Метаданные
  first_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ DEFAULT NOW(),
  last_message_at TIMESTAMPTZ,
  
  -- Настройки пользователя
  preferences JSONB DEFAULT '{}',
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для user_profiles
CREATE INDEX IF NOT EXISTS idx_user_profiles_user_id ON user_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_profiles_last_seen ON user_profiles(last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_profiles_total_messages ON user_profiles(total_messages DESC);

-- --------------------------------------------
-- 2. User Memory - долгосрочная память о пользователе
-- --------------------------------------------

CREATE TABLE IF NOT EXISTS user_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES user_profiles(user_id) ON DELETE CASCADE,
  
  -- Тип памяти
  memory_type TEXT NOT NULL CHECK (memory_type IN (
    'fact',           -- Факт о пользователе (имя, возраст, работа)
    'preference',     -- Предпочтение (любит/не любит)
    'context',        -- Контекст (текущий проект, задача)
    'summary',        -- Краткое содержание разговора
    'important'       -- Важная информация
  )),
  
  -- Содержимое
  content TEXT NOT NULL,
  
  -- Метаданные
  source TEXT,  -- Откуда получена информация (message, inference)
  confidence REAL DEFAULT 1.0,  -- Уверенность (0-1)
  
  -- Временные метки
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,  -- NULL = не истекает
  
  -- Флаги
  is_active BOOLEAN DEFAULT true,
  is_pinned BOOLEAN DEFAULT false  -- Важная информация, всегда включать в контекст
);

-- Индексы для user_memory
CREATE INDEX IF NOT EXISTS idx_user_memory_user_id ON user_memory(user_id);
CREATE INDEX IF NOT EXISTS idx_user_memory_type ON user_memory(memory_type);
CREATE INDEX IF NOT EXISTS idx_user_memory_active ON user_memory(user_id, is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_user_memory_pinned ON user_memory(user_id, is_pinned) WHERE is_pinned = true;

-- --------------------------------------------
-- 3. User Logs - детальные логи по пользователям
-- --------------------------------------------

CREATE TABLE IF NOT EXISTS user_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  
  -- Тип события
  event_type TEXT NOT NULL CHECK (event_type IN (
    'message',        -- Текстовое сообщение
    'voice',          -- Голосовое сообщение
    'image',          -- Изображение
    'command',        -- Команда бота
    'ai_response',    -- Ответ AI
    'error',          -- Ошибка
    'memory_created', -- Создана запись памяти
    'memory_updated', -- Обновлена запись памяти
    'session_start',  -- Начало сессии
    'session_end'     -- Конец сессии
  )),
  
  -- Содержимое
  content TEXT,
  
  -- Метаданные события
  metadata JSONB DEFAULT '{}',
  
  -- AI метрики (если применимо)
  model TEXT,
  tokens_prompt INTEGER,
  tokens_completion INTEGER,
  response_time_ms INTEGER,
  
  -- Timestamps
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для user_logs
CREATE INDEX IF NOT EXISTS idx_user_logs_user_id ON user_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_user_logs_timestamp ON user_logs(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_user_logs_user_timestamp ON user_logs(user_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_user_logs_event_type ON user_logs(event_type);

-- Партиционирование по времени (для больших объёмов)
-- CREATE INDEX IF NOT EXISTS idx_user_logs_partition ON user_logs(timestamp);

-- --------------------------------------------
-- 4. Conversation Summaries - краткие итоги разговоров
-- --------------------------------------------

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  
  -- Краткое содержание
  summary TEXT NOT NULL,
  
  -- Ключевые темы
  topics TEXT[] DEFAULT '{}',
  
  -- Извлечённые факты
  extracted_facts JSONB DEFAULT '[]',
  
  -- Метаданные
  message_count INTEGER DEFAULT 0,
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индексы для conversation_summaries
CREATE INDEX IF NOT EXISTS idx_conv_summaries_user_id ON conversation_summaries(user_id);
CREATE INDEX IF NOT EXISTS idx_conv_summaries_created ON conversation_summaries(created_at DESC);

-- --------------------------------------------
-- 5. RLS Policies
-- --------------------------------------------

ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_summaries ENABLE ROW LEVEL SECURITY;

-- Service role - полный доступ
CREATE POLICY "Service role full access on user_profiles"
  ON user_profiles FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on user_memory"
  ON user_memory FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on user_logs"
  ON user_logs FOR ALL TO service_role
  USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on conversation_summaries"
  ON conversation_summaries FOR ALL TO service_role
  USING (true) WITH CHECK (true);

-- Authenticated - чтение
CREATE POLICY "Authenticated read user_profiles"
  ON user_profiles FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Authenticated read user_memory"
  ON user_memory FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Authenticated read user_logs"
  ON user_logs FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Authenticated read conversation_summaries"
  ON conversation_summaries FOR SELECT TO authenticated
  USING (true);

-- --------------------------------------------
-- 6. Functions
-- --------------------------------------------

-- Функция для обновления профиля при сообщении
CREATE OR REPLACE FUNCTION update_user_profile_on_message(
  p_user_id TEXT,
  p_username TEXT DEFAULT NULL,
  p_first_name TEXT DEFAULT NULL,
  p_last_name TEXT DEFAULT NULL,
  p_language_code TEXT DEFAULT NULL,
  p_message_type TEXT DEFAULT 'message',
  p_tokens_used INTEGER DEFAULT 0
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_profile_id UUID;
BEGIN
  -- Upsert профиля
  INSERT INTO user_profiles (
    user_id, username, first_name, last_name, language_code,
    total_messages, total_voice_messages, total_images, total_tokens_used,
    last_seen_at, last_message_at
  )
  VALUES (
    p_user_id, p_username, p_first_name, p_last_name, 
    COALESCE(p_language_code, 'ru'),
    CASE WHEN p_message_type = 'message' THEN 1 ELSE 0 END,
    CASE WHEN p_message_type = 'voice' THEN 1 ELSE 0 END,
    CASE WHEN p_message_type = 'image' THEN 1 ELSE 0 END,
    p_tokens_used,
    NOW(), NOW()
  )
  ON CONFLICT (user_id) DO UPDATE SET
    username = COALESCE(EXCLUDED.username, user_profiles.username),
    first_name = COALESCE(EXCLUDED.first_name, user_profiles.first_name),
    last_name = COALESCE(EXCLUDED.last_name, user_profiles.last_name),
    language_code = COALESCE(EXCLUDED.language_code, user_profiles.language_code),
    total_messages = user_profiles.total_messages + CASE WHEN p_message_type = 'message' THEN 1 ELSE 0 END,
    total_voice_messages = user_profiles.total_voice_messages + CASE WHEN p_message_type = 'voice' THEN 1 ELSE 0 END,
    total_images = user_profiles.total_images + CASE WHEN p_message_type = 'image' THEN 1 ELSE 0 END,
    total_tokens_used = user_profiles.total_tokens_used + p_tokens_used,
    last_seen_at = NOW(),
    last_message_at = NOW(),
    updated_at = NOW()
  RETURNING id INTO v_profile_id;
  
  RETURN v_profile_id;
END;
$$;

-- Функция для получения контекста памяти пользователя
CREATE OR REPLACE FUNCTION get_user_memory_context(
  p_user_id TEXT,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE (
  memory_type TEXT,
  content TEXT,
  is_pinned BOOLEAN,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT 
    um.memory_type,
    um.content,
    um.is_pinned,
    um.created_at
  FROM user_memory um
  WHERE um.user_id = p_user_id
    AND um.is_active = true
    AND (um.expires_at IS NULL OR um.expires_at > NOW())
  ORDER BY 
    um.is_pinned DESC,
    um.created_at DESC
  LIMIT p_limit;
END;
$$;

-- Функция для получения статистики пользователя
CREATE OR REPLACE FUNCTION get_user_stats(p_user_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'profile', row_to_json(up),
    'memory_count', (SELECT COUNT(*) FROM user_memory WHERE user_id = p_user_id AND is_active = true),
    'conversation_count', (SELECT COUNT(*) FROM conversations WHERE user_id = p_user_id),
    'recent_topics', (
      SELECT COALESCE(array_agg(DISTINCT topic), '{}')
      FROM (
        SELECT unnest(topics) as topic
        FROM conversation_summaries
        WHERE user_id = p_user_id
        ORDER BY created_at DESC
        LIMIT 10
      ) t
    )
  )
  INTO v_result
  FROM user_profiles up
  WHERE up.user_id = p_user_id;
  
  RETURN COALESCE(v_result, '{}'::jsonb);
END;
$$;

-- Функция очистки старых логов (старше 90 дней)
CREATE OR REPLACE FUNCTION cleanup_old_user_logs()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM user_logs
  WHERE timestamp < NOW() - INTERVAL '90 days';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

-- --------------------------------------------
-- 7. Triggers
-- --------------------------------------------

-- Триггер для автоматического обновления updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_user_profiles_updated_at
  BEFORE UPDATE ON user_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_memory_updated_at
  BEFORE UPDATE ON user_memory
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- --------------------------------------------
-- 8. Comments
-- --------------------------------------------

COMMENT ON TABLE user_profiles IS 'Профили пользователей бота с статистикой';
COMMENT ON TABLE user_memory IS 'Долгосрочная память о каждом пользователе';
COMMENT ON TABLE user_logs IS 'Детальные логи взаимодействий по пользователям';
COMMENT ON TABLE conversation_summaries IS 'Краткие итоги разговоров для быстрого контекста';

COMMENT ON FUNCTION update_user_profile_on_message IS 'Обновляет профиль пользователя при каждом сообщении';
COMMENT ON FUNCTION get_user_memory_context IS 'Получает контекст памяти для включения в промпт';
COMMENT ON FUNCTION get_user_stats IS 'Получает полную статистику пользователя';
COMMENT ON FUNCTION cleanup_old_user_logs IS 'Удаляет логи старше 90 дней';

-- --------------------------------------------
-- 9. Grants
-- --------------------------------------------

GRANT SELECT, INSERT, UPDATE ON user_profiles TO authenticated;
GRANT SELECT ON user_memory TO authenticated;
GRANT SELECT ON user_logs TO authenticated;
GRANT SELECT ON conversation_summaries TO authenticated;

GRANT ALL ON user_profiles TO service_role;
GRANT ALL ON user_memory TO service_role;
GRANT ALL ON user_logs TO service_role;
GRANT ALL ON conversation_summaries TO service_role;

GRANT EXECUTE ON FUNCTION update_user_profile_on_message TO service_role;
GRANT EXECUTE ON FUNCTION get_user_memory_context TO service_role;
GRANT EXECUTE ON FUNCTION get_user_stats TO service_role;
GRANT EXECUTE ON FUNCTION cleanup_old_user_logs TO service_role;
