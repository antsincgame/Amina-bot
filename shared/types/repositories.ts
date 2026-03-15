/**
 * Repository Interfaces — абстракция над хранилищем данных.
 *
 * Текущая реализация: Appwrite
 * Целевая миграция:   AppWrite (Databases + Auth + Storage)
 *
 * Все репозитории реализуют эти интерфейсы.
 * Бизнес-логика работает ТОЛЬКО через интерфейсы, не через конкретную БД.
 */

import type {
  Settings,
  Prompt,
  Conversation,
  Message,
  ConversationMetadata,
  AnalyticsEventType,
  SystemLog,
  LogLevel,
  Reminder,
} from './index.js';

// ============================================
//  Settings Repository
// ============================================

export interface ISettingsRepo {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  getAll(): Promise<Settings[]>;
  getMany(keys: string[]): Promise<Record<string, string>>;
  invalidateCache?(): void;
}

// ============================================
//  Prompts Repository
// ============================================

export interface IPromptsRepo {
  getActive(channel: 'telegram' | 'voice' | 'all'): Promise<Prompt | null>;
  getAll(): Promise<Prompt[]>;
  create(prompt: Omit<Prompt, 'id' | 'created_at' | 'updated_at'>): Promise<Prompt>;
  update(id: string, updates: Partial<Pick<Prompt, 'name' | 'content' | 'channel' | 'is_active'>>): Promise<Prompt>;
  delete(id: string): Promise<void>;
  setActive(id: string): Promise<void>;
}

// ============================================
//  Conversations Repository
// ============================================

export interface IConversationsRepo {
  getOrCreate(
    userId: string,
    channel: 'telegram' | 'voice',
    metadata?: Partial<ConversationMetadata>
  ): Promise<Conversation>;
  get(conversationId: string): Promise<Conversation>;
  addMessage(conversationId: string, message: Message): Promise<void>;
  getMessages(conversationId: string, limit?: number): Promise<Message[]>;
  clearMessages(conversationId: string): Promise<void>;
}

// ============================================
//  Analytics Repository
// ============================================

export interface IAnalyticsRepo {
  log(
    eventType: AnalyticsEventType,
    channel: 'telegram' | 'voice' | 'admin',
    data: Record<string, unknown>,
    userId?: string
  ): Promise<void>;
  getStats(
    fromDate: Date,
    toDate: Date
  ): Promise<{
    total: number;
    byType: Record<string, number>;
    byChannel: Record<string, number>;
  }>;
}

// ============================================
//  Reminders Repository
// ============================================

export interface IReminderCreateInput {
  user_id: string;
  chat_id: number;
  task: string;
  scheduled_at: string;
}

export interface IRemindersRepo {
  create(reminder: IReminderCreateInput): Promise<Reminder>;
  getByUser(userId: string, limit?: number): Promise<Reminder[]>;
  getDue(): Promise<Reminder[]>;
  markCompleted(id: string): Promise<void>;
  delete(id: string): Promise<void>;
  countByUser(userId: string): Promise<number>;
}

// ============================================
//  Notes Repository
// ============================================

export interface INote {
  id: string;
  user_id: string;
  content: string;
  created_at: string;
}

export interface INotesRepo {
  create(userId: string, content: string): Promise<INote>;
  getByUser(userId: string, limit?: number): Promise<INote[]>;
  deleteByIndex(userId: string, index: number): Promise<boolean>;
  countByUser(userId: string): Promise<number>;
}

// ============================================
//  Todos Repository
// ============================================

export interface ITodo {
  id: string;
  user_id: string;
  task: string;
  is_done: boolean;
  created_at: string;
  completed_at?: string;
}

export interface ITodosRepo {
  create(userId: string, task: string): Promise<ITodo>;
  getActive(userId: string, limit?: number): Promise<ITodo[]>;
  markDone(userId: string, index: number): Promise<boolean>;
  delete(userId: string, index: number): Promise<boolean>;
  countActive(userId: string): Promise<number>;
}

// ============================================
//  System Logs Repository
// ============================================

export interface ISystemLogsRepo {
  queue(log: Omit<SystemLog, 'id'>): void;
  flush(): Promise<void>;
  getLogs(options: {
    level?: LogLevel;
    module?: string;
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<SystemLog[]>;
  getStats(from: Date, to: Date): Promise<{
    total: number;
    byLevel: Record<string, number>;
    byModule: Record<string, number>;
  }>;
}

// ============================================
//  User Preferences Repository
// ============================================

export interface IUserPreferences {
  id: string;
  user_id: string;
  digest_enabled: boolean;
  digest_time: string;
  language: string;
  timezone: string;
}

export interface IUserPrefsRepo {
  getOrCreate(userId: string): Promise<IUserPreferences>;
  update(userId: string, updates: Partial<Omit<IUserPreferences, 'id' | 'user_id'>>): Promise<IUserPreferences>;
  get(userId: string): Promise<IUserPreferences | null>;
}

// ============================================
//  Storage (File) Repository
// ============================================

export interface IStorageRepo {
  upload(bucket: string, path: string, data: Buffer, contentType?: string): Promise<string>;
  download(bucket: string, path: string): Promise<Buffer | null>;
  getSignedUrl(bucket: string, path: string, expiresIn?: number): Promise<string | null>;
  delete(bucket: string, path: string): Promise<void>;
}

// ============================================
//  Database Provider (factory)
// ============================================

export interface IDatabaseProvider {
  readonly settings: ISettingsRepo;
  readonly prompts: IPromptsRepo;
  readonly conversations: IConversationsRepo;
  readonly analytics: IAnalyticsRepo;

  ping(): Promise<boolean>;
}
