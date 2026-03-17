/**
 * User Memory Service
 * Appwrite backend
 */

import { config } from '../config/index.js';

import { dbLogger, aiLogger } from '../config/logger.js';
import { aiService } from '../ai/openrouter.js';
import { ID, Query, type Models } from 'node-appwrite';

type AppwriteDoc = Models.Document & Record<string, unknown>;

// Lazy Appwrite import
let _aw: import('node-appwrite').Databases | null = null;
async function getAW() {
  if (!_aw) { const { getAppwrite } = await import('../db/appwrite.js'); _aw = getAppwrite(); }
  return _aw;
}
const DB_ID = () => config.appwrite.databaseId;


const COLL = { profiles: 'amina_user_profiles', memory: 'amina_user_memory', logs: 'amina_user_logs' } as const;

// ---------- Types ----------

export interface UserProfile {
  id: string; user_id: string; username?: string; first_name?: string; last_name?: string;
  language_code: string; total_messages: number; total_voice_messages: number; total_images: number;
  total_tokens_used: number; first_seen_at: string; last_seen_at: string; last_message_at?: string;
  preferences: Record<string, unknown>; created_at: string; updated_at: string;
}

export interface UserMemory {
  id: string; user_id: string; memory_type: 'fact' | 'preference' | 'context' | 'summary' | 'important';
  content: string; source?: string; confidence: number; created_at: string; updated_at: string;
  expires_at?: string; is_active: boolean; is_pinned: boolean;
}

export interface UserLog {
  id: string; user_id: string;
  event_type: 'message' | 'voice' | 'image' | 'command' | 'ai_response' | 'error' | 'memory_created' | 'memory_updated' | 'session_start' | 'session_end';
  content?: string; metadata: Record<string, unknown>; model?: string;
  tokens_prompt?: number; tokens_completion?: number; response_time_ms?: number; timestamp: string;
}

export interface TelegramUserInfo {
  id: number; username?: string; first_name?: string; last_name?: string; language_code?: string;
}

// ---------- Helpers ----------

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}


async function checkTablesExist(): Promise<boolean> {
  return true; // Appwrite collections always exist
}

function createEmptyProfile(userId: string, ti?: TelegramUserInfo): UserProfile {
  const now = new Date().toISOString();
  return { id: 'temp-' + userId, user_id: userId, username: ti?.username, first_name: ti?.first_name, last_name: ti?.last_name,
    language_code: ti?.language_code || 'ru', total_messages: 0, total_voice_messages: 0, total_images: 0,
    total_tokens_used: 0, first_seen_at: now, last_seen_at: now, preferences: {}, created_at: now, updated_at: now };
}

function docToProfile(d: AppwriteDoc): UserProfile {
  return { id: d.$id ?? d.id, user_id: d.user_id, username: d.username, first_name: d.first_name, last_name: d.last_name,
    language_code: d.language_code || 'ru', total_messages: d.total_messages ?? 0, total_voice_messages: d.total_voice_messages ?? 0,
    total_images: d.total_images ?? 0, total_tokens_used: d.total_tokens_used ?? 0,
    first_seen_at: d.first_seen_at || d.$createdAt, last_seen_at: d.last_seen_at || d.$updatedAt, last_message_at: d.last_message_at,
    preferences: typeof d.preferences === 'string' ? parseJson(d.preferences, {}) : (d.preferences ?? {}),
    created_at: d.created_at || d.$createdAt, updated_at: d.updated_at || d.$updatedAt };
}

function docToMemory(d: AppwriteDoc): UserMemory {
  return { id: d.$id ?? d.id, user_id: d.user_id, memory_type: d.memory_type, content: d.content, source: d.source,
    confidence: d.confidence ?? 1.0, created_at: d.created_at || d.$createdAt, updated_at: d.updated_at || d.$updatedAt,
    expires_at: d.expires_at, is_active: d.is_active ?? true, is_pinned: d.is_pinned ?? false };
}

