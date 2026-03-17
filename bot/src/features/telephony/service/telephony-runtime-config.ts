import { settingsRepo } from '../../../db/index.js';
import { SingleCache } from '../../../utils/cache.js';

const RUNTIME_CONFIG_CACHE = new SingleCache<TelephonyRuntimeConfig>(60_000);
const DEFAULT_LIRAX_URL = 'https://api.lirax.net/general';
const DEFAULT_LIRAX_EXT = '201';
const DEFAULT_LATENCY_BUDGET_MS = 1800;
const DEFAULT_RECORDING_RETENTION_DAYS = 30;

export type TelephonyAiProvider = 'inherit' | 'openrouter' | 'lmstudio';

export interface TelephonyRuntimeConfig {
  liraxUrl: string;
  liraxToken: string;
  liraxWebhookToken: string;
  liraxDefaultExt: string;
  operatorPhone: string;
  adminChatId: string;
  ownerChatId: string;
  notifyCalls: boolean;
  notifyRecords: boolean;
  realtimeEnabled: boolean;
  mediaBridgeUrl: string;
  mediaBridgeToken: string;
  mediaBridgeHealthUrl: string;
  archiveRecordings: boolean;
  storePartialTranscript: boolean;
  latencyBudgetMs: number;
  recordingRetentionDays: number;
  sipServer: string;
  sipLogin: string;
  sipPassword: string;
  externalNumber: string;
  aiProvider: TelephonyAiProvider;
  openrouterModel: string;
}

function normalizeText(value: string | undefined): string {
  return value?.trim() || '';
}

function normalizeBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value === 'true';
}

function normalizeNumber(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

function normalizeAiProvider(value: string | undefined): TelephonyAiProvider {
  if (value === 'openrouter' || value === 'lmstudio') {
    return value;
  }

  return 'inherit';
}

function buildHealthUrl(url: string): string {
  if (!url) {
    return '';
  }

  return `${url.replace(/\/+$/, '')}/health`;
}

export async function getTelephonyRuntimeConfig(): Promise<TelephonyRuntimeConfig> {
  const cached = RUNTIME_CONFIG_CACHE.get();
  if (cached) {
    return cached;
  }

  const settings = await settingsRepo.getMany([
    'admin_chat_id',
    'lirax_admin_chat_id',
    'lirax_owner_chat_id',
    'lirax_url',
    'lirax_token',
    'lirax_webhook_token',
    'lirax_default_ext',
    'lirax_operator_phone',
    'lirax_notify_calls',
    'lirax_notify_records',
    'telephony_realtime_enabled',
    'telephony_media_bridge_url',
    'telephony_media_bridge_token',
    'telephony_media_bridge_health_url',
    'telephony_recordings_archive_enabled',
    'telephony_partial_transcript_enabled',
    'telephony_latency_budget_ms',
    'telephony_recording_retention_days',
    'telephony_sip_server',
    'telephony_sip_login',
    'telephony_sip_password',
    'telephony_external_number',
    'telephony_ai_provider',
    'telephony_openrouter_model',
  ]);

  const liraxUrl = normalizeText(settings['lirax_url'])
    || normalizeText(process.env.LIRAX_URL)
    || DEFAULT_LIRAX_URL;
  const mediaBridgeUrl = normalizeText(settings['telephony_media_bridge_url'])
    || normalizeText(process.env.TELEPHONY_MEDIA_BRIDGE_URL);

  const runtimeConfig: TelephonyRuntimeConfig = {
    liraxUrl,
    liraxToken: normalizeText(settings['lirax_token']) || normalizeText(process.env.LIRAX_TOKEN),
    liraxWebhookToken:
      normalizeText(settings['lirax_webhook_token']) || normalizeText(process.env.LIRAX_WEBHOOK_TOKEN),
    liraxDefaultExt:
      normalizeText(settings['lirax_default_ext']) || normalizeText(process.env.LIRAX_DEFAULT_EXT) || DEFAULT_LIRAX_EXT,
    operatorPhone: normalizeText(settings['lirax_operator_phone']),
    adminChatId: normalizeText(settings['lirax_admin_chat_id']) || normalizeText(settings['admin_chat_id']),
    ownerChatId:
      normalizeText(settings['lirax_owner_chat_id'])
      || normalizeText(settings['lirax_admin_chat_id'])
      || normalizeText(settings['admin_chat_id']),
    notifyCalls: normalizeBoolean(settings['lirax_notify_calls'], true),
    notifyRecords: normalizeBoolean(settings['lirax_notify_records'], true),
    realtimeEnabled:
      settings['telephony_realtime_enabled'] === 'true'
      || process.env.TELEPHONY_REALTIME_ENABLED === 'true',
    mediaBridgeUrl,
    mediaBridgeToken:
      normalizeText(settings['telephony_media_bridge_token'])
      || normalizeText(process.env.TELEPHONY_MEDIA_BRIDGE_TOKEN),
    mediaBridgeHealthUrl:
      normalizeText(settings['telephony_media_bridge_health_url']) || buildHealthUrl(mediaBridgeUrl),
    archiveRecordings: normalizeBoolean(
      settings['telephony_recordings_archive_enabled'] ?? process.env.TELEPHONY_RECORDINGS_ARCHIVE_ENABLED,
      true,
    ),
    storePartialTranscript: normalizeBoolean(
      settings['telephony_partial_transcript_enabled'] ?? process.env.TELEPHONY_PARTIAL_TRANSCRIPT_ENABLED,
      true,
    ),
    latencyBudgetMs: normalizeNumber(
      settings['telephony_latency_budget_ms'] ?? process.env.TELEPHONY_LATENCY_BUDGET_MS,
      DEFAULT_LATENCY_BUDGET_MS,
      500,
      10_000,
    ),
    recordingRetentionDays: normalizeNumber(
      settings['telephony_recording_retention_days'] ?? process.env.TELEPHONY_RECORDING_RETENTION_DAYS,
      DEFAULT_RECORDING_RETENTION_DAYS,
      1,
      365,
    ),
    sipServer: normalizeText(settings['telephony_sip_server']) || normalizeText(process.env.TELEPHONY_SIP_SERVER),
    sipLogin: normalizeText(settings['telephony_sip_login']) || normalizeText(process.env.TELEPHONY_SIP_LOGIN),
    sipPassword:
      normalizeText(settings['telephony_sip_password']) || normalizeText(process.env.TELEPHONY_SIP_PASSWORD),
    externalNumber:
      normalizeText(settings['telephony_external_number'])
      || normalizeText(process.env.TELEPHONY_EXTERNAL_NUMBER),
    aiProvider: normalizeAiProvider(settings['telephony_ai_provider']),
    openrouterModel:
      normalizeText(settings['telephony_openrouter_model'])
      || normalizeText(process.env.TELEPHONY_OPENROUTER_MODEL),
  };

  RUNTIME_CONFIG_CACHE.set(runtimeConfig);
  return runtimeConfig;
}

export function clearTelephonyRuntimeConfigCache(): void {
  RUNTIME_CONFIG_CACHE.clear();
}
