// ============================================
// Shared Types for Amina Bot
// ============================================

// --------------------------------------------
// Database Types (Supabase)
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
