#!/usr/bin/env node
import { createClient } from '@supabase/supabase-js';
import { Client, Databases, ID } from 'node-appwrite';

const supabase = createClient('https://azdvlsznlvktxvmfswhq.supabase.co', process.env.SUPABASE_SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
const db = new Databases(new Client().setEndpoint('https://appwrite.vibecoding.by/v1').setProject('69aa2114000211b48e63').setKey('standard_06b8634032f75c7d02d49e7a4add952c4183146ce5def3dc0f4a9df7e18307b29193788a0aa7694e6146ac3339a99eae5de4c3ce24b6a284e41f84dad5683cbc9a60ab5b18084171ad9b9a60d470bbce068b4ee21c8231467bd92bec43c9ed9dcfbe6e23f784c4c77e0c88beeacb60f4a7873f2baa936246a7aa4bacbd3c0d57'));
const DB = 'vibecoding';
let c = 0, e = 0;

const iso = v => { try { return v ? new Date(v).toISOString() : null; } catch { return null; } };

async function fetchAll(table) {
  const all = [];
  let from = 0;
  while (true) {
    const { data } = await supabase.from(table).select('*').order('id').range(from, from + 999);
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return all;
}

async function createDoc(coll, data) {
  try { await db.createDocument(DB, coll, ID.unique(), data); c++; }
  catch (err) { e++; if (e <= 3) console.error('  err:', err.message); }
}

// digest_caches
console.log('digest_caches');
const caches = await fetchAll('digest_caches');
console.log('  rows:', caches.length);
for (const r of caches) {
  await createDoc('amina_digest_caches', {
    cache_key: r.cache_key, pipeline: r.pipeline || 'hybrid_supabase',
    digest_date: r.digest_date, city: r.city || null, source_hash: r.source_hash || null,
    payload: JSON.stringify(r.payload || {}), last_error: r.last_error || null,
    expires_at: iso(r.expires_at), created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  });
}

// digest_deliveries
console.log('digest_deliveries');
const deliveries = await fetchAll('digest_deliveries');
console.log('  rows:', deliveries.length);
for (const r of deliveries) {
  await createDoc('amina_digest_deliveries', {
    delivery_key: r.delivery_key, pipeline: r.pipeline || 'hybrid_supabase',
    delivery_kind: r.delivery_kind || 'manual', user_id: String(r.user_id),
    chat_id: Number(r.chat_id), city: r.city || null, digest_date: r.digest_date || null,
    cache_key: r.cache_key || null, status: r.status || 'pending',
    attempt_count: r.attempt_count ?? 0, last_error: r.last_error || null,
    sent_at: iso(r.sent_at), created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  });
}

// voice_messages
console.log('voice_messages');
const voices = await fetchAll('voice_messages');
console.log('  rows:', voices.length);
for (const r of voices) {
  await createDoc('amina_voice_messages', {
    user_id: String(r.user_id), file_path: r.file_path,
    duration: r.duration ?? 0, file_size: r.file_size ?? 0,
    transcription: r.transcription || null, telegram_file_id: r.telegram_file_id || null,
    created_at: iso(r.created_at),
  });
}

console.log(`\nDone! Created: ${c}, Errors: ${e}`);
