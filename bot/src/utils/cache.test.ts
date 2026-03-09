import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TTLCache, SingleCache } from './cache.js';

describe('TTLCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should store and retrieve values', () => {
    const cache = new TTLCache<string>(60_000);
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');
  });

  it('should return null for missing keys', () => {
    const cache = new TTLCache<string>(60_000);
    expect(cache.get('nonexistent')).toBeNull();
  });

  it('should expire values after TTL', () => {
    const cache = new TTLCache<string>(5000);
    cache.set('key1', 'value1');
    expect(cache.get('key1')).toBe('value1');

    vi.advanceTimersByTime(5001);
    expect(cache.get('key1')).toBeNull();
  });

  it('should support default key', () => {
    const cache = new TTLCache<number>(60_000);
    cache.set(42);
    expect(cache.get()).toBe(42);
  });

  it('should track size', () => {
    const cache = new TTLCache<string>(60_000);
    expect(cache.size).toBe(0);
    cache.set('a', '1');
    cache.set('b', '2');
    expect(cache.size).toBe(2);
  });

  it('should delete specific keys', () => {
    const cache = new TTLCache<string>(60_000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.delete('a');
    expect(cache.get('a')).toBeNull();
    expect(cache.get('b')).toBe('2');
  });

  it('should clear all entries', () => {
    const cache = new TTLCache<string>(60_000);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('should report age in seconds', () => {
    const cache = new TTLCache<string>(60_000);
    cache.set('key', 'val');
    expect(cache.age('key')).toBe(0);

    vi.advanceTimersByTime(10_000);
    expect(cache.age('key')).toBe(10);
  });

  it('should report -1 age for missing keys', () => {
    const cache = new TTLCache<string>(60_000);
    expect(cache.age('missing')).toBe(-1);
  });

  it('has() should return true for fresh values', () => {
    const cache = new TTLCache<string>(60_000);
    cache.set('key', 'val');
    expect(cache.has('key')).toBe(true);
  });

  it('has() should return false for expired values', () => {
    const cache = new TTLCache<string>(1000);
    cache.set('key', 'val');
    vi.advanceTimersByTime(1001);
    expect(cache.has('key')).toBe(false);
  });
});

describe('SingleCache', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should store and retrieve a value', () => {
    const cache = new SingleCache<string>(60_000);
    cache.set('hello');
    expect(cache.get()).toBe('hello');
  });

  it('should return null when empty', () => {
    const cache = new SingleCache<string>(60_000);
    expect(cache.get()).toBeNull();
  });

  it('should expire after TTL', () => {
    const cache = new SingleCache<string>(5000);
    cache.set('value');
    expect(cache.get()).toBe('value');

    vi.advanceTimersByTime(5001);
    expect(cache.get()).toBeNull();
  });

  it('should clear on demand', () => {
    const cache = new SingleCache<string>(60_000);
    cache.set('value');
    cache.clear();
    expect(cache.get()).toBeNull();
  });

  it('should track age', () => {
    const cache = new SingleCache<number>(60_000);
    cache.set(42);
    expect(cache.age()).toBe(0);

    vi.advanceTimersByTime(15_000);
    expect(cache.age()).toBe(15);
  });

  it('should report -1 age when empty', () => {
    const cache = new SingleCache<string>(60_000);
    expect(cache.age()).toBe(-1);
  });

  it('should overwrite previous value', () => {
    const cache = new SingleCache<string>(60_000);
    cache.set('first');
    cache.set('second');
    expect(cache.get()).toBe('second');
  });

  it('should handle boolean false correctly', () => {
    const cache = new SingleCache<boolean>(60_000);
    cache.set(false);
    expect(cache.get()).toBe(false);
  });

  it('should handle zero correctly', () => {
    const cache = new SingleCache<number>(60_000);
    cache.set(0);
    expect(cache.get()).toBe(0);
  });
});
