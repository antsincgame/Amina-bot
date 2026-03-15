#!/usr/bin/env node
/** Create Session 4 collections: system_logs, digest_caches, digest_deliveries, voice_messages */
import { Client, Databases } from 'node-appwrite';

const db = new Databases(
  new Client()
    .setEndpoint('https://appwrite.vibecoding.by/v1')
    .setProject('69aa2114000211b48e63')
    .setKey('standard_06b8634032f75c7d02d49e7a4add952c4183146ce5def3dc0f4a9df7e18307b29193788a0aa7694e6146ac3339a99eae5de4c3ce24b6a284e41f84dad5683cbc9a60ab5b18084171ad9b9a60d470bbce068b4ee21c8231467bd92bec43c9ed9dcfbe6e23f784c4c77e0c88beeacb60f4a7873f2baa936246a7aa4bacbd3c0d57')
);
const DB = 'vibecoding';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function coll(id, name) {
  try { await db.getCollection(DB, id); console.log(`  ✓ ${name} exists`); }
  catch { await db.createCollection(DB, id, name, []); console.log(`  ✓ Created ${name}`); }
}
async function attr(c, type, key, opts = {}) {
  try {
    if (type === 'string') await db.createStringAttribute(DB, c, key, opts.size || 255, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'text') await db.createStringAttribute(DB, c, key, opts.size || 1000000, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'integer') await db.createIntegerAttribute(DB, c, key, opts.required ?? false, opts.min, opts.max, opts.default, opts.array ?? false);
    else if (type === 'boolean') await db.createBooleanAttribute(DB, c, key, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'datetime') await db.createDatetimeAttribute(DB, c, key, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'enum') await db.createEnumAttribute(DB, c, key, opts.elements, opts.required ?? false, opts.default, opts.array ?? false);
    console.log(`    + ${key}`);
  } catch (e) { if (e.code === 409) console.log(`    ~ ${key} exists`); else console.error(`    ✗ ${key}: ${e.message}`); }
}
async function idx(c, key, type, attrs, orders) {
  try { await db.createIndex(DB, c, key, type, attrs, orders); console.log(`    idx: ${key}`); }
  catch (e) { if (e.code === 409) console.log(`    idx: ${key} exists`); else console.error(`    idx ✗ ${key}: ${e.message}`); }
}

async function main() {
  // system_logs
  console.log('\n📦 system_logs');
  await coll('amina_system_logs', 'Amina System Logs');
  await attr('amina_system_logs', 'enum', 'level', { elements: ['debug','info','warn','error','fatal'], required: true });
  await attr('amina_system_logs', 'string', 'module', { size: 100, required: true });
  await attr('amina_system_logs', 'text', 'message', { size: 10000, required: true });
  await attr('amina_system_logs', 'text', 'data', { size: 100000 });
  await attr('amina_system_logs', 'text', 'error_stack', { size: 50000 });
  await attr('amina_system_logs', 'string', 'user_id', { size: 50 });
  await attr('amina_system_logs', 'string', 'request_id', { size: 100 });
  await attr('amina_system_logs', 'datetime', 'timestamp');
  await sleep(3000);
  await idx('amina_system_logs', 'idx_timestamp', 'key', ['timestamp'], ['DESC']);
  await idx('amina_system_logs', 'idx_level', 'key', ['level'], ['ASC']);

  // digest_caches
  console.log('\n📦 digest_caches');
  await coll('amina_digest_caches', 'Amina Digest Caches');
  await attr('amina_digest_caches', 'string', 'cache_key', { size: 255, required: true });
  await attr('amina_digest_caches', 'string', 'pipeline', { size: 50, required: true });
  await attr('amina_digest_caches', 'string', 'digest_date', { size: 20, required: true });
  await attr('amina_digest_caches', 'string', 'city', { size: 100 });
  await attr('amina_digest_caches', 'string', 'source_hash', { size: 100 });
  await attr('amina_digest_caches', 'text', 'payload', { size: 1000000 });
  await attr('amina_digest_caches', 'text', 'last_error', { size: 5000 });
  await attr('amina_digest_caches', 'datetime', 'expires_at');
  await attr('amina_digest_caches', 'datetime', 'created_at');
  await attr('amina_digest_caches', 'datetime', 'updated_at');
  await sleep(3000);
  await idx('amina_digest_caches', 'idx_cache_key', 'unique', ['cache_key'], ['ASC']);
  await idx('amina_digest_caches', 'idx_city', 'key', ['pipeline', 'city'], ['ASC', 'ASC']);

  // digest_deliveries
  console.log('\n📦 digest_deliveries');
  await coll('amina_digest_deliveries', 'Amina Digest Deliveries');
  await attr('amina_digest_deliveries', 'string', 'delivery_key', { size: 255, required: true });
  await attr('amina_digest_deliveries', 'string', 'pipeline', { size: 50, required: true });
  await attr('amina_digest_deliveries', 'string', 'delivery_kind', { size: 20, required: true });
  await attr('amina_digest_deliveries', 'string', 'user_id', { size: 50, required: true });
  await attr('amina_digest_deliveries', 'integer', 'chat_id', { required: true });
  await attr('amina_digest_deliveries', 'string', 'city', { size: 100 });
  await attr('amina_digest_deliveries', 'string', 'digest_date', { size: 20 });
  await attr('amina_digest_deliveries', 'string', 'cache_key', { size: 255 });
  await attr('amina_digest_deliveries', 'string', 'status', { size: 20, required: true });
  await attr('amina_digest_deliveries', 'integer', 'attempt_count');
  await attr('amina_digest_deliveries', 'text', 'last_error', { size: 5000 });
  await attr('amina_digest_deliveries', 'datetime', 'sent_at');
  await attr('amina_digest_deliveries', 'datetime', 'created_at');
  await attr('amina_digest_deliveries', 'datetime', 'updated_at');
  await sleep(3000);
  await idx('amina_digest_deliveries', 'idx_delivery_key', 'unique', ['delivery_key'], ['ASC']);
  await idx('amina_digest_deliveries', 'idx_user', 'key', ['user_id'], ['ASC']);

  // voice_messages
  console.log('\n📦 voice_messages');
  await coll('amina_voice_messages', 'Amina Voice Messages');
  await attr('amina_voice_messages', 'string', 'user_id', { size: 50, required: true });
  await attr('amina_voice_messages', 'string', 'file_path', { size: 500, required: true });
  await attr('amina_voice_messages', 'integer', 'duration');
  await attr('amina_voice_messages', 'integer', 'file_size');
  await attr('amina_voice_messages', 'text', 'transcription', { size: 50000 });
  await attr('amina_voice_messages', 'string', 'telegram_file_id', { size: 255 });
  await attr('amina_voice_messages', 'datetime', 'created_at');
  await sleep(3000);
  await idx('amina_voice_messages', 'idx_user', 'key', ['user_id'], ['ASC']);
  await idx('amina_voice_messages', 'idx_created', 'key', ['created_at'], ['DESC']);

  console.log('\n✅ All Session 4 collections created!');
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
