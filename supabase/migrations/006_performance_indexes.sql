-- ============================================
-- Performance Indexes & Constraints
-- Migration 006 - Optimization
-- ============================================

-- ============================================
-- 1. Composite Indexes (frequently filtered together)
-- ============================================

-- Conversations: user + channel lookup (used by getOrCreate)
CREATE INDEX IF NOT EXISTS idx_conversations_user_channel
  ON conversations(user_id, channel);

-- Analytics: event_type + timestamp (used in filtering)
CREATE INDEX IF NOT EXISTS idx_analytics_event_timestamp
  ON analytics(event_type, timestamp DESC);

-- Analytics: channel + timestamp (used in admin panel)
CREATE INDEX IF NOT EXISTS idx_analytics_channel_timestamp
  ON analytics(channel, timestamp DESC);

-- User logs: user + event_type (used in getByUser)
CREATE INDEX IF NOT EXISTS idx_user_logs_user_event
  ON user_logs(user_id, event_type);

-- User logs: user + timestamp (used in getMessageHistory)
CREATE INDEX IF NOT EXISTS idx_user_logs_user_timestamp
  ON user_logs(user_id, timestamp DESC);

-- Conversation summaries: user + created_at
CREATE INDEX IF NOT EXISTS idx_conv_summaries_user_created
  ON conversation_summaries(user_id, created_at DESC);

-- ============================================
-- 2. GIN Indexes for JSONB columns
-- ============================================

-- Analytics data (for filtering by data fields)
CREATE INDEX IF NOT EXISTS idx_analytics_data_gin
  ON analytics USING GIN (data);

-- System logs data
CREATE INDEX IF NOT EXISTS idx_system_logs_data_gin
  ON system_logs USING GIN (data);

-- ============================================
-- 3. CHECK Constraints (data validation)
-- ============================================

-- User profiles: non-negative counters
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_profiles_counts_non_negative'
  ) THEN
    ALTER TABLE user_profiles
    ADD CONSTRAINT user_profiles_counts_non_negative
    CHECK (total_messages >= 0 AND total_voice_messages >= 0 AND total_images >= 0 AND total_tokens_used >= 0);
  END IF;
END $$;

-- User memory: confidence range 0-1
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_memory_confidence_range'
  ) THEN
    ALTER TABLE user_memory
    ADD CONSTRAINT user_memory_confidence_range
    CHECK (confidence >= 0 AND confidence <= 1);
  END IF;
END $$;

-- User logs: non-negative metrics
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'user_logs_metrics_non_negative'
  ) THEN
    ALTER TABLE user_logs
    ADD CONSTRAINT user_logs_metrics_non_negative
    CHECK (
      (tokens_prompt IS NULL OR tokens_prompt >= 0) AND
      (tokens_completion IS NULL OR tokens_completion >= 0) AND
      (response_time_ms IS NULL OR response_time_ms >= 0)
    );
  END IF;
END $$;

-- ============================================
-- 4. NOT NULL where defaults exist
-- ============================================

ALTER TABLE conversations ALTER COLUMN messages SET NOT NULL;
ALTER TABLE conversations ALTER COLUMN metadata SET NOT NULL;
ALTER TABLE analytics ALTER COLUMN data SET NOT NULL;

-- ============================================
-- 5. Analytics aggregation function (avoid client-side)
-- ============================================

CREATE OR REPLACE FUNCTION get_analytics_stats(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'totalMessages', (
      SELECT COUNT(*) FROM analytics
      WHERE timestamp BETWEEN p_from AND p_to
        AND event_type IN ('message_sent', 'message_received')
    ),
    'totalCalls', (
      SELECT COUNT(*) FROM analytics
      WHERE timestamp BETWEEN p_from AND p_to
        AND event_type = 'call_started'
    ),
    'uniqueUsers', (
      SELECT COUNT(DISTINCT user_id) FROM analytics
      WHERE timestamp BETWEEN p_from AND p_to
        AND user_id IS NOT NULL
    ),
    'tokensByDay', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('date', d.day::text, 'tokens', d.tokens) ORDER BY d.day)
      FROM (
        SELECT 
          date_trunc('day', timestamp)::date as day,
          COALESCE(SUM((data->>'tokens')::int), 0) as tokens
        FROM analytics
        WHERE timestamp BETWEEN p_from AND p_to
          AND event_type = 'ai_response'
        GROUP BY date_trunc('day', timestamp)::date
      ) d
    ), '[]'::jsonb)
  )
  INTO v_result;
  
  RETURN v_result;
END;
$$;
