/**
 * Error handling utilities
 */

import { PostgrestError } from '@supabase/supabase-js';
import { dbLogger, aiLogger } from '../config/logger.js';

/**
 * Custom error types
 */

/** Base error with typed `code` field — replaces all `(error as any).code` patterns */
export class AppError extends Error {
  public readonly code: string;
  constructor(code: string, message: string, public readonly originalError?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class DatabaseError extends Error {
  constructor(message: string, public originalError?: unknown) {
    super(message);
    this.name = 'DatabaseError';
  }
}

export class AIError extends Error {
  constructor(message: string, public originalError?: unknown) {
    super(message);
    this.name = 'AIError';
  }
}

/** Type guard to check if an error has a `code` property */
export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/** Extract error code from unknown error safely */
export function getErrorCode(error: unknown): string | undefined {
  if (error instanceof AppError) return error.code;
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String((error as { code: unknown }).code);
  }
  return undefined;
}

/**
 * Check if error is "Not Found"
 */
export function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'PGRST116'
  );
}

/**
 * Handle legacy query errors
 */
export function handleLegacyDbError<T>(
  data: T | null,
  error: PostgrestError | null,
  context: { operation: string; [key: string]: unknown }
): T {
  if (error) {
    // Not found is OK for some operations
    if (isNotFoundError(error)) {
      dbLogger.debug(context, 'Record not found');
      throw new NotFoundError(`${context.operation}: not found`);
    }

    // Log and throw
    dbLogger.error({ error, ...context }, `${context.operation} failed`);
    throw new DatabaseError(`${context.operation} failed: ${error.message}`, error);
  }

  if (data === null) {
    throw new NotFoundError(`${context.operation}: data is null`);
  }

  return data;
}

/**
 * Handle AI errors
 */
export function handleAIError(error: unknown, context: { operation: string }): never {
  aiLogger.error({ error, ...context }, `${context.operation} failed`);

  if (error instanceof Error) {
    throw new AIError(`${context.operation} failed: ${error.message}`, error);
  }

  throw new AIError(`${context.operation} failed`, error);
}

/**
 * Safe JSON stringify (handles circular references)
 */
export function safeStringify(obj: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(obj, (key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  });
}