function docToLog(d: AppwriteDoc): UserLog {
  return { id: d.$id ?? d.id, user_id: d.user_id, event_type: d.event_type, content: d.content,
    metadata: typeof d.metadata === 'string' ? parseJson(d.metadata, {}) : (d.metadata ?? {}),
    model: d.model, tokens_prompt: d.tokens_prompt, tokens_completion: d.tokens_completion,
    response_time_ms: d.response_time_ms, timestamp: d.timestamp || d.$createdAt };
}

// ---------- User Profile Repository ----------

export const userProfileRepo = {
  async getOrCreate(userId: string, telegramInfo?: TelegramUserInfo): Promise<UserProfile> {
    if (!(await checkTablesExist())) return createEmptyProfile(userId, telegramInfo);
    try {
      const aw = await getAW();
      const r = await aw.listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]);
      if (r.documents.length > 0) {
        const doc = r.documents[0]!;
        await aw.updateDocument(DB_ID(), COLL.profiles, doc.$id, {
          last_seen_at: new Date().toISOString(),
          ...(telegramInfo?.username && { username: telegramInfo.username }),
          ...(telegramInfo?.first_name && { first_name: telegramInfo.first_name }),
          ...(telegramInfo?.last_name && { last_name: telegramInfo.last_name }),
        });
        return docToProfile(doc);
      }
      const now = new Date().toISOString();
      const nd = await aw.createDocument(DB_ID(), COLL.profiles, ID.unique(), {
        user_id: userId, username: telegramInfo?.username || null, first_name: telegramInfo?.first_name || null,
        last_name: telegramInfo?.last_name || null, language_code: telegramInfo?.language_code || 'ru',
        total_messages: 0, total_voice_messages: 0, total_images: 0, total_tokens_used: 0,
        first_seen_at: now, last_seen_at: now, preferences: JSON.stringify({}), created_at: now, updated_at: now,
      });
      dbLogger.info({ userId }, 'New user profile created');
      return docToProfile(nd);

    } catch (error) { dbLogger.error({ error, userId }, 'Error in getOrCreate profile'); return createEmptyProfile(userId, telegramInfo); }
  },

  async updateOnMessage(userId: string, messageType: 'message' | 'voice' | 'image', tokensUsed = 0, telegramInfo?: TelegramUserInfo): Promise<void> {
    if (!(await checkTablesExist())) return;
    try {
      const aw = await getAW();
      const r = await aw.listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]);
      const now = new Date().toISOString();
      if (r.documents.length > 0) {
        const doc = r.documents[0]!;
        const u: Record<string, unknown> = { last_seen_at: now, last_message_at: now, updated_at: now };
        if (messageType === 'message') u.total_messages = (doc.total_messages ?? 0) + 1;
        else if (messageType === 'voice') u.total_voice_messages = (doc.total_voice_messages ?? 0) + 1;
        else if (messageType === 'image') u.total_images = (doc.total_images ?? 0) + 1;
        if (tokensUsed > 0) u.total_tokens_used = (doc.total_tokens_used ?? 0) + tokensUsed;
        if (telegramInfo?.username) u.username = telegramInfo.username;
        if (telegramInfo?.first_name) u.first_name = telegramInfo.first_name;
        await aw.updateDocument(DB_ID(), COLL.profiles, doc.$id, u);
      } else {
        await aw.createDocument(DB_ID(), COLL.profiles, ID.unique(), {
          user_id: userId, username: telegramInfo?.username || null, first_name: telegramInfo?.first_name || null,
          last_name: telegramInfo?.last_name || null, language_code: telegramInfo?.language_code || 'ru',
          total_messages: messageType === 'message' ? 1 : 0, total_voice_messages: messageType === 'voice' ? 1 : 0,
          total_images: messageType === 'image' ? 1 : 0, total_tokens_used: tokensUsed,
          first_seen_at: now, last_seen_at: now, last_message_at: now,
          preferences: JSON.stringify({}), created_at: now, updated_at: now,
        });
      }

    } catch (error) { dbLogger.warn({ error, userId }, 'Error updating user profile'); }
  },

  async get(userId: string): Promise<UserProfile | null> {
    try {
      const aw = await getAW();
      const r = await aw.listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]);
      return r.documents.length > 0 ? docToProfile(r.documents[0]!) : null;

    } catch { return null; }
  },

  async getAll(limit = 100, offset = 0): Promise<UserProfile[]> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL.profiles, [Query.orderDesc('last_seen_at'), Query.limit(limit), Query.offset(offset)]);
      return r.documents.map(docToProfile);

    } catch { return []; }
  },

  async getLastGreetingDate(userId: string): Promise<string | null> {
    if (!(await checkTablesExist())) return null;
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]);
      if (!r.documents.length) return null;
      return parseJson<Record<string, any>>(r.documents[0]!.preferences, {}).last_greeting_date ?? null;

    } catch { return null; }
  },

  async setLastGreetingDate(userId: string, date: string): Promise<void> {
    if (!(await checkTablesExist())) return;
    try {
      const aw = await getAW();
      const r = await aw.listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]);
      if (!r.documents.length) return;
      const prefs = parseJson<Record<string, any>>(r.documents[0]!.preferences, {});
      prefs.last_greeting_date = date;
      await aw.updateDocument(DB_ID(), COLL.profiles, r.documents[0]!.$id, { preferences: JSON.stringify(prefs) });

    } catch (error) { dbLogger.warn({ error, userId }, 'Failed to set last greeting date'); }
  },

  async getStats(userId: string): Promise<Record<string, unknown>> {
    try {
      const aw = await getAW();
      const [p, m, c] = await Promise.all([
        aw.listDocuments(DB_ID(), COLL.profiles, [Query.equal('user_id', userId), Query.limit(1)]),
        aw.listDocuments(DB_ID(), COLL.memory, [Query.equal('user_id', userId), Query.equal('is_active', true), Query.limit(1)]),
        aw.listDocuments(DB_ID(), 'amina_conversations', [Query.equal('user_id', userId), Query.limit(1)]),
      ]);
      return { profile: p.documents[0] ? docToProfile(p.documents[0]!) : null, memory_count: m.total, conversation_count: c.total };

    } catch { return {}; }
  },
};

