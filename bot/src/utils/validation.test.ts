/**
 * Tests for validation utilities
 */

import { describe, it, expect } from 'vitest';
import {
  validateUserId,
  validateMessageContent,
  validateChannel,
  validateEventType,
  validateLimit,
  checkArraySize,
  MAX_MESSAGE_LENGTH,
  MAX_CONVERSATION_MESSAGES,
  userIdSchema,
  messageContentSchema,
  channelSchema,
  eventTypeSchema,
} from './validation.js';

// --------------------------------------------
// validateUserId Tests
// --------------------------------------------

describe('validateUserId', () => {
  it('should accept valid numeric user IDs', () => {
    expect(validateUserId('12345')).toBe('12345');
    expect(validateUserId('1')).toBe('1');
    expect(validateUserId('9999999999')).toBe('9999999999');
  });

  it('should accept "unknown" as valid user ID', () => {
    expect(validateUserId('unknown')).toBe('unknown');
  });

  it('should throw for empty string', () => {
    expect(() => validateUserId('')).toThrow();
  });

  it('should throw for non-numeric strings', () => {
    expect(() => validateUserId('abc')).toThrow();
    expect(() => validateUserId('123abc')).toThrow();
    expect(() => validateUserId('user_123')).toThrow();
  });

  it('should throw for negative numbers', () => {
    expect(() => validateUserId('-123')).toThrow();
  });

  it('should throw for decimal numbers', () => {
    expect(() => validateUserId('123.45')).toThrow();
  });

  it('should throw for special characters', () => {
    expect(() => validateUserId('12@34')).toThrow();
    expect(() => validateUserId('12 34')).toThrow();
  });
});

// --------------------------------------------
// validateMessageContent Tests
// --------------------------------------------

describe('validateMessageContent', () => {
  it('should accept valid messages', () => {
    expect(validateMessageContent('Hello')).toBe('Hello');
    expect(validateMessageContent('Привет мир!')).toBe('Привет мир!');
    expect(validateMessageContent('a'.repeat(100))).toBe('a'.repeat(100));
  });

  it('should accept messages at max length', () => {
    const maxMessage = 'a'.repeat(MAX_MESSAGE_LENGTH);
    expect(validateMessageContent(maxMessage)).toBe(maxMessage);
  });

  it('should throw for empty message', () => {
    expect(() => validateMessageContent('')).toThrow();
  });

  it('should accept whitespace-only message (schema allows min 1 char)', () => {
    // The schema only checks min length 1, not content
    expect(validateMessageContent('   ')).toBe('   ');
    expect(validateMessageContent('\n\t')).toBe('\n\t');
  });

  it('should throw for message exceeding max length', () => {
    const tooLong = 'a'.repeat(MAX_MESSAGE_LENGTH + 1);
    expect(() => validateMessageContent(tooLong)).toThrow();
  });

  it('should preserve whitespace in valid messages', () => {
    // The function doesn't trim - it validates
    expect(validateMessageContent('  Hello  ')).toBe('  Hello  ');
    expect(validateMessageContent('\nHello\n')).toBe('\nHello\n');
  });

  it('should handle unicode characters', () => {
    expect(validateMessageContent('🎉 Emoji test')).toBe('🎉 Emoji test');
    expect(validateMessageContent('日本語テスト')).toBe('日本語テスト');
  });
});

// --------------------------------------------
// validateChannel Tests
// --------------------------------------------

describe('validateChannel', () => {
  it('should accept valid channels', () => {
    expect(validateChannel('telegram')).toBe('telegram');
    expect(validateChannel('voice')).toBe('voice');
    expect(validateChannel('all')).toBe('all');
  });

  it('should throw for invalid channels', () => {
    expect(() => validateChannel('invalid')).toThrow();
    expect(() => validateChannel('TELEGRAM')).toThrow(); // Case sensitive
    expect(() => validateChannel('')).toThrow();
    expect(() => validateChannel('admin')).toThrow();
  });
});

// --------------------------------------------
// validateEventType Tests
// --------------------------------------------

describe('validateEventType', () => {
  it('should accept valid event types', () => {
    // All types from eventTypeSchema in validation.ts
    expect(validateEventType('message_sent')).toBe('message_sent');
    expect(validateEventType('message_received')).toBe('message_received');
    expect(validateEventType('call_started')).toBe('call_started');
    expect(validateEventType('call_ended')).toBe('call_ended');
    expect(validateEventType('ai_request')).toBe('ai_request');
    expect(validateEventType('ai_response')).toBe('ai_response');
    expect(validateEventType('error')).toBe('error');
  });

  it('should throw for invalid event types', () => {
    expect(() => validateEventType('invalid')).toThrow();
    expect(() => validateEventType('MESSAGE_SENT')).toThrow();
    expect(() => validateEventType('')).toThrow();
    expect(() => validateEventType('custom_event')).toThrow();
  });
});

// --------------------------------------------
// validateLimit Tests
// --------------------------------------------

