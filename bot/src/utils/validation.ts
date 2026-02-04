/**
 * Input validation utilities
 */

import { z } from 'zod';

// Maximum message length (Telegram limit is 4096, AI models typically accept 10k-100k)
export const MAX_MESSAGE_LENGTH = 10000;

// Maximum conversation history size (prevent memory issues)
export const MAX_CONVERSATION_MESSAGES = 1000;

// User ID validation (Telegram IDs are numeric strings)
export const userIdSchema = z.string().regex(/^\d+$/).or(z.literal('unknown'));

// Message content validation
export const messageContentSchema = z.string().min(1).max(MAX_MESSAGE_LENGTH);

// Channel validation
export const channelSchema = z.enum(['telegram', 'voice', 'all']);

// Event type validation
export const eventTypeSchema = z.enum([
  'message_received',
  'message_sent',
  'ai_request',
  'ai_response',
  'error',
  'call_started',
  'call_ended',
]);

/**
 * Validate and sanitize user ID
 */
export function validateUserId(userId: string): string {
  const result = userIdSchema.safeParse(userId);
  if (!result.success) {
    throw new Error(`Invalid user ID: ${userId}`);
  }
  return result.data;
}

/**
 * Validate and sanitize message content
 */
export function validateMessageContent(content: string): string {
  const result = messageContentSchema.safeParse(content);
  if (!result.success) {
    if (content.length > MAX_MESSAGE_LENGTH) {
      throw new Error(`Message too long (max ${MAX_MESSAGE_LENGTH} characters)`);
    }
    throw new Error('Invalid message content');
  }
  return result.data;
}

/**
 * Validate channel
 */
export function validateChannel(channel: string): 'telegram' | 'voice' | 'all' {
  const result = channelSchema.safeParse(channel);
  if (!result.success) {
    throw new Error(`Invalid channel: ${channel}`);
  }
  return result.data;
}

/**
 * Validate event type
 */
export function validateEventType(eventType: string): z.infer<typeof eventTypeSchema> {
  const result = eventTypeSchema.safeParse(eventType);
  if (!result.success) {
    throw new Error(`Invalid event type: ${eventType}`);
  }
  return result.data;
}

/**
 * Validate limit parameter
 */
export function validateLimit(limit: number, min = 1, max = 1000): number {
  if (limit < min || limit > max) {
    throw new Error(`Limit must be between ${min} and ${max}`);
  }
  return limit;
}

/**
 * Check if array size is within limits
 */
export function checkArraySize<T>(array: T[], maxSize: number, errorMsg: string): void {
  if (array.length > maxSize) {
    throw new Error(errorMsg);
  }
}
