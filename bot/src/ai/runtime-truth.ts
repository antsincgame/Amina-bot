import { config } from '../config/index.js';
import { settingsRepo } from '../db/index.js';
import { getTtsRuntimeProfile } from '../features/tts.js';
import { getLMStudioConfig } from './lmstudio.js';
import { getPersonaProfile } from './persona.js';
import type { ChatRuntimeState, PersonaRuntimeState, TtsRuntimeState } from '../../../shared/types/index.js';

const DEFAULT_CHAT_PROVIDER = 'auto';
const DEFAULT_CHAT_MODEL = 'openrouter/free';

function trimValue(value?: string | null): string {
  return value?.trim() ?? '';
}

export async function getChatRuntimeState(): Promise<ChatRuntimeState> {
  const [settings, lmStudioConfig] = await Promise.all([
    settingsRepo.getMany([
      'ai_provider',
      'openrouter_model',
      'custom_model_override',
      'cerebras_model',
      'groq_model',
    ]),
    getLMStudioConfig(),
  ]);

  const savedProvider = trimValue(settings['ai_provider']) || DEFAULT_CHAT_PROVIDER;
  const savedModel = trimValue(settings['openrouter_model'])
    || trimValue(process.env.OPENROUTER_MODEL)
    || trimValue(config.ai.model)
    || DEFAULT_CHAT_MODEL;
  const customModelOverride = trimValue(settings['custom_model_override']);
  const isLmStudioReady = Boolean(lmStudioConfig?.url && lmStudioConfig.model);

  if (savedProvider === 'lmstudio') {
    return {
      savedProvider,
      resolvedProvider: 'lmstudio',
      providerSource: trimValue(settings['ai_provider']) ? 'db' : 'default',
      savedModel,
      resolvedModel: lmStudioConfig?.model || 'not_configured',
      modelSource: lmStudioConfig?.model ? 'derived' : 'default',
      customModelOverride,
      isLmStudioReady,
      reason: isLmStudioReady
        ? 'Выбран LM Studio и runtime видит готовую локальную модель.'
        : 'Выбран LM Studio, но URL или модель сейчас не готовы.',
    };
  }

  if (savedProvider === 'cerebras') {
    const cerebrasModel = trimValue(settings['cerebras_model']) || 'qwen-3-235b-a22b-instruct-2507';
    return {
      savedProvider,
      resolvedProvider: 'cerebras',
      providerSource: 'db',
      savedModel,
      resolvedModel: cerebrasModel,
      modelSource: trimValue(settings['cerebras_model']) ? 'db' : 'default',
      customModelOverride,
      isLmStudioReady,
      reason: `Cerebras выбран как основной провайдер. Модель: ${cerebrasModel}.`,
    };
  }

  if (savedProvider === 'groq') {
    const groqModel = trimValue(settings['groq_model']) || 'llama-3.3-70b-versatile';
    return {
      savedProvider,
      resolvedProvider: 'groq',
      providerSource: 'db',
      savedModel,
      resolvedModel: groqModel,
      modelSource: trimValue(settings['groq_model']) ? 'db' : 'default',
      customModelOverride,
      isLmStudioReady,
      reason: `Groq выбран как основной провайдер. Модель: ${groqModel}.`,
    };
  }

  const resolvedProvider = savedProvider === 'auto'
    ? (isLmStudioReady ? 'auto (lmstudio-available)' : 'auto (openrouter)')
    : 'openrouter';
  const resolvedModel = customModelOverride || savedModel;
  const modelSource = customModelOverride
    ? 'custom_override'
    : trimValue(settings['openrouter_model'])
      ? 'db'
      : trimValue(process.env.OPENROUTER_MODEL)
        ? 'env'
        : trimValue(config.ai.model)
          ? 'default'
          : 'default';

  return {
    savedProvider,
    resolvedProvider,
    providerSource: trimValue(settings['ai_provider']) ? 'db' : 'default',
    savedModel,
    resolvedModel,
    modelSource,
    customModelOverride,
    isLmStudioReady,
    reason: customModelOverride
      ? 'Для chat runtime активен custom_model_override поверх выбранной модели.'
      : savedProvider === 'auto' && isLmStudioReady
        ? 'Режим auto оставляет OpenRouter каноническим, но LM Studio доступна как локальный runtime.'
        : 'Chat runtime использует каноническую модель OpenRouter без скрытого override.',
  };
}

export async function getTtsRuntimeState(): Promise<TtsRuntimeState> {
  const [settings, runtimeProfile] = await Promise.all([
    settingsRepo.getMany([
      'tts_enabled',
      'tts_provider',
    ]),
    getTtsRuntimeProfile(),
  ]);

  const enabledSource = settings['tts_enabled'] !== undefined ? 'db' : 'default';
  const enabled = settings['tts_enabled'] !== 'false';
  const savedProvider = (trimValue(settings['tts_provider']) || 'edge') as TtsRuntimeState['savedProvider'];
  const resolvedProvider = runtimeProfile.provider;
  const providerSource = savedProvider === resolvedProvider
    ? (trimValue(settings['tts_provider']) ? 'db' : 'default')
    : 'derived';

  const fallbackReason = savedProvider !== resolvedProvider
    ? `Выбран ${savedProvider}, но runtime переключился на ${resolvedProvider} из-за недостающего ключа или fallback-цепочки.`
    : null;

  const voice = resolvedProvider === 'elevenlabs'
    ? runtimeProfile.elevenlabsVoiceId
    : resolvedProvider === 'openai'
      ? runtimeProfile.openaiVoice
      : runtimeProfile.edgeVoice;
  const model = resolvedProvider === 'elevenlabs'
    ? runtimeProfile.elevenlabsModelId
    : resolvedProvider === 'openai'
      ? runtimeProfile.openaiModel
      : runtimeProfile.edgeVoice;

  return {
    enabled,
    enabledSource,
    savedProvider,
    resolvedProvider,
    providerSource,
    fallbackReason,
    voice,
    model,
  };
}

export async function getPersonaRuntimeState(): Promise<PersonaRuntimeState> {
  const profile = await getPersonaProfile();
  return {
    name: profile.name,
    ownerTitle: profile.ownerTitle,
    identity: profile.identity,
    relationshipToOwner: profile.relationshipToOwner,
    telegramStyle: profile.channelVariants.telegram,
    voiceStyle: profile.channelVariants.voice,
    digestStyle: profile.channelVariants.digest,
    systemStyle: profile.channelVariants.system,
  };
}
