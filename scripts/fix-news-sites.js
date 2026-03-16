#!/usr/bin/env node
/**
 * Перезаписать news-sites данными из backend-каталога.
 * Единый источник истины теперь живёт в коде backend-а.
 */

const BOT_URL = process.env.BOT_URL || 'https://amina-bot.onrender.com';
const ADMIN_JWT = process.env.AMINA_ADMIN_JWT?.trim();

function buildHeaders(extra = {}) {
  return ADMIN_JWT
    ? { ...extra, Authorization: `Bearer ${ADMIN_JWT}` }
    : extra;
}

async function main() {
  const presetsResponse = await fetch(`${BOT_URL}/api/news-sites/presets`);
  if (!presetsResponse.ok) {
    throw new Error(`GET presets failed: ${presetsResponse.status}`);
  }
  const presetsPayload = await presetsResponse.json();
  const allSites = presetsPayload.data?.all || [];

  console.log(`Перезаписываю ${allSites.length} источников на ${BOT_URL}...`);
  const res = await fetch(`${BOT_URL}/api/news-sites`, {
    method: 'POST',
    headers: buildHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(allSites),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`POST failed: ${res.status} ${err}`);
  }

  const result = await res.json();
  console.log(`Готово. Сохранено: ${result.data?.length ?? '?'} источников`);

  const verify = await fetch(`${BOT_URL}/api/news-sites`, {
    headers: buildHeaders(),
  });
  const { data } = await verify.json();
  const withCategory = data.filter((s) => s.category);
  const withType = data.filter((s) => s.type);
  
  const byCat = {};
  for (const s of data) {
    const cat = s.category || 'none';
    byCat[cat] = (byCat[cat] || 0) + 1;
  }
  
  console.log(`Проверка: всего=${data.length}, с category=${withCategory.length}, с type=${withType.length}`);
  console.log('По категориям:', byCat);
}

main().catch((e) => { console.error(e); process.exit(1); });
