import type { BotContext } from '../bot.js';
import { conversationsRepo } from '../../db/index.js';
import type { TelegramUserInfo } from '../../memory/user-memory.js';
import { buildAminaRuntimeContext } from '../../ai/amina-core-runtime.js';
import { sanitizeMessageHistory } from './history-utils.js';

/** Создаёт/загружает conversation если ещё не инициализирован */
export const ensureConversation = async (ctx: BotContext, userId: string, chatId: number): Promise<void> => {
  if (ctx.session.conversationId) return;

  const conversation = await conversationsRepo.getOrCreate(
    userId, 'telegram',
    { telegram_chat_id: chatId, telegram_user_id: ctx.from?.id }
  );
  ctx.session.conversationId = conversation.id;
  ctx.session.messageHistory = conversation.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));
  ctx.session.messageHistory = sanitizeMessageHistory(ctx.session.messageHistory);
};

/** Строит полный контекст (время + память + поиск) параллельно */
export const buildFullContext = async (
  userId: string,
  userText: string,
  firstName?: string,
  telegramInfo?: TelegramUserInfo,
  alreadyGreetedToday?: boolean,
  userTimezone?: string,
): Promise<{ memoryContext: string; webSearchContext: string }> => {
  const runtimeContext = await buildAminaRuntimeContext({
    channel: 'telegram',
    userId,
    userText,
    firstName,
    telegramInfo,
    alreadyGreetedToday,
    userTimezone,
    includeMemory: true,
    includeSearch: true,
  });

  return {
    memoryContext: runtimeContext.combinedContext,
    webSearchContext: runtimeContext.searchContext,
  };
};
