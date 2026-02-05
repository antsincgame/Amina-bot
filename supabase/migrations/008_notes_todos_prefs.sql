-- ============================================
-- Migration 008: Notes, Todos, User Preferences
-- Заметки, задачи и настройки пользователей
-- ============================================

-- ====== ЗАМЕТКИ ======
CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_notes_user ON notes(user_id);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to notes"
  ON notes FOR ALL USING (true) WITH CHECK (true);

-- ====== TO-DO ======
CREATE TABLE IF NOT EXISTS todos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  task TEXT NOT NULL,
  is_done BOOLEAN DEFAULT false,
  done_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_todos_user ON todos(user_id, is_done);

ALTER TABLE todos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to todos"
  ON todos FOR ALL USING (true) WITH CHECK (true);

-- ====== USER PREFERENCES (для дайджеста) ======
CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT UNIQUE NOT NULL,
  chat_id BIGINT NOT NULL,
  digest_enabled BOOLEAN DEFAULT false,
  digest_hour INTEGER DEFAULT 8,           -- Час отправки (0-23, Moscow time)
  digest_city TEXT DEFAULT 'Москва',       -- Город для погоды
  first_name TEXT,                          -- Имя пользователя
  timezone TEXT DEFAULT 'Europe/Moscow',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_user_prefs_user ON user_preferences(user_id);
CREATE INDEX idx_user_prefs_digest ON user_preferences(digest_enabled, digest_hour)
  WHERE digest_enabled = true;

ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to user_preferences"
  ON user_preferences FOR ALL USING (true) WITH CHECK (true);

-- Триггер updated_at
CREATE OR REPLACE FUNCTION update_user_prefs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_user_prefs_updated_at
  BEFORE UPDATE ON user_preferences
  FOR EACH ROW
  EXECUTE FUNCTION update_user_prefs_updated_at();
