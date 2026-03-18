import { config } from '../../../config/index.js';
import { settingsRepo } from '../../../db/index.js';
import { SingleCache } from '../../../utils/cache.js';

const RUNTIME_CONFIG_CACHE = new SingleCache<TelephonyRuntimeConfig>(60_000);
const DEFAULT_LIRAX_URL = 'https://api.lirax.net/general';
const DEFAULT_LIRAX_EXT = '201';
const DEFAULT_LATENCY_BUDGET_MS = 1800;
const DEFAULT_RECORDING_RETENTION_DAYS = 30;

export type TelephonyAiProvider = 'inherit' | 'openrouter' | 'lmstudio';

export interface TelephonyAiEffectiveState {
  preferredProvider: TelephonyAiProvider;
  preferredProviderSource: 'db' | 'env' | 'default';
  preferredProviderReason: string;
  preferredOpenrouterModel: string;
  preferredOpenrouterModelSource: 'db' | 'env' | 'default';
  preferredOpenrouterModelReason: string;
  effectiveProvider: 'auto' | 'openrouter' | 'lmstudio';
  effectiveProviderSource: 'db' | 'env' | 'default' | 'derived';
  effectiveProviderReason: string;
  effectiveModel: string;
  effectiveModelSource: 'db' | 'env' | 'default' | 'derived';
  effectiveModelReason: string;
}

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
  aiEffectiveState: TelephonyAiEffectiveState;
}

/**
 * Единый helper: приоритет DB -> env -> code default.
 * Строковое значение: обрезаем пробелы, пустая строка → следующий источник.
 */
function resolveStringSetting(...sources: (string | undefined)[]): string {
  for (const source of sources) {
    const trimmed = source?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return '';
}

/**
 * Единый helper для булевых настроек.
 * 'true' → true, 'false' → false, undefined → fallback.
 */
function resolveBooleanSetting(
  dbValue: string | undefined,
  envValue: string | undefined,
  fallback: boolean,
): boolean {
  if (dbValue !== undefined) {
    return dbValue === 'true';
  }
  if (envValue !== undefined) {
    return envValue === 'true';
  }
  return fallback;
}

/**
 * Единый helper для числовых настроек с валидацией диапазона.
 */
function resolveNumberSetting(
  dbValue: string | undefined,
  envValue: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  for (const raw of [dbValue, envValue]) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= min && parsed <= max) {
      return parsed;
    }
  }
  return fallback;
}

function resolveAiProvider(
  dbValue: string | undefined,
  envValue: string | undefined,
): TelephonyAiProvider {
  for (const v of [dbValue, envValue]) {
    if (v === 'openrouter' || v === 'lmstudio') {
      return v;
    }
  }
  return 'inherit';
}

function resolveGlobalAiProvider(dbValue: string | undefined): 'auto' | 'openrouter' | 'lmstudio' {
  if (dbValue === 'openrouter' || dbValue === 'lmstudio') {
    return dbValue;
  }
  return 'auto';
}