describe('validateLimit', () => {
  it('should accept valid limits within default range', () => {
    expect(validateLimit(1)).toBe(1);
    expect(validateLimit(100)).toBe(100);
    expect(validateLimit(1000)).toBe(1000);
  });

  it('should throw for values below minimum', () => {
    expect(() => validateLimit(0)).toThrow();
    expect(() => validateLimit(-5)).toThrow();
    expect(() => validateLimit(-100)).toThrow();
  });

  it('should throw for values above maximum', () => {
    expect(() => validateLimit(1001)).toThrow();
    expect(() => validateLimit(9999)).toThrow();
  });

  it('should respect custom min/max', () => {
    expect(() => validateLimit(5, 10, 100)).toThrow(); // Below min
    expect(() => validateLimit(150, 10, 100)).toThrow(); // Above max
    expect(validateLimit(50, 10, 100)).toBe(50); // Valid
  });

  it('should handle edge cases', () => {
    expect(validateLimit(1, 1, 1)).toBe(1);
    expect(validateLimit(0, 0, 10)).toBe(0);
  });

  it('should accept floating point numbers within range', () => {
    expect(validateLimit(5.5)).toBe(5.5);
    expect(validateLimit(5.9)).toBe(5.9);
  });
});

// --------------------------------------------
// checkArraySize Tests
// --------------------------------------------

describe('checkArraySize', () => {
  it('should not throw for arrays within limit', () => {
    expect(() => checkArraySize([1, 2, 3], 5, 'Error')).not.toThrow();
    expect(() => checkArraySize([1, 2, 3, 4, 5], 5, 'Error')).not.toThrow();
    expect(() => checkArraySize([], 5, 'Error')).not.toThrow();
  });

  it('should throw for arrays exceeding limit', () => {
    expect(() => checkArraySize([1, 2, 3, 4, 5, 6], 5, 'Too many items')).toThrow('Too many items');
    expect(() => checkArraySize([1], 0, 'No items allowed')).toThrow('No items allowed');
  });

  it('should use custom error message', () => {
    const customMessage = 'Custom error: array too large';
    expect(() => checkArraySize([1, 2, 3], 2, customMessage)).toThrow(customMessage);
  });

  it('should work with different array types', () => {
    expect(() => checkArraySize(['a', 'b', 'c'], 3, 'Error')).not.toThrow();
    expect(() => checkArraySize([{ id: 1 }, { id: 2 }], 2, 'Error')).not.toThrow();
    expect(() => checkArraySize([null, undefined], 2, 'Error')).not.toThrow();
  });
});

// --------------------------------------------
// Zod Schema Tests
// --------------------------------------------

describe('Zod Schemas', () => {
  describe('userIdSchema', () => {
    it('should validate correct user IDs', () => {
      expect(userIdSchema.safeParse('12345').success).toBe(true);
      expect(userIdSchema.safeParse('unknown').success).toBe(true);
    });

    it('should reject invalid user IDs', () => {
      expect(userIdSchema.safeParse('abc').success).toBe(false);
      expect(userIdSchema.safeParse('').success).toBe(false);
    });
  });

  describe('messageContentSchema', () => {
    it('should validate correct messages', () => {
      expect(messageContentSchema.safeParse('Hello').success).toBe(true);
    });

    it('should reject invalid messages', () => {
      expect(messageContentSchema.safeParse('').success).toBe(false);
      expect(messageContentSchema.safeParse('a'.repeat(MAX_MESSAGE_LENGTH + 1)).success).toBe(false);
    });
  });

  describe('channelSchema', () => {
    it('should validate correct channels', () => {
      expect(channelSchema.safeParse('telegram').success).toBe(true);
      expect(channelSchema.safeParse('voice').success).toBe(true);
      expect(channelSchema.safeParse('all').success).toBe(true);
    });

    it('should reject invalid channels', () => {
      expect(channelSchema.safeParse('invalid').success).toBe(false);
    });
  });

  describe('eventTypeSchema', () => {
    it('should validate correct event types', () => {
      expect(eventTypeSchema.safeParse('message_sent').success).toBe(true);
      expect(eventTypeSchema.safeParse('call_started').success).toBe(true);
      expect(eventTypeSchema.safeParse('error').success).toBe(true);
      expect(eventTypeSchema.safeParse('ai_response').success).toBe(true);
    });

    it('should reject invalid event types', () => {
      expect(eventTypeSchema.safeParse('invalid').success).toBe(false);
      expect(eventTypeSchema.safeParse('settings_updated').success).toBe(false);
    });
  });
});

// --------------------------------------------
// Constants Tests
// --------------------------------------------

describe('Constants', () => {
  it('should have reasonable MAX_MESSAGE_LENGTH', () => {
    expect(MAX_MESSAGE_LENGTH).toBeGreaterThan(0);
    expect(MAX_MESSAGE_LENGTH).toBeLessThanOrEqual(100000);
  });

  it('should have reasonable MAX_CONVERSATION_MESSAGES', () => {
    expect(MAX_CONVERSATION_MESSAGES).toBeGreaterThan(0);
    expect(MAX_CONVERSATION_MESSAGES).toBeLessThanOrEqual(10000);
  });
});
