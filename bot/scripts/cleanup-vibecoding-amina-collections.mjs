#!/usr/bin/env node
/**
 * Delete old amina_* collections from vibecoding project (69aa2114000211b48e63)
 * Run only AFTER confirming everything works on Appwrite amina project.
 *
 * Usage: node scripts/cleanup-vibecoding-amina-collections.mjs
 */
import { Client, Databases } from 'node-appwrite';

// ⚠️ API key must belong to vibecoding project! Create one in Appwrite console if needed.
const VIBECODING_API_KEY = process.env.VIBECODING_API_KEY;
if (!VIBECODING_API_KEY) {
  console.error('Set VIBECODING_API_KEY env var (create API key in Appwrite console for vibecoding project)');
  process.exit(1);
}

const client = new Client()
  .setEndpoint('https://appwrite.vibecoding.by/v1')
  .setProject('69aa2114000211b48e63')
  .setKey(VIBECODING_API_KEY);

const db = new Databases(client);
const DB_ID = 'vibecoding';

async function main() {
  console.log('🗑️  Cleaning up amina_* collections from vibecoding project\n');

  const collections = await db.listCollections(DB_ID, undefined, 100);
  const aminaColls = collections.collections.filter(c => c.$id.startsWith('amina_'));

  if (aminaColls.length === 0) {
    console.log('No amina_* collections found. Nothing to clean up.');
    return;
  }

  console.log(`Found ${aminaColls.length} amina_* collections:`);
  for (const c of aminaColls) {
    console.log(`  - ${c.$id} (${c.name})`);
  }

  console.log('\n⚠️  Deleting in 5 seconds... Press Ctrl+C to cancel.');
  await new Promise(r => setTimeout(r, 5000));

  for (const c of aminaColls) {
    try {
      await db.deleteCollection(DB_ID, c.$id);
      console.log(`  ✓ Deleted ${c.$id}`);
    } catch (e) {
      console.error(`  ✗ Failed to delete ${c.$id}:`, e.message);
    }
  }

  console.log('\n✅ Cleanup complete!');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
