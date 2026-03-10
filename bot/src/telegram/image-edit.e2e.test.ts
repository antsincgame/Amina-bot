import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Buffer } from 'buffer';

// Mock dependencies BEFORE importing anything that uses them
vi.mock('../config/index.js', () => ({
  config: {
    server: { logLevel: 'silent' },
    isDev: true,
    telegram: { token: 'test-token' },
  },
  getApiKeys: vi.fn(() => Promise.resolve({ openrouter: 'test-key', groq: 'test-key' })),
}));

vi.mock('../config/logger.js', () => ({
  telegramLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  aiLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
  logger: { child: vi.fn(() => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() })) },
}));

vi.mock('../db/supabase.js', () => ({
  conversationsRepo: { saveMessage: vi.fn().mockReturnValue({ catch: vi.fn() }), getHistory: vi.fn().mockResolvedValue([]), addMessage: vi.fn().mockResolvedValue({}) },
  analyticsRepo: { log: vi.fn().mockReturnValue({ catch: vi.fn() }) },
  userProfileRepo: { get: vi.fn().mockResolvedValue({ id: 1, first_name: 'Test' }) },
  userMemoryRepo: { get: vi.fn().mockResolvedValue({ memories: [] }) },
  userLogsRepo: { save: vi.fn().mockReturnValue({ catch: vi.fn() }) },
  settingsRepo: { get: vi.fn().mockResolvedValue('test-value') },
}));

vi.mock('../utils/rate-limiter.js', () => ({
  checkTelegramRateLimit: vi.fn().mockReturnValue({ allowed: true }),
}));

vi.mock('../features/user-prefs-repo.js', () => ({
  userPrefsRepo: { get: vi.fn().mockResolvedValue({}) },
}));

vi.mock('../ai/openrouter.js', () => ({
  aiService: { generate: vi.fn() },
  isGibberish: vi.fn().mockReturnValue(false),
}));

// Mock image-gen functions
vi.mock('../ai/image-gen.js', async () => {
  const actual = await vi.importActual('../ai/image-gen.js') as any;
  return {
    ...actual,
    editImage: vi.fn().mockResolvedValue({
      image: Buffer.from('edited_image'),
      prompt: 'edited prompt',
      model: 'test-model'
    }),
    classifyImageEditIntentGroq: vi.fn().mockResolvedValue(false),
  };
});

// Now import the functions we want to test
import { handlePhotoMessage } from './messages.js';
import * as imageGen from '../ai/image-gen.js';

describe('Image Editing E2E Flow', () => {
  let mockCtx: any;

  beforeEach(() => {
    vi.clearAllMocks();
    
    mockCtx = {
      from: { id: 123, first_name: 'Test User', username: 'testuser' },
      chat: { id: 123, type: 'private' },
      message: {
        message_id: 1,
        date: Date.now(),
        photo: [{ file_id: 'photo_id', width: 100, height: 100 }],
        caption: 'убери фон',
      },
      session: {
        messageHistory: [],
      },
      api: {
        getFile: vi.fn().mockResolvedValue({ file_path: 'path/to/file' }),
      },
      replyWithChatAction: vi.fn().mockResolvedValue(true),
      replyWithPhoto: vi.fn().mockResolvedValue(true),
      reply: vi.fn().mockResolvedValue(true),
    };

    // Mock global fetch for image download
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    });
  });

  it('should trigger image editing when caption contains edit intent', async () => {
    await handlePhotoMessage(mockCtx);

    expect(imageGen.editImage).toHaveBeenCalled();
    expect(mockCtx.replyWithPhoto).toHaveBeenCalled();
  });

  it('should trigger image editing via Groq if regex fails but Groq succeeds', async () => {
    mockCtx.message.caption = 'преврати это в шедевр';
    (imageGen.classifyImageEditIntentGroq as any).mockResolvedValue(true);
    
    await handlePhotoMessage(mockCtx);

    expect(imageGen.classifyImageEditIntentGroq).toHaveBeenCalled();
    expect(imageGen.editImage).toHaveBeenCalled();
  });

  it('should NOT trigger image editing if no intent detected', async () => {
    mockCtx.message.caption = 'просто красивая фотка';
    (imageGen.classifyImageEditIntentGroq as any).mockResolvedValue(false);
    
    // This will try to call processImageWithLLM, which we should mock to avoid errors
    vi.mock('../ai/multimodal.js', () => ({
      processImageWithLLM: vi.fn().mockResolvedValue({ content: 'test', tokens_used: { total: 10 }, model: 'test' }),
      downloadTelegramPhoto: vi.fn().mockResolvedValue({ base64: 'base64', mimeType: 'image/jpeg' }),
    }));

    await handlePhotoMessage(mockCtx);

    expect(imageGen.editImage).not.toHaveBeenCalled();
  });
});
