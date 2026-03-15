#!/usr/bin/env node
/**
 * Fix v2: recreate amina_tel_scenarios and amina_tel_sessions
 *
 * Appwrite uses MariaDB with utf8mb4 (4 bytes/char).
 * Row limit = 65535 bytes. So total chars across ALL string attrs ≈ 16383.
 *
 * Scenarios budget:  fixed strings ~1850 bytes → ~63685 bytes left → ~15921 chars for text
 * Sessions budget:   fixed strings ~6244 bytes → ~59291 bytes left → ~14822 chars for text
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
    else if (type === 'text') await db.createStringAttribute(DB, c, key, opts.size || 1000, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'integer') await db.createIntegerAttribute(DB, c, key, opts.required ?? false, opts.min, opts.max, opts.default, opts.array ?? false);
    else if (type === 'float') await db.createFloatAttribute(DB, c, key, opts.required ?? false, opts.min, opts.max, opts.default, opts.array ?? false);
    else if (type === 'boolean') await db.createBooleanAttribute(DB, c, key, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'datetime') await db.createDatetimeAttribute(DB, c, key, opts.required ?? false, opts.default, opts.array ?? false);
    console.log(`    + ${key} (${type}${opts.size ? ':'+opts.size : ''})`);
  } catch (e) { if (e.code === 409) console.log(`    ~ ${key} exists`); else { console.error(`    ✗ ${key}: ${e.message}`); process.exit(1); } }
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

  // Clear events from failed first migration (they'll be re-imported)
  console.log('🧹 Clearing events from previous migration attempt...');
  try {
    const { Query } = await import('node-appwrite');
    let cleared = 0;
    while (true) {
      const r = await db.listDocuments(DB, 'amina_tel_events', [Query.limit(100)]);
      if (r.documents.length === 0) break;
      for (const doc of r.documents) { await db.deleteDocument(DB, 'amina_tel_events', doc.$id); cleared++; }
    }
    console.log(`  ✓ Cleared ${cleared} event docs`);
  } catch (e) { console.log(`  ~ events: ${e.message}`); }

  await sleep(2000);

  // ═══════════════════════════════════════════════════════
  // amina_tel_scenarios
  // Fixed: scenario_id(100)+name(255)+call_mode(50)+runtime_mode(50) = 455 chars = 1820 bytes
  // Other: bool+2×int+2×datetime ≈ 33 bytes → total fixed ≈ 1853
  // Remaining: 65535 - 1853 = 63682 bytes / 4 = 15920 chars for 7 text fields
  //
  // Allocation (total 15000 chars, safe margin):
  //   system_prompt: 3000, result_prompt: 3000, policy: 3000
  //   goal: 1500, opening_line: 1500, question_hint: 1500, success_criteria: 1500
  // ═══════════════════════════════════════════════════════
  console.log('\n📦 amina_tel_scenarios (budget: 15920 chars for text, using 15000)');
  await db.createCollection(DB, 'amina_tel_scenarios', 'Tel Scenarios', []);
  await a('amina_tel_scenarios', 'string', 'scenario_id', { size: 100, required: true });
  await a('amina_tel_scenarios', 'string', 'name', { size: 255, required: true });
  await a('amina_tel_scenarios', 'boolean', 'enabled', { default: true });
  await a('amina_tel_scenarios', 'string', 'call_mode', { size: 50, required: true });
  await a('amina_tel_scenarios', 'string', 'runtime_mode', { size: 50 });
  await a('amina_tel_scenarios', 'integer', 'policy_version', { default: 1 });
  await a('amina_tel_scenarios', 'text', 'policy', { size: 3000 });
  await a('amina_tel_scenarios', 'text', 'goal', { size: 1500 });
  await a('amina_tel_scenarios', 'text', 'system_prompt', { size: 3000 });
  await a('amina_tel_scenarios', 'text', 'opening_line', { size: 1500 });
  await a('amina_tel_scenarios', 'text', 'question_hint', { size: 1500 });
  await a('amina_tel_scenarios', 'text', 'success_criteria', { size: 1500 });
  await a('amina_tel_scenarios', 'text', 'result_prompt', { size: 3000 });
  await a('amina_tel_scenarios', 'integer', 'max_speech_chars', { default: 420 });
  await a('amina_tel_scenarios', 'datetime', 'created_at');
  await a('amina_tel_scenarios', 'datetime', 'updated_at');
  await sleep(3000);
  await idx('amina_tel_scenarios', 'idx_scenario_id', 'unique', ['scenario_id'], ['ASC']);
  console.log('  ✅ done');

  // ═══════════════════════════════════════════════════════
  // amina_tel_sessions
  // Fixed strings: 1555 chars = 6220 bytes
  // Other: int+2×datetime ≈ 24 bytes → total fixed ≈ 6244
  // Remaining: 65535 - 6244 = 59291 / 4 = 14822 chars for 7 text fields
  //
  // Allocation (total 14600 chars, safe margin):
  //   transcript: 4000, summary: 3000, result_prompt: 2000, result_summary: 2000
  //   scenario_goal: 1200, task: 1200, success_criteria: 1200
  // ═══════════════════════════════════════════════════════
  console.log('\n📦 amina_tel_sessions (budget: 14822 chars for text, using 14600)');
  await db.createCollection(DB, 'amina_tel_sessions', 'Tel Sessions', []);
  await a('amina_tel_sessions', 'string', 'owner_telegram_id', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'initiated_by', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'scenario_id', { size: 100, required: true });
  await a('amina_tel_sessions', 'string', 'scenario_name', { size: 255 });
  await a('amina_tel_sessions', 'text', 'scenario_goal', { size: 1200 });
  await a('amina_tel_sessions', 'string', 'call_mode', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'runtime_mode', { size: 50 });
  await a('amina_tel_sessions', 'integer', 'policy_version', { default: 1 });
  await a('amina_tel_sessions', 'string', 'provider', { size: 50 });
  await a('amina_tel_sessions', 'string', 'target_phone', { size: 50, required: true });
  await a('amina_tel_sessions', 'text', 'task', { size: 1200 });
  await a('amina_tel_sessions', 'text', 'summary', { size: 3000 });
  await a('amina_tel_sessions', 'text', 'success_criteria', { size: 1200 });
  await a('amina_tel_sessions', 'text', 'result_prompt', { size: 2000 });
  await a('amina_tel_sessions', 'string', 'request_id', { size: 100 });
  await a('amina_tel_sessions', 'string', 'request_mode', { size: 50 });
  await a('amina_tel_sessions', 'string', 'call_id', { size: 100 });
  await a('amina_tel_sessions', 'string', 'record_link', { size: 500 });
  await a('amina_tel_sessions', 'text', 'transcript', { size: 4000 });
  await a('amina_tel_sessions', 'text', 'result_summary', { size: 2000 });
  await a('amina_tel_sessions', 'string', 'outcome_label', { size: 100 });
  await a('amina_tel_sessions', 'string', 'status', { size: 50, required: true });
  await a('amina_tel_sessions', 'datetime', 'created_at');
  await a('amina_tel_sessions', 'datetime', 'updated_at');
  await sleep(3000);
  await idx('amina_tel_sessions', 'idx_request_id', 'key', ['request_id'], ['ASC']);
  await idx('amina_tel_sessions', 'idx_call_id', 'key', ['call_id'], ['ASC']);
  await idx('amina_tel_sessions', 'idx_status', 'key', ['status', 'created_at'], ['ASC', 'DESC']);
  console.log('  ✅ done');

  console.log('\n✅ Fix v2 complete! Now re-run: node scripts/migrate-telephony-data.mjs');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
