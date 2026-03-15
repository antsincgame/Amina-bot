#!/usr/bin/env node
/**
 * Fix: recreate amina_tel_scenarios and amina_tel_sessions
 * with reduced text attribute sizes (Appwrite has per-collection size limit)
 *
 * Usage: node scripts/fix-telephony-collections.mjs
 */
import { Client, Databases } from 'node-appwrite';

const db = new Databases(
  new Client()
    .setEndpoint('https://appwrite.vibecoding.by/v1')
    .setProject('69af2faa003646d3574c')
    .setKey('standard_809851555374aeafe45e7cab53e88fd3935ff03a5282123b421f2260a7a0053cc29009dbc7e4c687a4f28f713961d4c3d746445690f0c6135d907fbcea41249fb8f7c6422e157e7e97a621034e48dd29b9451a170e59bfdbff564021012d7112849fdb2944ec3f274acf4e9e053534850d8d86117e36eebdf25cbdec7788d80e')
);
const DB = 'amina';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function a(c, type, key, opts = {}) {
  try {
    if (type === 'string') await db.createStringAttribute(DB, c, key, opts.size || 255, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'text') await db.createStringAttribute(DB, c, key, opts.size || 5000, opts.required ?? false, opts.default, opts.array ?? false);
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
  // 1. Delete broken collections
  console.log('🗑️  Deleting broken collections...');
  for (const id of ['amina_tel_scenarios', 'amina_tel_sessions']) {
    try { await db.deleteCollection(DB, id); console.log(`  ✓ Deleted ${id}`); }
    catch (e) { console.log(`  ~ ${id}: ${e.message}`); }
  }
  await sleep(2000);

  // 2. Recreate amina_tel_scenarios with reduced sizes
  console.log('\n📦 Recreating amina_tel_scenarios (reduced sizes)');
  await db.createCollection(DB, 'amina_tel_scenarios', 'Tel Scenarios', []);
  await a('amina_tel_scenarios', 'string', 'scenario_id', { size: 100, required: true });
  await a('amina_tel_scenarios', 'string', 'name', { size: 255, required: true });
  await a('amina_tel_scenarios', 'boolean', 'enabled', { default: true });
  await a('amina_tel_scenarios', 'string', 'call_mode', { size: 50, required: true });
  await a('amina_tel_scenarios', 'string', 'runtime_mode', { size: 50 });
  await a('amina_tel_scenarios', 'integer', 'policy_version', { default: 1 });
  await a('amina_tel_scenarios', 'text', 'policy', { size: 10000 });
  await a('amina_tel_scenarios', 'text', 'goal', { size: 2000 });
  await a('amina_tel_scenarios', 'text', 'system_prompt', { size: 10000 });
  await a('amina_tel_scenarios', 'text', 'opening_line', { size: 2000 });
  await a('amina_tel_scenarios', 'text', 'question_hint', { size: 2000 });
  await a('amina_tel_scenarios', 'text', 'success_criteria', { size: 2000 });
  await a('amina_tel_scenarios', 'text', 'result_prompt', { size: 10000 });
  await a('amina_tel_scenarios', 'integer', 'max_speech_chars', { default: 420 });
  await a('amina_tel_scenarios', 'datetime', 'created_at');
  await a('amina_tel_scenarios', 'datetime', 'updated_at');
  await sleep(3000);
  await idx('amina_tel_scenarios', 'idx_scenario_id', 'unique', ['scenario_id'], ['ASC']);
  console.log('  ✓ amina_tel_scenarios recreated');

  // 3. Recreate amina_tel_sessions with reduced sizes
  console.log('\n📦 Recreating amina_tel_sessions (reduced sizes)');
  await db.createCollection(DB, 'amina_tel_sessions', 'Tel Sessions', []);
  await a('amina_tel_sessions', 'string', 'owner_telegram_id', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'initiated_by', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'scenario_id', { size: 100, required: true });
  await a('amina_tel_sessions', 'string', 'scenario_name', { size: 255 });
  await a('amina_tel_sessions', 'text', 'scenario_goal', { size: 2000 });
  await a('amina_tel_sessions', 'string', 'call_mode', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'runtime_mode', { size: 50 });
  await a('amina_tel_sessions', 'integer', 'policy_version', { default: 1 });
  await a('amina_tel_sessions', 'string', 'provider', { size: 50 });
  await a('amina_tel_sessions', 'string', 'target_phone', { size: 50, required: true });
  await a('amina_tel_sessions', 'text', 'task', { size: 2000 });
  await a('amina_tel_sessions', 'text', 'summary', { size: 10000 });
  await a('amina_tel_sessions', 'text', 'success_criteria', { size: 2000 });
  await a('amina_tel_sessions', 'text', 'result_prompt', { size: 10000 });
  await a('amina_tel_sessions', 'string', 'request_id', { size: 100 });
  await a('amina_tel_sessions', 'string', 'request_mode', { size: 50 });
  await a('amina_tel_sessions', 'string', 'call_id', { size: 100 });
  await a('amina_tel_sessions', 'string', 'record_link', { size: 500 });
  await a('amina_tel_sessions', 'text', 'transcript', { size: 50000 });
  await a('amina_tel_sessions', 'text', 'result_summary', { size: 10000 });
  await a('amina_tel_sessions', 'string', 'outcome_label', { size: 100 });
  await a('amina_tel_sessions', 'string', 'status', { size: 50, required: true });
  await a('amina_tel_sessions', 'datetime', 'created_at');
  await a('amina_tel_sessions', 'datetime', 'updated_at');
  await sleep(3000);
  await idx('amina_tel_sessions', 'idx_request_id', 'key', ['request_id'], ['ASC']);
  await idx('amina_tel_sessions', 'idx_call_id', 'key', ['call_id'], ['ASC']);
  await idx('amina_tel_sessions', 'idx_status', 'key', ['status', 'created_at'], ['ASC', 'DESC']);
  console.log('  ✓ amina_tel_sessions recreated');

  console.log('\n✅ Fix complete! Now re-run: node scripts/migrate-telephony-data.mjs');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
