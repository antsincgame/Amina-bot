import { Client, Databases, ID, Query, type Models } from 'node-appwrite';
import { config } from '../config/index.js';
import { dbLogger } from '../config/logger.js';
import type {
  Settings,
  Prompt,
  Conversation,
  Message,
  AnalyticsEvent,
  AnalyticsEventType,
} from '../../../shared/types/index.js';
import {
  validateUserId,
  validateChannel,
  validateEventType,
  validateLimit,
  checkArraySize,
  MAX_CONVERSATION_MESSAGES,
} from '../utils/validation.js';
import { SETTINGS_CACHE_TTL } from '../config/constants.js';

// --------------------------------------------
// Appwrite Client Singleton
// --------------------------------------------

let appwriteClient: Client | null = null;
let databases: Databases | null = null;

const DB_ID = () => config.appwrite.databaseId;

// Collection IDs (prefixed to avoid collision with existing vibecoding collections)
const COLL = {
  settings: 'amina_settings',
  prompts: 'amina_prompts',
  conversations: 'amina_conversations',
  analytics: 'amina_analytics',
} as const;

export const getAppwrite = (): Databases => {
  if (!databases) {
    appwriteClient = new Client()
      .setEndpoint(config.appwrite.endpoint)
      .setProject(config.appwrite.projectId)
      .setKey(config.appwrite.apiKey);
    databases = new Databases(appwriteClient);
    dbLogger.info('Appwrite client initialized');
  }
  return databases;
};

/** Raw client access for other modules (storage, etc.) */
export const getAppwriteClient = (): Client => {
  if (!appwriteClient) getAppwrite();
  if (!appwriteClient) {
    throw new Error('Appwrite client initialization failed');
  }
  return appwriteClient;
};

// --------------------------------------------
// Helpers
// --------------------------------------------

/** Parse JSON string attribute safely */
function parseJson<T>(raw: string | null | undefined, fallback: T, context?: { collection?: string; field?: string; docId?: string }): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch (err) {
    // Раньше битые данные молча превращались в [] / {} — это маскирует реальную потерю смысла.
    // Логируем (raw усекаем, чтобы не спамить килобайтами) — пользователь увидит проблему в логах.
    const preview = raw.length > 200 ? `${raw.slice(0, 200)}…(${raw.length - 200}b more)` : raw;
    dbLogger.warn(
      { error: err instanceof Error ? err.message : String(err), preview, ...context },
      'parseJson: malformed JSON in DB field — falling back to default',
    );
    return fallback;
  }
}

type AppwriteDoc = Models.Document & Record<string, unknown>;

/** Map Appwrite document → Settings type */
function docToSettings(doc: AppwriteDoc): Settings {
  return {
    id: doc.$id,
    key: doc.key,
    value: doc.value,
    updated_at: doc.updated_at || doc.$updatedAt,
  };
}

/** Map Appwrite document → Prompt type */
function docToPrompt(doc: AppwriteDoc): Prompt {
  return {
    id: doc.$id,
    name: doc.name,
    content: doc.content,
    is_active: doc.is_active ?? false,
    channel: doc.channel,
    created_at: doc.created_at || doc.$createdAt,
    updated_at: doc.updated_at || doc.$updatedAt,
  };
}

/** Map Appwrite document → Conversation type */
function docToConversation(doc: AppwriteDoc): Conversation {
  return {
    id: doc.$id,
    user_id: doc.user_id,
    channel: doc.channel,
    messages: parseJson<Message[]>(
      typeof doc.messages === 'string' ? doc.messages : null,
      [],
      { collection: COLL.conversations, field: 'messages', docId: doc.$id },
    ),
    metadata: parseJson(
      typeof doc.metadata === 'string' ? doc.metadata : null,
      {},
      { collection: COLL.conversations, field: 'metadata', docId: doc.$id },
    ),
    created_at: doc.created_at || doc.$createdAt,
    updated_at: doc.updated_at || doc.$updatedAt,
  };
}

