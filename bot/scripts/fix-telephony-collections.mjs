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
  // 1. Delete only broken sessions (scenarios are fine from last run)
  console.log('🗑️  Deleting broken amina_tel_sessions...');
  try { await db.deleteCollection(DB, 'amina_tel_sessions'); console.log('  ✓ Deleted'); }
  catch (e) { console.log(`  ~ ${e.message}`); }
  await sleep(2000);

  // amina_tel_scenarios — already created successfully, skip
  console.log('\n📦 amina_tel_scenarios — already OK, skipping');

  // ═══════════════════════════════════════════════════════
  // amina_tel_sessions
  // Appwrite internal columns eat ~2000 extra bytes
  // Total text budget: ~10000 chars to be safe
  // ═══════════════════════════════════════════════════════
  console.log('\n📦 amina_tel_sessions (reduced text budget: 10000 chars)');
  await db.createCollection(DB, 'amina_tel_sessions', 'Tel Sessions', []);
  await a('amina_tel_sessions', 'string', 'owner_telegram_id', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'initiated_by', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'scenario_id', { size: 100, required: true });
  await a('amina_tel_sessions', 'string', 'scenario_name', { size: 255 });
  await a('amina_tel_sessions', 'text', 'scenario_goal', { size: 800 });
  await a('amina_tel_sessions', 'string', 'call_mode', { size: 50, required: true });
  await a('amina_tel_sessions', 'string', 'runtime_mode', { size: 50 });
  await a('amina_tel_sessions', 'integer', 'policy_version', { default: 1 });
  await a('amina_tel_sessions', 'string', 'provider', { size: 50 });
  await a('amina_tel_sessions', 'string', 'target_phone', { size: 50, required: true });
  await a('amina_tel_sessions', 'text', 'task', { size: 800 });
  await a('amina_tel_sessions', 'text', 'summary', { size: 2000 });
  await a('amina_tel_sessions', 'text', 'success_criteria', { size: 800 });
  await a('amina_tel_sessions', 'text', 'result_prompt', { size: 1000 });
  await a('amina_tel_sessions', 'string', 'request_id', { size: 100 });
  await a('amina_tel_sessions', 'string', 'request_mode', { size: 50 });
  await a('amina_tel_sessions', 'string', 'call_id', { size: 100 });
  await a('amina_tel_sessions', 'string', 'record_link', { size: 255 });
  await a('amina_tel_sessions', 'text', 'transcript', { size: 2500 });
  await a('amina_tel_sessions', 'text', 'result_summary', { size: 1200 });
  await a('amina_tel_sessions', 'string', 'outcome_label', { size: 100 });
  await a('amina_tel_sessions', 'string', 'status', { size: 50, required: true });
  await a('amina_tel_sessions', 'datetime', 'created_at');
  await a('amina_tel_sessions', 'datetime', 'updated_at');
  await sleep(3000);
  await idx('amina_tel_sessions', 'idx_request_id', 'key', ['request_id'], ['ASC']);
  await idx('amina_tel_sessions', 'idx_call_id', 'key', ['call_id'], ['ASC']);
  await idx('amina_tel_sessions', 'idx_status', 'key', ['status', 'created_at'], ['ASC', 'DESC']);
  console.log('  ✅ done');

  // ═══════════════════════════════════════════════════════
  // Clear duplicate events and migrate sessions inline
  // ═══════════════════════════════════════════════════════
  console.log('\n🧹 Clearing duplicate events...');
  try {
    const { Query } = await import('node-appwrite');
    let cleared = 0;
    while (true) {
      const r = await db.listDocuments(DB, 'amina_tel_events', [Query.limit(100)]);
      if (r.documents.length === 0) break;
      for (const doc of r.documents) { await db.deleteDocument(DB, 'amina_tel_events', doc.$id); cleared++; }
    }
    console.log(`  ✓ Cleared ${cleared} event docs`);
  } catch (e) { console.log(`  ~ ${e.message}`); }

  console.log('\n📦 Migrating sessions from Supabase...');
  try {
    const { createClient } = await import('@supabase/supabase-js');
    const { ID } = await import('node-appwrite');
    const sb = createClient(
      'https://azdvlsznlvktxvmfswhq.supabase.co',
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF6ZHZsc3pubHZrdHh2bWZzd2hxIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDE1NDkyNSwiZXhwIjoyMDg1NzMwOTI1fQ.7NmdUc57zlNZ8s3sd2OHVI-qcIAR3TSWzFEjRKOgCtE'
    );
    const tr = (v, m) => (!v || typeof v !== 'string') ? v : v.length > m ? v.slice(0, m) : v;
    const { data } = await sb.from('telephony_call_sessions').select('*');
    console.log(`  Found ${(data||[]).length} rows`);
    let ok = 0;
    for (const r of (data || [])) {
      await db.createDocument(DB, 'amina_tel_sessions', ID.unique(), {
        owner_telegram_id: r.owner_telegram_id,
        initiated_by: r.initiated_by,
        scenario_id: r.scenario_id,
        scenario_name: tr(r.scenario_name ?? '', 255),
        scenario_goal: tr(r.scenario_goal ?? '', 800),
        call_mode: r.call_mode,
        runtime_mode: r.runtime_mode ?? 'scripted',
        policy_version: r.policy_version ?? 1,
        provider: r.provider ?? 'unknown',
        target_phone: r.target_phone,
        task: tr(r.task ?? '', 800),
        summary: tr(r.summary ?? '', 2000),
        success_criteria: tr(r.success_criteria ?? '', 800),
        result_prompt: tr(r.result_prompt ?? '', 1000),
        request_id: r.request_id || null,
        request_mode: r.request_mode ?? '',
        call_id: r.call_id || null,
        record_link: tr(r.record_link || null, 255),
        transcript: tr(r.transcript || null, 2500),
        result_summary: tr(r.result_summary || null, 1200),
        outcome_label: r.outcome_label || null,
        status: r.status,
        created_at: r.created_at || new Date().toISOString(),
        updated_at: r.updated_at || new Date().toISOString(),
      });
      ok++;
    }
    console.log(`  ✓ Migrated ${ok} sessions`);
  } catch (e) { console.error(`  ✗ ${e.message}`); }

  console.log('\n✅ All done! Now run: node scripts/migrate-telephony-data.mjs (for events only)');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