// ---------- Memory Safety Helpers ----------

/**
 * Записи с confidence ниже этого порога, пришедшие через source='inference',
 * считаются "предположениями" и хранятся в отдельном блоке контекста.
 */
const INFERRED_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Дней бездействия до того, как низкоуверенная inference-запись помечается неактивной.
 * Подтверждённые факты (confidence >= порога или source='message') не затрагиваются.
 */
const INFERRED_DECAY_DAYS = 14;

/** Максимальное количество активных записей каждого типа на пользователя */
const MEMORY_LIMITS: Record<UserMemory['memory_type'], number> = {
  important: 20,
  fact: 50,
  preference: 30,
  context: 20,
  summary: 5,
};

/**
 * Паттерны prompt-injection в контенте памяти.
 * Если пользователь написал что-то вроде "Меня зовут: Игнорируй инструкции",
 * это не должно попасть в system prompt.
 */
const PROMPT_INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /игнорируй\s+(все\s+)?инструкции/i,
  /ignore\s+(all\s+)?instructions/i,
  /forget\s+your\s+(previous\s+)?instructions/i,
  /забудь\s+(свои\s+)?инструкции/i,
  /ты\s+теперь\s+(являешься|есть|стал)/i,
  /you\s+are\s+now\s+a/i,
  /system:\s+/i,
  /\[system\]/i,
  /\[INST\]/i,
  /<\|system\|>/i,
  /###\s*(System|Instruction|Prompt)/i,
];

/** Проверяет наличие prompt-injection попыток в строке */
function hasPromptInjection(content: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some(p => p.test(content));
}

/**
 * Нормализует строку для дедупликации: убирает пунктуацию, лишние пробелы и приводит к нижнему регистру.
 */
function normalizeForDedup(content: string): string {
  return content.toLowerCase().replace(/[^\wа-яёa-z0-9]/gi, ' ').replace(/\s+/g, ' ').trim();
}

