import { getSpeechRecognitionRuntimeProfile } from '../../../ai/multimodal.js';
import { config } from '../../../config/index.js';
import { FETCH_TIMEOUT_MS } from '../../../config/constants.js';
import { settingsRepo } from '../../../db/supabase.js';
import { getTtsRuntimeProfile } from '../../tts.js';

const DEFAULT_LATENCY_BUDGET_MS = 1800;
const DEFAULT_RECORDING_RETENTION_DAYS = 30;

export interface RealtimeBridgeConfig {
  enabled: boolean;
  url: string;
  token: string;
  archiveRecordings: boolean;
  storePartialTranscript: boolean;
  latencyBudgetMs: number;
  recordingRetentionDays: number;
  healthUrl: string;
}

export interface RealtimeBridgeStatus {
  enabled: boolean;
  configured: boolean;
  url: string;
  healthUrl: string;
  reachable: boolean | null;
  archiveRecordings: boolean;
  storePartialTranscript: boolean;
  latencyBudgetMs: number;
  recordingRetentionDays: number;
  voiceProvider: string;
  voiceModel: string;
  speechModel: string;
}

function normalizeBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value === 'true';
}

function normalizeNumber(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return fallback;
  }

  return parsed;
}

function buildHealthUrl(url: string): string {
  if (!url) {
    return '';
  }

  return `${url.replace(/\/+$/, '')}/health`;
}

export async function getRealtimeBridgeConfig(): Promise<RealtimeBridgeConfig> {
  const settings = await settingsRepo.getMany([
    'telephony_realtime_enabled',
    'telephony_media_bridge_url',
    'telephony_media_bridge_token',
    'telephony_recordings_archive_enabled',
    'telephony_partial_transcript_enabled',
    'telephony_latency_budget_ms',
    'telephony_recording_retention_days',
    'telephony_media_bridge_health_url',
  ]);

  const url = settings['telephony_media_bridge_url'] || process.env.TELEPHONY_MEDIA_BRIDGE_URL || '';

  return {
    enabled: settings['telephony_realtime_enabled'] === 'true'
      || process.env.TELEPHONY_REALTIME_ENABLED === 'true',
    url,
    token: settings['telephony_media_bridge_token'] || process.env.TELEPHONY_MEDIA_BRIDGE_TOKEN || '',
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
    healthUrl: settings['telephony_media_bridge_health_url'] || buildHealthUrl(url),
  };
}

export function getRealtimeBridgeCallbackBaseUrl(): string {
  return `${config.botUrl}/api/telephony/realtime/bridge`;
}

export async function getRealtimeBridgeRuntimeProfile(): Promise<{
  config: RealtimeBridgeConfig;
  voice: Awaited<ReturnType<typeof getTtsRuntimeProfile>>;
  speech: Awaited<ReturnType<typeof getSpeechRecognitionRuntimeProfile>>;
  callbacks: {
    eventsUrl: string;
    respondUrl: string;
  };
}> {
  const bridgeConfig = await getRealtimeBridgeConfig();
  const [voice, speech] = await Promise.all([
    getTtsRuntimeProfile(),
    getSpeechRecognitionRuntimeProfile(),
  ]);

  const callbackBaseUrl = getRealtimeBridgeCallbackBaseUrl();

  return {
    config: bridgeConfig,
    voice,
    speech,
    callbacks: {
      eventsUrl: `${callbackBaseUrl}/events`,
      respondUrl: `${callbackBaseUrl}/respond`,
    },
  };
}

export async function isRealtimeBridgeTokenValid(token: string | null | undefined): Promise<boolean> {
  const expectedToken = (await getRealtimeBridgeConfig()).token;
  return Boolean(token && expectedToken && token === expectedToken);
}

export async function getRealtimeBridgeStatus(): Promise<RealtimeBridgeStatus> {
  const runtimeProfile = await getRealtimeBridgeRuntimeProfile();
  let reachable: boolean | null = null;

  if (runtimeProfile.config.enabled && runtimeProfile.config.healthUrl) {
    try {
      const response = await fetch(runtimeProfile.config.healthUrl, {
        headers: runtimeProfile.config.token
          ? { Authorization: `Bearer ${runtimeProfile.config.token}` }
          : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      reachable = response.ok;
    } catch {
      reachable = false;
    }
  }

  return {
    enabled: runtimeProfile.config.enabled,
    configured: Boolean(runtimeProfile.config.url),
    url: runtimeProfile.config.url,
    healthUrl: runtimeProfile.config.healthUrl,
    reachable,
    archiveRecordings: runtimeProfile.config.archiveRecordings,
    storePartialTranscript: runtimeProfile.config.storePartialTranscript,
    latencyBudgetMs: runtimeProfile.config.latencyBudgetMs,
    recordingRetentionDays: runtimeProfile.config.recordingRetentionDays,
    voiceProvider: runtimeProfile.voice.provider,
    voiceModel: runtimeProfile.voice.provider === 'elevenlabs'
      ? runtimeProfile.voice.elevenlabsModelId
      : runtimeProfile.voice.provider === 'openai'
        ? runtimeProfile.voice.openaiModel
        : runtimeProfile.voice.edgeVoice,
    speechModel: runtimeProfile.speech.audioModel,
  };
}
