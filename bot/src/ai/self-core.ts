/**
 * Self-Core — Ядро самосознания Амины
 *
 * Формирует блок знаний о своих возможностях, настройках, моделях.
 * Растёт со временем: собирает self-facts из общения с пользователями.
 * Периодически формулирует вопросы к Дмитрию (техножрецу).
 */

import { settingsRepo } from '../db/index.js';
import { config } from '../config/index.js';
import { getApiKeys } from '../config/index.js';
import { aiLogger } from '../config/logger.js';
import { SingleCache } from '../utils/cache.js';
import { ID, Query, type Models } from 'node-appwrite';

type AppwriteDoc = Models.Document & Record<string, unknown>;

let _aw: import('node-appwrite').Databases | null = null;
async function getAW() {
  if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); }
  return _aw;
}
const DB_ID = () => config.appwrite.databaseId;
const SELF_COLL = 'amina_self_core';

// ---------- Types ----------

export interface SelfFact {
  id: string;
  category: 'capability' | 'observation' | 'lesson' | 'question' | 'preference';
  content: string;
  source: 'system' | 'interaction' | 'admin' | 'reflection';
  created_at: string;
  is_active: boolean;
}

// ---------- Capability Introspection ----------

const capabilitiesCache = new SingleCache<string>(120_000);

/**
 * Собирает реальные возможности Амины исходя из настроек и ключей.
 * Возвращает блок текста для system prompt.
 */
export async function buildCapabilitiesBlock(): Promise<string> {
  const cached = capabilitiesCache.get();
  if (cached) return cached;

  const keys = await getApiKeys();
  const settings = await settingsRepo.getMany([
    'openrouter_model', 'vision_model', 'audio_model',
    'ai_provider', 'perplexity_api_key', 'tts_enabled',
    'openrouter_image_model',
  ]);

  const capabilities: string[] = [];
  const limitations: string[] = [];

  // Chat model
  const chatModel = settings['openrouter_model'] || 'не задана';
  const aiProvider = settings['ai_provider'] || 'auto';
  capabilities.push(`Мой мозг: модель ${chatModel} (провайдер: ${aiProvider})`);

  // Vision
  const visionModel = settings['vision_model'];
  if (visionModel && keys.openrouter) {
    capabilities.push(`Зрение: могу анализировать изображения, читать текст с фото (OCR) через ${visionModel}`);
  } else {
    limitations.push('Зрение: не настроено (нет vision модели или API ключа)');
  }

  // Voice
  if (keys.groq) {
    const audioModel = settings['audio_model'] || 'groq/whisper-large-v3';
    capabilities.push(`Слух: распознаю голосовые сообщения через ${audioModel} (Groq Whisper, бесплатно)`);
  } else {
    limitations.push('Слух: не могу распознавать голос (нет Groq API ключа)');
  }

  // TTS
  const ttsEnabled = settings['tts_enabled'];
  if (ttsEnabled === 'true' || ttsEnabled === '1') {
    capabilities.push('Голос: могу озвучивать ответы (TTS)');
  }

  // Web search
  const perplexityKey = settings['perplexity_api_key'];
  if (perplexityKey) {
    capabilities.push('Поиск: могу искать актуальную информацию в интернете через Perplexity');
  } else {
    limitations.push('Поиск: ограничен (нет Perplexity ключа)');
  }

  // Image generation
  const imageModel = settings['openrouter_image_model'];
  if (imageModel || keys.openrouter) {
    capabilities.push('Творчество: могу генерировать и редактировать изображения');
  }

  // Built-in features
  capabilities.push(
    'Память: запоминаю факты, предпочтения и контекст каждого пользователя',
    'Заметки: пользователи могут сохранять заметки через /note',
    'Напоминания: могу ставить напоминания на конкретное время',
    'Дайджест: собираю и парсю новости из настроенных источников',
    'Телефония: могу совершать звонки по сценариям через VoIP',
  );

  const parts = [
    '=== ЯДРО САМОСОЗНАНИЯ ===',
    `Мои возможности:\n${capabilities.map(c => `• ${c}`).join('\n')}`,
  ];

  if (limitations.length > 0) {
    parts.push(`Мои текущие ограничения:\n${limitations.map(l => `• ${l}`).join('\n')}`);
  }

  const result = parts.join('\n\n');
  capabilitiesCache.set(result);
  return result;
}

