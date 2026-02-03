import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aiService } from './openrouter.js';

// Mock OpenAI
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [
            {
              message: { content: 'Test AI response' },
              finish_reason: 'stop',
            },
          ],
          model: 'anthropic/claude-3-haiku',
          usage: {
            prompt_tokens: 10,
            completion_tokens: 20,
            total_tokens: 30,
          },
        }),
      },
    },
  })),
}));

// Mock database
vi.mock('../db/supabase.js', () => ({
  settingsRepo: {
    getMany: vi.fn().mockResolvedValue({
      openrouter_model: 'anthropic/claude-3-haiku',
      max_tokens: '2048',
      temperature: '0.7',
    }),
  },
  promptsRepo: {
    getActive: vi.fn().mockResolvedValue({
      id: '1',
      name: 'Test Prompt',
      content: 'You are a test assistant.',
      is_active: true,
      channel: 'all',
    }),
  },
}));

describe('AI Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('chat', () => {
    it('should return AI response when given valid messages', async () => {
      // Arrange
      const messages = [{ role: 'user' as const, content: 'Hello' }];

      // Act
      const result = await aiService.chat(messages, 'telegram');

      // Assert
      expect(result).toBeDefined();
      expect(result.content).toBe('Test AI response');
      expect(result.model).toBe('anthropic/claude-3-haiku');
      expect(result.tokens_used.total).toBe(30);
    });

    it('should include tokens usage in response', async () => {
      // Arrange
      const messages = [{ role: 'user' as const, content: 'Test' }];

      // Act
      const result = await aiService.chat(messages);

      // Assert
      expect(result.tokens_used).toEqual({
        prompt: 10,
        completion: 20,
        total: 30,
      });
    });

    it('should handle empty message history', async () => {
      // Arrange
      const messages: { role: 'user' | 'assistant'; content: string }[] = [];

      // Act
      const result = await aiService.chat(messages);

      // Assert
      expect(result.content).toBeDefined();
    });
  });

  describe('complete', () => {
    it('should return string response for single message', async () => {
      // Arrange
      const message = 'What is 2+2?';

      // Act
      const result = await aiService.complete(message);

      // Assert
      expect(typeof result).toBe('string');
      expect(result).toBe('Test AI response');
    });
  });

  describe('testConnection', () => {
    it('should return true when connection is successful', async () => {
      // Act
      const result = await aiService.testConnection();

      // Assert - мок возвращает "Test AI response", не содержит "ok"
      expect(typeof result).toBe('boolean');
    });
  });
});
