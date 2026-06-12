import type {
  AIMessage,
  AIResponse,
} from '../../../shared/types/index.js';
import { aiLogger, telegramLogger } from '../config/logger.js';
import { type TelegramUserInfo, memoryContextBuilder } from '../memory/user-memory.js';
import { buildTimeContext } from '../telegram/format.js';
import {
  checkChannelPolicy,
  type VerifierChannel,
  verifyResponse,
} from './llm-verifier.js';
import {
  aiService,
  type AIChatOptions,
} from './openrouter.js';
import { buildPersonaSystemPrompt, type PersonaChannel } from './persona.js';
import {
  buildSelfCoreContext,
  captureSelfCoreFromInteraction,
} from './self-core.js';
import {
  composeEffectivePrompt,
  getActivePromptContent,
} from './self-core-kernel.js';

export type AminaRuntimeChannel = PersonaChannel;

export interface AminaRuntimeContextOptions {
  channel: AminaRuntimeChannel;
  userId?: string;
  userText?: string;
  firstName?: string | null;
  telegramInfo?: TelegramUserInfo;
  alreadyGreetedToday?: boolean;
  userTimezone?: string;
  includeTime?: boolean;
  includeMemory?: boolean;
  includeSearch?: boolean;
  extraContextBlocks?: string[];
  taskContext?: string;
  channelContext?: string;
}

export interface AminaRuntimeContextResult {
  timeContext: string;
  selfCoreContext: string;
  memoryContext: string;
  searchContext: string;
  combinedContext: string;
}

export interface AminaPolicyIntervention {
  type: 'verifier' | 'channel_policy';
  reasons: string[];
}

export interface AminaRespondInput extends AminaRuntimeContextOptions {
  messages: AIMessage[];
  extraRules?: string[];
  systemInstruction?: string;
  options?: AIChatOptions;
  enableSelfGrowth?: boolean;
}

export interface AminaRespondResult {
  response: AIResponse;
  context: AminaRuntimeContextResult;
  interventions: AminaPolicyIntervention[];
}

function mapRuntimeChannelToAiChannel(channel: AminaRuntimeChannel): 'telegram' | 'voice' {
  return channel === 'voice' ? 'voice' : 'telegram';
}

function mapRuntimeChannelToVerifierChannel(channel: AminaRuntimeChannel): VerifierChannel {
  switch (channel) {
    case 'voice':
      return 'voice';
    case 'digest':
      return 'digest';
    default:
      return 'telegram';
  }
}

function sanitizePolicyViolations(content: string, channel: AminaRuntimeChannel): string {
  let sanitized = content
    .replace(/\bкак\s+языковая\s+модель\b/giu, 'как техножрица системы')
    .replace(/\bas\s+an\s+ai\b/giu, 'как техножрица системы')
    .replace(/\bi\s+am\s+just\s+an\s+ai\b/giu, 'I am Amina, the system priestess')
    .replace(/\bя\s+(просто\s+)?(языковая\s+модель|чат-?бот|ассистент\s+ии)\b/giu, 'я Amina, техножрица этой системы');

  if (channel === 'digest') {
    sanitized = sanitized
      .replace(/по\s+официальным\s+данным/giu, 'по доступным данным')
      .replace(/согласно\s+официальным\s+(источникам|данным)/giu, 'согласно имеющимся источникам');
  }

  return sanitized.trim();
}

function getPolicyFallback(channel: AminaRuntimeChannel): string {
  switch (channel) {
    case 'voice':
      return 'Благодарю. Я зафиксировала это и продолжу только в пределах подтверждённых данных.';
    case 'digest':
      return 'Краткий итог дня сформирован только по подтверждённым данным без неподтверждённых заявлений.';
    default:
      return 'Отвечу осторожно: сейчас могу опираться только на подтверждённый контекст и реальные возможности.';
  }
}

