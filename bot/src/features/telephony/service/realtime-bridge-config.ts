import { getSpeechRecognitionRuntimeProfile } from '../../../ai/multimodal.js';
import { config } from '../../../config/index.js';
import { FETCH_TIMEOUT_MS } from '../../../config/constants.js';
import { getTtsRuntimeProfile } from '../../tts.js';
import { getTelephonyRuntimeConfig, type TelephonyAiEffectiveState } from './telephony-runtime-config.js';

export interface RealtimeBridgeConfig {
  enabled: boolean;
  url: string;
  token: string;
  archiveRecordings: boolean;
  storePartialTranscript: boolean;
  latencyBudgetMs: number;
  recordingRetentionDays: number;
  healthUrl: string;
  sipServer: string;
  sipLogin: string;
  sipPassword: string;
  externalNumber: string;
  aiProvider: string;
  openrouterModel: string;
  aiEffectiveState: TelephonyAiEffectiveState;
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
  telephonyAiProvider: string;
  telephonyAiProviderSource: string;
  telephonyAiProviderReason: string;
  telephonyPreferredOpenrouterModel: string;
  telephonyPreferredOpenrouterModelSource: string;
  telephonyPreferredOpenrouterModelReason: string;
  telephonyEffectiveAiProvider: string;
  telephonyEffectiveAiProviderSource: string;
  telephonyEffectiveAiProviderReason: string;
  telephonyEffectiveModel: string;
  telephonyEffectiveModelSource: string;
  telephonyEffectiveModelReason: string;
  sipServer: string;
  externalNumber: string;
  hasSipCredentials: boolean;
}

export async function getRealtimeBridgeConfig(): Promise<RealtimeBridgeConfig> {
  const runtimeConfig = await getTelephonyRuntimeConfig();

  return {
    enabled: runtimeConfig.realtimeEnabled,
    url: runtimeConfig.mediaBridgeUrl,
    token: runtimeConfig.mediaBridgeToken,
    archiveRecordings: runtimeConfig.archiveRecordings,
    storePartialTranscript: runtimeConfig.storePartialTranscript,
    latencyBudgetMs: runtimeConfig.latencyBudgetMs,
    recordingRetentionDays: runtimeConfig.recordingRetentionDays,
    healthUrl: runtimeConfig.mediaBridgeHealthUrl,
    sipServer: runtimeConfig.sipServer,
    sipLogin: runtimeConfig.sipLogin,
    sipPassword: runtimeConfig.sipPassword,
    externalNumber: runtimeConfig.externalNumber,
    aiProvider: runtimeConfig.aiProvider,
    openrouterModel: runtimeConfig.openrouterModel,
    aiEffectiveState: runtimeConfig.aiEffectiveState,
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
    telephonyAiProvider: runtimeProfile.config.aiEffectiveState.preferredProvider,
    telephonyAiProviderSource: runtimeProfile.config.aiEffectiveState.preferredProviderSource,
    telephonyAiProviderReason: runtimeProfile.config.aiEffectiveState.preferredProviderReason,
    telephonyPreferredOpenrouterModel: runtimeProfile.config.aiEffectiveState.preferredOpenrouterModel,
    telephonyPreferredOpenrouterModelSource: runtimeProfile.config.aiEffectiveState.preferredOpenrouterModelSource,
    telephonyPreferredOpenrouterModelReason: runtimeProfile.config.aiEffectiveState.preferredOpenrouterModelReason,
    telephonyEffectiveAiProvider: runtimeProfile.config.aiEffectiveState.effectiveProvider,
    telephonyEffectiveAiProviderSource: runtimeProfile.config.aiEffectiveState.effectiveProviderSource,
    telephonyEffectiveAiProviderReason: runtimeProfile.config.aiEffectiveState.effectiveProviderReason,
    telephonyEffectiveModel: runtimeProfile.config.aiEffectiveState.effectiveModel,
    telephonyEffectiveModelSource: runtimeProfile.config.aiEffectiveState.effectiveModelSource,
    telephonyEffectiveModelReason: runtimeProfile.config.aiEffectiveState.effectiveModelReason,
    sipServer: runtimeProfile.config.sipServer,
    externalNumber: runtimeProfile.config.externalNumber,
    hasSipCredentials: Boolean(runtimeProfile.config.sipServer && runtimeProfile.config.sipLogin && runtimeProfile.config.sipPassword),
  };
}
