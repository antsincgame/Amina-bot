import type {
  EffectiveCapability,
  EffectiveConfigurationEntry,
  EffectiveValueSource,
  SelfCoreEffectiveState,
} from '../../../shared/types/index.js';
import { config } from '../config/index.js';
import { settingsRepo } from '../db/index.js';
import { getTelephonyRuntimeConfig } from '../features/telephony/service/telephony-runtime-config.js';
import { SingleCache } from '../utils/cache.js';
import { getLMStudioConfig } from './lmstudio.js';
import { getPersonaProfile } from './persona.js';

const DEFAULT_VISION_MODEL = 'google/gemma-3-27b-it:free';
const DEFAULT_AUDIO_MODEL = 'groq/whisper-large-v3';
const DEFAULT_IMAGE_MODEL = 'google/gemini-2.5-flash-image';
const DEFAULT_TTS_PROVIDER = 'edge';

const EFFECTIVE_STATE_CACHE = new SingleCache<SelfCoreEffectiveState>(60_000);

interface ResolvedValue {
  value: string;
  source: EffectiveValueSource;
  reason: string;
}

function trimValue(value?: string | null): string {
  return value?.trim() ?? '';
}

function resolveStringValue(params: {
  label: string;
  dbValue?: string | null;
  envValue?: string | null;
  defaultValue?: string | null;
}): ResolvedValue {
  const dbValue = trimValue(params.dbValue);
  if (dbValue) {
    return {
      value: dbValue,
      source: 'db',
      reason: `${params.label} задано в настройках Appwrite.`,
    };
  }

  const envValue = trimValue(params.envValue);
  if (envValue) {
    return {
      value: envValue,
      source: 'env',
      reason: `${params.label} получено из переменных окружения.`,
    };
  }

  const defaultValue = trimValue(params.defaultValue);
  return {
    value: defaultValue,
    source: 'default',
    reason: defaultValue
      ? `${params.label} использует кодовое значение по умолчанию.`
      : `${params.label} пока не настроено.`,
  };
}

function resolveBooleanValue(params: {
  label: string;
  dbValue?: string | null;
  envValue?: string | null;
  defaultValue: boolean;
}): { value: boolean; source: EffectiveValueSource; reason: string } {
  if (params.dbValue === 'true' || params.dbValue === 'false') {
    return {
      value: params.dbValue === 'true',
      source: 'db',
      reason: `${params.label} задано в настройках Appwrite.`,
    };
  }

  if (params.envValue === 'true' || params.envValue === 'false') {
    return {
      value: params.envValue === 'true',
      source: 'env',
      reason: `${params.label} получено из переменных окружения.`,
    };
  }

  return {
    value: params.defaultValue,
    source: 'default',
    reason: `${params.label} использует кодовое значение по умолчанию.`,
  };
}

function createConfiguration(
  key: string,
  label: string,
  resolved: ResolvedValue,
): EffectiveConfigurationEntry {
  return {
    key,
    label,
    value: resolved.value || 'не настроено',
    source: resolved.source,
    reason: resolved.reason,
  };
}

function createCapability(input: {
  key: EffectiveCapability['key'];
  label: string;
  enabled: boolean;
  source: EffectiveValueSource;
  reason: string;
  provider?: string;
  model?: string;
  detail?: string;
}): EffectiveCapability {
  return {
    key: input.key,
    label: input.label,
    enabled: input.enabled,
    source: input.source,
    reason: input.reason,
    provider: input.provider,
    model: input.model,
    detail: input.detail,
  };
}

async function getSettingsSnapshot(): Promise<Record<string, string | undefined>> {
  return settingsRepo.getMany([
    'ai_provider',
    'openrouter_api_key',
    'openrouter_model',
    'groq_api_key',
    'preferred_vision_model',
    'effective_vision_model',
    'vision_model',
    'vision_model_override',
    'audio_model',
    'audio_model_override',
    'perplexity_api_key',
    'perplexity_model',
    'web_search_enabled',
    'hf_token',
    'openrouter_image_model',
    'tts_enabled',
    'tts_provider',
    'openai_api_key',
    'openai_tts_model',
    'elevenlabs_api_key',
    'lmstudio_url_updated_at',
    'lmstudio_url_heartbeat_url',
    'persona_name',
    'persona_owner_title',
  ]);
}

