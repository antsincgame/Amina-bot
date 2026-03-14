#!/usr/bin/env node
/**
 * Создание P0 коллекций Amina-bot в Appwrite
 * Запуск: node bot/scripts/setup-appwrite-collections.mjs
 */

import { Client, Databases, ID, Query } from 'node-appwrite';

const ENDPOINT = 'https://appwrite.vibecoding.by/v1';
const PROJECT_ID = '69aa2114000211b48e63';
const API_KEY = 'standard_06b8634032f75c7d02d49e7a4add952c4183146ce5def3dc0f4a9df7e18307b29193788a0aa7694e6146ac3339a99eae5de4c3ce24b6a284e41f84dad5683cbc9a60ab5b18084171ad9b9a60d470bbce068b4ee21c8231467bd92bec43c9ed9dcfbe6e23f784c4c77e0c88beeacb60f4a7873f2baa936246a7aa4bacbd3c0d57';
const DATABASE_ID = 'vibecoding';

const client = new Client()
  .setEndpoint(ENDPOINT)
  .setProject(PROJECT_ID)
  .setKey(API_KEY);

const db = new Databases(client);

// Helper: wait for attribute to be available
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForAttribute(collId, attrKey, maxWait = 15000) {
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    try {
      const attr = await db.getAttribute(DATABASE_ID, collId, attrKey);
      if (attr.status === 'available') return;
    } catch { /* not ready yet */ }
    await sleep(500);
  }
  console.warn(`  ⚠ Attribute ${attrKey} not ready after ${maxWait}ms, continuing...`);
}

async function createCollectionSafe(id, name) {
  try {
    await db.getCollection(DATABASE_ID, id);
    console.log(`  ✓ Collection ${name} already exists`);
    return false; // already exists
  } catch {
    await db.createCollection(DATABASE_ID, id, name, [
      // Server-level permissions (API key has full access)
    ]);
    console.log(`  ✓ Created collection: ${name}`);
    return true;
  }
}

async function createAttr(collId, type, key, opts = {}) {
  try {
    switch (type) {
      case 'string':
        await db.createStringAttribute(DATABASE_ID, collId, key,
          opts.size || 255, opts.required ?? false, opts.default ?? undefined, opts.array ?? false);
        break;
      case 'text': // large text
        await db.createStringAttribute(DATABASE_ID, collId, key,
          opts.size || 1000000, opts.required ?? false, opts.default ?? undefined, opts.array ?? false);
        break;
      case 'integer':
        await db.createIntegerAttribute(DATABASE_ID, collId, key,
          opts.required ?? false, opts.min ?? undefined, opts.max ?? undefined, opts.default ?? undefined, opts.array ?? false);
        break;
      case 'float':
        await db.createFloatAttribute(DATABASE_ID, collId, key,
          opts.required ?? false, opts.min ?? undefined, opts.max ?? undefined, opts.default ?? undefined, opts.array ?? false);
        break;
      case 'boolean':
        await db.createBooleanAttribute(DATABASE_ID, collId, key,
          opts.required ?? false, opts.default ?? undefined, opts.array ?? false);
        break;
      case 'datetime':
        await db.createDatetimeAttribute(DATABASE_ID, collId, key,
          opts.required ?? false, opts.default ?? undefined, opts.array ?? false);
        break;
      case 'enum':
        await db.createEnumAttribute(DATABASE_ID, collId, key,
          opts.elements, opts.required ?? false, opts.default ?? undefined, opts.array ?? false);
        break;
    }
    console.log(`    + ${key} (${type})`);
  } catch (e) {
    if (e.code === 409) {
      console.log(`    ~ ${key} already exists`);
    } else {
      console.error(`    ✗ ${key}: ${e.message}`);
    }
  }
}

async function createIdx(collId, key, type, attrs, orders) {
  try {
    await db.createIndex(DATABASE_ID, collId, key, type, attrs, orders);
    console.log(`    idx: ${key}`);
  } catch (e) {
    if (e.code === 409) {
      console.log(`    idx: ${key} already exists`);
    } else {
      console.error(`    idx ✗ ${key}: ${e.message}`);
    }
  }
}

// ============ COLLECTIONS ============

async function setupSettings() {
  console.log('\n📦 settings');
  await createCollectionSafe('amina_settings', 'Amina Settings');
  await createAttr('amina_settings', 'string', 'key', { size: 100, required: true });
  await createAttr('amina_settings', 'text', 'value', { size: 50000, required: true });
  await createAttr('amina_settings', 'datetime', 'updated_at');
  await sleep(2000);
  await createIdx('amina_settings', 'idx_key', 'unique', ['key'], ['ASC']);
}

