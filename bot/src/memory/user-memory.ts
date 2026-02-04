/**
 * User Memory Service
 * 
 * Управление долгосрочной памятью о пользователях
 */

import { getSupabase } from '../db/supabase.js';
import { dbLogger, aiLogger } from '../config/logger.js';
import { aiService } from '../ai/openrouter.js';

// --------------------------------------------
// Types
// --------------------------------------------

export interface UserProfile {
  id: string;
  user_id: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code: string;
  total_messages: number;
  total_voice_messages: number;
  total_images: number;
  total_tokens_used: number;
  first_seen_at: string;
  last_seen_at: string;
  last_message_at?: string;
  preferences: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface UserMemory {
  id: string;
  user_id: string;
  memory_type: 'fact' | 'preference' | 'context' | 'summary' | 'important';
  content: string;
  source?: string;
  confidence: number;
  created_at: string;
  updated_at: string;
  expires_at?: string;
  is_active: boolean;
  is_pinned: boolean;
}

export interface UserLog {
  id: string;
  user_id: string;
  event_type: 'message' | 'voice' | 'image' | 'command' | 'ai_response' | 'error' | 'memory_created' | 'memory_updated' | 'session_start' | 'session_end';
  content?: string;
  metadata: Record<string, unknown>;
  model?: string;
  tokens_prompt?: number;
  tokens_completion?: number;
  response_time_ms?: number;
  timestamp: string;
}

export interface TelegramUserInfo {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code?: string;
}

// --------------------------------------------
// User Profile Repository
// --------------------------------------------

// Flag to track if tables exist (avoid repeated error logs)
let tablesExist: boolean | null = null;

async function checkTablesExist(): Promise<boolean> {
  if (tablesExist !== null) return tablesExist;
  
  try {
    const supabase = getSupabase();
    const { error } = await supabase
      .from('user_profiles')
      .select('id')
      .limit(1);
    
    tablesExist = !error || error.code !== '42P01'; // 42P01 = table does not exist
    if (!tablesExist) {
      dbLogger.warn('User memory tables not found. Run migration 004_user_memory.sql');
    }
    return tablesExist;
  } catch {
    tablesExist = false;
    return false;
  }
}

// Default empty profile for graceful degradation
function createEmptyProfile(userId: string, telegramInfo?: TelegramUserInfo): UserProfile {
  return {
    id: 'temp-' + userId,
    user_id: userId,
    username: telegramInfo?.username,
    first_name: telegramInfo?.first_name,
    last_name: telegramInfo?.last_name,
    language_code: telegramInfo?.language_code || 'ru',
    total_messages: 0,
    total_voice_messages: 0,
    total_images: 0,
    total_tokens_used: 0,
    first_seen_at: new Date().toISOString(),
    last_seen_at: new Date().toISOString(),
    preferences: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export const userProfileRepo = {
  /**
   * Получить или создать профиль пользователя
   */
  async getOrCreate(userId: string, telegramInfo?: TelegramUserInfo): Promise<UserProfile> {
    // Graceful degradation if tables don't exist
    if (!(await checkTablesExist())) {
      return createEmptyProfile(userId, telegramInfo);
    }
    
    const supabase = getSupabase();
    
    try {
      // Сначала пробуем получить
      const { data: existing } = await supabase
        .from('user_profiles')
        .select('*')
        .eq('user_id', userId)
        .single();
      
      if (existing) {
        // Обновляем last_seen_at
        await supabase
          .from('user_profiles')
          .update({ 
            last_seen_at: new Date().toISOString(),
            username: telegramInfo?.username || existing.username,
            first_name: telegramInfo?.first_name || existing.first_name,
            last_name: telegramInfo?.last_name || existing.last_name,
          })
          .eq('user_id', userId);
        
        return existing as UserProfile;
      }
      
      // Создаём новый профиль
      const { data: newProfile, error } = await supabase
        .from('user_profiles')
        .insert({
          user_id: userId,
          username: telegramInfo?.username,
          first_name: telegramInfo?.first_name,
          last_name: telegramInfo?.last_name,
          language_code: telegramInfo?.language_code || 'ru',
        })
        .select()
        .single();
      
      if (error) {
        dbLogger.error({ error, userId }, 'Failed to create user profile');
        return createEmptyProfile(userId, telegramInfo);
      }
      
      dbLogger.info({ userId }, 'New user profile created');
      return newProfile as UserProfile;
    } catch (error) {
      dbLogger.error({ error, userId }, 'Error in getOrCreate profile');
      return createEmptyProfile(userId, telegramInfo);
    }
  },

  /**
   * Обновить статистику после сообщения
   */
  async updateOnMessage(
    userId: string,
    messageType: 'message' | 'voice' | 'image',
    tokensUsed: number = 0,
    telegramInfo?: TelegramUserInfo
  ): Promise<void> {
    // Skip if tables don't exist
    if (!(await checkTablesExist())) return;
    
    const supabase = getSupabase();
    
    try {
      // Используем RPC функцию для атомарного обновления
      const { error } = await supabase.rpc('update_user_profile_on_message', {
        p_user_id: userId,
        p_username: telegramInfo?.username,
        p_first_name: telegramInfo?.first_name,
        p_last_name: telegramInfo?.last_name,
        p_language_code: telegramInfo?.language_code,
        p_message_type: messageType,
        p_tokens_used: tokensUsed,
      });
      
      if (error) {
        // RPC might not exist, just log and continue
        dbLogger.warn({ error, userId }, 'Failed to update user profile (RPC may not exist)');
      }
    } catch (error) {
      dbLogger.warn({ error, userId }, 'Error updating user profile');
    }
  },

  /**
   * Получить профиль по ID
   */
  async get(userId: string): Promise<UserProfile | null> {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();
    
    if (error && error.code !== 'PGRST116') {
      dbLogger.error({ error, userId }, 'Failed to get user profile');
    }
    
    return data as UserProfile | null;
  },

  /**
   * Получить всех пользователей
   */
  async getAll(limit: number = 100, offset: number = 0): Promise<UserProfile[]> {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .order('last_seen_at', { ascending: false })
      .range(offset, offset + limit - 1);
    
    if (error) {
      dbLogger.error({ error }, 'Failed to get user profiles');
      return [];
    }
    
    return (data ?? []) as UserProfile[];
  },

  /**
   * Получить статистику пользователя
   */
  async getStats(userId: string): Promise<Record<string, unknown>> {
    const supabase = getSupabase();
    
    const { data, error } = await supabase.rpc('get_user_stats', {
      p_user_id: userId,
    });
    
    if (error) {
      dbLogger.error({ error, userId }, 'Failed to get user stats');
      return {};
    }
    
    return data ?? {};
  },
};

// --------------------------------------------
// User Memory Repository
// --------------------------------------------

export const userMemoryRepo = {
  /**
   * Добавить запись в память
   */
  async add(
    userId: string,
    memoryType: UserMemory['memory_type'],
    content: string,
    options: {
      source?: string;
      confidence?: number;
      isPinned?: boolean;
      expiresAt?: Date;
    } = {}
  ): Promise<UserMemory | null> {
    // Skip if tables don't exist
    if (!(await checkTablesExist())) return null;
    
    const supabase = getSupabase();
    
    try {
      const { data, error } = await supabase
        .from('user_memory')
        .insert({
          user_id: userId,
          memory_type: memoryType,
          content,
          source: options.source || 'message',
          confidence: options.confidence ?? 1.0,
          is_pinned: options.isPinned ?? false,
          expires_at: options.expiresAt?.toISOString(),
        })
        .select()
        .single();
      
      if (error) {
        dbLogger.warn({ error, userId }, 'Failed to add user memory');
        return null;
      }
      
      dbLogger.info({ userId, memoryType }, 'User memory added');
      return data as UserMemory;
    } catch (error) {
      dbLogger.warn({ error, userId }, 'Error adding user memory');
      return null;
    }
  },

  /**
   * Получить всю активную память пользователя
   */
  async getAll(userId: string, limit: number = 50): Promise<UserMemory[]> {
    // Skip if tables don't exist
    if (!(await checkTablesExist())) return [];
    
    const supabase = getSupabase();
    
    try {
      const { data, error } = await supabase
        .from('user_memory')
        .select('*')
        .eq('user_id', userId)
        .eq('is_active', true)
        .or('expires_at.is.null,expires_at.gt.now()')
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false })
        .limit(limit);
      
      if (error) {
        dbLogger.warn({ error, userId }, 'Failed to get user memory');
        return [];
      }
      
      return (data ?? []) as UserMemory[];
    } catch {
      return [];
    }
  },

  /**
   * Получить память определённого типа
   */
  async getByType(userId: string, memoryType: UserMemory['memory_type']): Promise<UserMemory[]> {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('user_memory')
      .select('*')
      .eq('user_id', userId)
      .eq('memory_type', memoryType)
      .eq('is_active', true)
      .order('created_at', { ascending: false });
    
    if (error) {
      dbLogger.error({ error, userId, memoryType }, 'Failed to get user memory by type');
      return [];
    }
    
    return (data ?? []) as UserMemory[];
  },

  /**
   * Получить закреплённую память (всегда включается в контекст)
   */
  async getPinned(userId: string): Promise<UserMemory[]> {
    const supabase = getSupabase();
    
    const { data, error } = await supabase
      .from('user_memory')
      .select('*')
      .eq('user_id', userId)
      .eq('is_pinned', true)
      .eq('is_active', true);
    
    if (error) {
      dbLogger.error({ error, userId }, 'Failed to get pinned memory');
      return [];
    }
    
    return (data ?? []) as UserMemory[];
  },

  /**
   * Обновить запись памяти
   */
  async update(
    memoryId: string,
    updates: Partial<Pick<UserMemory, 'content' | 'confidence' | 'is_pinned' | 'is_active'>>
  ): Promise<void> {
    const supabase = getSupabase();
    
    const { error } = await supabase
      .from('user_memory')
      .update(updates)
      .eq('id', memoryId);
    
    if (error) {
      dbLogger.error({ error, memoryId }, 'Failed to update user memory');
    }
  },

  /**
   * Деактивировать запись памяти
   */
  async deactivate(memoryId: string): Promise<void> {
    await this.update(memoryId, { is_active: false });
  },

  /**
   * Получить контекст памяти для промпта
   */
  async getContextForPrompt(userId: string): Promise<string> {
    const memories = await this.getAll(userId, 30);
    
    if (memories.length === 0) {
      return '';
    }
    
    // Группируем по типам
    const grouped = {
      important: [] as string[],
      fact: [] as string[],
      preference: [] as string[],
      context: [] as string[],
      summary: [] as string[],
    };
    
    for (const memory of memories) {
      const type = memory.memory_type as keyof typeof grouped;
      if (grouped[type]) {
        grouped[type].push(memory.content);
      }
    }
    
    // Формируем текст контекста
    const parts: string[] = [];
    
    if (grouped.important.length > 0) {
      parts.push(`ВАЖНО о пользователе:\n${grouped.important.map(m => `- ${m}`).join('\n')}`);
    }
    
    if (grouped.fact.length > 0) {
      parts.push(`Факты о пользователе:\n${grouped.fact.map(m => `- ${m}`).join('\n')}`);
    }
    
    if (grouped.preference.length > 0) {
      parts.push(`Предпочтения:\n${grouped.preference.map(m => `- ${m}`).join('\n')}`);
    }
    
    if (grouped.context.length > 0) {
      parts.push(`Текущий контекст:\n${grouped.context.map(m => `- ${m}`).join('\n')}`);
    }
    
    if (grouped.summary.length > 0) {
      parts.push(`Из предыдущих разговоров:\n${grouped.summary.slice(0, 3).map(m => `- ${m}`).join('\n')}`);
    }
    
    return parts.join('\n\n');
  },
};

// --------------------------------------------
// User Logs Repository
// --------------------------------------------

export const userLogsRepo = {
  /**
   * Добавить лог
   */
  async add(
    userId: string,
    eventType: UserLog['event_type'],
    content?: string,
    metadata: Record<string, unknown> = {},
    aiMetrics?: {
      model?: string;
      tokensPrompt?: number;
      tokensCompletion?: number;
      responseTimeMs?: number;
    }
  ): Promise<void> {
    // Skip if tables don't exist
    if (!(await checkTablesExist())) return;
    
    const supabase = getSupabase();
    
    try {
      const { error } = await supabase
        .from('user_logs')
        .insert({
          user_id: userId,
          event_type: eventType,
          content,
          metadata,
          model: aiMetrics?.model,
          tokens_prompt: aiMetrics?.tokensPrompt,
          tokens_completion: aiMetrics?.tokensCompletion,
          response_time_ms: aiMetrics?.responseTimeMs,
        });
      
      if (error) {
        dbLogger.warn({ error, userId, eventType }, 'Failed to add user log');
      }
    } catch {
      // Silently fail - logging should not break the bot
    }
  },

  /**
   * Получить логи пользователя
   */
  async getByUser(
    userId: string,
    options: {
      eventType?: UserLog['event_type'];
      from?: Date;
      to?: Date;
      limit?: number;
    } = {}
  ): Promise<UserLog[]> {
    // Skip if tables don't exist
    if (!(await checkTablesExist())) return [];
    
    const supabase = getSupabase();
    
    try {
      let query = supabase
        .from('user_logs')
        .select('*')
        .eq('user_id', userId)
        .order('timestamp', { ascending: false });
    
      if (options.eventType) {
        query = query.eq('event_type', options.eventType);
      }
      if (options.from) {
        query = query.gte('timestamp', options.from.toISOString());
      }
      if (options.to) {
        query = query.lte('timestamp', options.to.toISOString());
      }
      if (options.limit) {
        query = query.limit(options.limit);
      }
      
      const { data, error } = await query;
      
      if (error) {
        dbLogger.warn({ error, userId }, 'Failed to get user logs');
        return [];
      }
      
      return (data ?? []) as UserLog[];
    } catch {
      return [];
    }
  },

  /**
   * Получить историю сообщений пользователя
   */
  async getMessageHistory(userId: string, limit: number = 100): Promise<UserLog[]> {
    return this.getByUser(userId, {
      eventType: 'message',
      limit,
    });
  },

  /**
   * Получить статистику по типам событий
   */
  async getEventStats(userId: string, days: number = 30): Promise<Record<string, number>> {
    const supabase = getSupabase();
    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - days);
    
    const { data, error } = await supabase
      .from('user_logs')
      .select('event_type')
      .eq('user_id', userId)
      .gte('timestamp', fromDate.toISOString());
    
    if (error) {
      dbLogger.error({ error, userId }, 'Failed to get event stats');
      return {};
    }
    
    const stats: Record<string, number> = {};
    for (const log of data ?? []) {
      stats[log.event_type] = (stats[log.event_type] || 0) + 1;
    }
    
    return stats;
  },
};

