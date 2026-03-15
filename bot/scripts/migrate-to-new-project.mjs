#!/usr/bin/env node
/**
 * Migrate everything from old project (vibecoding) to new Amina project
 * 1. Create all collections
 * 2. Copy all documents
 */

import { Client, Databases, ID, Query } from 'node-appwrite';

// OLD project (vibecoding)
const OLD_PROJECT = '69aa2114000211b48e63';
const OLD_KEY = 'standard_06b8634032f75c7d02d49e7a4add952c4183146ce5def3dc0f4a9df7e18307b29193788a0aa7694e6146ac3339a99eae5de4c3ce24b6a284e41f84dad5683cbc9a60ab5b18084171ad9b9a60d470bbce068b4ee21c8231467bd92bec43c9ed9dcfbe6e23f784c4c77e0c88beeacb60f4a7873f2baa936246a7aa4bacbd3c0d57';
const OLD_DB = 'vibecoding';

// NEW project (Amina)
const NEW_PROJECT = '69af2faa003646d3574c';
const NEW_KEY = 'standard_809851555374aeafe45e7cab53e88fd3935ff03a5282123b421f2260a7a0053cc29009dbc7e4c687a4f28f713961d4c3d746445690f0c6135d907fbcea41249fb8f7c6422e157e7e97a621034e48dd29b9451a170e59bfdbff564021012d7112849fdb2944ec3f274acf4e9e053534850d8d86117e36eebdf25cbdec7788d80e';
const NEW_DB = 'amina';

const ENDPOINT = 'https://appwrite.vibecoding.by/v1';

const oldDb = new Databases(new Client().setEndpoint(ENDPOINT).setProject(OLD_PROJECT).setKey(OLD_KEY));
const newDb = new Databases(new Client().setEndpoint(ENDPOINT).setProject(NEW_PROJECT).setKey(NEW_KEY));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let created = 0, skipped = 0, errors = 0;

// ============ COLLECTION SETUP ============

async function coll(id, name) {
  try { await newDb.getCollection(NEW_DB, id); console.log(`  ✓ ${name} exists`); }
  catch { await newDb.createCollection(NEW_DB, id, name, []); console.log(`  ✓ Created ${name}`); }
}

async function attr(c, type, key, opts = {}) {
  try {
    if (type === 'string') await newDb.createStringAttribute(NEW_DB, c, key, opts.size || 255, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'text') await newDb.createStringAttribute(NEW_DB, c, key, opts.size || 1000000, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'integer') await newDb.createIntegerAttribute(NEW_DB, c, key, opts.required ?? false, opts.min, opts.max, opts.default, opts.array ?? false);
    else if (type === 'float') await newDb.createFloatAttribute(NEW_DB, c, key, opts.required ?? false, opts.min, opts.max, opts.default, opts.array ?? false);
    else if (type === 'boolean') await newDb.createBooleanAttribute(NEW_DB, c, key, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'datetime') await newDb.createDatetimeAttribute(NEW_DB, c, key, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'enum') await newDb.createEnumAttribute(NEW_DB, c, key, opts.elements, opts.required ?? false, opts.default, opts.array ?? false);
    console.log(`    + ${key}`);
  } catch (e) { if (e.code === 409) console.log(`    ~ ${key} exists`); else console.error(`    ✗ ${key}: ${e.message}`); }
}

async function idx(c, key, type, attrs, orders) {
  try { await newDb.createIndex(NEW_DB, c, key, type, attrs, orders); console.log(`    idx: ${key}`); }
  catch (e) { if (e.code === 409) console.log(`    idx: ${key} exists`); else console.error(`    idx ✗ ${key}: ${e.message}`); }
}

