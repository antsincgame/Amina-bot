import { Bot, Context, session, SessionFlavor } from 'grammy';
import { config } from '../config/index-simple.js';
import { telegramLogger } from '../config/logger-simple.js';
import { aiService, AIMessage } from '../ai/openrouter-simple.js';

// --------------------------------------------
// Session Types
// --------------------------------------------

interface SessionData {
  messageHistory: AIMessage[];
}

type BotContext = Context & SessionFlavor<SessionData>;

// --------------------------------------------
// Constants
// --------------------------------------------

const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_LENGTH = 4096; // Telegram limit

// --------------------------------------------
// Create Bot Instance
// --------------------------------------------

export const createBot = (): Bot<BotContext> => {
  const bot = new Bot<BotContext>(config.telegram.token);

  // Session middleware
  bot.use(
    session({
      initial: (): SessionData => ({
        messageHistory: [],
      }),
    })
  );

  // Error handler
  bot.catch((err) => {
    telegramLogger.error({ error: err.error, ctx: err.ctx?.update }, 'Bot error');
  });

  // Commands
  setupCommands(bot);

  // Message handlers
  setupMessageHandlers(bot);

  telegramLogger.info('Telegram bot configured');
  return bot;
};

// --------------------------------------------
// Command Handlers
// --------------------------------------------

const setupCommands = (bot: Bot<BotContext>): void => {
  // /start - Welcome message
  bot.command('start', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    telegramLogger.info({ userId }, 'User started bot');

    await ctx.reply(
      `👋 Привет! Я Amina — твой AI-ассистент.

Просто напиши мне сообщение, и я постараюсь помочь!

Команды:
/help — показать справку
/clear — очистить историю диалога`
    );
  });

  // /help - Help message
  bot.command('help', async (ctx) => {
    await ctx.reply(
      `🤖 **Amina AI Bot**

Я могу:
• Отвечать на вопросы
• Помогать с текстами
• Переводить
• Объяснять сложные темы
• Поддерживать диалог с контекстом

**Команды:**
/start — начать сначала
/clear — очистить историю диалога

**Совет:** Чем конкретнее вопрос, тем лучше ответ!`,
      { parse_mode: 'Markdown' }
    );
  });

  // /clear - Clear conversation history
  bot.command('clear', async (ctx) => {
    ctx.session.messageHistory = [];
    telegramLogger.info({ userId: ctx.from?.id }, 'Conversation cleared');
    await ctx.reply('🧹 История диалога очищена. Начнём сначала!');
  });
};

// --------------------------------------------
// Message Handlers
// --------------------------------------------

const setupMessageHandlers = (bot: Bot<BotContext>): void => {
  // Text messages
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat.id;
    const userMessage = ctx.message.text;

    telegramLogger.debug(
      { userId, chatId, messageLength: userMessage.length },
      'Text message received'
    );

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    try {
      // Add user message to history
      ctx.session.messageHistory.push({
        role: 'user',
        content: userMessage,
      });

      // Trim history if too long
      if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
        ctx.session.messageHistory = ctx.session.messageHistory.slice(
          -MAX_HISTORY_MESSAGES
        );
      }

      // Get AI response
      const response = await aiService.chat(ctx.session.messageHistory);

      // Add assistant response to history
      ctx.session.messageHistory.push({
        role: 'assistant',
        content: response.content,
      });

      // Send response (split if too long)
      await sendLongMessage(ctx, response.content);

      telegramLogger.info(
        { userId, tokens: response.tokens_used.total },
        'Response sent'
      );
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to process message');

      await ctx.reply(
        '😔 Извини, произошла ошибка. Попробуй ещё раз или напиши /clear для сброса диалога.'
      );
    }
  });

  // Voice messages
  bot.on('message:voice', async (ctx) => {
    await ctx.reply(
      '🎤 Голосовые сообщения временно недоступны.\n\nОтправьте текстовое сообщение.'
    );
  });

  // Stickers and other media
  bot.on('message', async (ctx) => {
    // Catch-all for unsupported message types
    if (!ctx.message.text && !ctx.message.voice) {
      await ctx.reply('🤔 Пока что я понимаю только текстовые сообщения.');
    }
  });
};

// --------------------------------------------
// Utility Functions
// --------------------------------------------

const sendLongMessage = async (ctx: BotContext, text: string): Promise<void> => {
  if (text.length <= MAX_MESSAGE_LENGTH) {
    await ctx.reply(text);
    return;
  }

  // Split by paragraphs first, then by length
  const chunks: string[] = [];
  let currentChunk = '';

  const paragraphs = text.split('\n\n');
  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length + 2 > MAX_MESSAGE_LENGTH) {
      if (currentChunk) {
        chunks.push(currentChunk.trim());
        currentChunk = '';
      }

      // If single paragraph is too long, split by sentences
      if (paragraph.length > MAX_MESSAGE_LENGTH) {
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if (currentChunk.length + sentence.length + 1 > MAX_MESSAGE_LENGTH) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = sentence;
          } else {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
          }
        }
      } else {
        currentChunk = paragraph;
      }
    } else {
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk.trim());
  }

  // Send all chunks
  for (const chunk of chunks) {
    await ctx.reply(chunk);
  }
};