type StoredAnalyticsDoc = Record<string, unknown> & {
  $id: string;
  $createdAt?: string;
  event_type?: string;
  data?: string | null;
  user_id?: string | null;
  channel?: string;
  timestamp?: string;
};

function docToAnalyticsEvent(doc: StoredAnalyticsDoc): AnalyticsEvent {
  const parsedChannel = validateChannel(typeof doc.channel === 'string' ? doc.channel : 'admin');
  return {
    id: doc.$id,
    event_type: validateEventType(typeof doc.event_type === 'string' ? doc.event_type : 'system_log'),
    data: parseJson<Record<string, unknown>>(typeof doc.data === 'string' ? doc.data : null, {}),
    user_id: typeof doc.user_id === 'string' && doc.user_id.trim() ? doc.user_id : undefined,
    channel: parsedChannel === 'all' ? 'admin' : parsedChannel,
    timestamp: typeof doc.timestamp === 'string' && doc.timestamp.trim()
      ? doc.timestamp
      : (doc.$createdAt ?? new Date().toISOString()),
  };
}

// --------------------------------------------
// Settings Repository (with in-memory cache)
// --------------------------------------------

const SETTINGS_CACHE = new Map<string, { value: string | null; ts: number }>();
const SETTINGS_CACHE_MAX_SIZE = 100;

export const settingsRepo = {
  async get(key: string): Promise<string | null> {
    const cached = SETTINGS_CACHE.get(key);
    if (cached && Date.now() - cached.ts < SETTINGS_CACHE_TTL) {
      return cached.value;
    }

    try {
      const result = await getAppwrite().listDocuments(DB_ID(), COLL.settings, [
        Query.equal('key', key),
        Query.limit(1),
      ]);

      const value = result.documents[0]?.value ?? null;

      if (SETTINGS_CACHE.size >= SETTINGS_CACHE_MAX_SIZE) {
        let oldestKey: string | undefined;
        let oldestTs = Infinity;
        for (const [k, v] of SETTINGS_CACHE) {
          if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
        }
        if (oldestKey) SETTINGS_CACHE.delete(oldestKey);
      }
      SETTINGS_CACHE.set(key, { value, ts: Date.now() });
      return value;
    } catch (error) {
      dbLogger.error({ error, key }, 'Failed to get setting');
      throw error;
    }
  },

  async set(key: string, value: string): Promise<void> {
    try {
      // Check if exists
      const result = await getAppwrite().listDocuments(DB_ID(), COLL.settings, [
        Query.equal('key', key),
        Query.limit(1),
      ]);

      const now = new Date().toISOString();

      if (result.documents.length > 0) {
        await getAppwrite().updateDocument(DB_ID(), COLL.settings, result.documents[0]!.$id, {
          value,
          updated_at: now,
        });
      } else {
        await getAppwrite().createDocument(DB_ID(), COLL.settings, ID.unique(), {
          key,
          value,
          updated_at: now,
        });
      }

      SETTINGS_CACHE.set(key, { value, ts: Date.now() });
    } catch (error) {
      dbLogger.error({ error, key }, 'Failed to set setting');
      throw error;
    }
  },

  async getAll(): Promise<Settings[]> {
    try {
      const allDocs: AppwriteDoc[] = [];
      let offset = 0;
      const limit = 100;

      while (true) {
        const result = await getAppwrite().listDocuments(DB_ID(), COLL.settings, [
          Query.orderAsc('key'),
          Query.limit(limit),
          Query.offset(offset),
        ]);
        allDocs.push(...result.documents);
        if (result.documents.length < limit) break;
        offset += limit;
      }

      const settings = allDocs.map(docToSettings);

      const now = Date.now();
      for (const s of settings) {
        SETTINGS_CACHE.set(s.key, { value: s.value, ts: now });
      }

      return settings;
    } catch (error) {
      dbLogger.error({ error }, 'Failed to get all settings');
      throw error;
    }
  },

  async getMany(keys: string[]): Promise<Record<string, string>> {
    const now = Date.now();
    const result: Record<string, string> = {};
    const missedKeys: string[] = [];

    for (const key of keys) {
      const cached = SETTINGS_CACHE.get(key);
      if (cached && now - cached.ts < SETTINGS_CACHE_TTL) {
        if (cached.value !== null) result[key] = cached.value;
      } else {
        missedKeys.push(key);
      }
    }

    if (missedKeys.length === 0) return result;

    try {
      // Appwrite Query.equal supports array → IN behavior, но Query.limit(100) с массивом >100
      // тихо обрежет результат — часть значений уйдёт в кэш как null, что даст ложные «нет настройки».
      // Поэтому разбиваем missedKeys на чанки по 100 и объединяем.
      const CHUNK = 100;
      for (let i = 0; i < missedKeys.length; i += CHUNK) {
        const chunk = missedKeys.slice(i, i + CHUNK);
        const resp = await getAppwrite().listDocuments(DB_ID(), COLL.settings, [
          Query.equal('key', chunk),
          Query.limit(chunk.length),
        ]);

        for (const doc of resp.documents) {
          result[doc.key] = doc.value;
          SETTINGS_CACHE.set(doc.key, { value: doc.value, ts: now });
        }
      }

      for (const key of missedKeys) {
        if (!(key in result)) {
          SETTINGS_CACHE.set(key, { value: null, ts: now });
        }
      }

      return result;
    } catch (error) {
      dbLogger.error({ error, keysCount: missedKeys.length }, 'Failed to get settings');
      throw error;
    }
  },

  invalidateCache(): void {
    SETTINGS_CACHE.clear();
  },
};

