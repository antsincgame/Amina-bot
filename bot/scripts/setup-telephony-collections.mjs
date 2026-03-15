#!/usr/bin/env node
/** Create telephony collections in Amina project */
import { Client, Databases } from 'node-appwrite';

const db = new Databases(
  new Client()
    .setEndpoint('https://appwrite.vibecoding.by/v1')
    .setProject('69af2faa003646d3574c')
    .setKey('standard_809851555374aeafe45e7cab53e88fd3935ff03a5282123b421f2260a7a0053cc29009dbc7e4c687a4f28f713961d4c3d746445690f0c6135d907fbcea41249fb8f7c6422e157e7e97a621034e48dd29b9451a170e59bfdbff564021012d7112849fdb2944ec3f274acf4e9e053534850d8d86117e36eebdf25cbdec7788d80e')
);
const DB = 'amina';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function coll(id, name) {
  try { await db.getCollection(DB, id); console.log(`  ✓ ${name} exists`); }
  catch { await db.createCollection(DB, id, name, []); console.log(`  ✓ Created ${name}`); }
}
async function a(c, type, key, opts = {}) {
  try {
    if (type === 'string') await db.createStringAttribute(DB, c, key, opts.size || 255, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'text') await db.createStringAttribute(DB, c, key, opts.size || 1000000, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'integer') await db.createIntegerAttribute(DB, c, key, opts.required ?? false, opts.min, opts.max, opts.default, opts.array ?? false);
    else if (type === 'float') await db.createFloatAttribute(DB, c, key, opts.required ?? false, opts.min, opts.max, opts.default, opts.array ?? false);
    else if (type === 'boolean') await db.createBooleanAttribute(DB, c, key, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'datetime') await db.createDatetimeAttribute(DB, c, key, opts.required ?? false, opts.default, opts.array ?? false);
    console.log(`    + ${key}`);
  } catch (e) { if (e.code === 409) console.log(`    ~ ${key} exists`); else console.error(`    ✗ ${key}: ${e.message}`); }
}
async function idx(c, key, type, attrs, orders) {
  try { await db.createIndex(DB, c, key, type, attrs, orders); console.log(`    idx: ${key}`); }
  catch (e) { if (e.code === 409) console.log(`    idx: ${key} exists`); else console.error(`    idx ✗ ${key}: ${e.message}`); }
}

