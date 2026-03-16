import { describe, it, expect, vi, beforeEach } from 'vitest';
import { detectImageEditIntent, extractEditPrompt, classifyImageEditIntentGroq, editImage } from './image-gen.js';

// Mock dependencies
vi.mock('../db/index.js', () => ({
  settingsRepo: {
    get: vi.fn().mockResolvedValue('google/gemini-2.0-flash-exp'),
    getMany: vi.fn().mockResolvedValue({ openrouter_api_key: 'test-key', groq_api_key: 'test-key' }),
  },
}));

vi.mock('../config/index.js', () => ({
  getApiKeys: vi.fn(() => Promise.resolve({ openrouter: 'test-key', groq: 'test-key' })),
  config: {
    ai: { apiKey: 'test-key' },
    groq: { apiKey: 'test-key' },
    server: { logLevel: 'info' },
    isDev: true,
    telegram: { token: 'test-token' },
  },
}));

describe('Image Editing Detection (Regex)', () => {
  it('should detect edit intent in Russian', () => {
    expect(detectImageEditIntent('убери фон')).toBe(true);
    expect(detectImageEditIntent('сделай ярче')).toBe(true);
    expect(detectImageEditIntent('добавь кота')).toBe(true);
    expect(detectImageEditIntent('стилизуй под аниме')).toBe(true);
    expect(detectImageEditIntent('обрежь фото')).toBe(true);
    expect(detectImageEditIntent('замени задний план')).toBe(true);
  });

  it('should detect edit intent in English', () => {
    expect(detectImageEditIntent('remove background')).toBe(true);
    expect(detectImageEditIntent('make it brighter')).toBe(true);
    expect(detectImageEditIntent('crop this image')).toBe(true);
    expect(detectImageEditIntent('style as van gogh')).toBe(true);
  });

  it('should NOT detect non-edit intent', () => {
    expect(detectImageEditIntent('привет')).toBe(false);
    expect(detectImageEditIntent('что на картинке?')).toBe(false);
    expect(detectImageEditIntent('красивое фото')).toBe(false);
    expect(detectImageEditIntent('123')).toBe(false);
  });
});

describe('Edit Prompt Extraction', () => {
  it('should clean up Russian prompts', () => {
    expect(extractEditPrompt('Амина, убери пожалуйста фон на этой картинке')).toBe('убери фон');
    expect(extractEditPrompt('можешь сделать ярче?')).toBe('сделать ярче');
    expect(extractEditPrompt('нужно добавить кота')).toBe('добавить кота');
    expect(extractEditPrompt('хочу стилизовать под аниме')).toBe('стилизовать под аниме');
  });
});

describe('Groq Intent Classification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('should return true when Groq detects edit intent', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"edit": true}' } }]
      }),
    });

    const result = await classifyImageEditIntentGroq('измени это как-нибудь');
    expect(result).toBe(true);
  });

  it('should return false when Groq rejects intent', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: '{"edit": false}' } }]
      }),
    });

    const result = await classifyImageEditIntentGroq('просто текст');
    expect(result).toBe(false);
  });

  it('should handle Groq API errors gracefully', async () => {
    (global.fetch as any).mockRejectedValueOnce(new Error('API Down'));

    const result = await classifyImageEditIntentGroq('убери фон');
    expect(result).toBe(false); // Fallback to false
  });
});

describe('Image Edit E2E (Mocked API)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    global.fetch = vi.fn();
  });

  it('should correctly format request and parse response', async () => {
    const mockBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const mockResponseBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
    
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: `data:image/png;base64,${mockResponseBase64}` } }]
      }),
    });

    const result = await editImage(mockBase64, 'image/png', 'make it red');
    
    expect(result.image).toBeInstanceOf(Buffer);
    expect(result.image.toString('base64')).toBe(mockResponseBase64);
    expect(result.prompt).toBe('make it red');
    
    // Verify request format
    const fetchCall = (global.fetch as any).mock.calls[0];
    const body = JSON.parse(fetchCall[1].body);
    
    expect(body.modalities).toContain('image');
    expect(body.modalities).toContain('text');
    expect(body.messages[0].content[0].type).toBe('text'); // Text should be first
    expect(body.messages[0].content[1].type).toBe('image_url');
  });

  it('should throw error on API failure', async () => {
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal Server Error'),
    });

    await expect(editImage('base64', 'image/jpeg', 'edit')).rejects.toThrow('OpenRouter API error: 500');
  });
});