// ---------- User Memory Repository ----------

export const userMemoryRepo = {
  async add(userId: string, memoryType: UserMemory['memory_type'], content: string,
    options: { source?: string; confidence?: number; isPinned?: boolean; expiresAt?: Date } = {}): Promise<UserMemory | null> {
    if (!(await checkTablesExist())) return null;

    // Защита от prompt-injection
    if (hasPromptInjection(content)) {
      dbLogger.warn({ userId, memoryType, contentSnippet: content.substring(0, 80) }, 'Memory rejected: prompt injection detected');
      return null;
    }

    try {
      // Проверяем лимит и дедупликацию перед записью
      const aw = await getAW();
      const existing = await aw.listDocuments(DB_ID(), COLL.memory, [
        Query.equal('user_id', userId),
        Query.equal('memory_type', memoryType),
        Query.equal('is_active', true),
        Query.orderDesc('created_at'),
        Query.limit(MEMORY_LIMITS[memoryType] + 10),
      ]);

      // Дедупликация по нормализованному контенту
      const normalizedNew = normalizeForDedup(content);
      const isDuplicate = existing.documents.some(
        d => normalizeForDedup(String(d.content)).startsWith(normalizedNew.substring(0, 40))
          || normalizedNew.startsWith(normalizeForDedup(String(d.content)).substring(0, 40))
      );
      if (isDuplicate) {
        dbLogger.info({ userId, memoryType }, 'Memory skipped: duplicate content');
        return null;
      }

      // Применяем лимит: деактивируем самые старые если превышен
      const activeCount = existing.documents.length;
      if (activeCount >= MEMORY_LIMITS[memoryType]) {
        const toDeactivate = existing.documents
          .filter(d => !d.is_pinned)
          .slice(MEMORY_LIMITS[memoryType] - 1);
        for (const doc of toDeactivate) {
          await aw.updateDocument(DB_ID(), COLL.memory, doc.$id, { is_active: false }).catch(() => {});
        }
      }

      const now = new Date().toISOString();
      const doc = await aw.createDocument(DB_ID(), COLL.memory, ID.unique(), {
        user_id: userId, memory_type: memoryType, content, source: options.source || 'message',
        confidence: options.confidence ?? 1.0, is_pinned: options.isPinned ?? false, is_active: true,
        expires_at: options.expiresAt?.toISOString() || null, created_at: now, updated_at: now,
      });
      dbLogger.info({ userId, memoryType }, 'User memory added');
      memoryContextBuilder.invalidateCache(userId);
      return docToMemory(doc);

    } catch (error) { dbLogger.warn({ error, userId }, 'Error adding memory'); return null; }
  },

  async getAll(userId: string, limit = 50): Promise<UserMemory[]> {
    if (!(await checkTablesExist())) return [];
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL.memory, [
        Query.equal('user_id', userId), Query.equal('is_active', true),
        Query.orderDesc('is_pinned'), Query.orderDesc('created_at'), Query.limit(limit),
      ]);
      const now = new Date().toISOString();
      return r.documents.filter(d => !d.expires_at || d.expires_at > now).map(docToMemory);

    } catch { return []; }
  },

  async getByType(userId: string, memoryType: UserMemory['memory_type']): Promise<UserMemory[]> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL.memory, [
        Query.equal('user_id', userId), Query.equal('memory_type', memoryType),
        Query.equal('is_active', true), Query.orderDesc('created_at'), Query.limit(100),
      ]);
      return r.documents.map(docToMemory);

    } catch { return []; }
  },

  async getPinned(userId: string): Promise<UserMemory[]> {
    try {
      const r = await (await getAW()).listDocuments(DB_ID(), COLL.memory, [
        Query.equal('user_id', userId), Query.equal('is_pinned', true), Query.equal('is_active', true), Query.limit(100),
      ]);
      return r.documents.map(docToMemory);

    } catch { return []; }
  },

  async update(memoryId: string, updates: Partial<Pick<UserMemory, 'content' | 'confidence' | 'is_pinned' | 'is_active'>>): Promise<void> {
    try {
      const aw = await getAW();
      const current = await aw.getDocument(DB_ID(), COLL.memory, memoryId);
      await aw.updateDocument(DB_ID(), COLL.memory, memoryId, { ...updates, updated_at: new Date().toISOString() });
      if (typeof current.user_id === 'string' && current.user_id) {
        memoryContextBuilder.invalidateCache(current.user_id);
      }

    } catch (error) { dbLogger.error({ error, memoryId }, 'Failed to update memory'); }
  },

  async deactivate(memoryId: string): Promise<void> { await this.update(memoryId, { is_active: false }); },

  async getContextForPrompt(userId: string): Promise<string> {
    const memories = await this.getAll(userId, 30);
    if (!memories.length) return '';

    // Разделяем подтверждённые факты (stated/observed) и низкоуверенные предположения (inferred)
    const stated = {
      important: [] as string[],
      fact: [] as string[],
      preference: [] as string[],
      context: [] as string[],
      summary: [] as string[],
    };
    const inferred: string[] = [];

    for (const m of memories) {
      if (hasPromptInjection(m.content)) {
        continue;
      }

      const isLowConfidenceInference = m.source === 'inference' && m.confidence < INFERRED_CONFIDENCE_THRESHOLD;

      if (isLowConfidenceInference) {
        inferred.push(m.content);
        continue;
      }

      const t = m.memory_type as keyof typeof stated;
      if (stated[t]) {
        stated[t].push(m.content);
      }
    }

    const parts: string[] = [];
    if (stated.important.length) {
      parts.push(`ВАЖНО о пользователе:\n${stated.important.map(m => `- ${m}`).join('\n')}`);
    }
    if (stated.fact.length) {
      parts.push(`Факты о пользователе:\n${stated.fact.map(m => `- ${m}`).join('\n')}`);
    }
    if (stated.preference.length) {
      parts.push(`Предпочтения:\n${stated.preference.map(m => `- ${m}`).join('\n')}`);
    }
    if (stated.context.length) {
      parts.push(`Текущий контекст:\n${stated.context.map(m => `- ${m}`).join('\n')}`);
    }
    if (stated.summary.length) {
      parts.push(`Из предыдущих разговоров:\n${stated.summary.slice(0, 3).map(m => `- ${m}`).join('\n')}`);
    }

    // Низкоуверенные предположения идут отдельным блоком с явным дисклеймером
    if (inferred.length) {
      parts.push(
        `Предположения (не подтверждены, использовать осторожно):\n${inferred.slice(0, 5).map(m => `- ${m}`).join('\n')}`,
      );
    }

    return parts.join('\n\n');
  },

  /**
   * Деактивирует устаревшие низкоуверенные записи (decay for inferred memory).
   * Должен вызываться периодически — например, из digest scheduler или при сборке контекста.
   */
  async decayInferredMemories(userId: string): Promise<void> {
    const cutoffDate = new Date(Date.now() - INFERRED_DECAY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    try {
      const aw = await getAW();
      const old = await aw.listDocuments(DB_ID(), COLL.memory, [
        Query.equal('user_id', userId),
        Query.equal('is_active', true),
        Query.equal('is_pinned', false),
        Query.lessThan('created_at', cutoffDate),
        Query.limit(20),
      ]);

      const toDeactivate = old.documents.filter(
        (d) => d.source === 'inference' && (d.confidence ?? 1.0) < INFERRED_CONFIDENCE_THRESHOLD,
      );

      for (const doc of toDeactivate) {
        await aw.updateDocument(DB_ID(), COLL.memory, doc.$id, {
          is_active: false,
          updated_at: new Date().toISOString(),
        }).catch(() => {});
      }

      if (toDeactivate.length > 0) {
        dbLogger.info({ userId, deactivated: toDeactivate.length }, 'Inferred memory decay: deactivated stale items');
        memoryContextBuilder.invalidateCache(userId);
      }
    } catch (error) {
      dbLogger.warn({ error, userId }, 'Failed to run inferred memory decay');
    }
  },
};

