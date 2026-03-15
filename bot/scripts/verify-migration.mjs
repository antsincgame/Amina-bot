#!/usr/bin/env node
/**
 * Сравнение данных Supabase vs Appwrite
 * Запуск: SUPABASE_SERVICE_KEY=... node bot/scripts/verify-migration.mjs
 */

import { createClient } from '@supabase/supabase-js';
import { Client, Databases, Query } from 'node-appwrite';

const SUPABASE_URL = 'https://azdvlsznlvktxvmfswhq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;

const AW_ENDPOINT = 'https://appwrite.vibecoding.by/v1';
const AW_PROJECT = '69aa2114000211b48e63';
const AW_KEY = 'standard_06b8634032f75c7d02d49e7a4add952c4183146ce5def3dc0f4a9df7e18307b29193788a0aa7694e6146ac3339a99eae5de4c3ce24b6a284e41f84dad5683cbc9a60ab5b18084171ad9b9a60d470bbce068b4ee21c8231467bd92bec43c9ed9dcfbe6e23f784c4c77e0c88beeacb60f4a7873f2baa936246a7aa4bacbd3c0d57';
const AW_DB = 'vibecoding';

if (!SUPABASE_KEY) { console.error('Set SUPABASE_SERVICE_KEY'); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const db = new Databases(new Client().setEndpoint(AW_ENDPOINT).setProject(AW_PROJECT).setKey(AW_KEY));

async function countSupabase(table) {
  const { count, error } = await supabase.from(table).select('*', { count: 'exact', head: true });
  if (error) return `ERR: ${error.message}`;
  return count ?? 0;
}

async function countAppwrite(collId) {
  try {
    const r = await db.listDocuments(AW_DB, collId, [Query.limit(1)]);
    return r.total;
  } catch (e) {
    return `ERR: ${e.message}`;
  }
}

const TABLES = [
  ['settings', 'amina_settings'],
  ['prompts', 'amina_prompts'],
  ['conversations', 'amina_conversations'],
  ['analytics', 'amina_analytics'],
  ['user_profiles', 'amina_user_profiles'],
  ['user_memory', 'amina_user_memory'],
  ['user_logs', 'amina_user_logs'],
  ['reminders', 'amina_reminders'],
  ['notes', 'amina_notes'],
  ['todos', 'amina_todos'],
  ['user_preferences', 'amina_user_preferences'],
  ['system_logs', 'amina_system_logs'],
  ['digest_caches', 'amina_digest_caches'],
  ['digest_deliveries', 'amina_digest_deliveries'],
  ['voice_messages', 'amina_voice_messages'],
];

async function main() {
  console.log('📊 Supabase vs Appwrite — Data Verification\n');
  console.log('Table'.padEnd(25) + 'Supabase'.padStart(10) + 'Appwrite'.padStart(10) + '  Status');
  console.log('─'.repeat(60));

  let allOk = true;

  for (const [sbTable, awColl] of TABLES) {
    const sbCount = await countSupabase(sbTable);
    const awCount = await countAppwrite(awColl);

    const sbStr = String(sbCount).padStart(10);
    const awStr = String(awCount).padStart(10);

    let status = '';
    if (typeof sbCount === 'string' || typeof awCount === 'string') {
      status = '⚠️  error';
      allOk = false;
    } else if (awCount >= sbCount) {
      status = '✅';
    } else {
      status = `❌ missing ${sbCount - awCount}`;
      allOk = false;
    }

    console.log(sbTable.padEnd(25) + sbStr + awStr + '  ' + status);
  }

  console.log('─'.repeat(60));
  console.log(allOk ? '\n✅ All data verified!' : '\n⚠️  Some tables need attention');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
