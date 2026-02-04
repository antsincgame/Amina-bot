import { Bot, Context, session, SessionFlavor } from 'grammy';
import { config } from '../config/index.js';
import { telegramLogger } from '../config/logger.js';
import { aiService } from '../ai/openrouter.js';
import { conversationsRepo, analyticsRepo } from '../db/supabase.js';
import type { Message, AIMessage } from '../../../shared/types/index.js';

// Note: Voice processing requires Vosk model to be installed
// Voice messages will fallback to text-only response if STT unavailable

// --------------------------------------------
// Session Types
// --------------------------------------------

interface SessionData {
  conversationId: string | null;
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
        conversationId: null,
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
    
    await analyticsRepo.log('message_received', 'telegram', {
      command: 'start',
      userId,
    });

    await ctx.reply(
      `👋 Привет! Я Amina — твой AI-ассистент.

Просто напиши мне сообщение, и я постараюсь помочь!

Команды:
/help — показать справку
/clear — очистить историю диалога
/voice — информация о голосовых сообщениях`
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
/voice — о голосовых сообщениях

**Совет:** Чем конкретнее вопрос, тем лучше ответ!`,
      { parse_mode: 'Markdown' }
    );
  });

  // /clear - Clear conversation history
  bot.command('clear', async (ctx) => {
    ctx.session.messageHistory = [];
    
    if (ctx.session.conversationId) {
      await conversationsRepo.clearMessages(ctx.session.conversationId);
    }
    
    telegramLogger.info({ userId: ctx.from?.id }, 'Conversation cleared');
    
    await ctx.reply('🧹 История диалога очищена. Начнём сначала!');
  });

  // /voice - Voice info
  bot.command('voice', async (ctx) => {
    await ctx.reply(
      `🎤 **Голосовые сообщения**

Отправь мне голосовое сообщение, и я:
1. Распознаю твою речь
2. Отвечу текстом
3. Озвучу ответ (опционально)

Поддерживаемые языки: 🇷🇺 Русский, 🇬🇧 English`,
      { parse_mode: 'Markdown' }
    );
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

    telegramLogger.debug({ userId, chatId, messageLength: userMessage.length }, 'Text message received');

    // Log analytics
    await analyticsRepo.log('message_received', 'telegram', {
      userId,
      chatId,
      messageLength: userMessage.length,
    });

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    try {
      // Get or create conversation
      if (!ctx.session.conversationId) {
        const conversation = await conversationsRepo.getOrCreate(
          userId,
          'telegram',
          { telegram_chat_id: chatId, telegram_user_id: ctx.from?.id }
        );
        ctx.session.conversationId = conversation.id;
        ctx.session.messageHistory = conversation.messages.map((m) => ({
          role: m.role,
          content: m.content,
        }));
      }

      // Add user message to history
      ctx.session.messageHistory.push({
        role: 'user',
        content: userMessage,
      });

      // Trim history if too long
      if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
        ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
      }

      // Get AI response
      const response = await aiService.chat(ctx.session.messageHistory, 'telegram');

      // Add assistant response to history
      ctx.session.messageHistory.push({
        role: 'assistant',
        content: response.content,
      });

      // Save to database
      const userMsg: Message = {
        role: 'user',
        content: userMessage,
        timestamp: new Date().toISOString(),
      };
      const assistantMsg: Message = {
        role: 'assistant',
        content: response.content,
        timestamp: new Date().toISOString(),
        metadata: {
          tokens_used: response.tokens_used.total,
          model: response.model,
        },
      };

      await conversationsRepo.addMessage(ctx.session.conversationId, userMsg);
      await conversationsRepo.addMessage(ctx.session.conversationId, assistantMsg);

      // Log analytics
      await analyticsRepo.log('ai_response', 'telegram', {
        userId,
        model: response.model,
        tokens: response.tokens_used.total,
      });

      // Send response (split if too long)
      await sendLongMessage(ctx, response.content);

      telegramLogger.info(
        { userId, tokens: response.tokens_used.total },
        'Response sent'
      );
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to process message');
      
      await analyticsRepo.log('error', 'telegram', {
        userId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      await ctx.reply(
        '😔 Извини, произошла ошибка. Попробуй ещё раз или напиши /clear для сброса диалога.'
      );
    }
  });

  // Voice messages
  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat.id;
    const voice = ctx.message.voice;
    
    telegramLogger.info({ userId, duration: voice.duration, fileId: voice.file_id }, 'Voice message received');

    // Log analytics
    await analyticsRepo.log('message_received', 'telegram', {
      userId,
      chatId,
      type: 'voice',
      duration: voice.duration,
    });

    // Show processing indicator
    await ctx.replyWithChatAction('typing');

    try {
      // Download voice file
      const file = await ctx.api.getFile(voice.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download voice: ${response.status}`);
      }
      
      const audioBuffer = Buffer.from(await response.arrayBuffer());
      telegramLogger.debug({ size: audioBuffer.length }, 'Voice file downloaded');

      // Process voice message
      const { processVoiceMessage } = await import('../voice/handler.js');
      const result = await processVoiceMessage(audioBuffer, 'ogg', ctx.session.messageHistory, {
        generateAudio: false, // For now, just text response
      });

      // Update conversation history
      ctx.session.messageHistory.push(
        { role: 'user', content: result.transcription.text },
        { role: 'assistant', content: result.aiResponse }
      );

      // Trim history
      if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
        ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
      }

      // Send response
      await ctx.reply(
        `🎤 *Распознано:* ${result.transcription.text}\n\n${result.aiResponse}`,
        { parse_mode: 'Markdown' }
      );

      // Log analytics
      await analyticsRepo.log('ai_response', 'telegram', {
        userId,
        type: 'voice',
        transcriptionLength: result.transcription.text.length,
      });

      telegramLogger.info({ userId, transcription: result.transcription.text.substring(0, 50) }, 'Voice processed');
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to process voice message');
      
      await analyticsRepo.log('error', 'telegram', {
        userId,
        type: 'voice',
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      // Fallback message
      await ctx.reply(
        '🎤 Не удалось обработать голосовое сообщение.\n\nПопробуй ещё раз или напиши текстом.'
      );
    }
  });

  // Stickers and other media
  bot.on('message', async (ctx) => {
    // Catch-all for unsupported message types
    if (!ctx.message.text && !ctx.message.voice) {
      await ctx.reply('🤔 Пока что я понимаю только текстовые и голосовые сообщения.');
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