async function setupPrompts() {
  console.log('\n📦 prompts');
  await createCollectionSafe('amina_prompts', 'Amina Prompts');
  await createAttr('amina_prompts', 'string', 'name', { size: 255, required: true });
  await createAttr('amina_prompts', 'text', 'content', { size: 500000, required: true });
  await createAttr('amina_prompts', 'boolean', 'is_active', { default: false });
  await createAttr('amina_prompts', 'enum', 'channel', { elements: ['telegram', 'voice', 'all'], required: true });
  await createAttr('amina_prompts', 'datetime', 'created_at');
  await createAttr('amina_prompts', 'datetime', 'updated_at');
  await sleep(2000);
  await createIdx('amina_prompts', 'idx_active_channel', 'key', ['is_active', 'channel'], ['ASC', 'ASC']);
  await createIdx('amina_prompts', 'idx_created', 'key', ['created_at'], ['DESC']);
}

async function setupConversations() {
  console.log('\n📦 conversations');
  await createCollectionSafe('amina_conversations', 'Amina Conversations');
  await createAttr('amina_conversations', 'string', 'user_id', { size: 50, required: true });
  await createAttr('amina_conversations', 'enum', 'channel', { elements: ['telegram', 'voice'], required: true });
  await createAttr('amina_conversations', 'text', 'messages', { size: 1000000 }); // JSON string
  await createAttr('amina_conversations', 'text', 'metadata', { size: 10000 }); // JSON string
  await createAttr('amina_conversations', 'datetime', 'created_at');
  await createAttr('amina_conversations', 'datetime', 'updated_at');
  await sleep(2000);
  await createIdx('amina_conversations', 'idx_user_channel', 'key', ['user_id', 'channel'], ['ASC', 'ASC']);
  await createIdx('amina_conversations', 'idx_updated', 'key', ['updated_at'], ['DESC']);
}

async function setupAnalytics() {
  console.log('\n📦 analytics');
  await createCollectionSafe('amina_analytics', 'Amina Analytics');
  await createAttr('amina_analytics', 'string', 'event_type', { size: 50, required: true });
  await createAttr('amina_analytics', 'text', 'data', { size: 100000 }); // JSON string
  await createAttr('amina_analytics', 'string', 'user_id', { size: 50 });
  await createAttr('amina_analytics', 'enum', 'channel', { elements: ['telegram', 'voice', 'admin'], required: true });
  await createAttr('amina_analytics', 'datetime', 'timestamp');
  await sleep(2000);
  await createIdx('amina_analytics', 'idx_type', 'key', ['event_type'], ['ASC']);
  await createIdx('amina_analytics', 'idx_timestamp', 'key', ['timestamp'], ['DESC']);
  await createIdx('amina_analytics', 'idx_user', 'key', ['user_id'], ['ASC']);
}

async function setupUserProfiles() {
  console.log('\n📦 user_profiles');
  await createCollectionSafe('amina_user_profiles', 'Amina User Profiles');
  await createAttr('amina_user_profiles', 'string', 'user_id', { size: 50, required: true });
  await createAttr('amina_user_profiles', 'string', 'username', { size: 100 });
  await createAttr('amina_user_profiles', 'string', 'first_name', { size: 100 });
  await createAttr('amina_user_profiles', 'string', 'last_name', { size: 100 });
  await createAttr('amina_user_profiles', 'string', 'language_code', { size: 10 });
  await createAttr('amina_user_profiles', 'integer', 'total_messages', { default: 0 });
  await createAttr('amina_user_profiles', 'integer', 'total_voice_messages', { default: 0 });
  await createAttr('amina_user_profiles', 'integer', 'total_images', { default: 0 });
  await createAttr('amina_user_profiles', 'integer', 'total_tokens_used', { default: 0 });
  await createAttr('amina_user_profiles', 'datetime', 'first_seen_at');
  await createAttr('amina_user_profiles', 'datetime', 'last_seen_at');
  await createAttr('amina_user_profiles', 'datetime', 'last_message_at');
  await createAttr('amina_user_profiles', 'text', 'preferences', { size: 50000 }); // JSON
  await createAttr('amina_user_profiles', 'datetime', 'created_at');
  await createAttr('amina_user_profiles', 'datetime', 'updated_at');
  await sleep(3000);
  await createIdx('amina_user_profiles', 'idx_user_id', 'unique', ['user_id'], ['ASC']);
  await createIdx('amina_user_profiles', 'idx_last_seen', 'key', ['last_seen_at'], ['DESC']);
}

async function setupUserMemory() {
  console.log('\n📦 user_memory');
  await createCollectionSafe('amina_user_memory', 'Amina User Memory');
  await createAttr('amina_user_memory', 'string', 'user_id', { size: 50, required: true });
  await createAttr('amina_user_memory', 'enum', 'memory_type', {
    elements: ['fact', 'preference', 'context', 'summary', 'important'], required: true
  });
  await createAttr('amina_user_memory', 'text', 'content', { size: 50000, required: true });
  await createAttr('amina_user_memory', 'string', 'source', { size: 50 });
  await createAttr('amina_user_memory', 'float', 'confidence', { default: 1.0 });
  await createAttr('amina_user_memory', 'datetime', 'created_at');
  await createAttr('amina_user_memory', 'datetime', 'updated_at');
  await createAttr('amina_user_memory', 'datetime', 'expires_at');
  await createAttr('amina_user_memory', 'boolean', 'is_active', { default: true });
  await createAttr('amina_user_memory', 'boolean', 'is_pinned', { default: false });
  await sleep(2000);
  await createIdx('amina_user_memory', 'idx_user', 'key', ['user_id'], ['ASC']);
  await createIdx('amina_user_memory', 'idx_user_active', 'key', ['user_id', 'is_active'], ['ASC', 'ASC']);
}