// --------------------------------------------
// Memory Extraction Service
// --------------------------------------------

export const memoryExtractor = {
  /**
   * Извлечь факты из сообщения с помощью AI
   */
  async extractFacts(
    userId: string,
    userMessage: string,
    aiResponse: string
  ): Promise<void> {
    // Не извлекаем из коротких сообщений
    if (userMessage.length < 20) return;
    
    try {
      const extractionPrompt = `Проанализируй диалог и извлеки ТОЛЬКО явные факты о пользователе.

Сообщение пользователя: "${userMessage}"
Ответ ассистента: "${aiResponse}"

Извлеки факты в формате JSON массива. Каждый факт должен быть объектом с полями:
- type: "fact" | "preference" | "context" | "important"
- content: краткое описание факта (1 предложение)
- confidence: число от 0 до 1 (насколько уверен в факте)

Примеры фактов:
- "Пользователя зовут Андрей" (type: fact)
- "Работает программистом" (type: fact)
- "Предпочитает Python" (type: preference)
- "Сейчас работает над проектом X" (type: context)

Если фактов нет, верни пустой массив [].
Верни ТОЛЬКО JSON без пояснений.`;

      const response = await aiService.complete(extractionPrompt, 'telegram');
      
      // Парсим JSON
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;
      
      const facts = JSON.parse(jsonMatch[0]) as Array<{
        type: 'fact' | 'preference' | 'context' | 'important';
        content: string;
        confidence: number;
      }>;
      
      // Сохраняем факты
      for (const fact of facts) {
        if (fact.content && fact.confidence > 0.5) {
          await userMemoryRepo.add(userId, fact.type, fact.content, {
            source: 'inference',
            confidence: fact.confidence,
          });
          
          await userLogsRepo.add(userId, 'memory_created', fact.content, {
            memory_type: fact.type,
            confidence: fact.confidence,
          });
        }
      }
      
      if (facts.length > 0) {
        aiLogger.info({ userId, factsCount: facts.length }, 'Facts extracted from conversation');
      }
    } catch (error) {
      aiLogger.error({ error, userId }, 'Failed to extract facts');
    }
  },

  /**
   * Создать краткое содержание разговора
   */
  async summarizeConversation(
    userId: string,
    messages: Array<{ role: string; content: string }>
  ): Promise<string | null> {
    if (messages.length < 4) return null;
    
    try {
      const conversationText = messages
        .map(m => `${m.role === 'user' ? 'Пользователь' : 'Ассистент'}: ${m.content}`)
        .join('\n');
      
      const summaryPrompt = `Создай краткое содержание этого разговора (2-3 предложения):

${conversationText}

Краткое содержание:`;

      const summary = await aiService.complete(summaryPrompt, 'telegram');
      
      // Сохраняем как память
      await userMemoryRepo.add(userId, 'summary', summary.trim(), {
        source: 'summarization',
        confidence: 0.9,
      });
      
      return summary.trim();
    } catch (error) {
      aiLogger.error({ error, userId }, 'Failed to summarize conversation');
      return null;
    }
  },
};

