#!/usr/bin/env node
/**
 * Migrate telephony data from Supabase → Appwrite
 * Run AFTER setup-telephony-collections.mjs
 *
 * Usage: node scripts/migrate-telephony-data.mjs
 */
import { Client, Databases, ID } from 'node-appwrite';
import { createClient } from '@supabase/supabase-js';

// --- Config ---
const AW_ENDPOINT = 'https://appwrite.vibecoding.by/v1';
const AW_PROJECT  = '69af2faa003646d3574c';
const AW_KEY      = 'standard_809851555374aeafe45e7cab53e88fd3935ff03a5282123b421f2260a7a0053cc29009dbc7e4c687a4f28f713961d4c3d746445690f0c6135d907fbcea41249fb8f7c6422e157e7e97a621034e48dd29b9451a170e59bfdbff564021012d7112849fdb2944ec3f274acf4e9e053534850d8d86117e36eebdf25cbdec7788d80e';
const AW_DB       = 'amina';

const SB_URL = 'https://azdvlsznlvktxvmfswhq.supabase.co';
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF6ZHZsc3pubHZrdHh2bWZzd2hxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDE1NDkyNSwiZXhwIjoyMDg1NzMwOTI1fQ.7NmdUc57zlNZ8s3sd2OHVI-qcIAR3TSWzFEjRKOgCtE';

// --- Clients ---
const aw = new Databases(
  new Client().setEndpoint(AW_ENDPOINT).setProject(AW_PROJECT).setKey(AW_KEY)
);
const sb = createClient(SB_URL, SB_KEY);

// --- Helpers ---
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchAll(table) {
  const { data, error } = await sb.from(table).select('*');
  if (error) { console.error(`  ✗ Failed to fetch ${table}:`, error.message); return []; }
  return data ?? [];
}

async function migrateTable(sbTable, awColl, mapFn) {
  console.log(`\n📦 ${sbTable} → ${awColl}`);
  const rows = await fetchAll(sbTable);
  console.log(`  Found ${rows.length} rows`);
  if (rows.length === 0) return 0;

  let ok = 0, skip = 0, fail = 0;
  for (const row of rows) {
    try {
      const doc = mapFn(row);
      await aw.createDocument(AW_DB, awColl, ID.unique(), doc);
      ok++;
    } catch (e) {
      if (e.code === 409) { skip++; }
      else { fail++; console.error(`  ✗ Row ${row.id}:`, e.message); }
    }
  }
  console.log(`  ✓ Created: ${ok}, Skipped: ${skip}, Failed: ${fail}`);
  return ok;
}

// --- Helpers ---
function trunc(val, max) {
  if (!val) return val;
  if (typeof val !== 'string') return val;
  return val.length > max ? val.slice(0, max) : val;
}

// --- Mappers (sizes match fix-telephony-collections.mjs) ---

function mapScenario(r) {
  return {
    scenario_id: r.id,
    name: trunc(r.name, 255),
    enabled: r.enabled ?? true,
    call_mode: r.call_mode,
    runtime_mode: r.runtime_mode ?? 'scripted',
    policy_version: r.policy_version ?? 1,
    policy: trunc(JSON.stringify(r.policy ?? {}), 10000),
    goal: trunc(r.goal ?? '', 2000),
    system_prompt: trunc(r.system_prompt ?? '', 10000),
    opening_line: trunc(r.opening_line ?? '', 2000),
    question_hint: trunc(r.question_hint ?? '', 2000),
    success_criteria: trunc(r.success_criteria ?? '', 2000),
    result_prompt: trunc(r.result_prompt ?? '', 10000),
    max_speech_chars: r.max_speech_chars ?? 420,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString(),
  };
}

