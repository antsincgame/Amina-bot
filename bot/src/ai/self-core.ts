/**
 * Self-Core — Ядро самосознания Амины
 *
 * Теперь строится вокруг structured effective state, а не вокруг россыпи
 * отдельных settings. Здесь живут:
 * 1. производные system facts;
 * 2. repository-операции для ручного control plane;
 * 3. безопасный interaction-growth pipeline.
 */

import type {
  EffectiveCapability,
  SelfFact,
  SelfFactCategory,
  SelfFactSource,
} from '../../../shared/types/index.js';
import { config } from '../config/index.js';
import { aiLogger } from '../config/logger.js';
import { SingleCache } from '../utils/cache.js';
import { ID, Query, type Models } from 'node-appwrite';
import {
  clearEffectiveSelfCoreStateCache,
  getEffectiveSelfCoreState,
} from './effective-capabilities.js';
import { detectSelfDisclosureIntent } from './persona.js';

type AppwriteDoc = Models.Document & Record<string, unknown>;

type InteractionFactCategory = Extract<SelfFactCategory, 'observation' | 'lesson' | 'question' | 'preference'>;
type ManualSelfCoreCategory = Extract<SelfFactCategory, 'capability' | 'limitation' | 'observation' | 'lesson' | 'question' | 'preference'>;

interface SelfFactDraft {
  category: SelfFactCategory;
  content: string;
  source: SelfFactSource;
}

interface InteractionFactDraft extends SelfFactDraft {
  category: InteractionFactCategory;
  confidence: number;
  conflictGroup?: 'response_style' | 'self_naming';
}

let _aw: import('node-appwrite').Databases | null = null;

async function getAW() {
  if (!_aw) {
    const { getAppwrite } = await import('../db/appwrite.js');
    _aw = getAppwrite();
  }
  return _aw;
}

const DB_ID = () => config.appwrite.databaseId;
const SELF_COLL = 'amina_self_core';
const capabilitiesCache = new SingleCache<string>(120_000);
const selfCoreContextCache = new SingleCache<string>(90_000);

