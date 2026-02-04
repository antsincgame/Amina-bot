/**
 * Tests for rate limiter utilities
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  checkRateLimit,
  createRateLimitKey,
  checkTelegramRateLimit,
  getRateLimitStats,
  RATE_LIMIT_CONFIGS,
} from './rate-limiter.js';

// Reset rate limit store between tests
beforeEach(() => {
  // We can't directly clear the store, but we can use unique keys
  vi.useFakeTimers();
});

// --------------------------------------------
// createRateLimitKey Tests
// --------------------------------------------

describe('createRateLimitKey', () => {
  it('should create key with type prefix', () => {
    expect(createRateLimitKey('user123', 'api')).toBe('api:user123');
    expect(createRateLimitKey('user123', 'telegram')).toBe('telegram:user123');
    expect(createRateLimitKey('user123', 'chat')).toBe('chat:user123');
    expect(createRateLimitKey('user123', 'admin')).toBe('admin:user123');
  });

  it('should handle special characters in identifier', () => {
    expect(createRateLimitKey('user@123', 'api')).toBe('api:user@123');
    expect(createRateLimitKey('192.168.1.1', 'api')).toBe('api:192.168.1.1');
  });
});

// --------------------------------------------
// checkRateLimit Tests
// --------------------------------------------

describe('checkRateLimit', () => {
  it('should allow first request', () => {
    const key = `test-${Date.now()}-1`;
    const result = checkRateLimit(key, 'api');
    
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RATE_LIMIT_CONFIGS.api.maxRequests - 1);
  });

  it('should decrement remaining count', () => {
    const key = `test-${Date.now()}-2`;
    
    const result1 = checkRateLimit(key, 'api');
    const result2 = checkRateLimit(key, 'api');
    const result3 = checkRateLimit(key, 'api');
    
    expect(result1.remaining).toBe(RATE_LIMIT_CONFIGS.api.maxRequests - 1);
    expect(result2.remaining).toBe(RATE_LIMIT_CONFIGS.api.maxRequests - 2);
    expect(result3.remaining).toBe(RATE_LIMIT_CONFIGS.api.maxRequests - 3);
  });

  it('should block when limit exceeded', () => {
    const key = `test-${Date.now()}-3`;
    const maxRequests = RATE_LIMIT_CONFIGS.api.maxRequests;
    
    // Make max requests
    for (let i = 0; i < maxRequests; i++) {
      checkRateLimit(key, 'api');
    }
    
    // Next request should be blocked
    const result = checkRateLimit(key, 'api');
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it('should reset after window expires', () => {
    const key = `test-${Date.now()}-4`;
    const windowMs = RATE_LIMIT_CONFIGS.api.windowMs;
    
    // Make max requests
    for (let i = 0; i < RATE_LIMIT_CONFIGS.api.maxRequests; i++) {
      checkRateLimit(key, 'api');
    }
    
    // Should be blocked
    expect(checkRateLimit(key, 'api').allowed).toBe(false);
    
    // Advance time past window
    vi.advanceTimersByTime(windowMs + 1);
    
    // Should be allowed again
    const result = checkRateLimit(key, 'api');
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(RATE_LIMIT_CONFIGS.api.maxRequests - 1);
  });

  it('should use correct config for different types', () => {
    const key1 = `test-${Date.now()}-5`;
    const key2 = `test-${Date.now()}-6`;
    
    const apiResult = checkRateLimit(key1, 'api');
    const chatResult = checkRateLimit(key2, 'chat');
    
    expect(apiResult.remaining).toBe(RATE_LIMIT_CONFIGS.api.maxRequests - 1);
    expect(chatResult.remaining).toBe(RATE_LIMIT_CONFIGS.chat.maxRequests - 1);
  });

  it('should track different keys separately', () => {
    const key1 = `test-${Date.now()}-7`;
    const key2 = `test-${Date.now()}-8`;
    
    // Make requests on key1
    checkRateLimit(key1, 'api');
    checkRateLimit(key1, 'api');
    
    // key2 should have full quota
    const result = checkRateLimit(key2, 'api');
    expect(result.remaining).toBe(RATE_LIMIT_CONFIGS.api.maxRequests - 1);
  });

  it('should return correct resetIn time', () => {
    const key = `test-${Date.now()}-9`;
    const windowMs = RATE_LIMIT_CONFIGS.api.windowMs;
    
    const result = checkRateLimit(key, 'api');
    expect(result.resetIn).toBe(windowMs);
    
    // Advance time
    vi.advanceTimersByTime(1000);
    
    const result2 = checkRateLimit(key, 'api');
    expect(result2.resetIn).toBeLessThan(windowMs);
  });
});

// --------------------------------------------
// checkTelegramRateLimit Tests
// --------------------------------------------

describe('checkTelegramRateLimit', () => {
  it('should allow first message', () => {
    const userId = `tg-${Date.now()}-1`;
    const result = checkTelegramRateLimit(userId);
    
    expect(result.allowed).toBe(true);
    expect(result.message).toBeUndefined();
  });

  it('should block when limit exceeded', () => {
    const userId = `tg-${Date.now()}-2`;
    const maxRequests = RATE_LIMIT_CONFIGS.telegram.maxRequests;
    
    // Make max requests
    for (let i = 0; i < maxRequests; i++) {
      checkTelegramRateLimit(userId);
    }
    
    // Next should be blocked
    const result = checkTelegramRateLimit(userId);
    expect(result.allowed).toBe(false);
    expect(result.message).toBeDefined();
    expect(result.message).toContain('Слишком много сообщений');
  });

  it('should accept numeric user ID', () => {
    const result = checkTelegramRateLimit(12345);
    expect(result.allowed).toBe(true);
  });
});

// --------------------------------------------
// getRateLimitStats Tests
// --------------------------------------------

describe('getRateLimitStats', () => {
  it('should return stats object', () => {
    const stats = getRateLimitStats();
    
    expect(stats).toHaveProperty('totalEntries');
    expect(stats).toHaveProperty('byType');
    expect(stats.byType).toHaveProperty('api');
    expect(stats.byType).toHaveProperty('chat');
    expect(stats.byType).toHaveProperty('telegram');
    expect(stats.byType).toHaveProperty('admin');
  });

  it('should count entries correctly', () => {
    // Make some requests
    const apiKey = `stats-${Date.now()}-api`;
    const chatKey = `stats-${Date.now()}-chat`;
    
    checkRateLimit(apiKey, 'api');
    checkRateLimit(chatKey, 'chat');
    
    const stats = getRateLimitStats();
    expect(stats.totalEntries).toBeGreaterThanOrEqual(2);
  });
});

// --------------------------------------------
// RATE_LIMIT_CONFIGS Tests
// --------------------------------------------

describe('RATE_LIMIT_CONFIGS', () => {
  it('should have all required types', () => {
    expect(RATE_LIMIT_CONFIGS).toHaveProperty('api');
    expect(RATE_LIMIT_CONFIGS).toHaveProperty('chat');
    expect(RATE_LIMIT_CONFIGS).toHaveProperty('telegram');
    expect(RATE_LIMIT_CONFIGS).toHaveProperty('admin');
  });

  it('should have valid config values', () => {
    for (const [type, config] of Object.entries(RATE_LIMIT_CONFIGS)) {
      expect(config.windowMs).toBeGreaterThan(0);
      expect(config.maxRequests).toBeGreaterThan(0);
    }
  });

  it('chat should be more restrictive than api', () => {
    expect(RATE_LIMIT_CONFIGS.chat.maxRequests).toBeLessThanOrEqual(
      RATE_LIMIT_CONFIGS.api.maxRequests
    );
  });

  it('admin should be less restrictive', () => {
    expect(RATE_LIMIT_CONFIGS.admin.maxRequests).toBeGreaterThanOrEqual(
      RATE_LIMIT_CONFIGS.api.maxRequests
    );
  });
});