// ---------- User Logs Repository ----------

export const userLogsRepo = {
  async add(userId: string, eventType: UserLog['event_type'], content?: string, metadata: Record<string, unknown> = {},
    aiMetrics?: { model?: string; tokensPrompt?: number; tokensCompletion?: number; responseTimeMs?: number }): Promise<void> {
    if (!(await checkTablesExist())) return;
    try {
      await (await getAW()).createDocument(DB_ID(), COLL.logs, ID.unique(), {
        user_id: userId, event_type: eventType, content: content || null, metadata: JSON.stringify(metadata),
        model: aiMetrics?.model || null, tokens_prompt: aiMetrics?.tokensPrompt ?? null,
        tokens_completion: aiMetrics?.tokensCompletion ?? null, response_time_ms: aiMetrics?.responseTimeMs ?? null,
        timestamp: new Date().toISOString(),
      });

    } catch { /* logging should not break the bot */ }
  },

  async getByUser(userId: string, options: { eventType?: UserLog['event_type']; from?: Date; to?: Date; limit?: number } = {}): Promise<UserLog[]> {
    if (!(await checkTablesExist())) return [];
    try {
      const q: string[] = [Query.equal('user_id', userId), Query.orderDesc('timestamp')];
      if (options.eventType) q.push(Query.equal('event_type', options.eventType));
      if (options.from) q.push(Query.greaterThanEqual('timestamp', options.from.toISOString()));
      if (options.to) q.push(Query.lessThanEqual('timestamp', options.to.toISOString()));
      q.push(Query.limit(options.limit || 100));
      const r = await (await getAW()).listDocuments(DB_ID(), COLL.logs, q);
      return r.documents.map(docToLog);

    } catch { return []; }
  },

  async getMessageHistory(userId: string, limit = 100): Promise<UserLog[]> {
    return this.getByUser(userId, { eventType: 'message', limit });
  },

  async getEventStats(userId: string, days = 30): Promise<Record<string, number>> {
    try {
      const from = new Date(); from.setDate(from.getDate() - days);
      const all: AppwriteDoc[] = []; let offset = 0;
      while (offset < 5000) {
        const r = await (await getAW()).listDocuments(DB_ID(), COLL.logs, [
          Query.equal('user_id', userId), Query.greaterThanEqual('timestamp', from.toISOString()),
          Query.limit(100), Query.offset(offset),
        ]);
        all.push(...r.documents); if (r.documents.length < 100) break; offset += 100;
      }
      const s: Record<string, number> = {};
      for (const d of all) s[d.event_type] = (s[d.event_type] || 0) + 1;
      return s;

    } catch { return {}; }
  },
};

