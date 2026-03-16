/**
 * Tests for error handling utilities
 */

import { describe, it, expect } from 'vitest';
import {
  NotFoundError,
  ValidationError,
  DatabaseError,
  AIError,
  AppError,
  isAppError,
  getErrorCode,
  isNotFoundError,
  safeStringify,
} from './error-handler.js';

// --------------------------------------------
// Custom Error Classes Tests
// --------------------------------------------

describe('NotFoundError', () => {
  it('should create error with correct name and message', () => {
    const error = new NotFoundError('User not found');
    expect(error.name).toBe('NotFoundError');
    expect(error.message).toBe('User not found');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof NotFoundError).toBe(true);
  });

  it('should have correct prototype chain', () => {
    const error = new NotFoundError('Test');
    expect(Object.getPrototypeOf(error)).toBe(NotFoundError.prototype);
  });
});

describe('ValidationError', () => {
  it('should create error with correct name and message', () => {
    const error = new ValidationError('Invalid input');
    expect(error.name).toBe('ValidationError');
    expect(error.message).toBe('Invalid input');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof ValidationError).toBe(true);
  });
});

describe('DatabaseError', () => {
  it('should create error with correct name and message', () => {
    const error = new DatabaseError('Connection failed');
    expect(error.name).toBe('DatabaseError');
    expect(error.message).toBe('Connection failed');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof DatabaseError).toBe(true);
  });
});

describe('AIError', () => {
  it('should create error with correct name and message', () => {
    const error = new AIError('API rate limited');
    expect(error.name).toBe('AIError');
    expect(error.message).toBe('API rate limited');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof AIError).toBe(true);
  });
});

// --------------------------------------------
// isNotFoundError Tests
// --------------------------------------------

describe('isNotFoundError', () => {
  it('should return false for NotFoundError instance', () => {
    const error = new NotFoundError('Not found');
    expect(isNotFoundError(error)).toBe(false);
  });

  it('should return true for Appwrite not found codes', () => {
    expect(isNotFoundError({ code: 'document_not_found', message: 'Document not found' })).toBe(true);
    expect(isNotFoundError({ code: 'storage_file_not_found', message: 'File not found' })).toBe(true);
  });

  it('should return false for other errors', () => {
    expect(isNotFoundError(new Error('Generic error'))).toBe(false);
    expect(isNotFoundError(new ValidationError('Invalid'))).toBe(false);
    expect(isNotFoundError(new DatabaseError('DB error'))).toBe(false);
    expect(isNotFoundError({ code: 'OTHER', message: 'Other error' })).toBe(false);
  });

  it('should return false for null/undefined', () => {
    expect(isNotFoundError(null)).toBe(false);
    expect(isNotFoundError(undefined)).toBe(false);
  });

  it('should return false for non-error objects', () => {
    expect(isNotFoundError('string')).toBe(false);
    expect(isNotFoundError(123)).toBe(false);
    expect(isNotFoundError({})).toBe(false);
  });
});

// --------------------------------------------
// safeStringify Tests
// --------------------------------------------

describe('safeStringify', () => {
  it('should stringify simple objects', () => {
    const obj = { name: 'Test', value: 123 };
    const result = safeStringify(obj);
    expect(JSON.parse(result)).toEqual(obj);
  });

  it('should stringify arrays', () => {
    const arr = [1, 2, 3, 'test'];
    const result = safeStringify(arr);
    expect(JSON.parse(result)).toEqual(arr);
  });

  it('should stringify primitives', () => {
    expect(safeStringify('string')).toBe('"string"');
    expect(safeStringify(123)).toBe('123');
    expect(safeStringify(true)).toBe('true');
    expect(safeStringify(null)).toBe('null');
  });

  it('should handle circular references', () => {
    const obj: any = { name: 'Test' };
    obj.self = obj; // Circular reference
    
    const result = safeStringify(obj);
    expect(result).toContain('[Circular]');
  });

  it('should handle nested circular references', () => {
    const obj: any = { a: { b: {} } };
    obj.a.b.c = obj.a; // Nested circular
    
    const result = safeStringify(obj);
    expect(result).toContain('[Circular]');
  });

  it('should handle undefined values', () => {
    const obj = { a: undefined, b: 'test' };
    const result = safeStringify(obj);
    // undefined is omitted in JSON
    expect(JSON.parse(result)).toEqual({ b: 'test' });
  });

  it('should handle functions', () => {
    const obj = { fn: () => {}, name: 'test' };
    const result = safeStringify(obj);
    // Functions are omitted in JSON
    expect(JSON.parse(result)).toEqual({ name: 'test' });
  });

  it('should handle Date objects', () => {
    const date = new Date('2024-01-01T00:00:00Z');
    const obj = { date };
    const result = safeStringify(obj);
    expect(result).toContain('2024-01-01');
  });

  it('should handle Error objects', () => {
    const error = new Error('Test error');
    const result = safeStringify(error);
    // Error objects are stringified as empty objects by default
    expect(result).toBeDefined();
  });

  it('should handle deeply nested objects', () => {
    const deep = { a: { b: { c: { d: { e: 'deep' } } } } };
    const result = safeStringify(deep);
    expect(JSON.parse(result)).toEqual(deep);
  });

  it('should handle large arrays', () => {
    const large = Array.from({ length: 1000 }, (_, i) => i);
    const result = safeStringify(large);
    expect(JSON.parse(result)).toEqual(large);
  });

  it('should handle special characters', () => {
    const obj = { text: 'Hello\nWorld\t"Quoted"' };
    const result = safeStringify(obj);
    expect(JSON.parse(result)).toEqual(obj);
  });

  it('should handle unicode', () => {
    const obj = { emoji: '🎉', japanese: '日本語' };
    const result = safeStringify(obj);
    expect(JSON.parse(result)).toEqual(obj);
  });
});

