-- ============================================
-- Amina Bot - Initial Database Schema
-- ============================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- Settings Table
-- ============================================

CREATE TABLE IF NOT EXISTS settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT UNIQUE NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast key lookups
CREATE INDEX idx_settings_key ON settings(key);

-- ============================================
-- Prompts Table
-- ============================================

CREATE TABLE IF NOT EXISTS prompts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  is_active BOOLEAN DEFAULT FALSE,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'voice', 'all')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for active prompts
CREATE INDEX idx_prompts_active ON prompts(is_active, channel);

-- ============================================
-- Conversations Table
-- ============================================

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'voice')),
  messages JSONB DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for conversation lookups
CREATE INDEX idx_conversations_user ON conversations(user_id);
CREATE INDEX idx_conversations_channel ON conversations(channel);
CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);

-- ============================================
-- Analytics Table
-- ============================================

CREATE TABLE IF NOT EXISTS analytics (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_type TEXT NOT NULL,
  data JSONB DEFAULT '{}'::jsonb,
  user_id TEXT,
  channel TEXT NOT NULL CHECK (channel IN ('telegram', 'voice', 'admin')),
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for analytics queries
CREATE INDEX idx_analytics_type ON analytics(event_type);
CREATE INDEX idx_analytics_timestamp ON analytics(timestamp DESC);
CREATE INDEX idx_analytics_user ON analytics(user_id) WHERE user_id IS NOT NULL;

-- Partitioning hint: Consider partitioning by month for large datasets
-- CREATE INDEX idx_analytics_month ON analytics(date_trunc('month', timestamp));

-- ============================================
-- Admin Users Table (for Supabase Auth)
-- ============================================

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('admin', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login TIMESTAMPTZ
);

-- ============================================
-- Row Level Security (RLS)
-- ============================================

-- Enable RLS on all tables
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE prompts ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_users ENABLE ROW LEVEL SECURITY;

-- Settings: Only service role can access
CREATE POLICY "Service role can manage settings" ON settings
  FOR ALL
  USING (auth.role() = 'service_role');

-- Prompts: Service role full access, authenticated can read
CREATE POLICY "Service role can manage prompts" ON prompts
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Authenticated can read prompts" ON prompts
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- Conversations: Service role only
CREATE POLICY "Service role can manage conversations" ON conversations
  FOR ALL
  USING (auth.role() = 'service_role');

-- Analytics: Service role can insert/read, authenticated can read
CREATE POLICY "Service role can manage analytics" ON analytics
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Authenticated can read analytics" ON analytics
  FOR SELECT
  USING (auth.role() = 'authenticated');

-- Admin users: Users can read their own profile
CREATE POLICY "Users can read own profile" ON admin_users
  FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Service role can manage admin_users" ON admin_users
  FOR ALL
  USING (auth.role() = 'service_role');

-- ============================================
-- Functions
-- ============================================

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER trigger_settings_updated
  BEFORE UPDATE ON settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_prompts_updated
  BEFORE UPDATE ON prompts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_conversations_updated
  BEFORE UPDATE ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- ============================================
-- Initial Data
-- ============================================

-- Insert default settings
INSERT INTO settings (key, value) VALUES
  ('openrouter_model', 'anthropic/claude-3-haiku'),
  ('max_tokens', '2048'),
  ('temperature', '0.7'),
  ('voice_enabled', 'true'),
  ('voice_speaker', 'xenia')
ON CONFLICT (key) DO NOTHING;

-- Insert default system prompt
INSERT INTO prompts (name, content, is_active, channel) VALUES
  ('Default Assistant', 
   'Ты — Amina, дружелюбный AI-ассистент.

Твои качества:
- Отвечаешь кратко и по делу
- Используешь понятный язык
- Помогаешь решать задачи пользователя
- Если не знаешь ответ — честно говоришь об этом

Отвечай на том языке, на котором к тебе обращаются.',
   true,
   'all')
ON CONFLICT DO NOTHING;

-- ============================================
-- Views for Analytics
-- ============================================

-- Daily stats view
CREATE OR REPLACE VIEW daily_stats AS
SELECT
  date_trunc('day', timestamp) AS day,
  channel,
  event_type,
  COUNT(*) AS count
FROM analytics
WHERE timestamp > NOW() - INTERVAL '30 days'
GROUP BY day, channel, event_type
ORDER BY day DESC;

-- User activity view
CREATE OR REPLACE VIEW user_activity AS
SELECT
  user_id,
  channel,
  COUNT(*) AS total_events,
  MAX(timestamp) AS last_activity
FROM analytics
WHERE user_id IS NOT NULL
GROUP BY user_id, channel
ORDER BY last_activity DESC;
