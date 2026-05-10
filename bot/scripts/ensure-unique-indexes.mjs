#!/usr/bin/env node
/**
 * Создаёт уникальные индексы Appwrite для коллекций, где репозиторий
 * использует list-then-create (псевдо-upsert). Без уникальных индексов
 * параллельные «первые сообщения» одного пользователя могут создавать
 * дубликаты документов; multi-worker-race не покрывается in-process mutex.
 *
 * Безопасно перезапускать: 409 (already exists) обрабатывается как «ok».
 *
 * Запуск:
 *   APPWRITE_API_KEY=... node bot/scripts/ensure-unique-indexes.mjs
 *
 * Если в коллекции уже есть дубликаты документов, Appwrite не даст создать
 * unique-индекс (вернёт ошибку валидации). В этом случае нужно сначала
 * удалить дубли вручную или объединить документы (старые/менее заполненные).
 */

import { ensureIndex, sleep, runSchemaSections, bootstrapConfig } from './lib/appwrite-bootstrap.mjs';

const sections = [
  {
    id: 'amina_user_profiles',
    name: 'Amina User Profiles (unique idx)',
    attributes: [],
    waitMs: 0,
    indexes: [
      // Защищает userProfileRepo.getOrCreate / updateOnMessage от создания
      // дубликата профиля при гонке параллельных сообщений нового пользователя.
      { key: 'idx_unique_user', type: 'unique', attributes: ['user_id'], orders: ['ASC'] },
    ],
  },
  {
    id: 'amina_conversations',
    name: 'Amina Conversations (unique idx)',
    attributes: [],
    waitMs: 0,
    indexes: [
      // Защищает conversationsRepo.getOrCreate(userId, channel) от создания
      // двух conversation'ов с одинаковым (user_id, channel).
      { key: 'idx_unique_user_channel', type: 'unique', attributes: ['user_id', 'channel'], orders: ['ASC', 'ASC'] },
    ],
  },
  // amina_settings уже имеет idx_key (unique) в setup-appwrite-collections.mjs
];

async function main() {
  console.log('Ensuring unique indexes target:');
  console.log(`  endpoint: ${bootstrapConfig.endpoint}`);
  console.log(`  project:  ${bootstrapConfig.projectId}`);
  console.log(`  database: ${bootstrapConfig.databaseId}\n`);

  // runSchemaSections тоже подойдёт, но здесь нет attributes — используем напрямую.
  for (const section of sections) {
    console.log(`[${section.id}] ${section.name}`);
    for (const index of section.indexes) {
      try {
        await ensureIndex(section.id, index);
      } catch (error) {
        // Если в коллекции есть дубли — Appwrite вернёт ошибку. Сообщаем,
        // что нужно сначала очистить данные.
        const message = error?.response?.message || error?.message || String(error);
        console.error(`    ✗ failed to create index ${index.key}: ${message}`);
        console.error(`      Подсказка: проверь дубликаты по ${index.attributes.join(', ')} в коллекции ${section.id}.`);
        process.exitCode = 1;
      }
    }
    await sleep(500);
  }
}

main().catch((error) => {
  console.error('Fatal:', error?.response?.message || error?.message || error);
  process.exit(1);
});

// Глушим warning про неиспользуемый импорт (на случай, если runSchemaSections
// ещё пригодится при расширении секций).
void runSchemaSections;