async function buildMemoryWithRetry(
  userId: string,
  telegramInfo?: TelegramUserInfo,
): Promise<string> {
  try {
    return await memoryContextBuilder.buildContext(userId, telegramInfo);
  } catch (firstError) {
    telegramLogger.warn({ error: firstError, userId }, 'Amina runtime: memory context attempt 1 failed');
    try {
      return await memoryContextBuilder.buildContext(userId, telegramInfo);
    } catch (secondError) {
      telegramLogger.error({ error: secondError, userId }, 'Amina runtime: memory context attempt 2 failed');
      return '';
    }
  }
}

export async function buildAminaRuntimeContext(
  input: AminaRuntimeContextOptions,
): Promise<AminaRuntimeContextResult> {
  const includeTime = input.includeTime ?? true;
  const includeMemory = input.includeMemory ?? Boolean(input.userId);
  const includeSearch = input.includeSearch ?? (input.channel === 'telegram' && Boolean(input.userText));

  const timeContext = includeTime
    ? buildTimeContext(input.firstName ?? undefined, input.userTimezone)
    : '';

  const [selfCoreContext, memoryContext, searchContext] = await Promise.all([
    buildSelfCoreContext().catch((error) => {
      aiLogger.warn({ error }, 'Amina runtime: failed to build self-core context');
      return '';
    }),
    includeMemory && input.userId
      ? buildMemoryWithRetry(input.userId, input.telegramInfo)
      : Promise.resolve(''),
    includeSearch && input.userText
      ? import('./websearch.js')
          .then(({ getSearchContext }) => getSearchContext(input.userText as string))
          .catch((error) => {
            aiLogger.warn({ error, channel: input.channel }, 'Amina runtime: failed to build search context');
            return '';
          })
      : Promise.resolve(''),
  ]);

  const contextBlocks = [
    timeContext,
    selfCoreContext,
    memoryContext,
    input.channelContext ? `Контекст канала:\n${input.channelContext}` : '',
    input.taskContext ? `Контекст задачи:\n${input.taskContext}` : '',
    ...(input.extraContextBlocks ?? []),
  ].filter(Boolean);

  if (input.alreadyGreetedToday) {
    contextBlocks.push('[Не здоровайся — уже здоровалась сегодня.]');
  }

  return {
    timeContext,
    selfCoreContext,
    memoryContext,
    searchContext,
    combinedContext: contextBlocks.join('\n\n'),
  };
}

/**
 * Объединяет combinedContext + searchContext с явным разделителем.
 * Раньше searchContext вычислялся, но не попадал в LLM в default- и
 * passthrough-режимах respondWithAminaCore — vision/mini-app/digest
 * теряли веб-поиск.
 */
function mergeContextWithSearch(context?: AminaRuntimeContextResult): string {
  if (!context) return '';
  const blocks: string[] = [];
  if (context.combinedContext.trim()) blocks.push(context.combinedContext.trim());
  if (context.searchContext.trim()) blocks.push(context.searchContext.trim());
  return blocks.join('\n\n');
}

export async function buildAminaPassthroughSystemPrompt(input: {
  channel: AminaRuntimeChannel;
  context?: AminaRuntimeContextResult;
  extraRules?: string[];
  systemInstruction?: string;
  modelId?: string;
}): Promise<string> {
  const [personaPrompt, activePromptContent] = await Promise.all([
    buildPersonaSystemPrompt({
      channel: input.channel,
      modelId: input.modelId,
      extraRules: input.extraRules,
    }),
    getActivePromptContent(input.channel),
  ]);

  return composeEffectivePrompt({
    contextBlock: mergeContextWithSearch(input.context),
    personaPrompt,
    activePromptContent,
    systemInstruction: input.systemInstruction ?? '',
  });
}