function resolveEffectiveTelephonyAiState(input: {
  telephonyProviderDb: string | undefined;
  telephonyProviderEnv: string | undefined;
  telephonyModelDb: string | undefined;
  telephonyModelEnv: string | undefined;
  globalProviderDb: string | undefined;
  globalOpenrouterModelDb: string | undefined;
  globalOpenrouterModelEnv: string | undefined;
  globalCustomModelOverrideDb: string | undefined;
  lmstudioModelDb: string | undefined;
}): TelephonyAiEffectiveState {
  const providerDb = input.telephonyProviderDb?.trim();
  const providerEnv = input.telephonyProviderEnv?.trim();
  const preferredProvider = resolveAiProvider(providerDb, providerEnv);
  const preferredProviderSource = providerDb
    ? 'db'
    : providerEnv
      ? 'env'
      : 'default';
  const preferredProviderReason = providerDb
    ? 'Telephony AI provider задан в Appwrite.'
    : providerEnv
      ? 'Telephony AI provider пришёл из env.'
      : 'Telephony AI provider использует режим inherit по умолчанию.';

  const modelDb = input.telephonyModelDb?.trim();
  const modelEnv = input.telephonyModelEnv?.trim();
  const preferredOpenrouterModel = modelDb || modelEnv || '';
  const preferredOpenrouterModelSource = modelDb
    ? 'db'
    : modelEnv
      ? 'env'
      : 'default';
  const preferredOpenrouterModelReason = modelDb
    ? 'Telephony OpenRouter model задана в Appwrite.'
    : modelEnv
      ? 'Telephony OpenRouter model пришла из env.'
      : 'Отдельная telephony OpenRouter model не задана.';

  if (preferredProvider === 'openrouter') {
    const customOverride = input.globalCustomModelOverrideDb?.trim();
    const globalModelDb = input.globalOpenrouterModelDb?.trim();
    const globalModelEnv = input.globalOpenrouterModelEnv?.trim();
    const effectiveModel = preferredOpenrouterModel || customOverride || globalModelDb || globalModelEnv || config.ai.model || 'openrouter/free';
    const effectiveModelSource = preferredOpenrouterModel
      ? preferredOpenrouterModelSource
      : customOverride
        ? 'derived'
        : globalModelDb
          ? 'db'
          : globalModelEnv
            ? 'env'
            : 'default';
    const effectiveModelReason = preferredOpenrouterModel
      ? 'Telephony использует собственную preferred OpenRouter model.'
      : customOverride
        ? 'Telephony provider принудительно OpenRouter, поэтому применяется общий custom_model_override.'
        : globalModelDb || globalModelEnv
          ? 'Telephony provider принудительно OpenRouter, используется общий chat model fallback.'
          : 'Telephony provider принудительно OpenRouter, используется кодовый default модели.';

    return {
      preferredProvider,
      preferredProviderSource,
      preferredProviderReason,
      preferredOpenrouterModel,
      preferredOpenrouterModelSource,
      preferredOpenrouterModelReason,
      effectiveProvider: 'openrouter',
      effectiveProviderSource: preferredProviderSource,
      effectiveProviderReason: 'Telephony provider принудительно переключён на OpenRouter.',
      effectiveModel,
      effectiveModelSource,
      effectiveModelReason,
    };
  }

  if (preferredProvider === 'lmstudio') {
    const lmstudioModel = input.lmstudioModelDb?.trim() || '';
    return {
      preferredProvider,
      preferredProviderSource,
      preferredProviderReason,
      preferredOpenrouterModel,
      preferredOpenrouterModelSource,
      preferredOpenrouterModelReason,
      effectiveProvider: 'lmstudio',
      effectiveProviderSource: preferredProviderSource,
      effectiveProviderReason: 'Telephony provider принудительно переключён на LM Studio.',
      effectiveModel: lmstudioModel,
      effectiveModelSource: lmstudioModel ? 'db' : 'default',
      effectiveModelReason: lmstudioModel
        ? 'Используется модель из LM Studio конфигурации.'
        : 'LM Studio выбран, но явная модель не задана в настройках.',
    };
  }

  const globalProvider = resolveGlobalAiProvider(input.globalProviderDb?.trim());
  const customOverride = input.globalCustomModelOverrideDb?.trim();
  const globalModelDb = input.globalOpenrouterModelDb?.trim();
  const globalModelEnv = input.globalOpenrouterModelEnv?.trim();
  const lmstudioModel = input.lmstudioModelDb?.trim() || '';

  if (globalProvider === 'openrouter') {
    const effectiveModel = preferredOpenrouterModel || customOverride || globalModelDb || globalModelEnv || config.ai.model || 'openrouter/free';
    const effectiveModelSource = preferredOpenrouterModel
      ? preferredOpenrouterModelSource
      : customOverride
        ? 'derived'
        : globalModelDb
          ? 'db'
          : globalModelEnv
            ? 'env'
            : 'default';
    const effectiveModelReason = preferredOpenrouterModel
      ? 'Telephony наследует provider=openrouter, но использует собственную preferred OpenRouter model.'
      : customOverride
        ? 'Telephony наследует provider=openrouter и использует общий custom_model_override.'
        : globalModelDb || globalModelEnv
          ? 'Telephony наследует глобальную OpenRouter model.'
          : 'Telephony наследует OpenRouter и использует кодовый default модели.';

    return {
      preferredProvider,
      preferredProviderSource,
      preferredProviderReason,
      preferredOpenrouterModel,
      preferredOpenrouterModelSource,
      preferredOpenrouterModelReason,
      effectiveProvider: 'openrouter',
      effectiveProviderSource: 'derived',
      effectiveProviderReason: 'Telephony provider = inherit, поэтому унаследован глобальный OpenRouter runtime.',
      effectiveModel,
      effectiveModelSource,
      effectiveModelReason,
    };
  }

  if (globalProvider === 'lmstudio') {
    return {
      preferredProvider,
      preferredProviderSource,
      preferredProviderReason,
      preferredOpenrouterModel,
      preferredOpenrouterModelSource,
      preferredOpenrouterModelReason,
      effectiveProvider: 'lmstudio',
      effectiveProviderSource: 'derived',
      effectiveProviderReason: 'Telephony provider = inherit, поэтому унаследован глобальный LM Studio runtime.',
      effectiveModel: lmstudioModel,
      effectiveModelSource: lmstudioModel ? 'db' : 'default',
      effectiveModelReason: lmstudioModel
        ? 'Telephony наследует модель из LM Studio конфигурации.'
        : 'Telephony наследует LM Studio, но явная модель не задана.',
    };
  }

  return {
    preferredProvider,
    preferredProviderSource,
    preferredProviderReason,
    preferredOpenrouterModel,
    preferredOpenrouterModelSource,
    preferredOpenrouterModelReason,
    effectiveProvider: 'auto',
    effectiveProviderSource: 'derived',
    effectiveProviderReason: 'Telephony provider = inherit, а глобальный provider не закреплён жёстко.',
    effectiveModel: preferredOpenrouterModel || customOverride || globalModelDb || globalModelEnv || config.ai.model || 'openrouter/free',
    effectiveModelSource: preferredOpenrouterModel
      ? preferredOpenrouterModelSource
      : customOverride
        ? 'derived'
        : globalModelDb
          ? 'db'
          : globalModelEnv
            ? 'env'
            : 'default',
    effectiveModelReason: preferredOpenrouterModel
      ? 'Если auto-runtime выберет OpenRouter, будет использована telephony preferred OpenRouter model.'
      : 'Telephony provider в auto-режиме; effective model показывает вероятный OpenRouter fallback.',
  };
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
    'ai_provider',
    'openrouter_model',
    'custom_model_override',
    'lmstudio_model',
  ]);

  // Единый приоритет для всех telephony полей: DB -> env -> code default
  const liraxUrl = resolveStringSetting(
    settings['lirax_url'],
    process.env.LIRAX_URL,
    DEFAULT_LIRAX_URL,
  );
  const mediaBridgeUrl = resolveStringSetting(
    settings['telephony_media_bridge_url'],
    process.env.TELEPHONY_MEDIA_BRIDGE_URL,
  );

  const aiEffectiveState = resolveEffectiveTelephonyAiState({
    telephonyProviderDb: settings['telephony_ai_provider'],
    telephonyProviderEnv: process.env.TELEPHONY_AI_PROVIDER,
    telephonyModelDb: settings['telephony_openrouter_model'],
    telephonyModelEnv: process.env.TELEPHONY_OPENROUTER_MODEL,
    globalProviderDb: settings['ai_provider'],
    globalOpenrouterModelDb: settings['openrouter_model'],
    globalOpenrouterModelEnv: process.env.OPENROUTER_MODEL,
    globalCustomModelOverrideDb: settings['custom_model_override'],
    lmstudioModelDb: settings['lmstudio_model'],
  });

  const runtimeConfig: TelephonyRuntimeConfig = {
    liraxUrl,
    liraxToken: resolveStringSetting(settings['lirax_token'], process.env.LIRAX_TOKEN),
    liraxWebhookToken: resolveStringSetting(
      settings['lirax_webhook_token'],
      process.env.LIRAX_WEBHOOK_TOKEN,
    ),
    liraxDefaultExt: resolveStringSetting(
      settings['lirax_default_ext'],
      process.env.LIRAX_DEFAULT_EXT,
      DEFAULT_LIRAX_EXT,
    ),
    operatorPhone: resolveStringSetting(
      settings['lirax_operator_phone'],
      process.env.LIRAX_OPERATOR_PHONE,
    ),
    adminChatId: resolveStringSetting(
      settings['lirax_admin_chat_id'],
      settings['admin_chat_id'],
      process.env.LIRAX_ADMIN_CHAT_ID,
    ),
    ownerChatId: resolveStringSetting(
      settings['lirax_owner_chat_id'],
      settings['lirax_admin_chat_id'],
      settings['admin_chat_id'],
      process.env.LIRAX_OWNER_CHAT_ID,
    ),
    notifyCalls: resolveBooleanSetting(
      settings['lirax_notify_calls'],
      process.env.LIRAX_NOTIFY_CALLS,
      true,
    ),
    notifyRecords: resolveBooleanSetting(
      settings['lirax_notify_records'],
      process.env.LIRAX_NOTIFY_RECORDS,
      true,
    ),
    realtimeEnabled: resolveBooleanSetting(
      settings['telephony_realtime_enabled'],
      process.env.TELEPHONY_REALTIME_ENABLED,
      false,
    ),
    mediaBridgeUrl,
    mediaBridgeToken: resolveStringSetting(
      settings['telephony_media_bridge_token'],
      process.env.TELEPHONY_MEDIA_BRIDGE_TOKEN,
    ),
    mediaBridgeHealthUrl: resolveStringSetting(
      settings['telephony_media_bridge_health_url'],
      process.env.TELEPHONY_MEDIA_BRIDGE_HEALTH_URL,
      buildHealthUrl(mediaBridgeUrl),
    ),
    archiveRecordings: resolveBooleanSetting(
      settings['telephony_recordings_archive_enabled'],
      process.env.TELEPHONY_RECORDINGS_ARCHIVE_ENABLED,
      true,
    ),
    storePartialTranscript: resolveBooleanSetting(
      settings['telephony_partial_transcript_enabled'],
      process.env.TELEPHONY_PARTIAL_TRANSCRIPT_ENABLED,
      true,
    ),
    latencyBudgetMs: resolveNumberSetting(
      settings['telephony_latency_budget_ms'],
      process.env.TELEPHONY_LATENCY_BUDGET_MS,
      DEFAULT_LATENCY_BUDGET_MS,
      500,
      10_000,
    ),
    recordingRetentionDays: resolveNumberSetting(
      settings['telephony_recording_retention_days'],
      process.env.TELEPHONY_RECORDING_RETENTION_DAYS,
      DEFAULT_RECORDING_RETENTION_DAYS,
      1,
      365,
    ),
    sipServer: resolveStringSetting(
      settings['telephony_sip_server'],
      process.env.TELEPHONY_SIP_SERVER,
    ),
    sipLogin: resolveStringSetting(
      settings['telephony_sip_login'],
      process.env.TELEPHONY_SIP_LOGIN,
    ),
    sipPassword: resolveStringSetting(
      settings['telephony_sip_password'],
      process.env.TELEPHONY_SIP_PASSWORD,
    ),
    externalNumber: resolveStringSetting(
      settings['telephony_external_number'],
      process.env.TELEPHONY_EXTERNAL_NUMBER,
    ),
    aiProvider: aiEffectiveState.preferredProvider,
    openrouterModel: aiEffectiveState.preferredOpenrouterModel,
    aiEffectiveState,
  };

  RUNTIME_CONFIG_CACHE.set(runtimeConfig);
  return runtimeConfig;
}

export function clearTelephonyRuntimeConfigCache(): void {
  RUNTIME_CONFIG_CACHE.clear();
}
