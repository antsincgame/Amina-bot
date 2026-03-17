import { beforeEach, describe, expect, it, vi } from 'vitest';

const chatMock = vi.fn();
const assembleConversationContextMock = vi.fn();
const upsertArtifactMock = vi.fn();
const recordEventMock = vi.fn();
const appendTurnMock = vi.fn();
const verifyTelephonyReplyMock = vi.fn();

vi.mock('../../../ai/openrouter.js', () => ({
  aiService: {
    chat: chatMock,
  },
}));

vi.mock('../../../ai/llm-verifier.js', () => ({
  verifyTelephonyReply: verifyTelephonyReplyMock,
}));

vi.mock('./conversation-context-assembler.js', () => ({
  assembleConversationContext: assembleConversationContextMock,
}));

vi.mock('../repository/call-artifact-repo.js', () => ({
  callArtifactRepo: {
    upsertForSession: upsertArtifactMock,
  },
}));

vi.mock('../repository/call-event-repo.js', () => ({
  callEventRepo: {
    record: recordEventMock,
  },
}));

vi.mock('../repository/call-turn-repo.js', () => ({
  callTurnRepo: {
    appendForSession: appendTurnMock,
  },
}));

describe('live turn engine', () => {
  beforeEach(() => {
    chatMock.mockReset();
    assembleConversationContextMock.mockReset();
    upsertArtifactMock.mockReset();
    recordEventMock.mockReset();
    appendTurnMock.mockReset();
    verifyTelephonyReplyMock.mockReset();
    verifyTelephonyReplyMock.mockReturnValue({ isSafe: true, reason: null });

    assembleConversationContextMock.mockResolvedValue({
      session: { id: 'session-1' },
      scenario: {
        policy: {
          maxTurns: 4,
        },
      },
      plan: {
        callMode: 'ask_question',
        summary: 'Уточнить подтверждение встречи',
        speechText: null,
        helloText: 'Здравствуйте, вас беспокоит AI-ассистент Амина.',
        askText: 'Подскажите, пожалуйста, вы придёте на подкаст в воскресенье в 15:00?',
        okText: 'Отлично, спасибо.',
        byeText: 'Благодарю, до свидания.',
        successHint: 'Понять, придёт ли собеседник.',
      },
      turns: [],
      messages: [{ role: 'system', content: 'test' }],
    });
    appendTurnMock
      .mockResolvedValueOnce({ id: 'turn-customer', content: 'Да, удобно.' })
      .mockResolvedValueOnce({ id: 'turn-agent', content: 'Отлично, подтверждаю.' });
  });

  it('generates agent reply and stores partial transcript artifact', async () => {
    chatMock.mockResolvedValue({
      content: JSON.stringify({
        replyText: 'Отлично, подтверждаю.',
        shouldEndCall: false,
        shouldFallback: false,
        outcomeLabel: 'успех',
        resultSummary: 'Собеседник подтвердил встречу.',
      }),
    });

    const { generateLiveAgentTurn } = await import('./live-turn-engine.js');
    const result = await generateLiveAgentTurn({
      sessionId: 'session-1',
      transcript: 'Да, удобно.',
      isFinal: true,
      confidence: 0.92,
      latencyMs: 450,
      providerEventId: 'evt-1',
    });

    expect(result.replyText).toBe('Отлично, подтверждаю.');
    expect(upsertArtifactMock).toHaveBeenCalledWith(
      'session-1',
      'transcript_partial',
      expect.objectContaining({
        content: 'Да, удобно.',
      }),
    );
    expect(recordEventMock).toHaveBeenCalledWith(
      'session-1',
      'agent_turn_completed',
      expect.objectContaining({
        outcomeLabel: 'успех',
      }),
      'evt-1',
    );
    expect(appendTurnMock).toHaveBeenCalledTimes(2);
  });

  it('bootstraps the first realtime turn from compiled plan', async () => {
    appendTurnMock.mockReset();
    appendTurnMock.mockResolvedValue({
      id: 'turn-bootstrap',
      content: 'Здравствуйте, вас беспокоит AI-ассистент Амина. Подскажите, пожалуйста, вы придёте на подкаст в воскресенье в 15:00?',
    });

    const { generateLiveAgentTurn } = await import('./live-turn-engine.js');
    const result = await generateLiveAgentTurn({
      sessionId: 'session-1',
      transcript: '',
      bootstrap: true,
      isFinal: true,
      providerEventId: 'evt-bootstrap',
    });

    expect(chatMock).not.toHaveBeenCalled();
    expect(result.replyText).toContain('подкаст в воскресенье в 15:00');
    expect(result.customerTurn).toBeNull();
    expect(recordEventMock).toHaveBeenCalledWith(
      'session-1',
      'agent_turn_completed',
      expect.objectContaining({
        bootstrap: true,
      }),
      'evt-bootstrap',
    );
    expect(upsertArtifactMock).not.toHaveBeenCalledWith(
      'session-1',
      'transcript_partial',
      expect.anything(),
    );
  });

  it('forces graceful end when max turns reached', async () => {
    assembleConversationContextMock.mockResolvedValue({
      session: { id: 'session-1' },
      scenario: {
        policy: {
          maxTurns: 1,
        },
      },
      plan: {
        callMode: 'ask_question',
        summary: 'test',
        speechText: null,
        helloText: 'Здравствуйте',
        askText: 'Удобно?',
        okText: null,
        byeText: null,
        successHint: 'test',
      },
      turns: [{ id: 'agent-1', speaker: 'agent' }],
      messages: [],
    });

    const { generateLiveAgentTurn } = await import('./live-turn-engine.js');
    const result = await generateLiveAgentTurn({
      sessionId: 'session-1',
      transcript: 'Хорошо',
      isFinal: true,
    });

    expect(result.shouldEndCall).toBe(true);
    expect(chatMock).not.toHaveBeenCalled();
    expect(recordEventMock).toHaveBeenCalledWith(
      'session-1',
      'agent_turn_completed',
      expect.objectContaining({
        maxTurnsReached: true,
      }),
    );
  });

  it('propagates safety fallback to realtime bridge orchestration', async () => {
    chatMock.mockResolvedValue({
      content: JSON.stringify({
        replyText: 'Я точно обещаю то, чего нет в контексте.',
        shouldEndCall: true,
        shouldFallback: false,
        outcomeLabel: 'успех',
        resultSummary: '',
      }),
    });
    verifyTelephonyReplyMock.mockReturnValue({
      isSafe: false,
      reason: 'unsupported_claim',
    });

    const { generateLiveAgentTurn } = await import('./live-turn-engine.js');
    const result = await generateLiveAgentTurn({
      sessionId: 'session-1',
      transcript: 'Подскажите итог',
      isFinal: true,
      providerEventId: 'evt-safe',
    });

    expect(result.replyText).toBe('Подождите пожалуйста, уточню информацию.');
    expect(result.shouldFallback).toBe(true);
    expect(result.shouldEndCall).toBe(false);
    expect(result.fallbackReason).toBe('telephony_safety:unsupported_claim');
    expect(recordEventMock).toHaveBeenCalledWith(
      'session-1',
      'agent_turn_completed',
      expect.objectContaining({
        shouldFallback: true,
        fallbackReason: 'telephony_safety:unsupported_claim',
      }),
      'evt-safe',
    );
  });
});
