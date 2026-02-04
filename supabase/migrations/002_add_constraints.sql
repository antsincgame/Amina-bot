-- ============================================
-- Amina Bot - Additional Constraints and Indexes
-- Migration 002
-- ============================================

-- Add CHECK constraint for analytics event_type
-- (if not already exists)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'analytics_event_type_check'
  ) THEN
    ALTER TABLE analytics
    ADD CONSTRAINT analytics_event_type_check
    CHECK (event_type IN (
      'message_sent',
      'message_received', 
      'call_started',
      'call_ended',
      'ai_response',
      'error',
      'settings_updated',
      'prompt_updated'
    ));
  END IF;
END $$;

-- Add CHECK constraint for analytics channel
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'analytics_channel_check'
  ) THEN
    ALTER TABLE analytics
    ADD CONSTRAINT analytics_channel_check
    CHECK (channel IN ('telegram', 'voice', 'admin'));
  END IF;
END $$;

-- Add composite index for common analytics queries
CREATE INDEX IF NOT EXISTS idx_analytics_channel_type_timestamp 
ON analytics(channel, event_type, timestamp DESC);

-- Add index for user activity queries
CREATE INDEX IF NOT EXISTS idx_analytics_user_timestamp 
ON analytics(user_id, timestamp DESC) 
WHERE user_id IS NOT NULL;

-- Add index for conversations by user
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated 
ON conversations(user_id, updated_at DESC);

-- Add partial index for active prompts
CREATE INDEX IF NOT EXISTS idx_prompts_active_channel 
ON prompts(channel) 
WHERE is_active = true;