async function setupReminders() {
  console.log('\n📦 reminders');
  await createCollectionSafe('amina_reminders', 'Amina Reminders');
  await createAttr('amina_reminders', 'string', 'user_id', { size: 50, required: true });
  await createAttr('amina_reminders', 'integer', 'chat_id', { required: true });
  await createAttr('amina_reminders', 'text', 'task', { size: 5000, required: true });
  await createAttr('amina_reminders', 'datetime', 'scheduled_at', { required: true });
  await createAttr('amina_reminders', 'boolean', 'is_completed', { default: false });
  await createAttr('amina_reminders', 'datetime', 'completed_at');
  await createAttr('amina_reminders', 'datetime', 'created_at');
  await createAttr('amina_reminders', 'datetime', 'updated_at');
  await sleep(2000);
  await createIdx('amina_reminders', 'idx_due', 'key', ['scheduled_at', 'is_completed'], ['ASC', 'ASC']);
  await createIdx('amina_reminders', 'idx_user', 'key', ['user_id', 'is_completed'], ['ASC', 'ASC']);
}

async function setupNotes() {
  console.log('\n📦 notes');
  await createCollectionSafe('amina_notes', 'Amina Notes');
  await createAttr('amina_notes', 'string', 'user_id', { size: 50, required: true });
  await createAttr('amina_notes', 'text', 'content', { size: 50000, required: true });
  await createAttr('amina_notes', 'datetime', 'created_at');
  await sleep(2000);
  await createIdx('amina_notes', 'idx_user', 'key', ['user_id'], ['ASC']);
}

async function setupTodos() {
  console.log('\n📦 todos');
  await createCollectionSafe('amina_todos', 'Amina Todos');
  await createAttr('amina_todos', 'string', 'user_id', { size: 50, required: true });
  await createAttr('amina_todos', 'text', 'task', { size: 5000, required: true });
  await createAttr('amina_todos', 'boolean', 'is_done', { default: false });
  await createAttr('amina_todos', 'datetime', 'done_at');
  await createAttr('amina_todos', 'datetime', 'created_at');
  await sleep(2000);
  await createIdx('amina_todos', 'idx_user_active', 'key', ['user_id', 'is_done'], ['ASC', 'ASC']);
}

async function setupUserPreferences() {
  console.log('\n📦 user_preferences');
  await createCollectionSafe('amina_user_preferences', 'Amina User Preferences');
  await createAttr('amina_user_preferences', 'string', 'user_id', { size: 50, required: true });
  await createAttr('amina_user_preferences', 'integer', 'chat_id', { required: true });
  await createAttr('amina_user_preferences', 'boolean', 'digest_enabled', { default: false });
  await createAttr('amina_user_preferences', 'integer', 'digest_hour', { default: 8 });
  await createAttr('amina_user_preferences', 'string', 'digest_city', { size: 100 });
  await createAttr('amina_user_preferences', 'string', 'first_name', { size: 100 });
  await createAttr('amina_user_preferences', 'string', 'timezone', { size: 50 });
  await createAttr('amina_user_preferences', 'datetime', 'created_at');
  await createAttr('amina_user_preferences', 'datetime', 'updated_at');
  await sleep(2000);
  await createIdx('amina_user_preferences', 'idx_user_id', 'unique', ['user_id'], ['ASC']);
  await createIdx('amina_user_preferences', 'idx_digest', 'key', ['digest_enabled', 'digest_hour'], ['ASC', 'ASC']);
}

// ============ MAIN ============

async function main() {
  console.log('🚀 Amina-bot: Creating Appwrite collections (P0)');
  console.log(`   Endpoint: ${ENDPOINT}`);
  console.log(`   Database: ${DATABASE_ID}`);

  // Ensure database exists
  try {
    await db.get(DATABASE_ID);
    console.log('✓ Database exists');
  } catch {
    console.error('✗ Database not found! Create it first.');
    process.exit(1);
  }

  await setupSettings();
  await setupPrompts();
  await setupConversations();
  await setupAnalytics();
  await setupUserProfiles();
  await setupUserMemory();
  await setupReminders();
  await setupNotes();
  await setupTodos();
  await setupUserPreferences();

  console.log('\n✅ All P0 collections created!');
  console.log('\nCollection IDs:');
  console.log('  amina_settings');
  console.log('  amina_prompts');
  console.log('  amina_conversations');
  console.log('  amina_analytics');
  console.log('  amina_user_profiles');
  console.log('  amina_user_memory');
  console.log('  amina_reminders');
  console.log('  amina_notes');
  console.log('  amina_todos');
  console.log('  amina_user_preferences');
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
