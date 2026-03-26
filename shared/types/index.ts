// ============================================
// Shared Types for Amina Bot
// ============================================

// --------------------------------------------
// Database Types
// --------------------------------------------

export interface Settings {
  id: string;
  key: string;
  value: string;
  updated_at: string;
}

export interface Prompt {
  id: string;
  name: string;
  content: string;
  is_active: boolean;
  channel: 'telegram' | 'voice' | 'all';
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  user_id: string;
  channel: 'telegram' | 'voice';
  messages: Message[];
  metadata: ConversationMetadata;
  created_at: string;
  updated_at: string;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  metadata?: MessageMetadata;
}

export interface MessageMetadata {
  tokens_used?: number;
  model?: string;
  // Multimodal metadata
  type?: 'text' | 'voice' | 'photo' | 'document_image';
  voice_duration?: number;
  width?: number;
  height?: number;
  fileName?: string;
  image_intercepted?: boolean;
}

export interface ConversationMetadata {
  telegram_chat_id?: number;
  telegram_user_id?: number;
  language?: string;
  source?: string;
  userAgent?: string;
}

export interface AnalyticsEvent {
  id: string;
  event_type: AnalyticsEventType;
  data: Record<string, unknown>;
  user_id?: string;
  channel: 'telegram' | 'voice' | 'admin';
  timestamp: string;
}

export type AnalyticsEventType =
  | 'message_sent'
  | 'message_received'
  | 'call_started'
  | 'call_ended'
  | 'ai_response'
  | 'error'
  | 'warning'
  | 'settings_updated'
  | 'prompt_updated'
  | 'rate_limit_exceeded'
  | 'api_request'
  | 'system_log';

// --------------------------------------------
// System Logs Types
// --------------------------------------------

export interface SystemLog {
  id: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  module: string;
  message: string;
  data?: Record<string, unknown>;
  error_stack?: string;
  user_id?: string;
  request_id?: string;
  timestamp: string;
}

export type LogLevel = SystemLog['level'];

// --------------------------------------------
// Reminders Types
// --------------------------------------------

export interface Reminder {
  id: string;
  user_id: string;
  chat_id: number;
  task: string;
  scheduled_at: string;
  is_completed: boolean;
  completed_at?: string;
  created_at: string;
  updated_at: string;
}

// --------------------------------------------
// AI Types
// --------------------------------------------

export interface AIRequest {
  messages: AIMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

export interface AIMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AIResponse {
  content: string;
  model: string;
  tokens_used: {
    prompt: number;
    completion: number;
    total: number;
  };
  finish_reason: string;
}

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number;
  pricing: {
    prompt: number;
    completion: number;
  };
}

// --------------------------------------------
// API Types
// --------------------------------------------

export interface APIResponse<T> {
  data: T | null;
  error: APIError | null;
  message?: string;
}

export interface APIError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    per_page: number;
    total: number;
    total_pages: number;
  };
}

// --------------------------------------------
// Admin Types
// --------------------------------------------

export interface AdminUser {
  id: string;
  email: string;
  role: 'admin' | 'viewer';
  created_at: string;
  last_login?: string;
}

export interface DashboardStats {
  total_messages: number;
  total_calls: number;
  total_users: number;
  messages_today: number;
  calls_today: number;
  avg_response_time_ms: number;
  tokens_used_today: number;
}

export interface SettingsUpdate {
  openrouter_api_key?: string;
  openrouter_model?: string;
  system_prompt?: string;
  max_tokens?: number;
  temperature?: number;
}

export type SettingVisibility = 'visible' | 'internal' | 'derived' | 'deprecated';
export type SettingValueType = 'string' | 'number' | 'boolean' | 'json' | 'secret';
export type SettingDomain =
  | 'chat'
  | 'api_keys'
  | 'multimodal'
  | 'tts'
  | 'telephony'
  | 'persona'
  | 'self_core'
  | 'news'
  | 'lmstudio'
  | 'system';

export interface SettingRegistryEntry {
  key: string;
  label: string;
  domain: SettingDomain;
  visibility: SettingVisibility;
  valueType: SettingValueType;
  description: string;
  uiPages: string[];
  runtimeConsumers: string[];
  sourceOrder: string[];
}

// --------------------------------------------
// Self-Core Types
// --------------------------------------------

export type SelfFactCategory =
  | 'identity'
  | 'relationship'
  | 'capability'
  | 'limitation'
  | 'configuration'
  | 'observation'
  | 'lesson'
  | 'question'
  | 'preference';

export type SelfFactSource =
  | 'system'
  | 'interaction'
  | 'admin'
  | 'manual'
  | 'reflection';

export interface SelfFact {
  id: string;
  category: SelfFactCategory;
  content: string;
  source: SelfFactSource;
  created_at: string;
  is_active: boolean;
}

export type EffectiveValueSource = 'db' | 'env' | 'default' | 'derived' | 'manual';

export type EffectiveCapabilityKey =
  | 'chat'
  | 'vision'
  | 'audio'
  | 'web_search'
  | 'image_generation'
  | 'telephony'
  | 'realtime_voice'
  | 'memory'
  | 'notes'
  | 'reminders'
  | 'digest'
  | 'tts';

export interface EffectiveCapability {
  key: EffectiveCapabilityKey;
  label: string;
  enabled: boolean;
  source: EffectiveValueSource;
  reason: string;
  provider?: string;
  model?: string;
  detail?: string;
}

export interface EffectiveConfigurationEntry {
  key: string;
  label: string;
  value: string;
  source: EffectiveValueSource;
  reason: string;
}

export interface EffectivePersonaSummary {
  name: string;
  ownerTitle: string;
  identity: string;
  relationshipToOwner: string;
}