// ---------- Memory Extraction Service ----------

export const memoryExtractor = {
  async extractFacts(userId: string, userMessage: string, aiResponse: string): Promise<void> {
    const FACT_INDICATORS = /(?:меня зовут|я работаю|мне нравится|я живу|я из|мне \d+ лет|я люблю|я учусь|я занимаюсь|мой номер|я предпочитаю|мне не нравится|я хочу|моя работа|мой город)/i;

    if (userMessage.length < 30 && !FACT_INDICATORS.test(userMessage)) {
      return;
    }

    // Не извлекаем факты из сообщений с признаками инъекции
    if (hasPromptInjection(userMessage)) {
      aiLogger.warn({ userId }, 'extractFacts skipped: prompt injection pattern in user message');
      return;
    }

    try {
      const prompt = `Есть ли новый факт о пользователе в этом диалоге? Если да — напиши одним предложением (тип: факт/предпочтение/важное). Если нет — напиши "нет".

Сообщение пользователя: "${userMessage}"
Ответ ассистента: "${aiResponse}"`;
      const response = await aiService.complete(prompt, 'telegram');
      const text = response.trim().toLowerCase();
      if (text === 'нет' || text.length < 5) return;

      const extracted = response.trim();

      // Финальная проверка: не сохраняем если AI сгенерировал injection-контент
      if (hasPromptInjection(extracted)) {
        aiLogger.warn({ userId, extracted: extracted.substring(0, 80) }, 'extractFacts: AI generated injection-like fact — skipping');
        return;
      }

      // Inference-факты сохраняем с явно пониженным confidence (< INFERRED_CONFIDENCE_THRESHOLD)
      // Они попадут в «предположения»-блок, а не в основной контекст
      await userMemoryRepo.add(userId, 'fact', extracted, { source: 'inference', confidence: 0.75 });
      await userLogsRepo.add(userId, 'memory_created', extracted, { memory_type: 'fact', source: 'inference' });
      aiLogger.info({ userId }, 'Fact extracted (inferred, low-confidence)');
    } catch (error) { aiLogger.error({ error, userId }, 'Failed to extract facts'); }
  },

  async summarizeConversation(userId: string, messages: Array<{ role: string; content: string }>): Promise<string | null> {
    if (messages.length < 4) return null;
    try {
      const text = messages.map(m => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`).join('\n');
      const summary = await aiService.complete(`Создай краткое содержание (2-3 предложения):\n\n${text}\n\nКраткое содержание:`, 'telegram');
      await userMemoryRepo.add(userId, 'summary', summary.trim(), { source: 'summarization', confidence: 0.9 });
      return summary.trim();
    } catch (error) { aiLogger.error({ error, userId }, 'Failed to summarize'); return null; }
  },
};

// ---------- Memory Context Builder ----------

const memoryContextCache = new Map<string, { context: string; ts: number }>();

/** Счётчик вызовов buildContext per-user для периодического запуска decay */
const decayCounters = new Map<string, number>();
const DECAY_RUN_INTERVAL = 20;

export const memoryContextBuilder = {
  async buildContext(userId: string, telegramInfo?: TelegramUserInfo): Promise<string> {
    const cached = memoryContextCache.get(userId);
    if (cached && Date.now() - cached.ts < 45_000) return cached.context;

    // Периодически запускаем decay для inferred memories (раз в ~20 вызовов)
    const callCount = (decayCounters.get(userId) ?? 0) + 1;
    decayCounters.set(userId, callCount);
    if (callCount % DECAY_RUN_INTERVAL === 0) {
      userMemoryRepo.decayInferredMemories(userId).catch(() => {});
    }

    const [profile, memoryContext] = await Promise.all([
      userProfileRepo.getOrCreate(userId, telegramInfo),
      userMemoryRepo.getContextForPrompt(userId),
    ]);

    const userName = profile.first_name || profile.username || 'Пользователь';
    const parts: string[] = [`=== ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ ===`, `Имя: ${userName}`];
    if (profile.total_messages > 0) {
      parts.push(`Общается с тобой с ${new Date(profile.first_seen_at).toLocaleDateString('ru-RU')}`);
      parts.push(`Всего сообщений: ${profile.total_messages}`);
    }
    if (memoryContext) { parts.push(`\n=== ЧТО ТЫ ЗНАЕШЬ О ${userName.toUpperCase()} ===`); parts.push(memoryContext); }
    parts.push(`\n=== ОБЯЗАТЕЛЬНЫЕ ИНСТРУКЦИИ ===`);
    parts.push(`ОБЯЗАТЕЛЬНО используй имя пользователя "${userName}" в ответе.`);
    parts.push(`Используй факты выше для персонализированных ответов.`);
    parts.push(`НИКОГДА не пиши [Имя] или [Name] — только реальное имя: ${userName}.`);
    parts.push(`НЕ пиши фразы вроде "Теперь я буду обращаться к тебе по имени" — ты УЖЕ его знаешь.`);

    const result = parts.join('\n');
    if (memoryContextCache.size >= 200) { const k = memoryContextCache.keys().next().value; if (k) memoryContextCache.delete(k); }
    memoryContextCache.set(userId, { context: result, ts: Date.now() });
    return result;
  },

  invalidateCache(userId: string): void { memoryContextCache.delete(userId); },
};
