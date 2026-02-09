-- 010: Атомарное обновление user preferences (jsonb_set)
-- Устраняет race condition при concurrent записи в preferences JSONB

CREATE OR REPLACE FUNCTION set_user_preference(
  p_user_id TEXT,
  p_key TEXT,
  p_value JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  UPDATE user_profiles
  SET preferences = COALESCE(preferences, '{}'::jsonb) || jsonb_build_object(p_key, p_value)
  WHERE user_id = p_user_id;
END;
$$;