export interface PersonaChannelVariants {
  telegram: string;
  voice: string;
  digest: string;
  system: string;
}

export interface SelfDisclosureProfile {
  whatSheLivesBy: string;
  whatSheLoves: string;
  howSheRelatesToOwner: string;
  howSheHandlesFlirting: string;
  introShort: string;
  introWarm: string;
}

export interface PersonaCoreState extends EffectivePersonaSummary {
  styleIntensity: number;
  ritualLexicon: string[];
  forbiddenPhrases: string[];
  channelVariants: PersonaChannelVariants;
  selfDescription: SelfDisclosureProfile;
}

export interface ChatRuntimeState {
  savedProvider: string;
  resolvedProvider: string;
  providerSource: 'db' | 'default' | 'derived';
  savedModel: string;
  resolvedModel: string;
  modelSource: 'db' | 'env' | 'default' | 'custom_override' | 'derived';
  customModelOverride: string;
  isLmStudioReady: boolean;
  reason: string;
}

export interface TtsRuntimeState {
  enabled: boolean;
  enabledSource: 'db' | 'default';
  savedProvider: 'elevenlabs' | 'openai' | 'edge';
  resolvedProvider: 'elevenlabs' | 'openai' | 'edge';
  providerSource: 'db' | 'default' | 'derived';
  fallbackReason: string | null;
  voice: string;
  model: string;
}

export interface PersonaRuntimeState {
  name: string;
  ownerTitle: string;
  identity: string;
  relationshipToOwner: string;
  telegramStyle: string;
  voiceStyle: string;
  digestStyle: string;
  systemStyle: string;
}

export interface SelfCorePromptPreview {
  channel: 'telegram' | 'voice' | 'digest' | 'system';
  prompt: string;
}

export interface SelfCoreEffectiveState {
  generated_at: string;
  persona: EffectivePersonaSummary;
  capabilities: EffectiveCapability[];
  configuration: EffectiveConfigurationEntry[];
}

export interface SelfCorePromptLayer {
  id: string;
  name: string;
  channel: 'telegram' | 'voice' | 'all';
  is_active: boolean;
  content: string;
  created_at: string;
  updated_at: string;
}

export interface SelfCoreKernel {
  generated_at: string;
  personaCore: PersonaCoreState;
  runtimeTruth: {
    chat: ChatRuntimeState;
    tts: TtsRuntimeState;
    persona: PersonaRuntimeState;
  };
  effective: SelfCoreEffectiveState;
  activePromptLayers: SelfCorePromptLayer[];
  facts: {
    system: SelfFact[];
    learned: SelfFact[];
  };
}

// --------------------------------------------
// Digest Types
// --------------------------------------------

export type DigestPipelineMode = 'legacy' | 'hybrid_appwrite';

// --------------------------------------------
// News Sources Types
// --------------------------------------------

export type NewsSourceType = 'rss' | 'json_api' | 'html_scrape';
export type NewsSourceCategory = 'ai_tech' | 'city_local' | 'community' | 'asia_tech';
export type ParsedHeadlineCategory = NewsSourceCategory | 'uncategorized';
export type NewsSourceLanguage = 'ru' | 'en' | 'zh' | 'ja' | 'ko';
export type NewsSourceTier = 'tier1' | 'tier2' | 'tier3';

export interface JsonFieldMapping {
  /** Путь к массиву элементов (пустая строка = корневой массив) */
  itemsPath: string;
  /** Поле заголовка */
  titleField: string;
  /** Поле URL (поддерживает fallback через |: "url|story_url") */
  urlField: string;
  /** Поле даты публикации */
  dateField?: string;
  /** Поле краткого описания/сниппета */
  descriptionField?: string;
}

export interface HtmlFieldMapping {
  /** Список селекторов контейнеров карточек/статей */
  itemSelectors?: string[];
  /** Список селекторов ссылок внутри контейнера */
  linkSelectors?: string[];
  /** Список селекторов заголовка внутри контейнера */
  titleSelectors?: string[];
  /** Список селекторов описания/сниппета внутри контейнера */
  descriptionSelectors?: string[];
  /** Список селекторов даты внутри контейнера */
  dateSelectors?: string[];
  /** Атрибут для извлечения даты, если текст пуст */
  dateAttribute?: string;
  /** Селекторы мусорных блоков, которые нужно удалить перед парсингом */
  removeSelectors?: string[];
}

export interface NewsSite {
  name: string;
  url: string;
  enabled: boolean;
  /** Тип источника: rss (по умолчанию), json_api, html_scrape */
  type?: NewsSourceType;
  /** Категория контента */
  category?: NewsSourceCategory;
  /** Язык контента */
  language?: NewsSourceLanguage;
  /** Надёжность/сложность источника */
  tier?: NewsSourceTier;
  /** Маппинг полей для JSON API источников */
  jsonMapping?: JsonFieldMapping;
  /** Маппинг для HTML-скрейпинга нестандартных сайтов */
  htmlMapping?: HtmlFieldMapping;
  /** Ключевые слова для фильтрации заголовков (хотя бы одно должно совпасть) */
  filterKeywords?: string[];
  /** Авто-режим: парсер пробует ВСЕ каналы (RSS→HTML scrape) и объединяет результаты */
  autoMode?: boolean;
}

export interface ParsedHeadline {
  title: string;
  url: string;
  canonicalUrl: string;
  source: string;
  sourceDomain: string;
  description: string;
  fingerprint: string;
  alternateSources: string[];
  pubDate?: string;
  category: ParsedHeadlineCategory;
  language?: NewsSourceLanguage;
  sourceUrl?: string;
  sourceTier?: NewsSourceTier;
  articleExcerpt?: string;
  translatedTitle?: string;
}

export * from './reconciliation.js';
