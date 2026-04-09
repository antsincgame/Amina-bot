export const TTS_PROVIDERS = [
  { id: 'edge', name: 'Microsoft Edge TTS', description: 'Бесплатно, нейронный голос. Хорошее качество.', badge: 'БЕСПЛАТНО', badgeColor: 'badge-success' },
  { id: 'openai', name: 'OpenAI TTS HD', description: 'Максимально натуральный голос. ~$0.015 за 1000 символов.', badge: 'ПРЕМИУМ', badgeColor: 'text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full text-xs font-medium' },
  { id: 'elevenlabs', name: 'ElevenLabs', description: 'Ультра-реалистичный мультиязычный голос. Лучшее качество для русского языка.', badge: 'ПРЕМИУМ+', badgeColor: 'text-fuchsia-400 bg-fuchsia-500/10 border border-fuchsia-500/20 px-2 py-0.5 rounded-full text-xs font-medium' },
] as const;

export const ELEVENLABS_VOICES = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', description: 'Тёплый женский — идеально для ассистента' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', description: 'Мягкий женский голос' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli', description: 'Молодой женский голос' },
  { id: '29vD33N1CtxCmqQRPOHJ', name: 'Drew', description: 'Уверенный мужской голос' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', description: 'Спокойный мужской голос' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh', description: 'Глубокий мужской голос' },
  { id: 'custom', name: 'Custom Voice', description: 'Свой голос — укажите Voice ID вручную' },
] as const;

export const ELEVENLABS_MODELS = [
  { id: 'eleven_multilingual_v2', name: 'Multilingual V2', description: 'Лучшее качество, русский и 28 языков' },
  { id: 'eleven_turbo_v2_5', name: 'Turbo V2.5', description: 'Быстрее, мультиязычный, дешевле' },
  { id: 'eleven_flash_v2_5', name: 'Flash V2.5', description: 'Самый быстрый, низкая задержка' },
] as const;

export const OPENAI_VOICES = [
  { id: 'nova', name: 'Nova', description: 'Тёплый, дружелюбный — идеально для ассистента' },
  { id: 'alloy', name: 'Alloy', description: 'Нейтральный, сбалансированный' },
  { id: 'shimmer', name: 'Shimmer', description: 'Яркий, оптимистичный' },
  { id: 'echo', name: 'Echo', description: 'Спокойный, глубокий' },
  { id: 'fable', name: 'Fable', description: 'Выразительный, артистичный' },
  { id: 'onyx', name: 'Onyx', description: 'Глубокий, авторитетный' },
] as const;

export const EDGE_VOICES = [
  { id: 'svetlana', name: 'Светлана', description: 'Женский русский голос' },
  { id: 'dmitry', name: 'Дмитрий', description: 'Мужской русский голос' },
] as const;

export const DEFAULT_VISION_PROMPT = 'Опиши подробно что изображено на этой картинке. Обрати внимание на детали, цвета, объекты и их расположение.';
export const DEFAULT_VISION_MAX_TOKENS = 1024;
export const DEFAULT_AUDIO_MODEL = 'groq/whisper-large-v3';
export const DEFAULT_VISION_MODEL = 'google/gemma-3-27b-it:free';

export const AUDIO_MODELS = [
  { id: 'groq/whisper-large-v3', name: 'Groq Whisper Large V3', description: 'Лучшее качество транскрипции' },
  { id: 'groq/whisper-large-v3-turbo', name: 'Groq Whisper Turbo', description: 'Быстрая транскрипция' },
  { id: 'groq/distil-whisper-large-v3-en', name: 'Groq Distil Whisper (EN)', description: 'Для английского языка' },
] as const;

export interface VisionModel {
  id: string;
  name: string;
  description: string;
}

export interface AudioRuntimeState {
  preferredModel: string;
  effectiveModel: string;
  overrideModel: string;
  source: string;
}

export interface ImageModel {
  id: string;
  name: string;
  description: string;
  pricing: {
    input: number;
    output: number;
    perImage: number;
  };
}

export interface ModelTestResult {
  status: 'ok' | 'error';
  latencyMs: number;
  detail?: string;
  error?: string;
}
