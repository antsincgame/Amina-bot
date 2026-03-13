-- ============================================
-- Realtime bridge + recording archive expansion
-- ============================================

ALTER TABLE telephony_call_sessions
  DROP CONSTRAINT IF EXISTS telephony_call_sessions_status_check;

ALTER TABLE telephony_call_sessions
  ADD CONSTRAINT telephony_call_sessions_status_check
  CHECK (
    status IN (
      'initiated',
      'queued',
      'dialing',
      'live',
      'linked',
      'recorded',
      'completed',
      'processed',
      'fallback',
      'cancelled',
      'failed'
    )
  );

ALTER TABLE telephony_call_artifacts
  DROP CONSTRAINT IF EXISTS telephony_call_artifacts_artifact_type_check;

ALTER TABLE telephony_call_artifacts
  ADD CONSTRAINT telephony_call_artifacts_artifact_type_check
  CHECK (
    artifact_type IN (
      'recording',
      'transcript_partial',
      'transcript_final',
      'transcript',
      'summary',
      'analysis_report'
    )
  );

ALTER TABLE telephony_call_artifacts
  ADD COLUMN IF NOT EXISTS storage_path TEXT,
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS duration_ms INTEGER,
  ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS archive_status TEXT,
  ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE telephony_call_artifacts
  DROP CONSTRAINT IF EXISTS telephony_call_artifacts_archive_status_check;

ALTER TABLE telephony_call_artifacts
  ADD CONSTRAINT telephony_call_artifacts_archive_status_check
  CHECK (
    archive_status IS NULL
    OR archive_status IN ('pending', 'archived', 'failed')
  );

CREATE INDEX IF NOT EXISTS idx_telephony_call_sessions_status_created
  ON telephony_call_sessions(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telephony_call_events_session_type
  ON telephony_call_events(session_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telephony_call_artifacts_archive_status
  ON telephony_call_artifacts(archive_status);

CREATE INDEX IF NOT EXISTS idx_telephony_call_artifacts_storage_path
  ON telephony_call_artifacts(storage_path)
  WHERE storage_path IS NOT NULL;
