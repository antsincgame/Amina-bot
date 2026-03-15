#!/usr/bin/env node
/** Create P1 collections: user_logs, system_logs */
import { Client, Databases, ID } from 'node-appwrite';

const db = new Databases(
  new Client()
    .setEndpoint('https://appwrite.vibecoding.by/v1')
    .setProject('69aa2114000211b48e63')
    .setKey('standard_06b8634032f75c7d02d49e7a4add952c4183146ce5def3dc0f4a9df7e18307b29193788a0aa7694e6146ac3339a99eae5de4c3ce24b6a284e41f84dad5683cbc9a60ab5b18084171ad9b9a60d470bbce068b4ee21c8231467bd92bec43c9ed9dcfbe6e23f784c4c77e0c88beeacb60f4a7873f2baa936246a7aa4bacbd3c0d57')
);
const DB = 'vibecoding';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function createColl(id, name) {
  try { await db.getCollection(DB, id); console.log(`  ✓ ${name} exists`); return; }
  catch { await db.createCollection(DB, id, name, []); console.log(`  ✓ Created ${name}`); }
}
async function attr(coll, type, key, opts = {}) {
  try {
    if (type === 'string') await db.createStringAttribute(DB, coll, key, opts.size || 255, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'text') await db.createStringAttribute(DB, coll, key, opts.size || 1000000, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'integer') await db.createIntegerAttribute(DB, coll, key, opts.required ?? false, opts.min, opts.max, opts.default, opts.array ?? false);
    else if (type === 'boolean') await db.createBooleanAttribute(DB, coll, key, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'datetime') await db.createDatetimeAttribute(DB, coll, key, opts.required ?? false, opts.default, opts.array ?? false);
    else if (type === 'enum') await db.createEnumAttribute(DB, coll, key, opts.elements, opts.required ?? false, opts.default, opts.array ?? false);
    console.log(`    + ${key}`);
  } catch (e) { if (e.code === 409) console.log(`    ~ ${key} exists`); else console.error(`    ✗ ${key}: ${e.message}`); }
}
async function idx(coll, key, type, attrs, orders) {
  try { await db.createIndex(DB, coll, key, type, attrs, orders); console.log(`    idx: ${key}`); }
  catch (e) { if (e.code === 409) console.log(`    idx: ${key} exists`); else console.error(`    idx ✗ ${key}: ${e.message}`); }
}

async function main() {
  console.log('📦 user_logs');
  await createColl('amina_user_logs', 'Amina User Logs');
  await attr('amina_user_logs', 'string', 'user_id', { size: 50, required: true });
  await attr('amina_user_logs', 'enum', 'event_type', { elements: ['message','voice','image','command','ai_response','error','memory_created','memory_updated','session_start','session_end'], required: true });
  await attr('amina_user_logs', 'text', 'content', { size: 50000 });
  await attr('amina_user_logs', 'text', 'metadata', { size: 100000 }); // JSON
  await attr('amina_user_logs', 'string', 'model', { size: 100 });
  await attr('amina_user_logs', 'integer', 'tokens_prompt');
  await attr('amina_user_logs', 'integer', 'tokens_completion');
  await attr('amina_user_logs', 'integer', 'response_time_ms');
  await attr('amina_user_logs', 'datetime', 'timestamp');
  await sleep(3000);
  await idx('amina_user_logs', 'idx_user', 'key', ['user_id'], ['ASC']);
  await idx('amina_user_logs', 'idx_timestamp', 'key', ['timestamp'], ['DESC']);
  await idx('amina_user_logs', 'idx_user_type', 'key', ['user_id', 'event_type'], ['ASC', 'ASC']);

  console.log('\n✅ Done!');
}
main().catch(e => { console.error('FATAL:', e); process.exit(1); });
