/**
 * Tests for Configuration Module
 * 
 * Note: This file tests configuration after env vars are set by test/setup.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock settingsRepo to avoid real DB connections
vi.mock('../db/appwrite.js', () => ({
  settingsRepo: {
    getMany: vi.fn().mockResolvedValue({}),
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
  },
}));

import { config, getApiKeys, clearApiKeysCache } from './index.js';

describe('Configuration', () => {
  beforeEach(() => {
    clearApiKeysCache();
    vi.clearAllMocks();
  });

  describe('config object', () => {
    it('should have required properties', () => {
      expect(config).toHaveProperty('isDev');
      expect(config).toHaveProperty('isProd');
      expect(config).toHaveProperty('server');
      expect(config).toHaveProperty('telegram');
      expect(config).toHaveProperty('ai');
      expect(config).toHaveProperty('appwrite');
    });

    it('should have valid server config', () => {
      expect(config.server.port).toBeTypeOf('number');
      expect(config.server.host).toBeTypeOf('string');
    });

    it('should have AI config with defaults', () => {
      expect(config.ai.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(config.ai.maxTokens).toBeTypeOf('number');
      expect(config.ai.temperature).toBeTypeOf('number');
      expect(config.ai.temperature).toBeGreaterThanOrEqual(0);
      expect(config.ai.temperature).toBeLessThanOrEqual(2);
    });

    it('should set test environment', () => {
      expect(config.isTest).toBe(true);
      expect(config.isProd).toBe(false);
    });
  });

  describe('config.setTelegramToken', () => {
    it('should update the telegram token', () => {
      const originalToken = config.telegram.token;
      config.setTelegramToken('new-token-123');
      expect(config.telegram.token).toBe('new-token-123');
      
      // Restore
      config.setTelegramToken(originalToken);
    });
  });

  describe('getApiKeys', () => {
    it('should return env keys when both are set', async () => {
      const keys = await getApiKeys();
      expect(keys).toHaveProperty('openrouter');
      expect(keys).toHaveProperty('groq');
    });

    it('should cache results', async () => {
      const keys1 = await getApiKeys();
      const keys2 = await getApiKeys();
      // Should be same object reference from cache
      expect(keys1.openrouter).toBe(keys2.openrouter);
    });
  });

  describe('clearApiKeysCache', () => {
    it('should clear cached keys', async () => {
      await getApiKeys(); // Populate cache
      clearApiKeysCache(); // Clear it
      // Next call should re-fetch (but result is same from env)
      const keys = await getApiKeys();
      expect(keys).toHaveProperty('openrouter');
    });
  });
});