async function createAllCollections() {
  console.log('\n=== CREATING COLLECTIONS ===');

  console.log('\n📦 settings');
  await coll('amina_settings', 'Settings'); await attr('amina_settings', 'string', 'key', { size: 100, required: true }); await attr('amina_settings', 'text', 'value', { size: 50000, required: true }); await attr('amina_settings', 'datetime', 'updated_at'); await sleep(2000); await idx('amina_settings', 'idx_key', 'unique', ['key'], ['ASC']);

  console.log('\n📦 prompts');
  await coll('amina_prompts', 'Prompts'); await attr('amina_prompts', 'string', 'name', { size: 255, required: true }); await attr('amina_prompts', 'text', 'content', { size: 500000, required: true }); await attr('amina_prompts', 'boolean', 'is_active', { default: false }); await attr('amina_prompts', 'enum', 'channel', { elements: ['telegram', 'voice', 'all'], required: true }); await attr('amina_prompts', 'datetime', 'created_at'); await attr('amina_prompts', 'datetime', 'updated_at'); await sleep(2000); await idx('amina_prompts', 'idx_active_channel', 'key', ['is_active', 'channel'], ['ASC', 'ASC']);

  console.log('\n📦 conversations');
  await coll('amina_conversations', 'Conversations'); await attr('amina_conversations', 'string', 'user_id', { size: 50, required: true }); await attr('amina_conversations', 'enum', 'channel', { elements: ['telegram', 'voice'], required: true }); await attr('amina_conversations', 'text', 'messages', { size: 1000000 }); await attr('amina_conversations', 'text', 'metadata', { size: 10000 }); await attr('amina_conversations', 'datetime', 'created_at'); await attr('amina_conversations', 'datetime', 'updated_at'); await sleep(2000); await idx('amina_conversations', 'idx_user_channel', 'key', ['user_id', 'channel'], ['ASC', 'ASC']); await idx('amina_conversations', 'idx_updated', 'key', ['updated_at'], ['DESC']);

  console.log('\n📦 analytics');
  await coll('amina_analytics', 'Analytics'); await attr('amina_analytics', 'string', 'event_type', { size: 50, required: true }); await attr('amina_analytics', 'text', 'data', { size: 100000 }); await attr('amina_analytics', 'string', 'user_id', { size: 50 }); await attr('amina_analytics', 'enum', 'channel', { elements: ['telegram', 'voice', 'admin'], required: true }); await attr('amina_analytics', 'datetime', 'timestamp'); await sleep(2000); await idx('amina_analytics', 'idx_type', 'key', ['event_type'], ['ASC']); await idx('amina_analytics', 'idx_timestamp', 'key', ['timestamp'], ['DESC']);

  console.log('\n📦 user_profiles');
  await coll('amina_user_profiles', 'User Profiles'); await attr('amina_user_profiles', 'string', 'user_id', { size: 50, required: true }); await attr('amina_user_profiles', 'string', 'username', { size: 100 }); await attr('amina_user_profiles', 'string', 'first_name', { size: 100 }); await attr('amina_user_profiles', 'string', 'last_name', { size: 100 }); await attr('amina_user_profiles', 'string', 'language_code', { size: 10 }); await attr('amina_user_profiles', 'integer', 'total_messages', { default: 0 }); await attr('amina_user_profiles', 'integer', 'total_voice_messages', { default: 0 }); await attr('amina_user_profiles', 'integer', 'total_images', { default: 0 }); await attr('amina_user_profiles', 'integer', 'total_tokens_used', { default: 0 }); await attr('amina_user_profiles', 'datetime', 'first_seen_at'); await attr('amina_user_profiles', 'datetime', 'last_seen_at'); await attr('amina_user_profiles', 'datetime', 'last_message_at'); await attr('amina_user_profiles', 'text', 'preferences', { size: 50000 }); await attr('amina_user_profiles', 'datetime', 'created_at'); await attr('amina_user_profiles', 'datetime', 'updated_at'); await sleep(3000); await idx('amina_user_profiles', 'idx_user_id', 'unique', ['user_id'], ['ASC']); await idx('amina_user_profiles', 'idx_last_seen', 'key', ['last_seen_at'], ['DESC']);

  console.log('\n📦 user_memory');
  await coll('amina_user_memory', 'User Memory'); await attr('amina_user_memory', 'string', 'user_id', { size: 50, required: true }); await attr('amina_user_memory', 'enum', 'memory_type', { elements: ['fact', 'preference', 'context', 'summary', 'important'], required: true }); await attr('amina_user_memory', 'text', 'content', { size: 50000, required: true }); await attr('amina_user_memory', 'string', 'source', { size: 50 }); await attr('amina_user_memory', 'float', 'confidence', { default: 1.0 }); await attr('amina_user_memory', 'datetime', 'created_at'); await attr('amina_user_memory', 'datetime', 'updated_at'); await attr('amina_user_memory', 'datetime', 'expires_at'); await attr('amina_user_memory', 'boolean', 'is_active', { default: true }); await attr('amina_user_memory', 'boolean', 'is_pinned', { default: false }); await sleep(2000); await idx('amina_user_memory', 'idx_user', 'key', ['user_id'], ['ASC']); await idx('amina_user_memory', 'idx_user_active', 'key', ['user_id', 'is_active'], ['ASC', 'ASC']);

  console.log('\n📦 user_logs');
  await coll('amina_user_logs', 'User Logs'); await attr('amina_user_logs', 'string', 'user_id', { size: 50, required: true }); await attr('amina_user_logs', 'enum', 'event_type', { elements: ['message','voice','image','command','ai_response','error','memory_created','memory_updated','session_start','session_end'], required: true }); await attr('amina_user_logs', 'text', 'content', { size: 50000 }); await attr('amina_user_logs', 'text', 'metadata', { size: 100000 }); await attr('amina_user_logs', 'string', 'model', { size: 100 }); await attr('amina_user_logs', 'integer', 'tokens_prompt'); await attr('amina_user_logs', 'integer', 'tokens_completion'); await attr('amina_user_logs', 'integer', 'response_time_ms'); await attr('amina_user_logs', 'datetime', 'timestamp'); await sleep(3000); await idx('amina_user_logs', 'idx_user', 'key', ['user_id'], ['ASC']); await idx('amina_user_logs', 'idx_timestamp', 'key', ['timestamp'], ['DESC']);

  console.log('\n📦 reminders');
  await coll('amina_reminders', 'Reminders'); await attr('amina_reminders', 'string', 'user_id', { size: 50, required: true }); await attr('amina_reminders', 'integer', 'chat_id', { required: true }); await attr('amina_reminders', 'text', 'task', { size: 5000, required: true }); await attr('amina_reminders', 'datetime', 'scheduled_at', { required: true }); await attr('amina_reminders', 'boolean', 'is_completed', { default: false }); await attr('amina_reminders', 'datetime', 'completed_at'); await attr('amina_reminders', 'datetime', 'created_at'); await attr('amina_reminders', 'datetime', 'updated_at'); await sleep(2000); await idx('amina_reminders', 'idx_due', 'key', ['scheduled_at', 'is_completed'], ['ASC', 'ASC']); await idx('amina_reminders', 'idx_user', 'key', ['user_id', 'is_completed'], ['ASC', 'ASC']);

  console.log('\n📦 notes');
  await coll('amina_notes', 'Notes'); await attr('amina_notes', 'string', 'user_id', { size: 50, required: true }); await attr('amina_notes', 'text', 'content', { size: 50000, required: true }); await attr('amina_notes', 'datetime', 'created_at'); await sleep(2000); await idx('amina_notes', 'idx_user', 'key', ['user_id'], ['ASC']);

  console.log('\n📦 todos');
  await coll('amina_todos', 'Todos'); await attr('amina_todos', 'string', 'user_id', { size: 50, required: true }); await attr('amina_todos', 'text', 'task', { size: 5000, required: true }); await attr('amina_todos', 'boolean', 'is_done', { default: false }); await attr('amina_todos', 'datetime', 'done_at'); await attr('amina_todos', 'datetime', 'created_at'); await sleep(2000); await idx('amina_todos', 'idx_user_active', 'key', ['user_id', 'is_done'], ['ASC', 'ASC']);

  console.log('\n📦 user_preferences');
  await coll('amina_user_preferences', 'User Preferences'); await attr('amina_user_preferences', 'string', 'user_id', { size: 50, required: true }); await attr('amina_user_preferences', 'integer', 'chat_id', { required: true }); await attr('amina_user_preferences', 'boolean', 'digest_enabled', { default: false }); await attr('amina_user_preferences', 'integer', 'digest_hour', { default: 8 }); await attr('amina_user_preferences', 'string', 'digest_city', { size: 100 }); await attr('amina_user_preferences', 'string', 'first_name', { size: 100 }); await attr('amina_user_preferences', 'string', 'timezone', { size: 50 }); await attr('amina_user_preferences', 'datetime', 'created_at'); await attr('amina_user_preferences', 'datetime', 'updated_at'); await sleep(2000); await idx('amina_user_preferences', 'idx_user_id', 'unique', ['user_id'], ['ASC']); await idx('amina_user_preferences', 'idx_digest', 'key', ['digest_enabled', 'digest_hour'], ['ASC', 'ASC']);

  console.log('\n📦 system_logs');
  await coll('amina_system_logs', 'System Logs'); await attr('amina_system_logs', 'enum', 'level', { elements: ['debug','info','warn','error','fatal'], required: true }); await attr('amina_system_logs', 'string', 'module', { size: 100, required: true }); await attr('amina_system_logs', 'text', 'message', { size: 10000, required: true }); await attr('amina_system_logs', 'text', 'data', { size: 100000 }); await attr('amina_system_logs', 'text', 'error_stack', { size: 50000 }); await attr('amina_system_logs', 'string', 'user_id', { size: 50 }); await attr('amina_system_logs', 'string', 'request_id', { size: 100 }); await attr('amina_system_logs', 'datetime', 'timestamp'); await sleep(3000); await idx('amina_system_logs', 'idx_timestamp', 'key', ['timestamp'], ['DESC']);

  console.log('\n📦 digest_caches');
  await coll('amina_digest_caches', 'Digest Caches'); await attr('amina_digest_caches', 'string', 'cache_key', { size: 255, required: true }); await attr('amina_digest_caches', 'string', 'pipeline', { size: 50, required: true }); await attr('amina_digest_caches', 'string', 'digest_date', { size: 20, required: true }); await attr('amina_digest_caches', 'string', 'city', { size: 100 }); await attr('amina_digest_caches', 'string', 'source_hash', { size: 100 }); await attr('amina_digest_caches', 'text', 'payload', { size: 1000000 }); await attr('amina_digest_caches', 'text', 'last_error', { size: 5000 }); await attr('amina_digest_caches', 'datetime', 'expires_at'); await attr('amina_digest_caches', 'datetime', 'created_at'); await attr('amina_digest_caches', 'datetime', 'updated_at'); await sleep(3000); await idx('amina_digest_caches', 'idx_cache_key', 'unique', ['cache_key'], ['ASC']);

  console.log('\n📦 digest_deliveries');
  await coll('amina_digest_deliveries', 'Digest Deliveries'); await attr('amina_digest_deliveries', 'string', 'delivery_key', { size: 255, required: true }); await attr('amina_digest_deliveries', 'string', 'pipeline', { size: 50, required: true }); await attr('amina_digest_deliveries', 'string', 'delivery_kind', { size: 20, required: true }); await attr('amina_digest_deliveries', 'string', 'user_id', { size: 50, required: true }); await attr('amina_digest_deliveries', 'integer', 'chat_id', { required: true }); await attr('amina_digest_deliveries', 'string', 'city', { size: 100 }); await attr('amina_digest_deliveries', 'string', 'digest_date', { size: 20 }); await attr('amina_digest_deliveries', 'string', 'cache_key', { size: 255 }); await attr('amina_digest_deliveries', 'string', 'status', { size: 20, required: true }); await attr('amina_digest_deliveries', 'integer', 'attempt_count'); await attr('amina_digest_deliveries', 'text', 'last_error', { size: 5000 }); await attr('amina_digest_deliveries', 'datetime', 'sent_at'); await attr('amina_digest_deliveries', 'datetime', 'created_at'); await attr('amina_digest_deliveries', 'datetime', 'updated_at'); await sleep(3000); await idx('amina_digest_deliveries', 'idx_delivery_key', 'unique', ['delivery_key'], ['ASC']);

  console.log('\n📦 voice_messages');
  await coll('amina_voice_messages', 'Voice Messages'); await attr('amina_voice_messages', 'string', 'user_id', { size: 50, required: true }); await attr('amina_voice_messages', 'string', 'file_path', { size: 500, required: true }); await attr('amina_voice_messages', 'integer', 'duration'); await attr('amina_voice_messages', 'integer', 'file_size'); await attr('amina_voice_messages', 'text', 'transcription', { size: 50000 }); await attr('amina_voice_messages', 'string', 'telegram_file_id', { size: 255 }); await attr('amina_voice_messages', 'datetime', 'created_at'); await sleep(3000); await idx('amina_voice_messages', 'idx_user', 'key', ['user_id'], ['ASC']);
}

