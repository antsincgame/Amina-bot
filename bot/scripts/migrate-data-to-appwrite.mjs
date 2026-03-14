#!/usr/bin/env node
/**
 * Миграция данных Supabase → Appwrite (P0 коллекции)
 * Запуск на VPS: node bot/scripts/migrate-data-to-appwrite.mjs
 *
 * Требует env:
 *   SUPABASE_URL, SUPABASE_SERVICE_KEY (текущие из Coolify)
 */

import { createClient } from '@supabase/supabase-js';
import { Client, Databases, ID, Query } from 'node-appwrite';

// ============ CONFIG ============

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://azdvlsznlvktxvmfswhq.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY;

const AW_ENDPOINT = 'https://appwrite.vibecoding.by/v1';
const AW_PROJECT = '69aa2114000211b48e63';
const AW_KEY = 'standard_06b8634032f75c7d02d49e7a4add952c4183146ce5def3dc0f4a9df7e18307b29193788a0aa7694e6146ac3339a99eae5de4c3ce24b6a284e41f84dad5683cbc9a60ab5b18084171ad9b9a60d470bbce068b4ee21c8231467bd92bec43c9ed9dcfbe6e23f784c4c77e0c88beeacb60f4a7873f2baa936246a7aa4bacbd3c0d57';
const AW_DB = 'vibecoding';

// Collection IDs
const COLL = {
  settings: 'amina_settings',
  prompts: 'amina_prompts',
  conversations: 'amina_conversations',
  analytics: 'amina_analytics',
  user_profiles: 'amina_user_profiles',
  user_memory: 'amina_user_memory',
  reminders: 'amina_reminders',
  notes: 'amina_notes',
  todos: 'amina_todos',
  user_preferences: 'amina_user_preferences',
};

// ============ CLIENTS ============

if (!SUPABASE_KEY) {
  console.error('FATAL: Set SUPABASE_SERVICE_KEY env var');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const awClient = new Client()
  .setEndpoint(AW_ENDPOINT)
  .setProject(AW_PROJECT)
  .setKey(AW_KEY);
const db = new Databases(awClient);

// ============ HELPERS ============

let created = 0;
let skipped = 0;
let errors = 0;

async function fetchAll(table, orderBy = 'id') {
  const all = [];
  let from = 0;
  const step = 1000;
  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .order(orderBy)
      .range(from, from + step - 1);
    if (error) throw new Error(`Supabase fetch ${table}: ${error.message}`);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < step) break;
    from += step;
  }
  return all;
}

async function createDoc(collId, data, dedupeField = null, dedupeValue = null) {
  // Optional dedup check
  if (dedupeField && dedupeValue != null) {
    try {
      const existing = await db.listDocuments(AW_DB, collId, [
        Query.equal(dedupeField, dedupeValue),
        Query.limit(1),
      ]);
      if (existing.documents.length > 0) {
        skipped++;
        return existing.documents[0];
      }
    } catch { /* ignore */ }
  }

  try {
    const doc = await db.createDocument(AW_DB, collId, ID.unique(), data);
    created++;
    return doc;
  } catch (e) {
    errors++;
    console.error(`  ✗ ${collId}: ${e.message}`);
    return null;
  }
}

function toIso(val) {
  if (!val) return null;
  try { return new Date(val).toISOString(); } catch { return null; }
}

// ============ MIGRATE EACH TABLE ============

async function migrateSettings() {
  console.log('\n📦 settings');
  const rows = await fetchAll('settings', 'key');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc(COLL.settings, {
      key: r.key,
      value: r.value,
      updated_at: toIso(r.updated_at),
    }, 'key', r.key);
  }
}

async function migratePrompts() {
  console.log('\n📦 prompts');
  const rows = await fetchAll('prompts');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc(COLL.prompts, {
      name: r.name,
      content: r.content,
      is_active: r.is_active ?? false,
      channel: r.channel,
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }, 'name', r.name);
  }
}

