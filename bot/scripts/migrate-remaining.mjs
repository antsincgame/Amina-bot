#!/usr/bin/env node
/**
 * Домиграция оставшихся таблиц Supabase → Appwrite
 * Запуск: SUPABASE_SERVICE_KEY=... node bot/scripts/migrate-remaining.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { Client, Databases, ID, Query } from 'node-appwrite';

const SUPABASE_URL = 'https://azdvlsznlvktxvmfswhq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const AW_ENDPOINT = 'https://appwrite.vibecoding.by/v1';
const AW_PROJECT = '69aa2114000211b48e63';
const AW_KEY = 'standard_06b8634032f75c7d02d49e7a4add952c4183146ce5def3dc0f4a9df7e18307b29193788a0aa7694e6146ac3339a99eae5de4c3ce24b6a284e41f84dad5683cbc9a60ab5b18084171ad9b9a60d470bbce068b4ee21c8231467bd92bec43c9ed9dcfbe6e23f784c4c77e0c88beeacb60f4a7873f2baa936246a7aa4bacbd3c0d57';
const AW_DB = 'vibecoding';

if (!SUPABASE_KEY) { console.error('Set SUPABASE_SERVICE_KEY'); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const db = new Databases(new Client().setEndpoint(AW_ENDPOINT).setProject(AW_PROJECT).setKey(AW_KEY));

let created = 0, skipped = 0, errors = 0;

async function fetchAll(table, orderBy = 'id', filter = null) {
  const all = [];
  let from = 0;
  const step = 1000;
  while (true) {
    let q = supabase.from(table).select('*').order(orderBy).range(from, from + step - 1);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`Supabase fetch ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < step) break;
    from += step;
  }
  return all;
}

async function createDoc(collId, data) {
  try {
    await db.createDocument(AW_DB, collId, ID.unique(), data);
    created++;
  } catch (e) {
    if (e.code === 409) { skipped++; }
    else { errors++; if (errors <= 5) console.error(`  ✗ ${collId}: ${e.message}`); }
  }
}

function toIso(val) {
  if (!val) return null;
  try { return new Date(val).toISOString(); } catch { return null; }
}

// ============ MIGRATE ============

async function migrateAnalytics() {
  console.log('\n📦 analytics');
  const rows = await fetchAll('analytics', 'id');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc('amina_analytics', {
      event_type: r.event_type || 'unknown',
      data: JSON.stringify(r.data || {}),
      user_id: r.user_id ? String(r.user_id) : null,
      channel: r.channel || 'telegram',
      timestamp: toIso(r.timestamp) || new Date().toISOString(),
    });
  }
}

async function migrateUserLogs() {
  console.log('\n📦 user_logs');
  const rows = await fetchAll('user_logs', 'id');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc('amina_user_logs', {
      user_id: String(r.user_id),
      event_type: r.event_type,
      content: r.content || null,
      metadata: JSON.stringify(r.metadata || {}),
      model: r.model || null,
      tokens_prompt: r.tokens_prompt ?? null,
      tokens_completion: r.tokens_completion ?? null,
      response_time_ms: r.response_time_ms ?? null,
      timestamp: toIso(r.timestamp) || new Date().toISOString(),
    });
  }
}

async function migrateSystemLogs() {
  console.log('\n📦 system_logs (last 7 days only)');
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await fetchAll('system_logs', 'id', (q) => q.gte('timestamp', sevenDaysAgo));
  console.log(`  Supabase: ${rows.length} rows (last 7d)`);
  for (const r of rows) {
    await createDoc('amina_system_logs', {
      level: r.level || 'info',
      module: r.module || 'unknown',
      message: (r.message || '').slice(0, 10000),
      data: r.data ? JSON.stringify(r.data).slice(0, 100000) : null,
      error_stack: r.error_stack?.slice(0, 50000) || null,
      user_id: r.user_id || null,
      request_id: r.request_id || null,
      timestamp: toIso(r.timestamp) || new Date().toISOString(),
    });
  }
}

async function migrateDigestCaches() {
  console.log('\n📦 digest_caches');
  const rows = await fetchAll('digest_caches', 'id');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc('amina_digest_caches', {
      cache_key: r.cache_key,
      pipeline: r.pipeline || 'hybrid_supabase',
      digest_date: r.digest_date,
      city: r.city || null,
      source_hash: r.source_hash || null,
      payload: JSON.stringify(r.payload || {}),
      last_error: r.last_error || null,
      expires_at: toIso(r.expires_at),
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    });
  }
}

async function migrateDigestDeliveries() {
  console.log('\n📦 digest_deliveries');
  const rows = await fetchAll('digest_deliveries', 'id');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc('amina_digest_deliveries', {
      delivery_key: r.delivery_key,
      pipeline: r.pipeline || 'hybrid_supabase',
      delivery_kind: r.delivery_kind || 'manual',
      user_id: String(r.user_id),
      chat_id: Number(r.chat_id),
      city: r.city || null,
      digest_date: r.digest_date || null,
      cache_key: r.cache_key || null,
      status: r.status || 'pending',
      attempt_count: r.attempt_count ?? 0,
      last_error: r.last_error || null,
      sent_at: toIso(r.sent_at),
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    });
  }
}

async function migrateVoiceMessages() {
  console.log('\n📦 voice_messages (metadata only, files stay in Supabase Storage)');
  const rows = await fetchAll('voice_messages', 'id');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc('amina_voice_messages', {
      user_id: String(r.user_id),
      file_path: r.file_path,
      duration: r.duration ?? 0,
      file_size: r.file_size ?? 0,
      transcription: r.transcription || null,
      telegram_file_id: r.telegram_file_id || null,
      created_at: toIso(r.created_at),
    });
  }
}

// ============ MAIN ============

async function main() {
  console.log('🚀 Migrating remaining data Supabase → Appwrite');

  await migrateAnalytics();
  await migrateUserLogs();
  await migrateSystemLogs();
  await migrateDigestCaches();
  await migrateDigestDeliveries();
  await migrateVoiceMessages();

  console.log('\n' + '='.repeat(50));
  console.log(`✅ Done! Created: ${created}, Skipped: ${skipped}, Errors: ${errors}`);
  if (errors > 0) console.log('⚠️  Some records failed — check output above');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
