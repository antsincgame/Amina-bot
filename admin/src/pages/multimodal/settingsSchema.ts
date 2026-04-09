import { z } from 'zod';
import {
  ELEVENLABS_VOICES,
  DEFAULT_AUDIO_MODEL,
  DEFAULT_VISION_MODEL,
  DEFAULT_VISION_PROMPT,
  DEFAULT_VISION_MAX_TOKENS,
} from './multimodalConstants';

export const settingsSchema = z.object({
  tts_enabled: z.boolean(),
  audio_model: z.string().min(1),
  vision_model: z.string().min(1),
  vision_prompt: z.string().min(10).max(500),
  vision_max_tokens: z.number().min(100).max(4096),
  openrouter_image_model: z.string().optional(),
  tts_provider: z.string(),
  elevenlabs_api_key: z.string().optional(),
  elevenlabs_voice_id: z.string().optional(),
  elevenlabs_custom_voice_id: z.string().optional(),
  elevenlabs_model_id: z.string().optional(),
  openai_tts_voice: z.string(),
  openai_tts_model: z.string(),
  voice_speaker: z.string(),
  openai_api_key: z.string().optional(),
});

export type SettingsForm = z.infer<typeof settingsSchema>;

function resolveElevenlabsVoiceId(map: Record<string, string>): string {
  const vid = map['elevenlabs_voice_id'] || '21m00Tcm4TlvDq8ikWAM';
  const knownIds: readonly string[] = ELEVENLABS_VOICES.map(v => v.id);
  return knownIds.includes(vid) ? vid : 'custom';
}

function resolveElevenlabsCustomVoiceId(map: Record<string, string>): string {
  const vid = map['elevenlabs_voice_id'] || '';
  const knownIds: readonly string[] = ELEVENLABS_VOICES.map(v => v.id);
  return knownIds.includes(vid) ? (map['elevenlabs_custom_voice_id'] || '') : vid;
}

export function mapSettingsToFormValues(map: Record<string, string>, includeTtsEnabled = true): SettingsForm {
  return {
    tts_enabled: includeTtsEnabled ? map['tts_enabled'] !== 'false' : true,
    audio_model: map['audio_model'] || DEFAULT_AUDIO_MODEL,
    vision_model: map['preferred_vision_model'] || map['vision_model'] || DEFAULT_VISION_MODEL,
    vision_prompt: map['vision_prompt'] || DEFAULT_VISION_PROMPT,
    vision_max_tokens: parseInt(map['vision_max_tokens'] || String(DEFAULT_VISION_MAX_TOKENS), 10),
    openrouter_image_model: map['openrouter_image_model'] || 'google/gemini-2.5-flash-image',
    tts_provider: map['tts_provider'] || 'edge',
    elevenlabs_api_key: map['elevenlabs_api_key'] || '',
    elevenlabs_voice_id: resolveElevenlabsVoiceId(map),
    elevenlabs_custom_voice_id: resolveElevenlabsCustomVoiceId(map),
    elevenlabs_model_id: map['elevenlabs_model_id'] || 'eleven_multilingual_v2',
    openai_tts_voice: map['openai_tts_voice'] || 'nova',
    openai_tts_model: map['openai_tts_model'] || 'tts-1-hd',
    voice_speaker: map['voice_speaker'] || 'svetlana',
    openai_api_key: map['openai_api_key'] || '',
  };
}