async function migrateConversations() {
  console.log('\n📦 conversations');
  const rows = await fetchAll('conversations');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc(COLL.conversations, {
      user_id: String(r.user_id),
      channel: r.channel,
      messages: JSON.stringify(r.messages || []),
      metadata: JSON.stringify(r.metadata || {}),
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }, 'user_id', String(r.user_id));
  }
}

async function migrateUserProfiles() {
  console.log('\n📦 user_profiles');
  const rows = await fetchAll('user_profiles', 'user_id');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc(COLL.user_profiles, {
      user_id: String(r.user_id),
      username: r.username || null,
      first_name: r.first_name || null,
      last_name: r.last_name || null,
      language_code: r.language_code || null,
      total_messages: r.total_messages ?? 0,
      total_voice_messages: r.total_voice_messages ?? 0,
      total_images: r.total_images ?? 0,
      total_tokens_used: r.total_tokens_used ?? 0,
      first_seen_at: toIso(r.first_seen_at),
      last_seen_at: toIso(r.last_seen_at),
      last_message_at: toIso(r.last_message_at),
      preferences: JSON.stringify(r.preferences || {}),
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }, 'user_id', String(r.user_id));
  }
}

async function migrateUserMemory() {
  console.log('\n📦 user_memory');
  const rows = await fetchAll('user_memory');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc(COLL.user_memory, {
      user_id: String(r.user_id),
      memory_type: r.memory_type,
      content: r.content,
      source: r.source || null,
      confidence: r.confidence ?? 1.0,
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
      expires_at: toIso(r.expires_at),
      is_active: r.is_active ?? true,
      is_pinned: r.is_pinned ?? false,
    });
  }
}

async function migrateReminders() {
  console.log('\n📦 reminders');
  const rows = await fetchAll('reminders');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc(COLL.reminders, {
      user_id: String(r.user_id),
      chat_id: Number(r.chat_id),
      task: r.task,
      scheduled_at: toIso(r.scheduled_at),
      is_completed: r.is_completed ?? false,
      completed_at: toIso(r.completed_at),
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    });
  }
}

async function migrateNotes() {
  console.log('\n📦 notes');
  const rows = await fetchAll('notes');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc(COLL.notes, {
      user_id: String(r.user_id),
      content: r.content,
      created_at: toIso(r.created_at),
    });
  }
}

async function migrateTodos() {
  console.log('\n📦 todos');
  const rows = await fetchAll('todos');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc(COLL.todos, {
      user_id: String(r.user_id),
      task: r.task,
      is_done: r.is_done ?? false,
      done_at: toIso(r.done_at),
      created_at: toIso(r.created_at),
    });
  }
}

async function migrateUserPreferences() {
  console.log('\n📦 user_preferences');
  const rows = await fetchAll('user_preferences', 'user_id');
  console.log(`  Supabase: ${rows.length} rows`);
  for (const r of rows) {
    await createDoc(COLL.user_preferences, {
      user_id: String(r.user_id),
      chat_id: Number(r.chat_id),
      digest_enabled: r.digest_enabled ?? false,
      digest_hour: r.digest_hour ?? 8,
      digest_city: r.digest_city || null,
      first_name: r.first_name || null,
      timezone: r.timezone || null,
      created_at: toIso(r.created_at),
      updated_at: toIso(r.updated_at),
    }, 'user_id', String(r.user_id));
  }
}

// ============ MAIN ============

async function main() {
  console.log('🚀 Amina-bot: Migrate Supabase → Appwrite');
  console.log(`   From: ${SUPABASE_URL}`);
  console.log(`   To:   ${AW_ENDPOINT} (db: ${AW_DB})`);

  await migrateSettings();
  await migratePrompts();
  await migrateConversations();
  await migrateUserProfiles();
  await migrateUserMemory();
  await migrateReminders();
  await migrateNotes();
  await migrateTodos();
  await migrateUserPreferences();

  console.log('\n' + '='.repeat(40));
  console.log(`✅ Done! Created: ${created}, Skipped: ${skipped}, Errors: ${errors}`);

  if (errors > 0) {
    console.log('⚠️  Some records failed — re-run is safe (dedup by key/user_id)');
  }
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
