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
  voice_duration_ms?: number;
  audio_file_id?: string;
}

export interface ConversationMetadata {
  telegram_chat_id?: number;
  telegram_user_id?: number;
  phone_number?: string;
  call_id?: string;
  language?: string;
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
  | 'settings_updated'
  | 'prompt_updated';

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
// Voice Types
// --------------------------------------------

export interface VoiceConfig {
  stt: STTConfig;
  tts: TTSConfig;
}

export interface STTConfig {
  model_path: string;
  language: string;
  sample_rate: number;
}

export interface TTSConfig {
  model_path: string;
  speaker: string;
  sample_rate: number;
  language: string;
}

export interface TranscriptionResult {
  text: string;
  confidence: number;
  language: string;
  duration_ms: number;
}

export interface SynthesisResult {
  audio: Buffer;
  duration_ms: number;
  sample_rate: number;
  format: 'wav' | 'ogg' | 'mp3';
}

// --------------------------------------------
// Voximplant Types
// --------------------------------------------

export interface VoximplantWebhookEvent {
  event: VoximplantEventType;
  call_session_id: string;
  caller_id?: string;
  destination?: string;
  start_time?: string;
  duration?: number;
  recording_url?: string;
  transcription?: string;
  custom_data?: Record<string, unknown>;
}

export type VoximplantEventType =
  | 'call.started'
  | 'call.connected'
  | 'call.ended'
  | 'call.transcription'
  | 'call.recording';

export interface VoximplantCallState {
  call_id: string;
  status: 'ringing' | 'connected' | 'ended';
  direction: 'inbound' | 'outbound';
  caller_id: string;
  called_number: string;
  started_at: string;
  answered_at?: string;
  ended_at?: string;
  duration_ms?: number;
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
  voice_enabled?: boolean;
  voice_speaker?: string;
  max_tokens?: number;
  temperature?: number;
}