// --------------------------------------------
// Prompts Repository
// --------------------------------------------

export const promptsRepo = {
  async getActive(channel: 'telegram' | 'voice' | 'all'): Promise<Prompt | null> {
    try {
      const result = await getAppwrite().listDocuments(DB_ID(), COLL.prompts, [
        Query.equal('is_active', true),
        Query.equal('channel', [channel, 'all']),
        Query.orderDesc('updated_at'),
        Query.limit(1),
      ]);

      if (result.documents.length === 0) return null;
      return docToPrompt(result.documents[0]!);
    } catch (error) {
      dbLogger.error({ error, channel }, 'Failed to get active prompt');
      throw error;
    }
  },

  async getAll(): Promise<Prompt[]> {
    try {
      const allDocs: AppwriteDoc[] = [];
      let offset = 0;

      while (true) {
        const result = await getAppwrite().listDocuments(DB_ID(), COLL.prompts, [
          Query.orderDesc('created_at'),
          Query.limit(100),
          Query.offset(offset),
        ]);
        allDocs.push(...result.documents);
        if (result.documents.length < 100) break;
        offset += 100;
      }

      return allDocs.map(docToPrompt);
    } catch (error) {
      dbLogger.error({ error }, 'Failed to get all prompts');
      throw error;
    }
  },

  async create(prompt: Omit<Prompt, 'id' | 'created_at' | 'updated_at'>): Promise<Prompt> {
    try {
      const now = new Date().toISOString();
      const doc = await getAppwrite().createDocument(DB_ID(), COLL.prompts, ID.unique(), {
        name: prompt.name,
        content: prompt.content,
        is_active: prompt.is_active ?? false,
        channel: prompt.channel,
        created_at: now,
        updated_at: now,
      });
      return docToPrompt(doc);
    } catch (error) {
      dbLogger.error({ error }, 'Failed to create prompt');
      throw error;
    }
  },

  async update(id: string, updates: Partial<Omit<Prompt, 'id' | 'created_at'>>): Promise<Prompt> {
    try {
      const data: Record<string, unknown> = { ...updates, updated_at: new Date().toISOString() };
      for (const k of Object.keys(data)) {
        if (data[k] === undefined) delete data[k];
      }
      const doc = await getAppwrite().updateDocument(DB_ID(), COLL.prompts, id, data);
      return docToPrompt(doc);
    } catch (error) {
      dbLogger.error({ error, id }, 'Failed to update prompt');
      throw error;
    }
  },

  async delete(id: string): Promise<void> {
    try {
      await getAppwrite().deleteDocument(DB_ID(), COLL.prompts, id);
    } catch (error) {
      dbLogger.error({ error, id }, 'Failed to delete prompt');
      throw error;
    }
  },

  async setActive(id: string): Promise<void> {
    try {
      const targetPrompt = await getAppwrite().getDocument(DB_ID(), COLL.prompts, id);
      const targetChannel = String(targetPrompt.channel ?? 'all') as Prompt['channel'];

      // Пагинация: при >100 активных промптов одного канала старая логика оставляла часть
      // is_active=true, ломая инвариант «один активный на канал».
      const previousActive: AppwriteDoc[] = [];
      let offset = 0;
      const PAGE = 100;
      while (true) {
        const page = await getAppwrite().listDocuments(DB_ID(), COLL.prompts, [
          Query.equal('is_active', true),
          Query.equal('channel', targetChannel),
          Query.limit(PAGE),
          Query.offset(offset),
        ]);
        previousActive.push(...page.documents);
        if (page.documents.length < PAGE) break;
        offset += PAGE;
        if (offset > 5000) {
          dbLogger.warn({ targetChannel, offset }, 'setActive: too many active prompts, stopping pagination');
          break;
        }
      }

      const previousActiveIds = previousActive.map(doc => doc.$id);

      for (const doc of previousActive) {
        await getAppwrite().updateDocument(DB_ID(), COLL.prompts, doc.$id, {
          is_active: false,
        });
      }

      // Activate selected
      try {
        await getAppwrite().updateDocument(DB_ID(), COLL.prompts, id, {
          is_active: true,
          updated_at: new Date().toISOString(),
        });
      } catch (error) {
        // Rollback всех ранее активных промптов канала, не только первого.
        dbLogger.error({ error, id }, 'Failed to set active prompt — rolling back');
        for (const prevId of previousActiveIds) {
          try {
            await getAppwrite().updateDocument(DB_ID(), COLL.prompts, prevId, {
              is_active: true,
            });
          } catch (rollbackErr) {
            dbLogger.error({ error: rollbackErr, prevId }, 'Rollback failed for one prompt');
          }
        }
        throw error;
      }
    } catch (error) {
      dbLogger.error({ error, id }, 'Failed to set active prompt');
      throw error;
    }
  },
};