// --------------------------------------------
// Error Inheritance Tests
// --------------------------------------------

describe('Error Inheritance', () => {
  it('all custom errors should be instances of Error', () => {
    expect(new NotFoundError('') instanceof Error).toBe(true);
    expect(new ValidationError('') instanceof Error).toBe(true);
    expect(new DatabaseError('') instanceof Error).toBe(true);
    expect(new AIError('') instanceof Error).toBe(true);
  });

  it('custom errors should have stack traces', () => {
    const error = new NotFoundError('Test');
    expect(error.stack).toBeDefined();
    expect(error.stack).toContain('NotFoundError');
  });

  it('custom errors should be catchable', () => {
    const throwNotFound = () => {
      throw new NotFoundError('Not found');
    };

    expect(throwNotFound).toThrow(NotFoundError);
    expect(throwNotFound).toThrow(Error);
  });

  it('custom errors should be distinguishable', () => {
    const errors = [
      new NotFoundError('1'),
      new ValidationError('2'),
      new DatabaseError('3'),
      new AIError('4'),
    ];

    expect(errors.filter(e => e instanceof NotFoundError)).toHaveLength(1);
    expect(errors.filter(e => e instanceof ValidationError)).toHaveLength(1);
    expect(errors.filter(e => e instanceof DatabaseError)).toHaveLength(1);
    expect(errors.filter(e => e instanceof AIError)).toHaveLength(1);
  });
});

// --------------------------------------------
// AppError Tests (NEW)
// --------------------------------------------

describe('AppError', () => {
  it('should create error with code and message', () => {
    const error = new AppError('AUTH_ERROR', 'Invalid API key');
    expect(error.name).toBe('AppError');
    expect(error.code).toBe('AUTH_ERROR');
    expect(error.message).toBe('Invalid API key');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof AppError).toBe(true);
  });

  it('should store original error', () => {
    const original = new Error('original');
    const error = new AppError('WRAP', 'Wrapped error', original);
    expect(error.originalError).toBe(original);
  });

  it('should have correct prototype chain', () => {
    const error = new AppError('TEST', 'test');
    expect(error instanceof Error).toBe(true);
    expect(error instanceof AppError).toBe(true);
  });
});

describe('isAppError', () => {
  it('should return true for AppError instances', () => {
    expect(isAppError(new AppError('CODE', 'msg'))).toBe(true);
  });

  it('should return false for plain Error', () => {
    expect(isAppError(new Error('test'))).toBe(false);
  });

  it('should return false for non-errors', () => {
    expect(isAppError(null)).toBe(false);
    expect(isAppError(undefined)).toBe(false);
    expect(isAppError('string')).toBe(false);
    expect(isAppError({ code: 'FAKE' })).toBe(false);
  });
});

describe('getErrorCode', () => {
  it('should extract code from AppError', () => {
    expect(getErrorCode(new AppError('AUTH', 'msg'))).toBe('AUTH');
  });

  it('should extract code from object with code property', () => {
    const error = Object.assign(new Error('test'), { code: 'CUSTOM' });
    expect(getErrorCode(error)).toBe('CUSTOM');
  });

  it('should return undefined for plain Error', () => {
    expect(getErrorCode(new Error('test'))).toBeUndefined();
  });

  it('should return undefined for non-objects', () => {
    expect(getErrorCode(null)).toBeUndefined();
    expect(getErrorCode(undefined)).toBeUndefined();
    expect(getErrorCode('string')).toBeUndefined();
    expect(getErrorCode(42)).toBeUndefined();
  });
});