export async function getEffectiveSelfCoreState(): Promise<SelfCoreEffectiveState> {
  const cached = EFFECTIVE_STATE_CACHE.get();
  if (cached) {
    return cached;
  }

  const [settings, persona, telephonyConfig, lmStudioConfig] = await Promise.all([
    getSettingsSnapshot(),
    getPersonaProfile(),
    getTelephonyRuntimeConfig(),
    getLMStudioConfig(),
  ]);

  const openRouterKey = resolveStringValue({
    label: 'OpenRouter API key',
    dbValue: settings['openrouter_api_key'],
    envValue: process.env.OPENROUTER_API_KEY,
  });
  const groqKey = resolveStringValue({
    label: 'Groq API key',
    dbValue: settings['groq_api_key'],
    envValue: process.env.GROQ_API_KEY,
  });
  const perplexityKey = resolveStringValue({
    label: 'Perplexity API key',
    dbValue: settings['perplexity_api_key'],
    envValue: process.env.PERPLEXITY_API_KEY,
  });
  const hfToken = resolveStringValue({
    label: 'HuggingFace token',
    dbValue: settings['hf_token'],
  });
  const openaiTtsKey = resolveStringValue({
    label: 'OpenAI TTS key',
    dbValue: settings['openai_api_key'],
  });
  const elevenLabsKey = resolveStringValue({
    label: 'ElevenLabs API key',
    dbValue: settings['elevenlabs_api_key'],
  });

  const aiProvider = resolveStringValue({
    label: 'AI provider',
    dbValue: settings['ai_provider'],
    defaultValue: 'auto',
  });
  const openRouterModel = resolveStringValue({
    label: 'OpenRouter chat model',
    dbValue: settings['openrouter_model'],
    envValue: process.env.OPENROUTER_MODEL,
    defaultValue: config.ai.model,
  });
  const preferredVisionModel = resolveStringValue({
    label: 'Preferred vision model',
    dbValue: settings['preferred_vision_model'] ?? settings['vision_model'],
    defaultValue: DEFAULT_VISION_MODEL,
  });
  const effectiveVisionModel = resolveStringValue({
    label: 'Effective vision model',
    dbValue: settings['vision_model_override'] ?? settings['effective_vision_model'] ?? settings['preferred_vision_model'] ?? settings['vision_model'],
    defaultValue: preferredVisionModel.value || DEFAULT_VISION_MODEL,
  });
  const audioModel = resolveStringValue({
    label: 'Audio model',
    dbValue: settings['audio_model_override'] ?? settings['audio_model'],
    defaultValue: DEFAULT_AUDIO_MODEL,
  });
  const perplexityModel = resolveStringValue({
    label: 'Perplexity model',
    dbValue: settings['perplexity_model'],
    defaultValue: 'sonar',
  });
  const imageModel = resolveStringValue({
    label: 'Image model',
    dbValue: settings['openrouter_image_model'],
    defaultValue: DEFAULT_IMAGE_MODEL,
  });
  const ttsProvider = resolveStringValue({
    label: 'TTS provider',
    dbValue: settings['tts_provider'],
    defaultValue: DEFAULT_TTS_PROVIDER,
  });
  const ttsEnabled = resolveBooleanValue({
    label: 'TTS enabled',
    dbValue: settings['tts_enabled'],
    defaultValue: true,
  });

  const webSearchEnabledSetting = resolveStringValue({
    label: 'Web search flag',
    dbValue: settings['web_search_enabled'],
  });
  const isWebSearchEnabled = webSearchEnabledSetting.value === 'false'
    ? false
    : webSearchEnabledSetting.value === 'true'
      ? true
      : Boolean(perplexityKey.value || openRouterKey.value);

  const hasLmStudio = Boolean(lmStudioConfig?.url && lmStudioConfig.model);
  const effectiveChatProvider = aiProvider.value === 'lmstudio' && hasLmStudio
    ? 'lmstudio'
    : aiProvider.value === 'lmstudio'
      ? 'lmstudio (not ready)'
      : aiProvider.value;
  const effectiveChatModel = aiProvider.value === 'lmstudio' && hasLmStudio
    ? lmStudioConfig?.model ?? ''
    : openRouterModel.value;

  const chatCapabilityEnabled = aiProvider.value === 'lmstudio'
    ? hasLmStudio
    : Boolean(openRouterKey.value || hasLmStudio);

  const telephonyConfigured = Boolean(
    telephonyConfig.liraxToken
      || telephonyConfig.sipServer
      || telephonyConfig.externalNumber
      || telephonyConfig.operatorPhone,
  );
  const realtimeVoiceEnabled = telephonyConfigured
    && telephonyConfig.realtimeEnabled
    && Boolean(telephonyConfig.mediaBridgeUrl && telephonyConfig.mediaBridgeToken);

  const capabilities: EffectiveCapability[] = [
    createCapability({
      key: 'chat',
      label: 'Диалоговый интеллект',
      enabled: chatCapabilityEnabled,
      source: chatCapabilityEnabled ? 'derived' : aiProvider.source,
      provider: effectiveChatProvider,
      model: effectiveChatModel || undefined,
      reason: chatCapabilityEnabled
        ? aiProvider.value === 'lmstudio'
          ? 'Диалоговый runtime опирается на LM Studio.'
          : hasLmStudio && aiProvider.value === 'auto'
            ? 'Диалоговый runtime доступен через OpenRouter с optional LM Studio fallback.'
            : 'Диалоговый runtime доступен через OpenRouter.'
        : aiProvider.value === 'lmstudio'
          ? 'Выбран LM Studio, но URL или модель не настроены.'
          : 'Нет OpenRouter ключа и нет готового LM Studio runtime.',
      detail: effectiveChatModel || undefined,
    }),
    createCapability({
      key: 'vision',
      label: 'Зрение',
      enabled: Boolean(openRouterKey.value),
      source: openRouterKey.value ? effectiveVisionModel.source : openRouterKey.source,
      provider: 'openrouter',
      model: effectiveVisionModel.value || undefined,
      reason: openRouterKey.value
        ? `Анализ изображений доступен через ${effectiveVisionModel.value}.`
        : 'Для vision нужен OpenRouter API key.',
      detail: `Предпочтение: ${preferredVisionModel.value}. ${effectiveVisionModel.reason}`,
    }),
    createCapability({
      key: 'audio',
      label: 'Слух и транскрипция',
      enabled: Boolean(groqKey.value),
      source: groqKey.value ? audioModel.source : groqKey.source,
      provider: 'groq',
      model: audioModel.value || undefined,
      reason: groqKey.value
        ? `Транскрипция включена через ${audioModel.value}.`
        : 'Для аудио-транскрипции нужен Groq API key.',
      detail: audioModel.reason,
    }),
    createCapability({
      key: 'web_search',
      label: 'Поиск в интернете',
      enabled: isWebSearchEnabled,
      source: webSearchEnabledSetting.value ? webSearchEnabledSetting.source : 'derived',
      provider: perplexityKey.value ? 'perplexity' : openRouterKey.value ? 'openrouter' : undefined,
      model: perplexityKey.value ? perplexityModel.value : undefined,
      reason: isWebSearchEnabled
        ? perplexityKey.value
          ? `Актуальный поиск включён через Perplexity (${perplexityModel.value}).`
          : 'Поиск включён через OpenRouter online fallback.'
        : 'Веб-поиск явно выключен или для него нет ключей.',
      detail: webSearchEnabledSetting.reason,
    }),
    createCapability({
      key: 'image_generation',
      label: 'Генерация изображений',
      enabled: Boolean(hfToken.value || openRouterKey.value),
      source: hfToken.value ? hfToken.source : openRouterKey.value ? imageModel.source : 'default',
      provider: hfToken.value ? 'huggingface' : openRouterKey.value ? 'openrouter' : undefined,
      model: hfToken.value ? undefined : imageModel.value || undefined,
      reason: hfToken.value
        ? 'Генерация изображений доступна через HuggingFace Inference.'
        : openRouterKey.value
          ? `Генерация изображений доступна через OpenRouter (${imageModel.value}).`
          : 'Нет HuggingFace токена и нет OpenRouter ключа для image runtime.',
      detail: hfToken.value ? hfToken.reason : imageModel.reason,
    }),
    createCapability({
      key: 'telephony',
      label: 'Телефония',
      enabled: telephonyConfigured,
      source: 'derived',
      provider: telephonyConfig.aiProvider === 'inherit' ? effectiveChatProvider : telephonyConfig.aiProvider,
      model: telephonyConfig.openrouterModel || effectiveChatModel || undefined,
      reason: telephonyConfigured
        ? `Телефония настроена: SIP ${telephonyConfig.sipServer || 'не задан'}, внешний номер ${telephonyConfig.externalNumber || 'не задан'}.`
        : 'Нет достаточной telephony-конфигурации для внешней связи.',
      detail: telephonyConfig.realtimeEnabled ? 'realtime mode requested' : 'scripted mode',
    }),
    createCapability({
      key: 'realtime_voice',
      label: 'Realtime voice',
      enabled: realtimeVoiceEnabled,
      source: telephonyConfig.realtimeEnabled ? 'derived' : 'db',
      provider: telephonyConfig.aiProvider === 'inherit' ? effectiveChatProvider : telephonyConfig.aiProvider,
      model: telephonyConfig.openrouterModel || effectiveChatModel || undefined,
      reason: realtimeVoiceEnabled
        ? 'Realtime bridge, токен и telephony runtime настроены.'
        : telephonyConfig.realtimeEnabled
          ? 'Realtime mode включён, но media bridge URL или token отсутствуют.'
          : 'Realtime voice выключен в настройках телефонии.',
    }),
    createCapability({
      key: 'memory',
      label: 'Память пользователей',
      enabled: true,
      source: 'derived',
      reason: 'Хранилище памяти и профилей пользователей встроено в backend.',
    }),
    createCapability({
      key: 'notes',
      label: 'Заметки',
      enabled: true,
      source: 'derived',
      reason: 'Сервис заметок доступен через Appwrite-репозиторий.',
    }),
    createCapability({
      key: 'reminders',
      label: 'Напоминания',
      enabled: true,
      source: 'derived',
      reason: 'Планировщик и репозиторий напоминаний встроены в runtime.',
    }),
    createCapability({
      key: 'digest',
      label: 'Дайджест',
      enabled: true,
      source: 'derived',
      reason: 'Сборка и доставка дайджестов встроены в backend.',
    }),
    createCapability({
      key: 'tts',
      label: 'Озвучивание',
      enabled: ttsEnabled.value,
      source: ttsEnabled.value ? ttsProvider.source : ttsEnabled.source,
      provider: ttsProvider.value || undefined,
      model: ttsProvider.value === 'openai'
        ? (trimValue(settings['openai_tts_model']) || 'tts-1-hd')
        : undefined,
      reason: ttsEnabled.value
        ? ttsProvider.value === 'elevenlabs' && !elevenLabsKey.value
          ? 'Выбран ElevenLabs, но ключ отсутствует: runtime упадёт на fallback.'
          : ttsProvider.value === 'openai' && !openaiTtsKey.value
            ? 'Выбран OpenAI TTS, но ключ отсутствует: runtime упадёт на fallback.'
            : `Озвучивание активно через ${ttsProvider.value}.`
        : 'Озвучивание явно выключено настройкой tts_enabled.',
    }),
  ];

  const configuration: EffectiveConfigurationEntry[] = [
    createConfiguration('chat_provider', 'AI provider', aiProvider),
    createConfiguration('chat_model', 'Chat model', {
      value: effectiveChatModel || openRouterModel.value,
      source: aiProvider.value === 'lmstudio' ? 'derived' : openRouterModel.source,
      reason: aiProvider.value === 'lmstudio'
        ? 'Эффективная chat-модель выбрана из LM Studio конфигурации.'
        : openRouterModel.reason,
    }),
    createConfiguration('preferred_vision_model', 'Preferred vision model', preferredVisionModel),
    createConfiguration('effective_vision_model', 'Effective vision model', effectiveVisionModel),
    createConfiguration('audio_model', 'Audio model', audioModel),
    createConfiguration('audio_model_override', 'Audio model override', {
      value: trimValue(settings['audio_model_override']) || 'not_set',
      source: trimValue(settings['audio_model_override']) ? 'derived' : 'default',
      reason: trimValue(settings['audio_model_override'])
        ? 'Для speech runtime активен скрытый audio_model_override.'
        : 'Скрытый override аудио-модели не задан.',
    }),
    createConfiguration('perplexity_model', 'Perplexity model', perplexityModel),
    createConfiguration('image_model', 'Image model', imageModel),
    createConfiguration('tts_provider', 'TTS provider', ttsProvider),
    createConfiguration('telephony_ai_provider', 'Telephony AI provider', {
      value: telephonyConfig.aiEffectiveState.preferredProvider || 'inherit',
      source: telephonyConfig.aiEffectiveState.preferredProviderSource,
      reason: telephonyConfig.aiEffectiveState.preferredProviderReason,
    }),
    createConfiguration('telephony_effective_ai_provider', 'Telephony effective AI provider', {
      value: telephonyConfig.aiEffectiveState.effectiveProvider,
      source: telephonyConfig.aiEffectiveState.effectiveProviderSource,
      reason: telephonyConfig.aiEffectiveState.effectiveProviderReason,
    }),
    createConfiguration('telephony_preferred_openrouter_model', 'Telephony preferred OpenRouter model', {
      value: telephonyConfig.aiEffectiveState.preferredOpenrouterModel || 'not_set',
      source: telephonyConfig.aiEffectiveState.preferredOpenrouterModelSource,
      reason: telephonyConfig.aiEffectiveState.preferredOpenrouterModelReason,
    }),
    createConfiguration('telephony_effective_model', 'Telephony effective model', {
      value: telephonyConfig.aiEffectiveState.effectiveModel || 'not_set',
      source: telephonyConfig.aiEffectiveState.effectiveModelSource,
      reason: telephonyConfig.aiEffectiveState.effectiveModelReason,
    }),
    createConfiguration('lmstudio_heartbeat_at', 'LM Studio heartbeat at', resolveStringValue({
      label: 'LM Studio heartbeat timestamp',
      dbValue: settings['lmstudio_url_updated_at'],
    })),
    createConfiguration('lmstudio_heartbeat_url', 'LM Studio heartbeat URL', resolveStringValue({
      label: 'LM Studio heartbeat URL',
      dbValue: settings['lmstudio_url_heartbeat_url'],
    })),
    createConfiguration('telephony_mode', 'Telephony mode', {
      value: telephonyConfig.realtimeEnabled ? 'realtime' : 'scripted',
      source: settings['telephony_realtime_enabled'] !== undefined ? 'db' : 'default',
      reason: settings['telephony_realtime_enabled'] !== undefined
        ? 'Режим телефонии задан в настройках Appwrite.'
        : 'Режим телефонии использует значение по умолчанию.',
    }),
    createConfiguration('telephony_sip_server', 'SIP server', resolveStringValue({
      label: 'Telephony SIP server',
      dbValue: settings['telephony_sip_server'],
      envValue: process.env.TELEPHONY_SIP_SERVER,
    })),
    createConfiguration('telephony_external_number', 'Внешний номер', resolveStringValue({
      label: 'Telephony external number',
      dbValue: settings['telephony_external_number'],
      envValue: process.env.TELEPHONY_EXTERNAL_NUMBER,
    })),
  ];

  const state: SelfCoreEffectiveState = {
    generated_at: new Date().toISOString(),
    persona: {
      name: persona.name,
      ownerTitle: persona.ownerTitle,
      identity: persona.identity,
      relationshipToOwner: persona.relationshipToOwner,
    },
    capabilities,
    configuration,
  };

  EFFECTIVE_STATE_CACHE.set(state);
  return state;
}

export function clearEffectiveSelfCoreStateCache(): void {
  EFFECTIVE_STATE_CACHE.clear();
}
