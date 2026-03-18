import type { BotContext } from '../bot.js';
import { config } from '../../config/index.js';
import { telegramLogger } from '../../config/logger.js';
import { conversationsRepo } from '../../db/index.js';
import {
  memoryContextBuilder,
  type TelegramUserInfo,
} from '../../memory/user-memory.js';
import { buildTimeContext } from '../format.js';
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

/** Строит контекст памяти с одной повторной попыткой */
export const buildMemoryWithRetry = async (
  userId: string,
  telegramInfo: TelegramUserInfo,
): Promise<string> => {
  try {
    return await memoryContextBuilder.buildContext(userId, telegramInfo);
  } catch (err) {
    telegramLogger.warn({ error: err, userId }, 'Memory context attempt 1 failed, retrying...');
    try {
      return await memoryContextBuilder.buildContext(userId, telegramInfo);
    } catch (err2) {
      telegramLogger.error({ error: err2, userId }, 'Memory context attempt 2 failed — responding WITHOUT memory');
      return '';
    }
  }
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
  const { getSearchContext } = await import('../../ai/websearch.js');
  const timeContext = buildTimeContext(firstName, userTimezone);

  const { buildSelfCoreContext } = await import('../../ai/self-core.js');

  const [memoryContextRaw, webSearchContext, selfCoreContext] = await Promise.all([
    buildMemoryWithRetry(userId, telegramInfo ?? ({} as TelegramUserInfo)),
    getSearchContext(userText).catch((err) => {
      telegramLogger.warn({ error: err, userId }, 'Failed to get search context');
      return '';
    }),
    buildSelfCoreContext().catch(() => ''),
  ]);

  let memoryContext = timeContext
    + (selfCoreContext ? '\n' + selfCoreContext : '')
    + (memoryContextRaw ? '\n' + memoryContextRaw : '');

  // Антиповтор приветствия: если сегодня уже здоровалась — запрет
  if (alreadyGreetedToday) {
    memoryContext += '\n[Не здоровайся — уже здоровалась сегодня.]';
  }

  return { memoryContext, webSearchContext };
};
