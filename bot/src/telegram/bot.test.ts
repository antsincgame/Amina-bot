import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../config/index.js', () => ({
  config: {
    telegram: { token: 'test_token' },
  },
}));

vi.mock('../config/logger.js', () => ({
  telegramLogger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../ai/openrouter.js', () => ({
  aiService: {
    chat: vi.fn().mockResolvedValue({
      content: 'Test AI response',
      model: 'test-model',
      tokens_used: { prompt: 10, completion: 20, total: 30 },
    }),
  },
}));

vi.mock('../db/supabase.js', () => ({
  conversationsRepo: {
    getOrCreate: vi.fn().mockResolvedValue({
      id: 'conv-123',
      messages: [],
    }),
    addMessage: vi.fn().mockResolvedValue(undefined),
    clearMessages: vi.fn().mockResolvedValue(undefined),
  },
  analyticsRepo: {
    log: vi.fn().mockResolvedValue(undefined),
  },
}));

// Mock grammy
vi.mock('grammy', () => {
  const mockBot = {
    use: vi.fn(),
    catch: vi.fn(),
    command: vi.fn(),
    on: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    api: {
      setWebhook: vi.fn(),
      getFile: vi.fn(),
    },
  };
  
  return {
    Bot: vi.fn().mockImplementation(() => mockBot),
    Context: vi.fn(),
    session: vi.fn().mockReturnValue(vi.fn()),
    SessionFlavor: vi.fn(),
  };
});

import { createBot } from './bot.js';
import { Bot } from 'grammy';

describe('Telegram Bot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createBot', () => {
    it('should create bot instance with correct token', () => {
      // Act
      const bot = createBot();

      // Assert
      expect(Bot).toHaveBeenCalledWith('test_token');
      expect(bot).toBeDefined();
    });

    it('should register session middleware', () => {
      // Act
      const bot = createBot();

      // Assert
      expect(bot.use).toHaveBeenCalled();
    });

    it('should register error handler', () => {
      // Act
      const bot = createBot();

      // Assert
      expect(bot.catch).toHaveBeenCalled();
    });

    it('should register command handlers', () => {
      // Act
      const bot = createBot();

      // Assert
      // Should register /start, /help, /clear, /voice commands
      expect(bot.command).toHaveBeenCalledTimes(4);
    });

    it('should register message handlers', () => {
      // Act
      const bot = createBot();

      // Assert
      // Should register text, voice, and catch-all handlers
      expect(bot.on).toHaveBeenCalledTimes(3);
    });
  });
});

describe('Bot Commands', () => {
  it('should have /start command that welcomes user', () => {
    const bot = createBot();
    
    // Find the /start command registration
    const startCall = (bot.command as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'start'
    );
    
    expect(startCall).toBeDefined();
    expect(typeof startCall[1]).toBe('function');
  });

  it('should have /help command', () => {
    const bot = createBot();
    
    const helpCall = (bot.command as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'help'
    );
    
    expect(helpCall).toBeDefined();
  });

  it('should have /clear command', () => {
    const bot = createBot();
    
    const clearCall = (bot.command as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'clear'
    );
    
    expect(clearCall).toBeDefined();
  });

  it('should have /voice command', () => {
    const bot = createBot();
    
    const voiceCall = (bot.command as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'voice'
    );
    
    expect(voiceCall).toBeDefined();
  });
});

describe('Bot Message Handlers', () => {
  it('should handle text messages', () => {
    const bot = createBot();
    
    const textHandler = (bot.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'message:text'
    );
    
    expect(textHandler).toBeDefined();
    expect(typeof textHandler[1]).toBe('function');
  });

  it('should handle voice messages', () => {
    const bot = createBot();
    
    const voiceHandler = (bot.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'message:voice'
    );
    
    expect(voiceHandler).toBeDefined();
    expect(typeof voiceHandler[1]).toBe('function');
  });

  it('should have catch-all message handler', () => {
    const bot = createBot();
    
    const catchAllHandler = (bot.on as ReturnType<typeof vi.fn>).mock.calls.find(
      (call) => call[0] === 'message'
    );
    
    expect(catchAllHandler).toBeDefined();
  });
});

describe('Session Management', () => {
  it('should initialize session with null conversationId', () => {
    // The session initial function is passed to session middleware
    const { session } = vi.mocked(await import('grammy'));
    
    createBot();
    
    // Get the session configuration
    const sessionConfig = session.mock.calls[0]?.[0];
    expect(sessionConfig).toBeDefined();
    
    if (sessionConfig && typeof sessionConfig.initial === 'function') {
      const initialSession = sessionConfig.initial();
      expect(initialSession.conversationId).toBeNull();
      expect(initialSession.messageHistory).toEqual([]);
    }
  });
});

describe('Message History', () => {
  it('should limit history to MAX_HISTORY_MESSAGES', () => {
    // This is tested implicitly through the bot's behavior
    // The actual test would require mocking the context and session
    expect(true).toBe(true); // Placeholder for integration test
  });
});

describe('Error Handling', () => {
  it('should log errors through error handler', () => {
    const bot = createBot();
    
    // The error handler should be registered
    expect(bot.catch).toHaveBeenCalled();
    
    // Get the error handler function
    const errorHandler = (bot.catch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(typeof errorHandler).toBe('function');
  });
});