async function main() {
  // scenarios
  console.log('\n📦 telephony_scenarios');
  await coll('amina_tel_scenarios', 'Tel Scenarios');
  await a('amina_tel_scenarios', 'string', 'scenario_id', { size: 100, required: true });
  await a('amina_tel_scenarios', 'string', 'name', { size: 255, required: true });
  await a('amina_tel_scenarios', 'boolean', 'enabled', { default: true });
  await a('amina_tel_scenarios', 'string', 'call_mode', { size: 50, required: true });
  await a('amina_tel_scenarios', 'string', 'runtime_mode', { size: 50 });
  await a('amina_tel_scenarios', 'integer', 'policy_version', { default: 1 });
  await a('amina_tel_scenarios', 'text', 'policy', { size: 100000 });
  await a('amina_tel_scenarios', 'text', 'goal', { size: 10000 });
  await a('amina_tel_scenarios', 'text', 'system_prompt', { size: 100000 });
  await a('amina_tel_scenarios', 'text', 'opening_line', { size: 5000 });
  await a('amina_tel_scenarios', 'text', 'question_hint', { size: 5000 });
  await a('amina_tel_scenarios', 'text', 'success_criteria', { size: 10000 });
  await a('amina_tel_scenarios', 'text', 'result_prompt', { size: 100000 });
  await a('amina_tel_scenarios', 'integer', 'max_speech_chars', { default: 420 });
  await a('amina_tel_scenarios', 'datetime', 'created_at');
  await a('amina_tel_scenarios', 'datetime', 'updated_at');
  await sleep(3000);
  await idx('amina_tel_scenarios', 'idx_scenario_id', 'unique', ['scenario_id'], ['ASC']);

  // call_sessions
  console.log('\n📦 telephony_call_sessions');
  await coll('amina_tel_sessions', 'Tel Sessions');
  await a('amina_tel_sessions', 'string', 'owner_telegram_id', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'initiated_by', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'scenario_id', { size: 100, required: true });
  await a('amina_tel_sessions', 'string', 'scenario_name', { size: 255 });
  await a('amina_tel_sessions', 'text', 'scenario_goal', { size: 10000 });
  await a('amina_tel_sessions', 'string', 'call_mode', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'runtime_mode', { size: 50 });
  await a('amina_tel_sessions', 'integer', 'policy_version', { default: 1 });
  await a('amina_tel_sessions', 'string', 'provider', { size: 50 });
  await a('amina_tel_sessions', 'string', 'target_phone', { size: 50, required: true });
  await a('amina_tel_sessions', 'text', 'task', { size: 5000 });
  await a('amina_tel_sessions', 'text', 'summary', { size: 50000 });
  await a('amina_tel_sessions', 'text', 'success_criteria', { size: 10000 });
  await a('amina_tel_sessions', 'text', 'result_prompt', { size: 100000 });
  await a('amina_tel_sessions', 'string', 'request_id', { size: 100 });
  await a('amina_tel_sessions', 'string', 'request_mode', { size: 50 });
  await a('amina_tel_sessions', 'string', 'call_id', { size: 100 });
  await a('amina_tel_sessions', 'string', 'record_link', { size: 500 });
  await a('amina_tel_sessions', 'text', 'transcript', { size: 500000 });
  await a('amina_tel_sessions', 'text', 'result_summary', { size: 50000 });
  await a('amina_tel_sessions', 'string', 'outcome_label', { size: 100 });
  await a('amina_tel_sessions', 'string', 'status', { size: 50, required: true });
  await a('amina_tel_sessions', 'datetime', 'created_at');
  await a('amina_tel_sessions', 'datetime', 'updated_at');
  await sleep(3000);
  await idx('amina_tel_sessions', 'idx_request_id', 'key', ['request_id'], ['ASC']);
  await idx('amina_tel_sessions', 'idx_call_id', 'key', ['call_id'], ['ASC']);
  await idx('amina_tel_sessions', 'idx_status', 'key', ['status', 'created_at'], ['ASC', 'DESC']);

  // call_events
  console.log('\n📦 telephony_call_events');
  await coll('amina_tel_events', 'Tel Events');
  await a('amina_tel_events', 'string', 'session_id', { size: 100, required: true });
  await a('amina_tel_events', 'string', 'event_type', { size: 100, required: true });
  await a('amina_tel_events', 'string', 'provider_event_id', { size: 100 });
  await a('amina_tel_events', 'text', 'payload', { size: 500000 });
  await a('amina_tel_events', 'datetime', 'created_at');
  await sleep(2000);
  await idx('amina_tel_events', 'idx_session_type', 'key', ['session_id', 'event_type'], ['ASC', 'ASC']);

  // call_turns
  console.log('\n📦 telephony_call_turns');
  await coll('amina_tel_turns', 'Tel Turns');
  await a('amina_tel_turns', 'string', 'session_id', { size: 100, required: true });
  await a('amina_tel_turns', 'integer', 'turn_index', { required: true });
  await a('amina_tel_turns', 'string', 'speaker', { size: 50, required: true });
  await a('amina_tel_turns', 'string', 'source', { size: 50, required: true });
  await a('amina_tel_turns', 'text', 'content', { size: 50000, required: true });
  await a('amina_tel_turns', 'float', 'confidence');
  await a('amina_tel_turns', 'datetime', 'created_at');
  await sleep(2000);
  await idx('amina_tel_turns', 'idx_session', 'key', ['session_id', 'turn_index'], ['ASC', 'ASC']);

  // call_artifacts
  console.log('\n📦 telephony_call_artifacts');
  await coll('amina_tel_artifacts', 'Tel Artifacts');
  await a('amina_tel_artifacts', 'string', 'session_id', { size: 100, required: true });
  await a('amina_tel_artifacts', 'string', 'artifact_type', { size: 50, required: true });
  await a('amina_tel_artifacts', 'string', 'status', { size: 50, required: true });
  await a('amina_tel_artifacts', 'string', 'url', { size: 500 });
  await a('amina_tel_artifacts', 'string', 'storage_path', { size: 500 });
  await a('amina_tel_artifacts', 'text', 'content', { size: 500000 });
  await a('amina_tel_artifacts', 'string', 'mime_type', { size: 100 });
  await a('amina_tel_artifacts', 'integer', 'size_bytes');
  await a('amina_tel_artifacts', 'integer', 'duration_ms');
  await a('amina_tel_artifacts', 'string', 'checksum_sha256', { size: 100 });
  await a('amina_tel_artifacts', 'string', 'archive_status', { size: 50 });
  await a('amina_tel_artifacts', 'datetime', 'retention_until');
  await a('amina_tel_artifacts', 'integer', 'version', { default: 1 });
  await a('amina_tel_artifacts', 'text', 'metadata', { size: 100000 });
  await a('amina_tel_artifacts', 'datetime', 'created_at');
  await a('amina_tel_artifacts', 'datetime', 'updated_at');
  await sleep(3000);
  await idx('amina_tel_artifacts', 'idx_session_type', 'unique', ['session_id', 'artifact_type'], ['ASC', 'ASC']);

  // call_outcomes
  console.log('\n📦 telephony_call_outcomes');
  await coll('amina_tel_outcomes', 'Tel Outcomes');
  await a('amina_tel_outcomes', 'string', 'session_id', { size: 100, required: true });
  await a('amina_tel_outcomes', 'string', 'outcome_label', { size: 100, required: true });
  await a('amina_tel_outcomes', 'text', 'result_summary', { size: 50000, required: true });
  await a('amina_tel_outcomes', 'float', 'confidence');
  await a('amina_tel_outcomes', 'text', 'metadata', { size: 100000 });
  await a('amina_tel_outcomes', 'datetime', 'created_at');
  await a('amina_tel_outcomes', 'datetime', 'updated_at');
  await sleep(2000);
  await idx('amina_tel_outcomes', 'idx_session', 'unique', ['session_id'], ['ASC']);

  // call_jobs
  console.log('\n📦 telephony_call_jobs');
  await coll('amina_tel_jobs', 'Tel Jobs');
  await a('amina_tel_jobs', 'string', 'session_id', { size: 100, required: true });
  await a('amina_tel_jobs', 'string', 'job_type', { size: 50, required: true });
  await a('amina_tel_jobs', 'string', 'status', { size: 50, required: true });
  await a('amina_tel_jobs', 'string', 'dedupe_key', { size: 255, required: true });
  await a('amina_tel_jobs', 'integer', 'attempts', { default: 0 });
  await a('amina_tel_jobs', 'integer', 'max_attempts', { default: 5 });
  await a('amina_tel_jobs', 'datetime', 'next_run_at');
  await a('amina_tel_jobs', 'datetime', 'locked_at');
  await a('amina_tel_jobs', 'text', 'payload', { size: 100000 });
  await a('amina_tel_jobs', 'text', 'last_error', { size: 5000 });
  await a('amina_tel_jobs', 'datetime', 'created_at');
  await a('amina_tel_jobs', 'datetime', 'updated_at');
  await sleep(3000);
  await idx('amina_tel_jobs', 'idx_dedupe', 'unique', ['dedupe_key'], ['ASC']);
  await idx('amina_tel_jobs', 'idx_status_due', 'key', ['status', 'next_run_at'], ['ASC', 'ASC']);

  console.log('\n✅ All telephony collections created!');
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