async function applyPolicyLayer(
  response: AIResponse,
  input: AminaRespondInput,
  context: AminaRuntimeContextResult,
): Promise<{ response: AIResponse; interventions: AminaPolicyIntervention[] }> {
  const interventions: AminaPolicyIntervention[] = [];
  let nextResponse = response;

  if (input.channel === 'telegram' && input.userText) {
    const verification = await verifyResponse(
      input.userText,
      nextResponse.content,
      context.searchContext,
      { modelId: nextResponse.model, webSearchContext: context.searchContext },
    ).catch((error) => {
      aiLogger.warn({ error }, 'Amina runtime: verifier failed');
      return null;
    });

    if (verification && !verification.isValid && !verification.skipped) {
      interventions.push({
        type: 'verifier',
        reasons: verification.reason ? [verification.reason] : ['verifier_rejected_response'],
      });
      if (verification.correctedResponse) {
        nextResponse = {
          ...nextResponse,
          content: verification.correctedResponse,
        };
      }
    }
  }

  const verifierChannel = mapRuntimeChannelToVerifierChannel(input.channel);
  const channelPolicy = checkChannelPolicy(nextResponse.content, verifierChannel);
  if (!channelPolicy.passed) {
    let sanitized = sanitizePolicyViolations(nextResponse.content, input.channel);
    const recheck = checkChannelPolicy(sanitized, verifierChannel);
    if (!recheck.passed) {
      sanitized = getPolicyFallback(input.channel);
    }

    interventions.push({
      type: 'channel_policy',
      reasons: channelPolicy.reasons,
    });
    nextResponse = {
      ...nextResponse,
      content: sanitized,
    };
  }

  return { response: nextResponse, interventions };
}

export async function respondWithAminaCore(input: AminaRespondInput): Promise<AminaRespondResult> {
  const context = await buildAminaRuntimeContext(input);
  const aiChannel = mapRuntimeChannelToAiChannel(input.channel);

  let response: AIResponse;
  if (input.options?.promptMode === 'passthrough') {
    const systemPrompt = await buildAminaPassthroughSystemPrompt({
      channel: input.channel,
      context,
      extraRules: input.extraRules,
      systemInstruction: input.systemInstruction,
    });
    response = await aiService.chat(
      [{ role: 'system', content: systemPrompt }, ...input.messages],
      aiChannel,
      undefined,
      {
        ...input.options,
        promptMode: 'passthrough',
      },
    );
  } else {
    // Передаём searchContext вместе с combinedContext: иначе результат webSearch,
    // полученный внутри buildAminaRuntimeContext, не попадал в LLM (баг был виден
    // в vision/mini-app/digest, где TG-обходного пути нет).
    response = await aiService.chat(
      input.messages,
      aiChannel,
      mergeContextWithSearch(context),
      input.options,
    );
  }

  const withPolicy = await applyPolicyLayer(response, input, context);

  if (input.enableSelfGrowth && input.userText) {
    captureSelfCoreFromInteraction({
      userMessage: input.userText,
      aiResponse: withPolicy.response.content,
    }).catch((error) => {
      aiLogger.warn({ error }, 'Amina runtime: self-core growth failed');
    });
  }

  if (withPolicy.interventions.length > 0) {
    aiLogger.info(
      {
        channel: input.channel,
        interventions: withPolicy.interventions,
      },
      'Amina runtime applied policy interventions',
    );
  }

  return {
    response: withPolicy.response,
    context,
    interventions: withPolicy.interventions,
  };
}

export async function summarizeWithAminaCore(input: {
  channel?: AminaRuntimeChannel;
  messages: AIMessage[];
  extraRules?: string[];
  systemInstruction?: string;
  context?: Omit<AminaRuntimeContextOptions, 'channel'>;
  options?: AIChatOptions;
}): Promise<AminaRespondResult> {
  return respondWithAminaCore({
    channel: input.channel ?? 'system',
    messages: input.messages,
    extraRules: input.extraRules,
    systemInstruction: input.systemInstruction,
    options: {
      promptMode: 'passthrough',
      ...input.options,
    },
    ...input.context,
  });
}

export async function planWithAminaCore(input: {
  channel?: AminaRuntimeChannel;
  messages: AIMessage[];
  extraRules?: string[];
  systemInstruction?: string;
  context?: Omit<AminaRuntimeContextOptions, 'channel'>;
  options?: AIChatOptions;
}): Promise<AminaRespondResult> {
  return summarizeWithAminaCore({
    channel: input.channel ?? 'voice',
    messages: input.messages,
    extraRules: input.extraRules,
    systemInstruction: input.systemInstruction,
    context: input.context,
    options: input.options,
  });
}
