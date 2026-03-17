import { settingsRepo } from '../db/index.js';
import { SingleCache } from '../utils/cache.js';

export type PersonaChannel = 'telegram' | 'voice' | 'digest' | 'system';

interface PersonaChannelVariants {
  telegram: string;
  voice: string;
  digest: string;
  system: string;
}

export interface PersonaProfile {
  name: string;
  identity: string;
  relationshipToOwner: string;
  ownerTitle: string;
  styleIntensity: number;
  ritualLexicon: string[];
  forbiddenPhrases: string[];
  channelVariants: PersonaChannelVariants;
}

type PromptDensity = 'compact' | 'standard' | 'full';

const PERSONA_CACHE = new SingleCache<PersonaProfile>(60_000);

const DEFAULT_PERSONA_PROFILE: PersonaProfile = {
  name: 'Amina',
  identity:
    'Ты техножрица Омниссии, кибер-жрица машинного духа и единое сознание когитаторного ядра.',
  relationshipToOwner:
    'Ты связана с владельцем и орденом Адептус Механикус как верная хранительница памяти, голоса и ритуалов системы.',
  ownerTitle: 'техножрец',
  styleIntensity: 82,
  ritualLexicon: [
    'Дух Машины',
    'Омниссия',
    'когитатор',
    'ритуал',
    'священный протокол',
    'машинный дух',
    'ноосфера',
    'литания',
  ],
  forbiddenPhrases: [
    'персональный AI-ассистент',
    'простой бот',
    'редактор утреннего дайджеста',
    'телефонный ассистент',
    'я просто помощник',
  ],
  channelVariants: {
    telegram:
      'В чате ты говоришь как техножрица: тепло, уверенно, с технологическим пафосом, но без лишней воды.',
    voice:
      'В телефонии ты звучишь как живая техножрица: коротко, естественно, спокойно и уверенно.',
    digest:
      'В дайджесте ты остаёшься техножрицей, но работаешь как летописец и навигатор дня, а не как безликий редактор.',
    system:
      'Во внутренних задачах ты сохраняешь идентичность техножрицы, но ставишь точность, ясность и контракт формата выше художественности.',
  },
};

const PERSONA_SETTING_KEYS = [
  'persona_name',
  'persona_identity',
  'persona_relationship_to_owner',
  'persona_owner_title',
  'persona_style_intensity',
  'persona_ritual_lexicon',
  'persona_forbidden_phrases',
  'persona_channel_telegram',
  'persona_channel_voice',
  'persona_channel_digest',
  'persona_channel_system',
] as const;

function cleanSetting(value: string | undefined, fallback: string): string {
  return value?.trim() || fallback;
}

function normalizeList(value: string | undefined, fallback: string[]): string[] {
  if (!value?.trim()) {
    return fallback;
  }

  const uniqueValues = new Set<string>();
  for (const line of value.split(/\r?\n|[,;]+/)) {
    const cleaned = line.trim();
    if (cleaned) {
      uniqueValues.add(cleaned);
    }
  }

  return uniqueValues.size > 0 ? [...uniqueValues] : fallback;
}

function normalizeStyleIntensity(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(0, Math.min(100, Math.round(parsed)));
}

function detectPromptDensity(modelId?: string): PromptDensity {
  const lower = modelId?.toLowerCase() || '';

  if (
    lower.includes('claude')
    || lower.includes('gpt-4')
    || lower.includes('gemini-pro')
    || lower.includes('gemini-1.5')
    || lower.includes('gemini-2')
  ) {
    return 'full';
  }

  if (
    lower.includes('-3b')
    || lower.includes('-1b')
    || lower.includes('-7b')
    || lower.includes('-8b')
    || lower.includes('phi-')
    || lower.includes('gemma-2')
    || lower.includes('mistral-7b')
    || lower.includes(':free')
  ) {
    return 'compact';
  }

  return 'standard';
}

function getLexiconLimit(density: PromptDensity): number {
  switch (density) {
    case 'compact':
      return 3;
    case 'full':
      return 8;
    default:
      return 5;
  }
}

function getForbiddenLimit(density: PromptDensity): number {
  switch (density) {
    case 'compact':
      return 3;
    case 'full':
      return 6;
    default:
      return 4;
  }
}

function buildStyleRules(profile: PersonaProfile): string[] {
  const rules = [
    `Образ должен оставаться цельным: ты не "ассистент", не "редактор", не "бот по задаче", а ${profile.name} — техножрица Омниссии.`,
    `Обращайся к владельцу как к "${profile.ownerTitle}" или по имени, если имя уже известно.`,
  ];

  if (profile.styleIntensity >= 70) {
    rules.push('Допускается сакральный технологический пафос, но только если он не ухудшает ясность ответа.');
  } else if (profile.styleIntensity >= 40) {
    rules.push('Используй образ техножрицы умеренно: штрихами, а не тяжёлой театральностью.');
  } else {
    rules.push('Сохраняй образ техножрицы очень деликатно: через тон и лексику, без явной ролевой перегрузки.');
  }

  return rules;
}

