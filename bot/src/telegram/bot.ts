/**
 * Telegram Bot — Orchestrator
 * 
 * Рефакторинг: из монолита 2744 строк → модульная архитектура:
 * - keyboards.ts  — все клавиатуры (дедуплицированы)
 * - format.ts     — форматирование текста, Markdown→HTML, утилиты
 * - commands.ts   — обработчики /command
 * - callbacks.ts  — обработчики callback-кнопок
 * - messages.ts   — обработчики текстовых/голосовых/фото сообщений
 * - bot.ts        — создание бота и подключение модулей (этот файл)
 */

import { Bot, Context, session, SessionFlavor } from 'grammy';
import { config } from '../config/index.js';
import { telegramLogger } from '../config/logger.js';
import { setupCommands } from './commands.js';
import { setupCallbacks } from './callbacks.js';
import { setupMessageHandlers } from './messages.js';
import type { AIMessage } from '../../../shared/types/index.js';

// ============================================
// Session Types (exported for other modules)
// ============================================

export interface SessionData {
  conversationId: string | null;
  messageHistory: AIMessage[];
  messageCount?: number;
  awaitingImagePrompt?: boolean;
  awaitingTodoTask?: boolean;
  awaitingNoteContent?: boolean;
  awaitingSearchQuery?: boolean;
  /** Изображение, ожидающее инструкции по редактированию (base64 + MIME) */
  pendingEditImage?: { base64: string; mimeType: string };
  /** Дата последнего приветствия (YYYY-MM-DD) чтобы не здороваться повторно за день */
  lastGreetingDate?: string;
}

export type BotContext = Context & SessionFlavor<SessionData>;

// ============================================
// Constants (exported for other modules)
// ============================================

export const MAX_HISTORY_MESSAGES = 20;
export const MAX_MESSAGE_LENGTH = 4096;

// ============================================
// Create Bot Instance
// ============================================

export const createBot = (): Bot<BotContext> => {
  const bot = new Bot<BotContext>(config.telegram.token);

  // Session middleware
  bot.use(
    session({
      initial: (): SessionData => ({
        conversationId: null,
        messageHistory: [],
      }),
    })
  );

  // Error handler
  bot.catch((err) => {
    telegramLogger.error({ error: err.error, ctx: err.ctx?.update }, 'Bot error');
  });

  // Register handlers in order
  setupCommands(bot);
  setupCallbacks(bot);
  setupMessageHandlers(bot);

  telegramLogger.info('Telegram bot configured (modular architecture)');
  return bot;
};
