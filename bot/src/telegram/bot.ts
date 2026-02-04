import { Bot, Context, session, SessionFlavor } from 'grammy';
import { config } from '../config/index.js';
import { telegramLogger } from '../config/logger.js';
import { aiService } from '../ai/openrouter.js';
import { processVoiceWithLLM, processImageWithLLM } from '../ai/multimodal.js';
import { conversationsRepo, analyticsRepo } from '../db/supabase.js';
import { checkTelegramRateLimit } from '../utils/rate-limiter.js';
import { 
  userProfileRepo, 
  userMemoryRepo, 
  userLogsRepo, 
  memoryExtractor,
  memoryContextBuilder,
  type TelegramUserInfo 
} from '../memory/user-memory.js';
import type { Message, AIMessage } from '../../../shared/types/index.js';

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
    
    if (ctx.session.conversationId) {
      try {
        await conversationsRepo.clearMessages(ctx.session.conversationId);
      } catch (error) {
        telegramLogger.error({ error }, 'Failed to clear messages in DB');
      }
    }
    
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
    const startTime = Date.now();

    // Telegram user info for profile
    const telegramInfo: TelegramUserInfo = {
      id: ctx.from?.id ?? 0,
      username: ctx.from?.username,
      first_name: ctx.from?.first_name,
      last_name: ctx.from?.last_name,
      language_code: ctx.from?.language_code,
    };

    telegramLogger.debug({ userId, chatId, messageLength: userMessage.length }, 'Text message received');

    // Check rate limit
    const rateLimitResult = checkTelegramRateLimit(userId);
    if (!rateLimitResult.allowed) {
      telegramLogger.warn({ userId }, 'Rate limit exceeded for Telegram user');
      await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений. Подожди немного.');
      return;
    }

    // Log analytics
    await analyticsRepo.log('message_received', 'telegram', {
      userId,
      chatId,
      messageLength: userMessage.length,
    });

    // Log user message
    await userLogsRepo.add(userId, 'message', userMessage, {
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

      // Build memory context for personalized responses
      const memoryContext = await memoryContextBuilder.buildContext(userId, telegramInfo);

      // Add user message to history
      ctx.session.messageHistory.push({
        role: 'user',
        content: userMessage,
      });

      // Trim history if too long
      if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
        ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
      }

      // Get AI response with memory context
      const response = await aiService.chat(ctx.session.messageHistory, 'telegram', memoryContext);

      // Add assistant response to history
      ctx.session.messageHistory.push({
        role: 'assistant',
        content: response.content,
      });

      // Update user profile stats
      await userProfileRepo.updateOnMessage(userId, 'message', response.tokens_used.total, telegramInfo);

      // Log AI response
      const responseTime = Date.now() - startTime;
      await userLogsRepo.add(userId, 'ai_response', response.content, {
        chatId,
        responseLength: response.content.length,
      }, {
        model: response.model,
        tokensPrompt: response.tokens_used.prompt,
        tokensCompletion: response.tokens_used.completion,
        responseTimeMs: responseTime,
      });

      // Extract facts from conversation (async, don't wait)
      memoryExtractor.extractFacts(userId, userMessage, response.content).catch(() => {});

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

  // Voice messages - transcribe and send to LLM
  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat.id;
    const duration = ctx.message.voice.duration;
    
    telegramLogger.info({ userId, duration }, 'Voice message received');

    // Check rate limit
    const rateLimitResult = checkTelegramRateLimit(userId);
    if (!rateLimitResult.allowed) {
      await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.');
      return;
    }

    await analyticsRepo.log('message_received', 'telegram', {
      userId,
      type: 'voice',
      duration,
    });

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    try {
      // Download voice file
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      
      telegramLogger.debug({ fileUrl }, 'Downloading voice file');
      
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download voice file: ${response.status}`);
      }
      
      const audioBuffer = await response.arrayBuffer();
      const audioBase64 = Buffer.from(audioBuffer).toString('base64');
      
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

      // Process voice: transcribe + LLM
      const result = await processVoiceWithLLM(
        audioBase64,
        'audio/ogg',
        ctx.session.messageHistory
      );

      // Update history
      ctx.session.messageHistory.push(
        { role: 'user', content: result.transcription },
        { role: 'assistant', content: result.response.content }
      );

      // Trim history if too long
      if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
        ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
      }

      // Save to database
      const userMsg: Message = {
        role: 'user',
        content: result.transcription,
        timestamp: new Date().toISOString(),
        metadata: { voice_duration: duration },
      };
      const assistantMsg: Message = {
        role: 'assistant',
        content: result.response.content,
        timestamp: new Date().toISOString(),
        metadata: {
          tokens_used: result.response.tokens_used.total,
          model: result.response.model,
        },
      };

      await conversationsRepo.addMessage(ctx.session.conversationId, userMsg);
      await conversationsRepo.addMessage(ctx.session.conversationId, assistantMsg);

      // Log analytics
      await analyticsRepo.log('ai_response', 'telegram', {
        userId,
        type: 'voice',
        model: result.response.model,
        tokens: result.response.tokens_used.total,
        transcription_length: result.transcription.length,
      });

      // Send response with transcription preview
      const transcriptionPreview = result.transcription.length > 100
        ? result.transcription.slice(0, 100) + '...'
        : result.transcription;
      
      await ctx.reply(`🎤 _"${transcriptionPreview}"_`, { parse_mode: 'Markdown' });
      await sendLongMessage(ctx, result.response.content);

      telegramLogger.info(
        { userId, tokens: result.response.tokens_used.total },
        'Voice response sent'
      );
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to process voice message');
      
      await analyticsRepo.log('error', 'telegram', {
        userId,
        type: 'voice',
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      await ctx.reply(
        '😔 Не удалось обработать голосовое сообщение. Попробуй ещё раз или отправь текст.'
      );
    }
  });

  // Photo messages - analyze and send to LLM
  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const chatId = ctx.chat.id;
    const caption = ctx.message.caption;
    
    telegramLogger.info({ userId, hasCaption: !!caption }, 'Photo message received');

    // Check rate limit
    const rateLimitResult = checkTelegramRateLimit(userId);
    if (!rateLimitResult.allowed) {
      await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.');
      return;
    }

    await analyticsRepo.log('message_received', 'telegram', {
      userId,
      type: 'photo',
      hasCaption: !!caption,
    });

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    try {
      // Get largest photo
      const photos = ctx.message.photo;
      const largestPhoto = photos[photos.length - 1];
      
      if (!largestPhoto) {
        throw new Error('No photo found in message');
      }
      
      // Download photo
      const file = await ctx.api.getFile(largestPhoto.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      
      telegramLogger.debug({ fileUrl, width: largestPhoto.width, height: largestPhoto.height }, 'Downloading photo');
      
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download photo: ${response.status}`);
      }
      
      const imageBuffer = await response.arrayBuffer();
      const imageBase64 = Buffer.from(imageBuffer).toString('base64');
      
      // Determine MIME type
      const mimeType = file.file_path?.endsWith('.png') ? 'image/png' : 'image/jpeg';
      
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

      // Process image: analyze + LLM
      const aiResponse = await processImageWithLLM(
        imageBase64,
        mimeType,
        caption,
        ctx.session.messageHistory
      );

      // Create user message content
      const userContent = caption
        ? `[Изображение с подписью: "${caption}"]`
        : '[Изображение]';

      // Update history
      ctx.session.messageHistory.push(
        { role: 'user', content: userContent },
        { role: 'assistant', content: aiResponse.content }
      );

      // Trim history if too long
      if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
        ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
      }

      // Save to database
      const userMsg: Message = {
        role: 'user',
        content: userContent,
        timestamp: new Date().toISOString(),
        metadata: { 
          type: 'photo',
          width: largestPhoto.width,
          height: largestPhoto.height,
        },
      };
      const assistantMsg: Message = {
        role: 'assistant',
        content: aiResponse.content,
        timestamp: new Date().toISOString(),
        metadata: {
          tokens_used: aiResponse.tokens_used.total,
          model: aiResponse.model,
        },
      };

      await conversationsRepo.addMessage(ctx.session.conversationId, userMsg);
      await conversationsRepo.addMessage(ctx.session.conversationId, assistantMsg);

      // Log analytics
      await analyticsRepo.log('ai_response', 'telegram', {
        userId,
        type: 'photo',
        model: aiResponse.model,
        tokens: aiResponse.tokens_used.total,
      });

      // Send response
      await sendLongMessage(ctx, aiResponse.content);

      telegramLogger.info(
        { userId, tokens: aiResponse.tokens_used.total },
        'Photo response sent'
      );
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to process photo');
      
      await analyticsRepo.log('error', 'telegram', {
        userId,
        type: 'photo',
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      await ctx.reply(
        '😔 Не удалось обработать изображение. Попробуй ещё раз или отправь текст.'
      );
    }
  });

  // Document/file messages (images sent as files)
  bot.on('message:document', async (ctx) => {
    const userId = ctx.from?.id.toString() ?? 'unknown';
    const document = ctx.message.document;
    const mimeType = document.mime_type ?? '';
    
    // Check if it's an image
    if (!mimeType.startsWith('image/')) {
      await ctx.reply('📄 Пока что я могу анализировать только изображения. Отправь фото или картинку.');
      return;
    }

    telegramLogger.info({ userId, mimeType, fileName: document.file_name }, 'Document image received');

    // Check rate limit
    const rateLimitResult = checkTelegramRateLimit(userId);
    if (!rateLimitResult.allowed) {
      await ctx.reply(rateLimitResult.message ?? '⏳ Слишком много сообщений.');
      return;
    }

    await analyticsRepo.log('message_received', 'telegram', {
      userId,
      type: 'document_image',
      mimeType,
    });

    // Show typing indicator
    await ctx.replyWithChatAction('typing');

    try {
      // Download document
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${config.telegram.token}/${file.file_path}`;
      
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download document: ${response.status}`);
      }
      
      const imageBuffer = await response.arrayBuffer();
      const imageBase64 = Buffer.from(imageBuffer).toString('base64');
      const caption = ctx.message.caption;
      const chatId = ctx.chat.id;
      
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

      // Process image
      const aiResponse = await processImageWithLLM(
        imageBase64,
        mimeType,
        caption,
        ctx.session.messageHistory
      );

      const userContent = caption
        ? `[Изображение "${document.file_name}" с подписью: "${caption}"]`
        : `[Изображение "${document.file_name}"]`;

      // Update history
      ctx.session.messageHistory.push(
        { role: 'user', content: userContent },
        { role: 'assistant', content: aiResponse.content }
      );

      if (ctx.session.messageHistory.length > MAX_HISTORY_MESSAGES) {
        ctx.session.messageHistory = ctx.session.messageHistory.slice(-MAX_HISTORY_MESSAGES);
      }

      // Save to database
      const userMsg: Message = {
        role: 'user',
        content: userContent,
        timestamp: new Date().toISOString(),
        metadata: { type: 'document_image', fileName: document.file_name },
      };
      const assistantMsg: Message = {
        role: 'assistant',
        content: aiResponse.content,
        timestamp: new Date().toISOString(),
        metadata: {
          tokens_used: aiResponse.tokens_used.total,
          model: aiResponse.model,
        },
      };

      await conversationsRepo.addMessage(ctx.session.conversationId, userMsg);
      await conversationsRepo.addMessage(ctx.session.conversationId, assistantMsg);

      await analyticsRepo.log('ai_response', 'telegram', {
        userId,
        type: 'document_image',
        model: aiResponse.model,
        tokens: aiResponse.tokens_used.total,
      });

      await sendLongMessage(ctx, aiResponse.content);

      telegramLogger.info({ userId }, 'Document image response sent');
    } catch (error) {
      telegramLogger.error({ error, userId }, 'Failed to process document image');
      
      await analyticsRepo.log('error', 'telegram', {
        userId,
        type: 'document_image',
        error: error instanceof Error ? error.message : 'Unknown error',
      });

      await ctx.reply('😔 Не удалось обработать изображение. Попробуй ещё раз.');
    }
  });

  // Stickers and other unsupported media
  bot.on('message', async (ctx) => {
    // Catch-all for unsupported message types
    const msg = ctx.message;
    if (!msg.text && !msg.voice && !msg.photo && !msg.document) {
      await ctx.reply('🤔 Я понимаю текст, голосовые сообщения и изображения.');
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
