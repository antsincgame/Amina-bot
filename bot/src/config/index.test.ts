import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('Config', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('should load configuration from environment variables', async () => {
    // Arrange - environment is already set in setup.ts
    
    // Act
    const { config } = await import('./index.js');

    // Assert
    expect(config).toBeDefined();
    expect(config.telegram.token).toBe('test_bot_token');
    expect(config.ai.apiKey).toBe('test_openrouter_key');
    expect(config.db.url).toBe('https://test.supabase.co');
  });

  it('should have correct environment flags for test mode', async () => {
    // Act
    const { config } = await import('./index.js');

    // Assert
    expect(config.isTest).toBe(true);
    expect(config.isDev).toBe(false);
    expect(config.isProd).toBe(false);
  });

  it('should have default values for optional settings', async () => {
    // Act
    const { config } = await import('./index.js');

    // Assert
    expect(config.ai.model).toBe('anthropic/claude-3-haiku');
    expect(config.ai.maxTokens).toBe(2048);
    expect(config.ai.temperature).toBe(0.7);
  });

  it('should have voice configuration', async () => {
    // Act
    const { config } = await import('./index.js');

    // Assert
    expect(config.voice.stt.sampleRate).toBe(16000);
    expect(config.voice.tts.sampleRate).toBe(48000);
    expect(config.voice.tts.speaker).toBe('xenia');
  });

  it('should disable zadarma when credentials not provided', async () => {
    // Act
    const { config } = await import('./index.js');

    // Assert
    expect(config.zadarma.enabled).toBe(false);
  });
});

describe('Config Validation', () => {
  it('should have required Telegram token', async () => {
    const { config } = await import('./index.js');
    expect(config.telegram.token).toBeTruthy();
  });

  it('should have required OpenRouter API key', async () => {
    const { config } = await import('./index.js');
    expect(config.ai.apiKey).toBeTruthy();
  });

  it('should have required Supabase URL', async () => {
    const { config } = await import('./index.js');
    expect(config.db.url).toMatch(/^https?:\/\//);
  });
});