function mapSession(r) {
  return {
    owner_telegram_id: r.owner_telegram_id,
    initiated_by: r.initiated_by,
    scenario_id: r.scenario_id,
    scenario_name: trunc(r.scenario_name ?? '', 255),
    scenario_goal: trunc(r.scenario_goal ?? '', 2000),
    call_mode: r.call_mode,
    runtime_mode: r.runtime_mode ?? 'scripted',
    policy_version: r.policy_version ?? 1,
    provider: r.provider ?? 'unknown',
    target_phone: r.target_phone,
    task: trunc(r.task ?? '', 2000),
    summary: trunc(r.summary ?? '', 10000),
    success_criteria: trunc(r.success_criteria ?? '', 2000),
    result_prompt: trunc(r.result_prompt ?? '', 10000),
    request_id: r.request_id || null,
    request_mode: r.request_mode ?? '',
    call_id: r.call_id || null,
    record_link: trunc(r.record_link || null, 500),
    transcript: trunc(r.transcript || null, 50000),
    result_summary: trunc(r.result_summary || null, 10000),
    outcome_label: r.outcome_label || null,
    status: r.status,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString(),
  };
}

function mapEvent(r) {
  return {
    session_id: r.session_id,
    event_type: r.event_type,
    provider_event_id: r.provider_event_id || null,
    payload: JSON.stringify(r.payload ?? {}),
    created_at: r.created_at || new Date().toISOString(),
  };
}

function mapTurn(r) {
  return {
    session_id: r.session_id,
    turn_index: r.turn_index,
    speaker: r.speaker,
    source: r.source,
    content: r.content,
    confidence: r.confidence ?? null,
    created_at: r.created_at || new Date().toISOString(),
  };
}

function mapArtifact(r) {
  return {
    session_id: r.session_id,
    artifact_type: r.artifact_type,
    status: r.status,
    url: r.url || null,
    storage_path: r.storage_path || null,
    content: r.content || null,
    mime_type: r.mime_type || null,
    size_bytes: r.size_bytes ?? null,
    duration_ms: r.duration_ms ?? null,
    checksum_sha256: r.checksum_sha256 || null,
    archive_status: r.archive_status || null,
    retention_until: r.retention_until || null,
    version: r.version ?? 1,
    metadata: JSON.stringify(r.metadata ?? {}),
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString(),
  };
}

function mapOutcome(r) {
  return {
    session_id: r.session_id,
    outcome_label: r.outcome_label,
    result_summary: r.result_summary,
    confidence: r.confidence ?? null,
    metadata: JSON.stringify(r.metadata ?? {}),
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString(),
  };
}

function mapJob(r) {
  return {
    session_id: r.session_id,
    job_type: r.job_type,
    status: r.status,
    dedupe_key: r.dedupe_key,
    attempts: r.attempts ?? 0,
    max_attempts: r.max_attempts ?? 5,
    next_run_at: r.next_run_at || new Date().toISOString(),
    locked_at: r.locked_at || null,
    payload: JSON.stringify(r.payload ?? {}),
    last_error: r.last_error || null,
    created_at: r.created_at || new Date().toISOString(),
    updated_at: r.updated_at || new Date().toISOString(),
  };
}

// --- Main ---
async function main() {
  console.log('🚀 Telephony data migration: Supabase → Appwrite\n');

  let total = 0;
  total += await migrateTable('telephony_scenarios',      'amina_tel_scenarios', mapScenario);
  await sleep(500);
  total += await migrateTable('telephony_call_sessions',  'amina_tel_sessions',  mapSession);
  await sleep(500);
  total += await migrateTable('telephony_call_events',    'amina_tel_events',    mapEvent);
  await sleep(500);
  total += await migrateTable('telephony_call_turns',     'amina_tel_turns',     mapTurn);
  await sleep(500);
  total += await migrateTable('telephony_call_artifacts', 'amina_tel_artifacts', mapArtifact);
  await sleep(500);
  total += await migrateTable('telephony_call_outcomes',  'amina_tel_outcomes',  mapOutcome);
  await sleep(500);
  total += await migrateTable('telephony_call_jobs',      'amina_tel_jobs',      mapJob);

  console.log(`\n✅ Migration complete! Total documents created: ${total}`);
  console.log('\n⚠️  Note: telephony recordings (audio files) in Supabase Storage');
  console.log('   are NOT migrated by this script. They will be stored in Appwrite');
  console.log('   Storage (bucket: amina-tel-recordings) for new recordings only.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
