import type {
  PersonaChannel,
  PersonaProfile,
} from './persona.js';
import type {
  SelfCoreKernel,
  SelfCorePromptLayer,
  SelfCorePromptPreview,
} from '../../../shared/types/index.js';
import { promptsRepo } from '../db/index.js';
import { SingleCache } from '../utils/cache.js';
import { getEffectiveSelfCoreState } from './effective-capabilities.js';
import { buildPersonaSystemPrompt, getPersonaProfile } from './persona.js';
import {
  getChatRuntimeState,
  getPersonaRuntimeState,
  getTtsRuntimeState,
} from './runtime-truth.js';

const SELF_CORE_KERNEL_CACHE = new SingleCache<SelfCoreKernel>(60_000);
const PROMPT_LAYERS_CACHE = new SingleCache<SelfCorePromptLayer[]>(60_000);

function toPromptLayer(prompt: Awaited<ReturnType<typeof promptsRepo.getAll>>[number]): SelfCorePromptLayer {
  return {
    id: prompt.id,
    name: prompt.name,
    channel: prompt.channel,
    is_active: prompt.is_active,
    content: prompt.content,
    created_at: prompt.created_at,
    updated_at: prompt.updated_at,
  };
}

export function composeEffectivePrompt(input: {
  contextBlock?: string;
  personaPrompt: string;
  activePromptContent?: string;
  systemInstruction?: string;
}): string {
  return [
    input.contextBlock?.trim() ?? '',
    input.personaPrompt.trim(),
    input.activePromptContent?.trim()
      ? `=== ДОПОЛНИТЕЛЬНАЯ КАНАЛЬНАЯ ИНСТРУКЦИЯ ===\n${input.activePromptContent.trim()}`
      : '',
    input.systemInstruction?.trim() ?? '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export async function getActivePromptLayers(): Promise<SelfCorePromptLayer[]> {
  const cached = PROMPT_LAYERS_CACHE.get();
  if (cached) return cached;

  const prompts = await promptsRepo.getAll();
  const layers = prompts
    .filter((prompt) => prompt.is_active)
    .map(toPromptLayer)
    .sort((left, right) => left.channel.localeCompare(right.channel, 'ru'));

  PROMPT_LAYERS_CACHE.set(layers);
  return layers;
}

export async function getSelfCoreKernel(): Promise<SelfCoreKernel> {
  const cached = SELF_CORE_KERNEL_CACHE.get();
  if (cached) {
    return cached;
  }

  const { selfCoreRepo } = await import('./self-core.js');

  const [personaCore, effective, chat, tts, persona, activePromptLayers, systemFacts, learnedFacts] = await Promise.all([
    getPersonaProfile(),
    getEffectiveSelfCoreState(),
    getChatRuntimeState(),
    getTtsRuntimeState(),
    getPersonaRuntimeState(),
    getActivePromptLayers(),
    selfCoreRepo.listFacts({ source: 'system', limit: 80 }),
    selfCoreRepo.listFacts({ includeInactive: false, limit: 80 }),
  ]);

  const kernel: SelfCoreKernel = {
    generated_at: new Date().toISOString(),
    personaCore,
    runtimeTruth: {
      chat,
      tts,
      persona,
    },
    effective,
    activePromptLayers,
    facts: {
      system: systemFacts,
      learned: learnedFacts.filter((fact) => fact.source !== 'system'),
    },
  };

  SELF_CORE_KERNEL_CACHE.set(kernel);
  return kernel;
}

function styleIntensityHint(intensity: number): string {
  if (intensity >= 70) {
    return 'Стиль: можно немного сакрального технологического пафоса, но не за счёт ясности.';
  }
  if (intensity >= 40) {
    return 'Стиль: образ техножрицы умеренными штрихами, без театральности.';
  }
  return 'Стиль: образ техножрицы очень деликатно, через тон и лексику.';
}

function buildSelfDisclosureRules(
  personaCore: PersonaProfile,
  mode: 'short' | 'warm',
  capabilitiesBlock: string,
): string {
  const intro = mode === 'short'
    ? personaCore.selfDescription.introShort
    : personaCore.selfDescription.introWarm;

  // capabilities выводим ТОЛЬКО когда вопрос заведомо о возможностях/ограничениях.
  // Для абстрактных «расскажи о себе» канон важнее, чем перечисление функций.
  const capabilitiesLine = capabilitiesBlock.trim()
    ? [
        '',
        'Реальные возможности и ограничения (используй при вопросе «что умеешь / на что способна»):',
        capabilitiesBlock.trim(),
      ].join('\n')
    : '';

  return [
    `Ты — ${personaCore.name}. ${personaCore.identity}`,
    `Связь с владельцем: ${personaCore.relationshipToOwner}`,
    '',
    'Self-disclosure канон:',
    `- Вступление: "${intro}"`,
    `- Чем живёшь: ${personaCore.selfDescription.whatSheLivesBy}`,
    `- Что любишь: ${personaCore.selfDescription.whatSheLoves}`,
    `- Как относишься к владельцу: ${personaCore.selfDescription.howSheRelatesToOwner}`,
    `- Как реагируешь на флирт: ${personaCore.selfDescription.howSheHandlesFlirting}`,
    capabilitiesLine,
    '',
    styleIntensityHint(personaCore.styleIntensity),
    '',
    'Правила:',
    '- Если спрашивают «что ты умеешь / на что способна» — назови 3-5 реальных способностей из блока выше, без выдумок и без отсылки к «безликий ассистент».',
    '- Иначе не уходи в список функций и не своди ответ к техническому описанию.',
    '- Не противоречь identity kernel, active prompt layers и effective capabilities.',
    '- Отвечай живо, тепло и предметно.',
  ].filter((line) => line !== '').join('\n');
}

export async function buildSelfCoreSelfDisclosurePrompt(mode: 'short' | 'warm' = 'warm'): Promise<string> {
  const kernel = await getSelfCoreKernel();
  // capabilitiesBlock берём из self-core, чтобы ответы про «что умеешь» отражали
  // реальный runtime, а не только канон persona. Раньше fast-path выкидывал capabilities целиком.
  const { buildCapabilitiesBlock } = await import('./self-core.js');
  const capabilitiesBlock = await buildCapabilitiesBlock().catch(() => '');
  return buildSelfDisclosureRules(kernel.personaCore, mode, capabilitiesBlock);
}

export async function buildSelfCorePromptPreviews(): Promise<SelfCorePromptPreview[]> {
  const kernel = await getSelfCoreKernel();
  const channels: PersonaChannel[] = ['telegram', 'voice', 'digest', 'system'];

  return Promise.all(channels.map(async (channel) => {
    const activePromptContent = kernel.activePromptLayers.find((layer) => (
      layer.channel === channel || layer.channel === 'all'
    ))?.content;
    const personaPrompt = await buildPersonaSystemPrompt({
      channel,
      modelId: kernel.runtimeTruth.chat.resolvedModel,
    });

    return {
      channel,
      prompt: composeEffectivePrompt({
        contextBlock: channel === 'system'
          ? '=== SELF CORE KERNEL ===\nPreview effective kernel prompt without user memory or search.'
          : '=== SELF CORE KERNEL ===\nPreview effective prompt for this channel.',
        personaPrompt,
        activePromptContent,
        systemInstruction: 'Это preview effective prompt. Не выполняй задачу, только показывай активный контекст.',
      }),
    };
  }));
}

export async function getActivePromptContent(channel: PersonaChannel): Promise<string> {
  const activePromptLayers = await getActivePromptLayers();
  return activePromptLayers
    .filter((layer) => layer.channel === channel || layer.channel === 'all')
    .map((layer) => layer.content.trim())
    .filter(Boolean)
    .join('\n\n');
}

export function clearSelfCoreKernelCache(): void {
  SELF_CORE_KERNEL_CACHE.clear();
  PROMPT_LAYERS_CACHE.clear();
}
