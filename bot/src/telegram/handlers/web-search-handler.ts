import { InlineKeyboard } from 'grammy';
import type { BotContext } from '../bot.js';
import { MAX_HISTORY_MESSAGES } from '../bot.js';
import { telegramLogger } from '../../config/logger.js';
import { aiService } from '../../ai/openrouter.js';
import { webSearch, isWebSearchEnabled, shouldForceWebSearch, needsWebSearch } from '../../ai/websearch.js';
import { conversationsRepo, analyticsRepo } from '../../db/index.js';
import { userProfileRepo } from '../../memory/user-memory.js';
import type { TelegramUserInfo } from '../../memory/user-memory.js';
import {
  sendLongMessage,
  buildTimeContext,
  looksLikeSearchSimulation,
  looksLikeSearchRefusal,
  inlineCitations,
} from '../format.js';
import { ensureConversation } from './context-builder.js';

export { shouldForceWebSearch, needsWebSearch };

export const handleDirectWebSearch = async (
  ctx: BotContext,
  userMessage: string,
  userId: string,
  chatId: number,
  startTime: number,
): Promise<boolean> => {
  const searchEnabled = await isWebSearchEnabled();
  if (!searchEnabled) {
    telegramLogger.warn({ userId }, 'Web search disabled — falling through to AI');
    return false;
  }

  await ctx.replyWithChatAction('typing');

  try {
    telegramLogger.info({ userId, query: userMessage.substring(0, 80) }, 'Direct web search started');
    const searchResult = await webSearch(userMessage);
    telegramLogger.info({ userId, model: searchResult.model, tokens: searchResult.tokens_used.total }, 'Direct web search succeeded');

    const timeContext = buildTimeContext(ctx.from?.first_name);

    const citationsMap = searchResult.citations.length > 0
      ? `\n\nКАРТА ИСТОЧНИКОВ (используй номера [N] в тексте):\n${searchResult.citations.map((url, i) => `[${i + 1}] ${url}`).join('\n')}`
      : '';

    const searchContext = `${timeContext}\n\n=== ДАННЫЕ ИЗ ИНТЕРНЕТА (${new Date().toLocaleDateString('ru-RU')}) ===\n${searchResult.answer}${citationsMap}\n=== КОНЕЦ ДАННЫХ ===\n\n` +
      `КРИТИЧЕСКАЯ ИНСТРУКЦИЯ (ОБЯЗАТЕЛЬНО ВЫПОЛНИ):\n` +
      `1. Данные из интернета УЖЕ НАЙДЕНЫ и предоставлены выше — ИСПОЛЬЗУЙ ИХ!\n` +
      `2. Перескажи эти данные пользователю красиво, структурированно, своими словами.\n` +
      `3. Для КАЖДОГО пункта новости/факта сохраняй ссылку [N] на источник — пользователь должен видеть откуда информация.\n` +
      `4. АБСОЛЮТНО ЗАПРЕЩЕНО: писать "не могу искать", "нет доступа к интернету", "не удалось найти" — данные ЕСТЬ выше!\n` +
      `5. АБСОЛЮТНО ЗАПРЕЩЕНО: писать "Ищу...", "Поиск...", "Сейчас найду..."\n` +
      `6. АБСОЛЮТНО ЗАПРЕЩЕНО: игнорировать данные и предлагать пользователю искать самостоятельно.\n` +
      `7. Просто возьми данные из блока "=== ДАННЫЕ ИЗ ИНТЕРНЕТА ===" и представь их.`;

    await ensureConversation(ctx, userId, chatId);
    ctx.session.messageHistory.push({ role: 'user', content: userMessage });
    if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
      ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
    }

    await ctx.replyWithChatAction('typing');
    const response = await aiService.chat(ctx.session.messageHistory, 'telegram', searchContext);

    let finalContent = response.content;
    const llmRefusedSearch = looksLikeSearchSimulation(finalContent) || looksLikeSearchRefusal(finalContent);
    if (llmRefusedSearch) {
      telegramLogger.warn({ userId, reason: looksLikeSearchSimulation(finalContent) ? 'simulation' : 'refusal' }, 'LLM ignored/refused search data — using raw results');
      finalContent = searchResult.answer;
    }

    if (searchResult.citations.length > 0) {
      finalContent = inlineCitations(finalContent, searchResult.citations);
    }

    ctx.session.messageHistory.push({ role: 'assistant', content: finalContent });

    const searchKeyboard = new InlineKeyboard().text('📌 В заметки', 'save_to_notes').text('🔊 Озвучить', 'read_aloud');
    await sendLongMessage(ctx, finalContent, searchKeyboard);

    // Fire-and-forget analytics
    const responseTime = Date.now() - startTime;
    const telegramInfo: TelegramUserInfo = {
      id: ctx.from?.id ?? 0, first_name: ctx.from?.first_name, last_name: ctx.from?.last_name,
      username: ctx.from?.username, language_code: ctx.from?.language_code,
    };
    userProfileRepo.updateOnMessage(userId, 'message', response.tokens_used.total, telegramInfo).catch(() => {});
    const convId = ctx.session.conversationId;
    if (convId) {
      const nowISO = new Date().toISOString();
      conversationsRepo.addMessage(convId, { role: 'user', content: userMessage, timestamp: nowISO })
        .then(() => conversationsRepo.addMessage(convId, { role: 'assistant', content: finalContent, timestamp: nowISO }))
        .catch((err) => { telegramLogger.warn({ error: err }, 'Search DB write failed'); });
    }
    analyticsRepo.log('message_sent', 'telegram', { userId, model: response.model, tokens: response.tokens_used.total, responseTimeMs: responseTime, webSearch: true, webSearchModel: searchResult.model }).catch(() => {});

    telegramLogger.info({ userId, responseTimeMs: responseTime, webSearchModel: searchResult.model }, 'Direct search response sent');
    return true;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const errCode = (error as { code?: string })?.code ?? 'UNKNOWN';
    telegramLogger.error({ error: err.message, code: errCode, userId, query: userMessage.substring(0, 80) }, 'Direct web search FAILED → falling through to LLM');
    return false;
  }
};
