#!/usr/bin/env node
/**
 * Добавить пресеты news-sites через backend API.
 *
 * Использование:
 *   node scripts/add-news-presets.js
 *   node scripts/add-news-presets.js asia
 *   BOT_URL=https://amina-bot.onrender.com node scripts/add-news-presets.js global
 */

const BOT_URL = process.env.BOT_URL || 'https://amina-bot.onrender.com';
const groupArg = (process.argv[2] || 'all').trim().toLowerCase();
const group = ['all', 'global', 'asia'].includes(groupArg) ? groupArg : 'all';

async function main() {
  console.log(`Синхронизирую пресеты группы "${group}" через ${BOT_URL}...`);
  const saveRes = await fetch(`${BOT_URL}/api/news-sites/add-presets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ group }),
  });

  if (!saveRes.ok) {
    const err = await saveRes.text();
    throw new Error(`POST failed: ${saveRes.status} ${err}`);
  }

  const result = await saveRes.json();
  console.log(`Готово. Добавлено: ${result.data?.added ?? 0}, всего: ${result.data?.total ?? '?'}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
