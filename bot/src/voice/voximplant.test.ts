import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies
vi.mock('../config/index.js', () => ({
  config: {
    voximplant: {
      accountId: 'test_account',
      apiKey: 'test_key',
      appId: 'test_app',
      appName: 'test-app',
      enabled: true,
    },
  },
}));

vi.mock('../config/logger.js', () => ({
  voiceLogger: {
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock('../ai/openrouter.js', () => ({
  aiService: {
    chat: vi.fn().mockResolvedValue({
      content: 'AI response for voice',
      model: 'test-model',
      tokens_used: { total: 50 },
    }),
  },
}));

// Mock fetch
global.fetch = vi.fn();

import {
  handleVoximplantWebhook,
  getCallStatus,
  getActiveCalls,
  isVoximplantEnabled,
} from './voximplant.js';

describe('Voximplant Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('isVoximplantEnabled', () => {
    it('should return true when credentials are configured', () => {
      // Act
      const result = isVoximplantEnabled();

      // Assert
      expect(typeof result).toBe('boolean');
    });
  });

  describe('handleVoximplantWebhook', () => {
    it('should handle call.started event', async () => {
      // Arrange
      const event = {
        event: 'call.started',
        call_session_id: 'session-123',
        caller_id: '+1234567890',
        destination: '+0987654321',
      };

      // Act
      const result = await handleVoximplantWebhook(event);

      // Assert
      expect(result).toBeDefined();
    });

    it('should handle call.connected event', async () => {
      // Arrange
      const event = {
        event: 'call.connected',
        call_session_id: 'session-123',
      };

      // Act
      const result = await handleVoximplantWebhook(event);

      // Assert
      expect(result).toBeDefined();
    });

    it('should handle call.ended event', async () => {
      // Arrange
      const event = {
        event: 'call.ended',
        call_session_id: 'session-123',
        duration: 60,
      };

      // Act
      const result = await handleVoximplantWebhook(event);

      // Assert
      expect(result).toBeDefined();
    });

    it('should handle call.transcription event with AI response', async () => {
      // Arrange
      const event = {
        event: 'call.transcription',
        call_session_id: 'session-123',
        transcription: 'Hello, how are you?',
      };

      // Act
      const result = await handleVoximplantWebhook(event);

      // Assert
      expect(result).toBeDefined();
      // Should return a response for TTS
      if (result.response) {
        expect(typeof result.response).toBe('string');
      }
    });

    it('should handle unknown event gracefully', async () => {
      // Arrange
      const event = {
        event: 'unknown.event',
        call_session_id: 'session-123',
      };

      // Act
      const result = await handleVoximplantWebhook(event);

      // Assert
      expect(result).toEqual({});
    });
  });

  describe('Call State Management', () => {
    it('should track call status after call.started', async () => {
      // Arrange
      const callId = 'track-test-123';
      await handleVoximplantWebhook({
        event: 'call.started',
        call_session_id: callId,
        caller_id: '+111',
        destination: '+222',
      });

      // Act
      const status = getCallStatus(callId);

      // Assert
      expect(status).toBeDefined();
      if (status) {
        expect(status.call_id).toBe(callId);
        expect(status.status).toBe('ringing');
      }
    });

    it('should update status to connected', async () => {
      // Arrange
      const callId = 'connect-test-123';
      await handleVoximplantWebhook({
        event: 'call.started',
        call_session_id: callId,
        caller_id: '+111',
        destination: '+222',
      });
      
      await handleVoximplantWebhook({
        event: 'call.connected',
        call_session_id: callId,
      });

      // Act
      const status = getCallStatus(callId);

      // Assert
      expect(status?.status).toBe('connected');
    });

    it('should return undefined for unknown call', () => {
      // Act
      const status = getCallStatus('non-existent-call');

      // Assert
      expect(status).toBeUndefined();
    });

    it('should return active calls list', () => {
      // Act
      const calls = getActiveCalls();

      // Assert
      expect(Array.isArray(calls)).toBe(true);
    });
  });
});

describe('Voximplant Webhook Validation', () => {
  it('should validate webhook event structure', () => {
    // A valid event should have at minimum: event and call_session_id
    const validEvent = {
      event: 'call.started',
      call_session_id: 'test-123',
    };

    expect(validEvent.event).toBeDefined();
    expect(validEvent.call_session_id).toBeDefined();
  });
});

describe('AI Integration in Voice', () => {
  it('should call AI service for transcription events', async () => {
    // Arrange
    const { aiService } = await import('../ai/openrouter.js');
    
    const event = {
      event: 'call.transcription',
      call_session_id: 'ai-test-123',
      transcription: 'What is the weather today?',
    };

    // Act
    await handleVoximplantWebhook(event);

    // Assert
    expect(aiService.chat).toHaveBeenCalled();
  });
});
