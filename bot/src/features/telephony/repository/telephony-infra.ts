import { dbLogger } from '../../../config/logger.js';
import { getSupabase } from '../../../db/index.js';

let initialized = false;
let initPromise: Promise<void> | null = null;

const AUTO_CREATE_SQL = `
CREATE TABLE IF NOT EXISTS telephony_scenarios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  call_mode TEXT NOT NULL,
  runtime_mode TEXT NOT NULL DEFAULT 'scripted',
  policy_version INTEGER NOT NULL DEFAULT 1,
  policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  goal TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  opening_line TEXT NOT NULL DEFAULT '',
  question_hint TEXT NOT NULL DEFAULT '',
  success_criteria TEXT NOT NULL DEFAULT '',
  result_prompt TEXT NOT NULL DEFAULT '',
  max_speech_chars INTEGER NOT NULL DEFAULT 420,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telephony_call_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_telegram_id TEXT NOT NULL,
  initiated_by TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_name TEXT NOT NULL,
  scenario_goal TEXT NOT NULL DEFAULT '',
  call_mode TEXT NOT NULL,
  runtime_mode TEXT NOT NULL DEFAULT 'scripted',
  policy_version INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL DEFAULT 'unknown',
  target_phone TEXT NOT NULL,
  task TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  success_criteria TEXT NOT NULL DEFAULT '',
  result_prompt TEXT NOT NULL DEFAULT '',
  request_id TEXT,
  request_mode TEXT NOT NULL DEFAULT '',
  call_id TEXT,
  record_link TEXT,
  transcript TEXT,
  result_summary TEXT,
  outcome_label TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telephony_call_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES telephony_call_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  provider_event_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telephony_call_turns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES telephony_call_sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  speaker TEXT NOT NULL,
  source TEXT NOT NULL,
  content TEXT NOT NULL,
  confidence DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, turn_index)
);

CREATE TABLE IF NOT EXISTS telephony_call_artifacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES telephony_call_sessions(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,
  status TEXT NOT NULL,
  url TEXT,
  storage_path TEXT,
  content TEXT,
  mime_type TEXT,
  size_bytes BIGINT,
  duration_ms INTEGER,
  checksum_sha256 TEXT,
  archive_status TEXT,
  retention_until TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, artifact_type)
);

CREATE TABLE IF NOT EXISTS telephony_call_outcomes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL UNIQUE REFERENCES telephony_call_sessions(id) ON DELETE CASCADE,
  outcome_label TEXT NOT NULL,
  result_summary TEXT NOT NULL,
  confidence DOUBLE PRECISION,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS telephony_call_jobs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES telephony_call_sessions(id) ON DELETE CASCADE,
  job_type TEXT NOT NULL,
  status TEXT NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telephony_call_sessions_request_id
  ON telephony_call_sessions(request_id);
CREATE INDEX IF NOT EXISTS idx_telephony_call_sessions_call_id
  ON telephony_call_sessions(call_id);
CREATE INDEX IF NOT EXISTS idx_telephony_call_sessions_status_created
  ON telephony_call_sessions(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telephony_call_events_session_type
  ON telephony_call_events(session_id, event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telephony_call_artifacts_archive_status
  ON telephony_call_artifacts(archive_status);
CREATE INDEX IF NOT EXISTS idx_telephony_call_jobs_status_due
  ON telephony_call_jobs(status, next_run_at);

ALTER TABLE telephony_call_artifacts ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE telephony_call_artifacts ADD COLUMN IF NOT EXISTS mime_type TEXT;
ALTER TABLE telephony_call_artifacts ADD COLUMN IF NOT EXISTS size_bytes BIGINT;
ALTER TABLE telephony_call_artifacts ADD COLUMN IF NOT EXISTS duration_ms INTEGER;
ALTER TABLE telephony_call_artifacts ADD COLUMN IF NOT EXISTS checksum_sha256 TEXT;
ALTER TABLE telephony_call_artifacts ADD COLUMN IF NOT EXISTS archive_status TEXT;
ALTER TABLE telephony_call_artifacts ADD COLUMN IF NOT EXISTS retention_until TIMESTAMPTZ;
ALTER TABLE telephony_call_artifacts ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;
`;

export async function ensureTelephonyInfra(): Promise<void> {
  if (initialized) {
    return;
  }

  if (initPromise) {
    return initPromise;
  }

  initPromise = doEnsureTelephonyInfra();
  try {
    await initPromise;
  } finally {
    initPromise = null;
  }
}

async function doEnsureTelephonyInfra(): Promise<void> {
  if (initialized) {
    return;
  }

  const sb = getSupabase();

  try {
    const { error } = await sb.from('telephony_scenarios').select('id').limit(1);
    if (!error) {
      initialized = true;
      return;
    }

    if (!error.message?.includes('does not exist') && !error.message?.includes('schema cache')) {
      dbLogger.warn({ error }, 'telephony_scenarios table check returned non-fatal error');
      initialized = true;
      return;
    }

    const { error: rpcError } = await sb.rpc('exec_sql', { sql: AUTO_CREATE_SQL });
    if (rpcError) {
      dbLogger.warn({ error: rpcError }, 'Telephony infra auto-create failed — run migration 012 manually');
      return;
    }

    dbLogger.info('Telephony infra auto-created');
    initialized = true;
  } catch (error) {
    dbLogger.warn({ error }, 'Telephony infra init failed');
  }
}