// --------------------------------------------
// Conversations Repository
// --------------------------------------------

// In-process mutex по conversationId. Защищает от lost-update при параллельных addMessage:
// раньше два одновременных вызова читали один и тот же снимок messages[] и второй upsert
// затирал первый, теряя сообщения. Multi-worker race это НЕ покрывает — для этого нужен
// серверный механизм; но 99% потерь происходят именно внутри одного процесса.
const CONVERSATION_LOCKS = new Map<string, Promise<void>>();

async function withConversationLock<T>(conversationId: string, fn: () => Promise<T>): Promise<T> {
  const previous = CONVERSATION_LOCKS.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const done = new Promise<void>((resolve) => { release = resolve; });
  // Цепочка: ждём предыдущую операцию, затем нашу. В Map кладём именно нашу done-метку,
  // чтобы потом по идентичности снять её и не утечь Map'у.
  const chained = previous.then(() => done);
  CONVERSATION_LOCKS.set(conversationId, chained);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    if (CONVERSATION_LOCKS.get(conversationId) === chained) {
      CONVERSATION_LOCKS.delete(conversationId);
    }
  }
}

export const conversationsRepo = {
  async getOrCreate(
    userId: string,
    channel: 'telegram' | 'voice',
    metadata: Conversation['metadata']
  ): Promise<Conversation> {
    const validUserId = validateUserId(userId);
    const validChannel = validateChannel(channel);

    try {
      // Try to find existing
      const result = await getAppwrite().listDocuments(DB_ID(), COLL.conversations, [
        Query.equal('user_id', validUserId),
        Query.equal('channel', validChannel),
        Query.orderDesc('updated_at'),
        Query.limit(1),
      ]);

      if (result.documents.length > 0) {
        return docToConversation(result.documents[0]!);
      }

      // Create new
      const now = new Date().toISOString();
      const doc = await getAppwrite().createDocument(DB_ID(), COLL.conversations, ID.unique(), {
        user_id: validUserId,
        channel: validChannel,
        messages: JSON.stringify([]),
        metadata: JSON.stringify(metadata || {}),
        created_at: now,
        updated_at: now,
      });

      return docToConversation(doc);
    } catch (error) {
      dbLogger.error({ error, userId: validUserId, channel: validChannel }, 'Failed to getOrCreate conversation');
      throw error;
    }
  },

  async addMessage(conversationId: string, message: Message): Promise<void> {
    checkArraySize([message], 1, 'Cannot add empty message');

    // In-process mutex: read-modify-write больше не теряет сообщения при параллельных вызовах
    // в одном процессе. Retry оставлен для сетевых сбоев.
    return withConversationLock(conversationId, async () => {
      const maxRetries = 3;
      let lastError: Error | null = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const doc = await getAppwrite().getDocument(DB_ID(), COLL.conversations, conversationId);
          let currentMessages: Message[] = parseJson(
            typeof doc.messages === 'string' ? doc.messages : null,
            [],
            { collection: COLL.conversations, field: 'messages', docId: conversationId },
          );

          // Авто-обрезка: если достигнут лимит — удаляем старые сообщения вместо throw
          if (currentMessages.length >= MAX_CONVERSATION_MESSAGES) {
            const trimTo = Math.floor(MAX_CONVERSATION_MESSAGES * 0.5);
            dbLogger.info(
              { conversationId, was: currentMessages.length, trimTo },
              'Conversation auto-trimmed (exceeded max messages)'
            );
            currentMessages = currentMessages.slice(-trimTo);
          }

          const messages = [...currentMessages, message];

          await getAppwrite().updateDocument(DB_ID(), COLL.conversations, conversationId, {
            messages: JSON.stringify(messages),
            updated_at: new Date().toISOString(),
          });

          dbLogger.debug({ conversationId, attempt }, 'Message added');
          return;
        } catch (error) {
          lastError = error as Error;
          dbLogger.warn({ error, attempt, conversationId }, 'Retry adding message');
          if (attempt < maxRetries) {
            await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
          }
        }
      }

      dbLogger.error({ error: lastError, conversationId }, 'Failed to add message after retries');
      throw lastError;
    });
  },

  async getMessages(conversationId: string, limit = 20): Promise<Message[]> {
    const validLimit = validateLimit(limit, 1, 1000);

    try {
      const doc = await getAppwrite().getDocument(DB_ID(), COLL.conversations, conversationId);
      const messages: Message[] = parseJson(doc.messages, []);
      return messages.slice(-validLimit);
    } catch (error) {
      dbLogger.error({ error, conversationId }, 'Failed to get messages');
      throw error;
    }
  },

  async get(conversationId: string): Promise<Conversation> {
    try {
      const doc = await getAppwrite().getDocument(DB_ID(), COLL.conversations, conversationId);
      return docToConversation(doc);
    } catch (error) {
      dbLogger.error({ error, conversationId }, 'Failed to get conversation');
      throw new Error(`Conversation not found: ${conversationId}`);
    }
  },

  async clearMessages(conversationId: string): Promise<void> {
    return withConversationLock(conversationId, async () => {
      try {
        await getAppwrite().updateDocument(DB_ID(), COLL.conversations, conversationId, {
          messages: JSON.stringify([]),
          updated_at: new Date().toISOString(),
        });
      } catch (error) {
        dbLogger.error({ error, conversationId }, 'Failed to clear messages');
        throw error;
      }
    });
  },
};

