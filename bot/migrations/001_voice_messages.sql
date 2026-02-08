-- Voice Messages Storage
-- Хранит метаданные голосовых сообщений, файлы в Supabase Storage bucket "voice-messages"

CREATE TABLE IF NOT EXISTS voice_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  duration INTEGER DEFAULT 0,
  file_size INTEGER DEFAULT 0,
  transcription TEXT,
  telegram_file_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_voice_messages_user ON voice_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_voice_messages_created ON voice_messages(created_at DESC);

-- Storage bucket (выполнить в Supabase Dashboard → Storage → New Bucket)
-- Имя: voice-messages
-- Public: false
-- File size limit: 25MB