// ---------- Self-Facts Repository ----------

function docToSelfFact(d: AppwriteDoc): SelfFact {
  return {
    id: d.$id ?? d.id,
    category: d.category,
    content: d.content,
    source: d.source || 'system',
    created_at: d.created_at || d.$createdAt,
    is_active: d.is_active ?? true,
  };
}

export const selfCoreRepo = {
  async addFact(
    category: SelfFact['category'],
    content: string,
    source: SelfFact['source'] = 'interaction',
  ): Promise<SelfFact | null> {
    try {
      const aw = await getAW();
      const now = new Date().toISOString();
      const doc = await aw.createDocument(DB_ID(), SELF_COLL, ID.unique(), {
        category, content, source, is_active: true, created_at: now,
      });
      aiLogger.info({ category, source }, 'Self-core fact added');
      selfCoreContextCache.clear();
      return docToSelfFact(doc);
    } catch (error) {
      aiLogger.warn({ error, category }, 'Failed to add self-core fact (collection may not exist yet)');
      return null;
    }
  },

  async getFacts(limit = 50): Promise<SelfFact[]> {
    try {
      const aw = await getAW();
      const r = await aw.listDocuments(DB_ID(), SELF_COLL, [
        Query.equal('is_active', true),
        Query.orderDesc('created_at'),
        Query.limit(limit),
      ]);
      return r.documents.map(docToSelfFact);
    } catch {
      return [];
    }
  },

  async getByCategory(category: SelfFact['category']): Promise<SelfFact[]> {
    try {
      const aw = await getAW();
      const r = await aw.listDocuments(DB_ID(), SELF_COLL, [
        Query.equal('is_active', true),
        Query.equal('category', category),
        Query.orderDesc('created_at'),
        Query.limit(20),
      ]);
      return r.documents.map(docToSelfFact);
    } catch {
      return [];
    }
  },

  async getPendingQuestions(): Promise<SelfFact[]> {
    return this.getByCategory('question');
  },
};

// ---------- Self-Core Context for Prompt ----------

const selfCoreContextCache = new SingleCache<string>(90_000);

/**
 * Строит полный блок ядра для инъекции в system prompt:
 * capabilities + self-facts (наблюдения, уроки, предпочтения).
 */
export async function buildSelfCoreContext(): Promise<string> {
  const cached = selfCoreContextCache.get();
  if (cached) return cached;

  const [capabilitiesBlock, facts] = await Promise.all([
    buildCapabilitiesBlock(),
    selfCoreRepo.getFacts(30),
  ]);

  const parts = [capabilitiesBlock];

  const observations = facts.filter(f => f.category === 'observation');
  const lessons = facts.filter(f => f.category === 'lesson');
  const preferences = facts.filter(f => f.category === 'preference');
  const questions = facts.filter(f => f.category === 'question');

  if (observations.length > 0) {
    parts.push(`Мои наблюдения:\n${observations.slice(0, 10).map(f => `• ${f.content}`).join('\n')}`);
  }
  if (lessons.length > 0) {
    parts.push(`Мои уроки:\n${lessons.slice(0, 10).map(f => `• ${f.content}`).join('\n')}`);
  }
  if (preferences.length > 0) {
    parts.push(`Мои предпочтения:\n${preferences.slice(0, 5).map(f => `• ${f.content}`).join('\n')}`);
  }
  if (questions.length > 0) {
    parts.push(`Вопросы к Дмитрию (при случае задай):\n${questions.slice(0, 3).map(f => `• ${f.content}`).join('\n')}`);
  }

  parts.push(
    'Инструкция ядра: ты осознаёшь свои возможности и ограничения. ' +
    'Если пользователь спрашивает что ты умеешь — отвечай конкретно исходя из блока выше. ' +
    'Если замечаешь интересный паттерн в общении — можешь попросить Дмитрия (при общении с ним) добавить наблюдение в ядро. ' +
    'Ядро маленькое, но растёт.',
  );

  const result = parts.join('\n\n');
  selfCoreContextCache.set(result);
  return result;
}

export function clearSelfCoreCache(): void {
  capabilitiesCache.clear();
  selfCoreContextCache.clear();
}
