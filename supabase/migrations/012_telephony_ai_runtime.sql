-- ============================================
-- Telephony AI Runtime Domain Schema
-- ============================================

CREATE TABLE IF NOT EXISTS telephony_scenarios (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  call_mode TEXT NOT NULL CHECK (call_mode IN ('speech', 'ask_question')),
  runtime_mode TEXT NOT NULL DEFAULT 'scripted' CHECK (runtime_mode IN ('scripted', 'shadow', 'hybrid', 'realtime')),
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

CREATE INDEX IF NOT EXISTS idx_telephony_scenarios_enabled
  ON telephony_scenarios(enabled);
CREATE INDEX IF NOT EXISTS idx_telephony_scenarios_updated
  ON telephony_scenarios(updated_at DESC);

CREATE TABLE IF NOT EXISTS telephony_call_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_telegram_id TEXT NOT NULL,
  initiated_by TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  scenario_name TEXT NOT NULL,
  scenario_goal TEXT NOT NULL DEFAULT '',
  call_mode TEXT NOT NULL CHECK (call_mode IN ('speech', 'ask_question')),
  runtime_mode TEXT NOT NULL DEFAULT 'scripted' CHECK (runtime_mode IN ('scripted', 'shadow', 'hybrid', 'realtime')),
  policy_version INTEGER NOT NULL DEFAULT 1,
  provider TEXT NOT NULL DEFAULT 'unknown' CHECK (provider IN ('lirax', 'media_bridge', 'unknown')),
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
  status TEXT NOT NULL CHECK (status IN ('initiated', 'linked', 'recorded', 'processed', 'failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telephony_call_sessions_created
  ON telephony_call_sessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telephony_call_sessions_status
  ON telephony_call_sessions(status);
CREATE INDEX IF NOT EXISTS idx_telephony_call_sessions_request_id
  ON telephony_call_sessions(request_id)
  WHERE request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_telephony_call_sessions_call_id
  ON telephony_call_sessions(call_id)
  WHERE call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_telephony_call_sessions_phone_created
  ON telephony_call_sessions(target_phone, created_at DESC);

CREATE TABLE IF NOT EXISTS telephony_call_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES telephony_call_sessions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  provider_event_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_telephony_call_events_session
  ON telephony_call_events(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_telephony_call_events_type
  ON telephony_call_events(event_type);

CREATE TABLE IF NOT EXISTS telephony_call_turns (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES telephony_call_sessions(id) ON DELETE CASCADE,
  turn_index INTEGER NOT NULL,
  speaker TEXT NOT NULL CHECK (speaker IN ('agent', 'customer', 'system')),
  source TEXT NOT NULL CHECK (source IN ('script', 'transcript', 'summary', 'shadow', 'realtime')),
  content TEXT NOT NULL,
  confidence DOUBLE PRECISION,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, turn_index)
);

CREATE INDEX IF NOT EXISTS idx_telephony_call_turns_session
  ON telephony_call_turns(session_id, turn_index);

CREATE TABLE IF NOT EXISTS telephony_call_artifacts (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID NOT NULL REFERENCES telephony_call_sessions(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('recording', 'transcript', 'summary', 'analysis_report')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'ready', 'failed')),
  url TEXT,
  content TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(session_id, artifact_type)
);

CREATE INDEX IF NOT EXISTS idx_telephony_call_artifacts_session
  ON telephony_call_artifacts(session_id, artifact_type);

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
  job_type TEXT NOT NULL CHECK (job_type IN ('process_recording')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
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

CREATE INDEX IF NOT EXISTS idx_telephony_call_jobs_status_due
  ON telephony_call_jobs(status, next_run_at);
CREATE INDEX IF NOT EXISTS idx_telephony_call_jobs_session
  ON telephony_call_jobs(session_id);

ALTER TABLE telephony_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephony_call_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephony_call_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephony_call_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephony_call_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephony_call_outcomes ENABLE ROW LEVEL SECURITY;
ALTER TABLE telephony_call_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role can manage telephony scenarios" ON telephony_scenarios
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage telephony call sessions" ON telephony_call_sessions
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage telephony call events" ON telephony_call_events
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage telephony call turns" ON telephony_call_turns
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage telephony call artifacts" ON telephony_call_artifacts
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage telephony call outcomes" ON telephony_call_outcomes
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE POLICY "Service role can manage telephony call jobs" ON telephony_call_jobs
  FOR ALL
  USING (auth.role() = 'service_role');

CREATE TRIGGER trigger_telephony_scenarios_updated
  BEFORE UPDATE ON telephony_scenarios
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_telephony_call_sessions_updated
  BEFORE UPDATE ON telephony_call_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_telephony_call_artifacts_updated
  BEFORE UPDATE ON telephony_call_artifacts
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_telephony_call_outcomes_updated
  BEFORE UPDATE ON telephony_call_outcomes
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER trigger_telephony_call_jobs_updated
  BEFORE UPDATE ON telephony_call_jobs
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();