// --------------------------------------------
// Analytics Repository
// --------------------------------------------

export const analyticsRepo = {
  async log(
    eventType: AnalyticsEventType,
    channel: AnalyticsEvent['channel'],
    data: Record<string, unknown>,
    userId?: string
  ): Promise<void> {
    try {
      const validEventType = validateEventType(eventType);
      const validChannel = validateChannel(channel);
      const validUserId = userId ? validateUserId(userId) : undefined;

      await getAppwrite().createDocument(DB_ID(), COLL.analytics, ID.unique(), {
        event_type: validEventType,
        channel: validChannel,
        data: JSON.stringify(data),
        user_id: validUserId || null,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      // Analytics shouldn't break the app
      dbLogger.warn({ error, eventType }, 'Analytics log failed');
    }
  },

  async listEvents(filters: {
    from?: Date;
    to?: Date;
    channel?: AnalyticsEvent['channel'];
    eventType?: AnalyticsEventType;
    limit?: number;
  }): Promise<AnalyticsEvent[]> {
    const queries = [Query.orderDesc('timestamp'), Query.limit(validateLimit(filters.limit ?? 100, 1, 500))];

    if (filters.from) {
      queries.push(Query.greaterThanEqual('timestamp', filters.from.toISOString()));
    }
    if (filters.to) {
      queries.push(Query.lessThanEqual('timestamp', filters.to.toISOString()));
    }
    if (filters.channel) {
      queries.push(Query.equal('channel', filters.channel));
    }
    if (filters.eventType) {
      queries.push(Query.equal('event_type', filters.eventType));
    }

    try {
      const result = await getAppwrite().listDocuments(DB_ID(), COLL.analytics, queries);
      return result.documents.map((document) => docToAnalyticsEvent(document as StoredAnalyticsDoc));
    } catch (error) {
      dbLogger.error({ error, filters }, 'Failed to list analytics events');
      throw error;
    }
  },

  async getStats(fromDate: Date, toDate: Date): Promise<{
    totalMessages: number;
    totalCalls: number;
    uniqueUsers: number;
    tokensByDay: { date: string; tokens: number }[];
  }> {
    try {
      // Fetch all events in range (paginated)
      const allEvents: StoredAnalyticsDoc[] = [];
      let offset = 0;
      const limit = 100;

      while (true) {
        const result = await getAppwrite().listDocuments(DB_ID(), COLL.analytics, [
          Query.greaterThanEqual('timestamp', fromDate.toISOString()),
          Query.lessThanEqual('timestamp', toDate.toISOString()),
          Query.limit(limit),
          Query.offset(offset),
        ]);
        allEvents.push(...result.documents as StoredAnalyticsDoc[]);
        if (result.documents.length < limit) break;
        offset += limit;
        // Safety limit — max 5000 events
        if (offset > 5000) break;
      }

      const uniqueUsers = new Set(allEvents.map(e => e.user_id).filter(Boolean));

      const tokensByDay = allEvents
        .filter(e => e.event_type === 'ai_response')
        .reduce((acc, e) => {
          const timestamp = typeof e.timestamp === 'string' ? e.timestamp : '';
          const date = timestamp ? new Date(timestamp).toISOString().split('T')[0] : '';
          const eventData = parseJson<{ tokens?: number }>(e.data, {});
          const tokens = eventData?.tokens ?? 0;
          if (!date) return acc;
          const existing = acc.find((entry) => entry.date === date);
          if (existing) {
            existing.tokens += tokens;
          } else {
            acc.push({ date, tokens });
          }
          return acc;
        }, [] as { date: string; tokens: number }[]);

      return {
        totalMessages: allEvents.filter(
          e => e.event_type === 'message_sent' || e.event_type === 'message_received'
        ).length,
        totalCalls: allEvents.filter(e => e.event_type === 'call_started').length,
        uniqueUsers: uniqueUsers.size,
        tokensByDay: tokensByDay.sort((left, right) => left.date.localeCompare(right.date)),
      };
    } catch (error) {
      dbLogger.error({ error }, 'Failed to get analytics stats');
      throw error;
    }
  },
};
