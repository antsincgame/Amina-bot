-- ============================================
-- Migration 007: Reminders
-- Напоминания пользователей через Telegram
-- ============================================

-- Таблица напоминаний
CREATE TABLE IF NOT EXISTS reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  chat_id BIGINT NOT NULL,
  task TEXT NOT NULL,
  scheduled_at TIMESTAMPTZ NOT NULL,
  is_completed BOOLEAN DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Индекс для планировщика: быстрый поиск незавершённых напоминаний по времени
CREATE INDEX idx_reminders_due ON reminders(scheduled_at)
  WHERE is_completed = false;

-- Индекс для пользовательских запросов
CREATE INDEX idx_reminders_user ON reminders(user_id, is_completed);

-- Триггер updated_at
CREATE OR REPLACE FUNCTION update_reminders_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trigger_reminders_updated_at
  BEFORE UPDATE ON reminders
  FOR EACH ROW
  EXECUTE FUNCTION update_reminders_updated_at();

-- RLS
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access to reminders"
  ON reminders
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- Функция очистки старых завершённых напоминаний (старше 30 дней)
CREATE OR REPLACE FUNCTION cleanup_old_reminders()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM reminders
  WHERE is_completed = true
    AND completed_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;