// --------------------------------------------
// Memory Context Builder
// --------------------------------------------

export const memoryContextBuilder = {
  /**
   * Построить полный контекст для AI с учётом памяти
   */
  async buildContext(userId: string, telegramInfo?: TelegramUserInfo): Promise<string> {
    // Получаем профиль
    const profile = await userProfileRepo.getOrCreate(userId, telegramInfo);
    
    // Получаем память
    const memoryContext = await userMemoryRepo.getContextForPrompt(userId);
    
    // Формируем контекст
    const parts: string[] = [];
    
    // Информация о пользователе
    const userName = profile.first_name || profile.username || 'Пользователь';
    parts.push(`=== ИНФОРМАЦИЯ О ПОЛЬЗОВАТЕЛЕ ===`);
    parts.push(`Имя: ${userName}`);
    
    if (profile.total_messages > 0) {
      parts.push(`Общается с тобой с ${new Date(profile.first_seen_at).toLocaleDateString('ru-RU')}`);
      parts.push(`Всего сообщений: ${profile.total_messages}`);
    }
    
    // Память
    if (memoryContext) {
      parts.push(`\n=== ЧТО ТЫ ЗНАЕШЬ О ${userName.toUpperCase()} ===`);
      parts.push(memoryContext);
    }
    
    parts.push(`\n=== ИНСТРУКЦИИ ===`);
    parts.push(`Используй эту информацию для персонализированных ответов.`);
    parts.push(`Обращайся к пользователю по имени когда уместно.`);
    parts.push(`Помни о его предпочтениях и контексте.`);
    
    return parts.join('\n');
  },
};