// ============ DATA COPY ============

const COLLECTIONS = [
  'amina_settings', 'amina_prompts', 'amina_conversations', 'amina_analytics',
  'amina_user_profiles', 'amina_user_memory', 'amina_user_logs',
  'amina_reminders', 'amina_notes', 'amina_todos', 'amina_user_preferences',
  'amina_digest_caches', 'amina_digest_deliveries', 'amina_voice_messages',
];

// System fields to strip
const SYSTEM_FIELDS = ['$id', '$createdAt', '$updatedAt', '$permissions', '$databaseId', '$collectionId'];

async function copyCollection(collId) {
  console.log(`\n📋 Copying ${collId}...`);

  // Fetch all from old
  const allDocs = [];
  let offset = 0;
  while (true) {
    try {
      const result = await oldDb.listDocuments(OLD_DB, collId, [Query.limit(100), Query.offset(offset)]);
      allDocs.push(...result.documents);
      if (result.documents.length < 100) break;
      offset += 100;
      if (offset > 10000) break; // safety
    } catch (e) {
      console.log(`  ⚠ Could not read from old: ${e.message}`);
      return;
    }
  }

  console.log(`  Old project: ${allDocs.length} docs`);
  if (allDocs.length === 0) return;

  // Check how many already in new
  try {
    const check = await newDb.listDocuments(NEW_DB, collId, [Query.limit(1)]);
    if (check.total >= allDocs.length) {
      console.log(`  New project: ${check.total} docs — already migrated, skipping`);
      skipped += allDocs.length;
      return;
    }
    if (check.total > 0) {
      console.log(`  New project: ${check.total} docs already — copying remaining`);
    }
  } catch {}

  // Copy each doc
  for (const doc of allDocs) {
    const data = {};
    for (const [key, value] of Object.entries(doc)) {
      if (!SYSTEM_FIELDS.includes(key)) {
        data[key] = value;
      }
    }

    try {
      await newDb.createDocument(NEW_DB, collId, ID.unique(), data);
      created++;
    } catch (e) {
      if (e.code === 409) { skipped++; }
      else { errors++; if (errors <= 5) console.error(`  ✗ ${e.message}`); }
    }
  }
}

// ============ MAIN ============

async function main() {
  console.log('🚀 Amina: Full migration to new project');
  console.log(`   Old: project ${OLD_PROJECT}, db ${OLD_DB}`);
  console.log(`   New: project ${NEW_PROJECT}, db ${NEW_DB}`);

  // Step 1: Create collections
  await createAllCollections();

  console.log('\n\n=== COPYING DATA ===');

  // Step 2: Copy data (skip system_logs — too large)
  for (const collId of COLLECTIONS) {
    if (collId === 'amina_system_logs') {
      console.log(`\n📋 Skipping ${collId} (logs — will accumulate naturally)`);
      continue;
    }
    await copyCollection(collId);
  }

  console.log('\n' + '='.repeat(50));
  console.log(`✅ Done! Created: ${created}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log('\nNext steps:');
  console.log('1. Update Coolify env vars:');
  console.log(`   APPWRITE_PROJECT_ID=${NEW_PROJECT}`);
  console.log(`   APPWRITE_DATABASE_ID=${NEW_DB}`);
  console.log(`   APPWRITE_API_KEY=standard_809851...`);
  console.log(`   VITE_APPWRITE_PROJECT_ID=${NEW_PROJECT}`);
  console.log('2. Redeploy');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
