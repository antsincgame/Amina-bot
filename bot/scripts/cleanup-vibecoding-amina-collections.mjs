#!/usr/bin/env node
/**
 * Delete old amina_* collections from vibecoding project (69aa2114000211b48e63)
 * Run only AFTER confirming everything works on Appwrite amina project.
 *
 * Usage: node scripts/cleanup-vibecoding-amina-collections.mjs
 */
import { Client, Databases } from 'node-appwrite';

// ⚠️ API key must belong to vibecoding project! Create one in Appwrite console if needed.
const VIBECODING_API_KEY = 'standard_06b8634032f75c7d02d49e7a4add952c4183146ce5def3dc0f4a9df7e18307b29193788a0aa7694e6146ac3339a99eae5de4c3ce24b6a284e41f84dad5683cbc9a60ab5b18084171ad9b9a60d470bbce068b4ee21c8231467bd92bec43c9ed9dcfbe6e23f784c4c77e0c88beeacb60f4a7873f2baa936246a7aa4bacbd3c0d57';

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