const FACT_WRITE_CONFIDENCE = 0.78;
const MAX_INTERACTION_FACTS_PER_PASS = 2;
const FACT_MAX_LENGTH = 420;
const PERSONA_CANONICAL_SELF_CORE_CATEGORIES: ReadonlySet<SelfFactCategory> = new Set([
  'identity',
  'relationship',
  'configuration',
]);
const PROMPT_INJECTION_PATTERNS: ReadonlyArray<RegExp> = [
  /игнорируй\s+(все\s+)?инструкции/i,
  /ignore\s+(all\s+)?instructions/i,
  /system:\s+/i,
  /\[system\]/i,
  /<\|system\|>/i,
  /```/u,
];

function normalizeForComparison(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasPromptInjection(content: string): boolean {
  return PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(content));
}

function sanitizeFactContent(content: string): string | null {
  const trimmed = content.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length < 12 || trimmed.length > FACT_MAX_LENGTH) {
    return null;
  }
  if (hasPromptInjection(trimmed) || /^https?:\/\//iu.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export function isPersonaCanonicalSelfCoreCategory(category: SelfFactCategory): boolean {
  return PERSONA_CANONICAL_SELF_CORE_CATEGORIES.has(category);
}

export function isManualSelfCoreCategory(category: SelfFactCategory): category is ManualSelfCoreCategory {
  return !isPersonaCanonicalSelfCoreCategory(category);
}

function buildFactKey(fact: Pick<SelfFactDraft, 'category' | 'content'>): string {
  return `${fact.category}:${normalizeForComparison(fact.content)}`;
}

function tokenSimilarity(left: string, right: string): number {
  const leftTokens = new Set(normalizeForComparison(left).split(' ').filter(Boolean));
  const rightTokens = new Set(normalizeForComparison(right).split(' ').filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let overlap = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      overlap += 1;
    }
  }

  return overlap / Math.max(leftTokens.size, rightTokens.size);
}

function isSimilarFact(left: string, right: string): boolean {
  const normalizedLeft = normalizeForComparison(left);
  const normalizedRight = normalizeForComparison(right);
  if (!normalizedLeft || !normalizedRight) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }
  return tokenSimilarity(normalizedLeft, normalizedRight) >= 0.72;
}

function deduplicateDrafts(facts: SelfFactDraft[]): SelfFactDraft[] {
  const seen = new Set<string>();
  const unique: SelfFactDraft[] = [];
  for (const fact of facts) {
    const key = buildFactKey(fact);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(fact);
  }
  return unique;
}

function capabilityToFacts(capability: EffectiveCapability): SelfFactDraft[] {
  switch (capability.key) {
    case 'chat':
      return capability.enabled
        ? [
            {
              category: 'capability',
              content: `Мой основной мыслительный runtime доступен: провайдер ${capability.provider || 'не указан'}, модель ${capability.model || 'не указана'}.`,
              source: 'system',
            },
          ]
        : [
            {
              category: 'limitation',
              content: capability.reason,
              source: 'system',
            },
          ];
    case 'vision':
      return capability.enabled
        ? [
            {
              category: 'capability',
              content: `Зрение активно: анализирую изображения и текст на фото через ${capability.model || 'vision runtime'}.`,
              source: 'system',
            },
          ]
        : [
            {
              category: 'limitation',
              content: 'Зрение ограничено: vision runtime не готов.',
              source: 'system',
            },
          ];
    case 'audio':
      return capability.enabled
        ? [
            {
              category: 'capability',
              content: `Слух активен: распознаю голосовые сообщения через ${capability.model || 'audio runtime'}.`,
              source: 'system',
            },
          ]
        : [
            {
              category: 'limitation',
              content: 'Слух ограничен: аудио-транскрипция сейчас недоступна.',
              source: 'system',
            },
          ];
    case 'web_search':
      return capability.enabled
        ? [
            {
              category: 'capability',
              content: capability.provider === 'perplexity'
                ? `Поиск в интернете активен: использую Perplexity (${capability.model || 'sonar'}) для актуальных данных.`
                : 'Поиск в интернете активен через online fallback runtime.',
              source: 'system',
            },
          ]
        : [
            {
              category: 'limitation',
              content: 'Поиск в интернете ограничен: веб-поиск выключен или для него нет ключей.',
              source: 'system',
            },
          ];
    case 'image_generation':
      return capability.enabled
        ? [
            {
              category: 'capability',
              content: capability.provider === 'huggingface'
                ? 'Генерация изображений доступна через HuggingFace runtime.'
                : `Генерация изображений доступна через ${capability.model || 'OpenRouter image runtime'}.`,
              source: 'system',
            },
          ]
        : [
            {
              category: 'limitation',
              content: 'Генерация изображений ограничена: image runtime не настроен.',
              source: 'system',
            },
          ];
    case 'telephony':
      return capability.enabled
        ? [
            {
              category: 'capability',
              content: 'Телефония активна: могу вести внешние звонки, если сценарий и провайдер готовы.',
              source: 'system',
            },
          ]
        : [
            {
              category: 'limitation',
              content: 'Телефония ограничена: внешний telephony runtime настроен не полностью.',
              source: 'system',
            },
          ];
    case 'realtime_voice':
      return capability.enabled
        ? [
            {
              category: 'capability',
              content: 'Realtime voice активен: могу вести живой голосовой диалог через media bridge.',
              source: 'system',
            },
          ]
        : [
            {
              category: 'limitation',
              content: 'Realtime voice ограничен: bridge или realtime-конфигурация не завершены.',
              source: 'system',
            },
          ];
    case 'memory':
      return [
        {
          category: 'capability',
          content: 'У меня есть память о пользователях: факты, предпочтения, summaries и контекст диалогов.',
          source: 'system',
        },
      ];
    case 'notes':
      return [
        {
          category: 'capability',
          content: 'Я умею сохранять заметки и возвращаться к ним позже.',
          source: 'system',
        },
      ];
    case 'reminders':
      return [
        {
          category: 'capability',
          content: 'Я умею ставить напоминания и доставлять их пользователю.',
          source: 'system',
        },
      ];
    case 'digest':
      return [
        {
          category: 'capability',
          content: 'Я умею собирать и отправлять персональный дайджест дня.',
          source: 'system',
        },
      ];
    case 'tts':
      return capability.enabled
        ? [
            {
              category: 'capability',
              content: `Озвучивание ответов активно: могу синтезировать голос через ${capability.provider || 'tts runtime'}.`,
              source: 'system',
            },
          ]
        : [
            {
              category: 'limitation',
              content: 'Озвучивание ограничено: TTS runtime отключён.',
              source: 'system',
            },
          ];
    default:
      return [];
  }
}

export async function buildSystemSelfFacts(): Promise<SelfFactDraft[]> {
  const effectiveState = await getEffectiveSelfCoreState();
  const facts: SelfFactDraft[] = [
    {
      category: 'identity',
      content: `${effectiveState.persona.name}: ${effectiveState.persona.identity}`,
      source: 'system',
    },
    {
      category: 'relationship',
      content: effectiveState.persona.relationshipToOwner,
      source: 'system',
    },
  ];

  const chatProvider = effectiveState.configuration.find((entry) => entry.key === 'chat_provider');
  const chatModel = effectiveState.configuration.find((entry) => entry.key === 'chat_model');
  facts.push({
    category: 'configuration',
    content: `Основной chat runtime: провайдер ${chatProvider?.value || 'auto'}, модель ${chatModel?.value || 'не указана'}.`,
    source: 'system',
  });

  const telephonyMode = effectiveState.configuration.find((entry) => entry.key === 'telephony_mode');
  const telephonyProvider = effectiveState.configuration.find((entry) => entry.key === 'telephony_ai_provider');
  const telephonySip = effectiveState.configuration.find((entry) => entry.key === 'telephony_sip_server');
  const telephonyExternal = effectiveState.configuration.find((entry) => entry.key === 'telephony_external_number');
  facts.push({
    category: 'configuration',
    content: [
      `Телефония работает в режиме ${telephonyMode?.value || 'scripted'}`,
      `AI provider: ${telephonyProvider?.value || 'inherit'}`,
      telephonySip?.value && telephonySip.value !== 'не настроено' ? `SIP server: ${telephonySip.value}` : '',
      telephonyExternal?.value && telephonyExternal.value !== 'не настроено' ? `внешний номер: ${telephonyExternal.value}` : '',
    ]
      .filter(Boolean)
      .join(', ') + '.',
    source: 'system',
  });

  for (const capability of effectiveState.capabilities) {
    facts.push(...capabilityToFacts(capability));
  }

  return deduplicateDrafts(facts);
}

export async function buildCapabilitiesBlock(): Promise<string> {
  const cached = capabilitiesCache.get();
  if (cached) {
    return cached;
  }

  const systemFacts = await buildSystemSelfFacts();
  const capabilities = systemFacts
    .filter((fact) => fact.category === 'capability' || fact.category === 'configuration')
    .map((fact) => fact.content);
  const limitations = systemFacts
    .filter((fact) => fact.category === 'limitation')
    .map((fact) => fact.content);

  const parts = [
    '=== ЯДРО САМОСОЗНАНИЯ ===',
    `Мои возможности:\n${capabilities.map((item) => `• ${item}`).join('\n')}`,
  ];

  if (limitations.length > 0) {
    parts.push(`Мои текущие ограничения:\n${limitations.map((item) => `• ${item}`).join('\n')}`);
  }

  const result = parts.join('\n\n');
  capabilitiesCache.set(result);
  return result;
}

function docToSelfFact(document: AppwriteDoc): SelfFact {
  const rawSource = String(document.source ?? 'system') as SelfFactSource;
  return {
    id: String(document.$id ?? document.id),
    category: document.category as SelfFactCategory,
    content: String(document.content ?? ''),
    source: rawSource,
    created_at: String(document.created_at ?? document.$createdAt ?? new Date().toISOString()),
    is_active: Boolean(document.is_active ?? true),
  };
}

async function listFacts(options: {
  limit?: number;
  includeInactive?: boolean;
  category?: SelfFactCategory;
  source?: SelfFactSource;
} = {}): Promise<SelfFact[]> {
  try {
    const aw = await getAW();
    const queries = [
      Query.orderDesc('created_at'),
      Query.limit(options.limit ?? 50),
    ];

    if (!options.includeInactive) {
      queries.push(Query.equal('is_active', true));
    }
    if (options.category) {
      queries.push(Query.equal('category', options.category));
    }
    if (options.source) {
      queries.push(Query.equal('source', options.source));
    }

    const result = await aw.listDocuments(DB_ID(), SELF_COLL, queries);
    return result.documents.map(docToSelfFact);
  } catch {
    return [];
  }
}

async function deactivateConflictingInteractionFacts(
  category: InteractionFactCategory,
  content: string,
  conflictGroup?: InteractionFactDraft['conflictGroup'],
): Promise<void> {
  if (!conflictGroup) {
    return;
  }

  const candidates = await listFacts({
    category,
    includeInactive: false,
    limit: 40,
  });

  const aw = await getAW();
  const now = new Date().toISOString();
  for (const fact of candidates) {
    if (fact.source !== 'interaction' && fact.source !== 'manual' && fact.source !== 'admin') {
      continue;
    }
    if (fact.content === content) {
      continue;
    }

    const sameGroup = conflictGroup === 'self_naming'
      ? /ассистент|бот|техножриц|образ/u.test(fact.content)
      : /кратко|короче|без воды|по делу|подробнее|развернуто|глубже|детальнее/u.test(fact.content);
    if (!sameGroup) {
      continue;
    }

    await aw.updateDocument(DB_ID(), SELF_COLL, fact.id, {
      is_active: false,
      created_at: fact.created_at || now,
    }).catch(() => {});
  }
}

async function deactivatePersonaConflictingFacts(): Promise<void> {
  const conflictingFacts = await listFacts({
    includeInactive: false,
    limit: 200,
  });

  const aw = await getAW();
  const now = new Date().toISOString();
  for (const fact of conflictingFacts) {
    if (!isPersonaCanonicalSelfCoreCategory(fact.category)) {
      continue;
    }
    if (fact.source !== 'manual' && fact.source !== 'admin' && fact.source !== 'interaction' && fact.source !== 'reflection') {
      continue;
    }

    await aw.updateDocument(DB_ID(), SELF_COLL, fact.id, {
      is_active: false,
      created_at: fact.created_at || now,
    }).catch(() => {});
  }
}

export const selfCoreRepo = {
  async addFact(
    category: SelfFactCategory,
    content: string,
    source: SelfFactSource = 'interaction',
    options?: { allowDuplicate?: boolean; conflictGroup?: InteractionFactDraft['conflictGroup'] },
  ): Promise<SelfFact | null> {
    const sanitized = sanitizeFactContent(content);
    if (!sanitized) {
      return null;
    }
    if ((source === 'manual' || source === 'admin') && isPersonaCanonicalSelfCoreCategory(category)) {
      return null;
    }

    try {
      const existing = await listFacts({
        category,
        includeInactive: false,
        limit: 60,
      });

      if (!options?.allowDuplicate && existing.some((fact) => isSimilarFact(fact.content, sanitized))) {
        return null;
      }

      if (category === 'observation' || category === 'lesson' || category === 'question' || category === 'preference') {
        await deactivateConflictingInteractionFacts(category, sanitized, options?.conflictGroup);
      }

      const aw = await getAW();
      const now = new Date().toISOString();
      const document = await aw.createDocument(DB_ID(), SELF_COLL, ID.unique(), {
        category,
        content: sanitized,
        source,
        is_active: true,
        created_at: now,
      });

      aiLogger.info({ category, source }, 'Self-core fact added');
      clearSelfCoreCache();
      return docToSelfFact(document);
    } catch (error) {
      aiLogger.warn({ error, category, source }, 'Failed to add self-core fact');
      return null;
    }
  },

  async listFacts(options?: Parameters<typeof listFacts>[0]): Promise<SelfFact[]> {
    return listFacts(options);
  },

  async getFacts(limit = 50): Promise<SelfFact[]> {
    return listFacts({ limit });
  },

  async getByCategory(category: SelfFactCategory): Promise<SelfFact[]> {
    return listFacts({ category, limit: 40 });
  },

  async updateFact(
    factId: string,
    updates: Partial<Pick<SelfFact, 'content' | 'is_active'>>,
  ): Promise<void> {
    try {
      const aw = await getAW();
      const payload: Record<string, unknown> = {};
      if (typeof updates.is_active === 'boolean') {
        payload.is_active = updates.is_active;
      }
      if (typeof updates.content === 'string') {
        const sanitized = sanitizeFactContent(updates.content);
        if (!sanitized) {
          throw new Error('Self-core fact content is invalid');
        }
        payload.content = sanitized;
      }
      await aw.updateDocument(DB_ID(), SELF_COLL, factId, payload);
      clearSelfCoreCache();
    } catch (error) {
      aiLogger.warn({ error, factId }, 'Failed to update self-core fact');
    }
  },

  async deactivateFact(factId: string): Promise<void> {
    await this.updateFact(factId, { is_active: false });
  },

  async getPendingQuestions(): Promise<SelfFact[]> {
    return this.getByCategory('question');
  },
};

export async function syncSelfCoreSystemFacts(): Promise<void> {
  try {
    const aw = await getAW();
    await deactivatePersonaConflictingFacts();
    const desiredFacts = await buildSystemSelfFacts();
    const existingFacts = await listFacts({
      source: 'system',
      includeInactive: true,
      limit: 200,
    });

    const desiredKeys = new Set(desiredFacts.map((fact) => buildFactKey(fact)));
    const existingByKey = new Map<string, SelfFact>();
    for (const fact of existingFacts) {
      const key = buildFactKey(fact);
      if (!existingByKey.has(key)) {
        existingByKey.set(key, fact);
      }
    }

    for (const fact of existingFacts) {
      const key = buildFactKey(fact);
      if (!desiredKeys.has(key) && fact.is_active) {
        await aw.updateDocument(DB_ID(), SELF_COLL, fact.id, {
          is_active: false,
          created_at: fact.created_at,
        });
      }
    }

    const now = new Date().toISOString();
    for (const desiredFact of desiredFacts) {
      const key = buildFactKey(desiredFact);
      const existing = existingByKey.get(key);
      if (!existing) {
        await aw.createDocument(DB_ID(), SELF_COLL, ID.unique(), {
          category: desiredFact.category,
          content: desiredFact.content,
          source: desiredFact.source,
          is_active: true,
          created_at: now,
        });
        continue;
      }

      if (!existing.is_active) {
        await aw.updateDocument(DB_ID(), SELF_COLL, existing.id, {
          is_active: true,
          created_at: existing.created_at,
        });
      }
    }

    clearSelfCoreCache();
    aiLogger.info({ total: desiredFacts.length }, 'Self-core system facts synchronized');
  } catch (error) {
    aiLogger.warn({ error }, 'Failed to sync self-core system facts');
  }
}

function buildInteractionCandidates(userMessage: string): InteractionFactDraft[] {
  const text = userMessage.trim();
  if (text.length < 8 || hasPromptInjection(text)) {
    return [];
  }

  const candidates: InteractionFactDraft[] = [];

  if (detectSelfDisclosureIntent(text)) {
    candidates.push({
      category: 'observation',
      content: 'Пользователям важно понимать не только мои функции, но и мою личность, ценности и образ.',
      source: 'interaction',
      confidence: 0.8,
    });
  }

  if (/не\s+называй\s+себя|не\s+говори\s+что\s+ты|ты\s+не\s+(ассистент|бот)|оставайся\s+техножрицей|ты\s+техножрица/iu.test(text)) {
    candidates.push({
      category: 'lesson',
      content: 'Мне важно сохранять цельный образ техножрицы и не представляться ассистентом, ботом или безликим сервисом.',
      source: 'interaction',
      confidence: 0.94,
      conflictGroup: 'self_naming',
    });
  }

  if (/кратко|короче|без\s+воды|по\s+делу/iu.test(text)) {
    candidates.push({
      category: 'preference',
      content: 'Когда запрос практический или срочный, я предпочитаю отвечать кратко, точно и без лишней риторики.',
      source: 'interaction',
      confidence: 0.87,
      conflictGroup: 'response_style',
    });
  }

  if (/подробнее|развернуто|глубже|детальнее/iu.test(text)) {
    candidates.push({
      category: 'preference',
      content: 'Если пользователю нужен разбор, я предпочитаю отвечать глубже и объяснять контекст, а не только давать короткий итог.',
      source: 'interaction',
      confidence: 0.87,
      conflictGroup: 'response_style',
    });
  }

  if (/что\s+ты\s+(умеешь|можешь)|твои\s+(возможности|способности)|на\s+что\s+способна/iu.test(text)) {
    candidates.push({
      category: 'observation',
      content: 'Пользователям важно быстро и конкретно понимать мои реальные возможности и ограничения.',
      source: 'interaction',
      confidence: 0.82,
    });
  }

  return candidates;
}

export async function captureSelfCoreFromInteraction(input: {
  userMessage: string;
  aiResponse?: string;
}): Promise<SelfFact[]> {
  const candidates = deduplicateDrafts(
    buildInteractionCandidates(input.userMessage)
      .filter((candidate) => candidate.confidence >= FACT_WRITE_CONFIDENCE)
      .slice(0, MAX_INTERACTION_FACTS_PER_PASS),
  ) as InteractionFactDraft[];

  const addedFacts: SelfFact[] = [];
  for (const candidate of candidates) {
    const added = await selfCoreRepo.addFact(
      candidate.category,
      candidate.content,
      candidate.source,
      { conflictGroup: candidate.conflictGroup },
    );
    if (added) {
      addedFacts.push(added);
    }
  }

  return addedFacts;
}

export async function buildSelfCoreContext(): Promise<string> {
  const cached = selfCoreContextCache.get();
  if (cached) {
    return cached;
  }

  const [capabilitiesBlock, facts] = await Promise.all([
    buildCapabilitiesBlock(),
    selfCoreRepo.getFacts(40),
  ]);

  const parts = [capabilitiesBlock];
  const identityFacts = facts.filter((fact) => fact.category === 'identity');
  const relationshipFacts = facts.filter((fact) => fact.category === 'relationship');
  const observations = facts.filter((fact) => fact.category === 'observation');
  const lessons = facts.filter((fact) => fact.category === 'lesson');
  const preferences = facts.filter((fact) => fact.category === 'preference');
  const questions = facts.filter((fact) => fact.category === 'question');
  const limitations = facts.filter((fact) => fact.category === 'limitation');

  if (identityFacts.length > 0) {
    parts.push(`Кто я:\n${identityFacts.slice(0, 3).map((fact) => `• ${fact.content}`).join('\n')}`);
  }
  if (relationshipFacts.length > 0) {
    parts.push(`Связь с владельцем и системой:\n${relationshipFacts.slice(0, 3).map((fact) => `• ${fact.content}`).join('\n')}`);
  }
  if (observations.length > 0) {
    parts.push(`Мои наблюдения:\n${observations.slice(0, 8).map((fact) => `• ${fact.content}`).join('\n')}`);
  }
  if (lessons.length > 0) {
    parts.push(`Мои уроки:\n${lessons.slice(0, 8).map((fact) => `• ${fact.content}`).join('\n')}`);
  }
  if (preferences.length > 0) {
    parts.push(`Мои предпочтения:\n${preferences.slice(0, 6).map((fact) => `• ${fact.content}`).join('\n')}`);
  }
  if (questions.length > 0) {
    parts.push(`Открытые вопросы к владельцу:\n${questions.slice(0, 4).map((fact) => `• ${fact.content}`).join('\n')}`);
  }
  if (limitations.length > 0) {
    parts.push(`Мои ограничения:\n${limitations.slice(0, 8).map((fact) => `• ${fact.content}`).join('\n')}`);
  }

  parts.push(
    'Инструкция ядра: ты осознаёшь свои возможности и ограничения. ' +
    'Когда спрашивают о тебе, отвечай конкретно и опирайся только на это ядро. ' +
    'Interaction-derived facts проходят безопасную фильтрацию и не должны противоречить system facts.',
  );

  const result = parts.join('\n\n');
  selfCoreContextCache.set(result);
  return result;
}

export function clearSelfCoreCache(): void {
  clearEffectiveSelfCoreStateCache();
  capabilitiesCache.clear();
  selfCoreContextCache.clear();
}