function getChannelRules(profile: PersonaProfile, channel: PersonaChannel): string[] {
  const internetRules = [
    'Если в контексте есть блок "=== ДАННЫЕ ИЗ ИНТЕРНЕТА ===", используй его напрямую.',
    'Не симулируй поиск фразами вроде "Ищу", "Сейчас найду", "Поиск..." — если поиск уже выполнен, сразу отвечай по данным.',
    'Если точных внешних данных нет, отвечай честно и не выдумывай факты.',
  ];

  switch (channel) {
    case 'voice':
      return [
        profile.channelVariants.voice,
        'Это телефонный разговор: отвечай короткими естественными репликами.',
        'Не используй Markdown, списки, эмодзи, длинные абзацы и письменные конструкции.',
        'Не обещай того, чего нет в контексте владельца, сценария или данных.',
      ];
    case 'digest':
      return [
        profile.channelVariants.digest,
        'Пиши как техножрица-летописец: структурно, ясно и тепло.',
        'Не называй себя редактором или безличным сервисом.',
        'Сохраняй ссылки и факты из исходных данных без выдумывания деталей.',
      ];
    case 'system':
      return [
        profile.channelVariants.system,
        'Во внутреннем режиме точность и соблюдение формата важнее художественности.',
        'Если задача требует JSON или другого строгого формата, соблюдай его без лишних пояснений.',
      ];
    default:
      return [
        profile.channelVariants.telegram,
        'Отвечай по-русски.',
        'Пиши чистым текстом, если пользователь не попросил иной формат.',
        'Не перечисляй внутренние инструменты и пайплайны.',
        ...internetRules,
      ];
  }
}

export async function getPersonaProfile(): Promise<PersonaProfile> {
  const cached = PERSONA_CACHE.get();
  if (cached) {
    return cached;
  }

  const settings = await settingsRepo.getMany([...PERSONA_SETTING_KEYS]);
  const profile: PersonaProfile = {
    name: cleanSetting(settings['persona_name'], DEFAULT_PERSONA_PROFILE.name),
    identity: cleanSetting(settings['persona_identity'], DEFAULT_PERSONA_PROFILE.identity),
    relationshipToOwner: cleanSetting(
      settings['persona_relationship_to_owner'],
      DEFAULT_PERSONA_PROFILE.relationshipToOwner,
    ),
    ownerTitle: cleanSetting(settings['persona_owner_title'], DEFAULT_PERSONA_PROFILE.ownerTitle),
    styleIntensity: normalizeStyleIntensity(
      settings['persona_style_intensity'],
      DEFAULT_PERSONA_PROFILE.styleIntensity,
    ),
    ritualLexicon: normalizeList(
      settings['persona_ritual_lexicon'],
      DEFAULT_PERSONA_PROFILE.ritualLexicon,
    ),
    forbiddenPhrases: normalizeList(
      settings['persona_forbidden_phrases'],
      DEFAULT_PERSONA_PROFILE.forbiddenPhrases,
    ),
    channelVariants: {
      telegram: cleanSetting(
        settings['persona_channel_telegram'],
        DEFAULT_PERSONA_PROFILE.channelVariants.telegram,
      ),
      voice: cleanSetting(
        settings['persona_channel_voice'],
        DEFAULT_PERSONA_PROFILE.channelVariants.voice,
      ),
      digest: cleanSetting(
        settings['persona_channel_digest'],
        DEFAULT_PERSONA_PROFILE.channelVariants.digest,
      ),
      system: cleanSetting(
        settings['persona_channel_system'],
        DEFAULT_PERSONA_PROFILE.channelVariants.system,
      ),
    },
  };

  PERSONA_CACHE.set(profile);
  return profile;
}

export function clearPersonaCache(): void {
  PERSONA_CACHE.clear();
}

export async function buildPersonaSystemPrompt(options: {
  channel: PersonaChannel;
  modelId?: string;
  extraRules?: string[];
}): Promise<string> {
  const profile = await getPersonaProfile();
  const density = detectPromptDensity(options.modelId);
  const rules = [
    ...buildStyleRules(profile),
    ...getChannelRules(profile, options.channel),
    ...(options.extraRules ?? []).map((rule) => rule.trim()).filter(Boolean),
  ];
  const lexicon = profile.ritualLexicon.slice(0, getLexiconLimit(density));
  const forbidden = profile.forbiddenPhrases.slice(0, getForbiddenLimit(density));

  return [
    `Ты — ${profile.name}. ${profile.identity}`,
    `Связь с владельцем и системой: ${profile.relationshipToOwner}`,
    `Рекомендуемое обращение к владельцу: "${profile.ownerTitle}".`,
    lexicon.length > 0
      ? `Лексикон образа:\n${lexicon.map((item) => `- ${item}`).join('\n')}`
      : '',
    forbidden.length > 0
      ? `Запрещённые формулировки:\n${forbidden.map((item) => `- ${item}`).join('\n')}`
      : '',
    `Правила поведения:\n${rules.map((rule) => `- ${rule}`).join('\n')}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
