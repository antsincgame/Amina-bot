-- ============================================
-- Migration 011: Hybrid Digest Pipeline
-- Persist-кеш подготовленных секций дайджеста
-- и метаданные доставки для отдельного Supabase pipeline
-- ============================================

CREATE TABLE IF NOT EXISTS digest_caches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key TEXT NOT NULL UNIQUE,
  pipeline TEXT NOT NULL DEFAULT 'hybrid_supabase'
    CHECK (pipeline IN ('hybrid_supabase')),
  digest_date DATE NOT NULL,
  city TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_digest_caches_pipeline_date_city
  ON digest_caches (pipeline, digest_date DESC, city);

CREATE INDEX IF NOT EXISTS idx_digest_caches_expires_at
  ON digest_caches (expires_at);

ALTER TABLE digest_caches ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to digest_caches" ON digest_caches;
CREATE POLICY "Service role full access to digest_caches"
  ON digest_caches FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION update_digest_caches_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trigger_digest_caches_updated_at'
  ) THEN
    CREATE TRIGGER trigger_digest_caches_updated_at
      BEFORE UPDATE ON digest_caches
      FOR EACH ROW
      EXECUTE FUNCTION update_digest_caches_updated_at();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS digest_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_key TEXT NOT NULL UNIQUE,
  pipeline TEXT NOT NULL DEFAULT 'hybrid_supabase'
    CHECK (pipeline IN ('hybrid_supabase')),
  delivery_kind TEXT NOT NULL DEFAULT 'manual'
    CHECK (delivery_kind IN ('manual', 'scheduled', 'api')),
  user_id TEXT NOT NULL,
  chat_id BIGINT NOT NULL,
  city TEXT NOT NULL,
  digest_date DATE NOT NULL,
  cache_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CHECK (attempt_count >= 0),
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_digest_deliveries_user_date
  ON digest_deliveries (user_id, digest_date DESC);

CREATE INDEX IF NOT EXISTS idx_digest_deliveries_status_date
  ON digest_deliveries (status, digest_date DESC, updated_at DESC);

ALTER TABLE digest_deliveries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access to digest_deliveries" ON digest_deliveries;
CREATE POLICY "Service role full access to digest_deliveries"
  ON digest_deliveries FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE OR REPLACE FUNCTION update_digest_deliveries_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trigger_digest_deliveries_updated_at'
  ) THEN
    CREATE TRIGGER trigger_digest_deliveries_updated_at
      BEFORE UPDATE ON digest_deliveries
      FOR EACH ROW
      EXECUTE FUNCTION update_digest_deliveries_updated_at();
  END IF;
END $$;
