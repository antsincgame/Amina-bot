/**
 * Общие хелперы для Telegram message handlers.
 *
 * Раньше каждый handler (text/voice/photo/document/web-search) делал
 * одно и то же руками: push user+assistant в session, trim, save в БД.
 * Логика расходилась мелочами и приводила к багам (потеря порядка,
 * утечки в session при ошибках). Здесь — единый набор примитивов.
 */

import type { Message } from '../../../../shared/types/index.js';
import type { BotContext } from '../bot.js';
import { MAX_HISTORY_MESSAGES } from '../bot.js';
import { telegramLogger } from '../../config/logger.js';
import { conversationsRepo } from '../../db/index.js';
import {
  detectImageEditIntent as regexDetectImageEditIntent,
  classifyImageEditIntentGroq,
} from '../../ai/image-gen.js';

/**
 * Пушит реплику в session.messageHistory и обрезает по MAX_HISTORY_MESSAGES.
 * Принимает один или несколько Message — для парных user+assistant записей.
 */
export function pushSessionTurn(
  ctx: BotContext,
  ...turns: Array<{ role: 'user' | 'assistant'; content: string }>
): void {
  for (const turn of turns) {
    ctx.session.messageHistory.push(turn);
  }
  if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
    ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
  }
}

/**
 * Сохраняет user+assistant пару в БД последовательно (через addMessage,
 * который защищён мьютексом). Раньше каждый handler писал
 * .then-цепочку с одинаковыми полями и ловил ошибки по-своему.
 *
 * Fire-and-forget: ошибки логируются, но не пробрасываются — UX не должен
 * страдать из-за временных проблем БД.
 */
export function persistTurn(
  conversationId: string | null | undefined,
  userMessage: Pick<Message, 'content'> & Partial<Pick<Message, 'metadata'>>,
  assistantMessage: Pick<Message, 'content'> & Partial<Pick<Message, 'metadata'>>,
  context?: { userId?: string; channel?: string },
): void {
  if (!conversationId) return;
  const nowISO = new Date().toISOString();

  conversationsRepo
    .addMessage(conversationId, { role: 'user', content: userMessage.content, timestamp: nowISO, metadata: userMessage.metadata })
    .then(() =>
      conversationsRepo.addMessage(conversationId, {
        role: 'assistant',
        content: assistantMessage.content,
        timestamp: nowISO,
        metadata: assistantMessage.metadata,
      }),
    )
    .catch((err) => {
      telegramLogger.warn(
        { error: err, userId: context?.userId, channel: context?.channel },
        'persistTurn: addMessage failed',
      );
    });
}

/**
 * Распознаёт intent на редактирование уже отправленного фото.
 * Сначала regex (быстро, без LLM), затем Groq-классификатор как fallback.
 * Раньше эта пара дублировалась в text/voice/photo/document handlers.
 */
export async function detectImageEditFromText(text: string | undefined | null): Promise<boolean> {
  if (!text) return false;
  if (regexDetectImageEditIntent(text)) return true;
  return Boolean(await classifyImageEditIntentGroq(text));
}

/**
 * Маппинг кодов ошибок vision (photo/document) → пользовательские сообщения.
 * Раньше копия if-else цепочки была в photo-handler:70 и document-handler:87.
 */
export function formatVisionError(errorCode: string | undefined): string {
  switch (errorCode) {
    case 'VISION_MODEL_NOT_FOUND':
      return '🔧 Vision модель не найдена.\n\nВ админке выберите другую модель.';
    case 'VISION_SERVICE_UNAVAILABLE':
      return '⏳ Сервис анализа фото недоступен. Попробуй через минуту.';
    case 'AUTH_ERROR':
      return '🔑 Ошибка авторизации API.';
    case 'ALL_MODELS_FAILED':
    case 'ALL_VISION_MODELS_FAILED':
      return '🔄 Все vision модели заняты. Попробуй через 30 сек.';
    case 'RATE_LIMIT':
      return '⏳ Слишком много запросов!';
    case 'VISION_RACE_TIMEOUT':
      return '⏰ Vision модели отвечают слишком долго. Попробуй ещё раз.';
    default:
      return '😔 Не удалось обработать изображение. Попробуй ещё раз.';
  }
}
