import type { UseFormReturn } from 'react-hook-form';
import { Volume2, Key } from 'lucide-react';
import type { SettingsForm } from './settingsSchema';
import {
  TTS_PROVIDERS,
  OPENAI_VOICES,
  EDGE_VOICES,
  ELEVENLABS_VOICES,
  ELEVENLABS_MODELS,
} from './multimodalConstants';

interface RuntimeTruthTts {
  savedProvider: string;
  enabled: boolean;
  enabledSource: string;
  resolvedProvider: string;
  model: string;
  voice: string;
  fallbackReason: string;
}

interface TtsSettingsCardProps {
  form: UseFormReturn<SettingsForm>;
  runtimeTruth: { tts: RuntimeTruthTts } | undefined;
}

export const TtsSettingsCard = ({ form, runtimeTruth }: TtsSettingsCardProps) => {
  const { register, watch, setValue } = form;

  return (
    <div className="card animate-fade-in-up stagger-2">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 bg-gradient-to-br from-emerald-500 to-teal-500 rounded-xl shadow-lg shadow-emerald-500/25">
          <Volume2 className="w-6 h-6 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Озвучка ответов (TTS)</h2>
          <p className="text-sm text-white/50">Текст в речь — голосовые ответы бота</p>
        </div>
      </div>

      {runtimeTruth && (
        <div className="mb-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-wide text-white/40 mb-2">Saved to DB</p>
            <p className="text-sm text-white">{runtimeTruth.tts.savedProvider}</p>
            <p className="text-xs text-white/50 mt-2">
              TTS {runtimeTruth.tts.enabled ? 'включён' : 'выключен'} ({runtimeTruth.tts.enabledSource})
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-wide text-white/40 mb-2">Resolved by runtime</p>
            <p className="text-sm text-white">{runtimeTruth.tts.resolvedProvider}</p>
            <p className="text-xs text-white/50 mt-2 break-all">
              {runtimeTruth.tts.model}
            </p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-wide text-white/40 mb-2">Observed live</p>
            <p className="text-sm text-white break-all">{runtimeTruth.tts.voice}</p>
            <p className="text-xs text-white/50 mt-2">
              {runtimeTruth.tts.fallbackReason || 'Fallback сейчас не активен.'}
            </p>
          </div>
        </div>
      )}

      <div className="mb-6 rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-medium text-white">Master toggle TTS</p>
            <p className="text-sm text-white/60 mt-1">
              Если выключено, `textToSpeech()` и realtime synthesis перестают генерировать аудио во всех runtime-путях.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setValue('tts_enabled', !watch('tts_enabled'), { shouldDirty: true })}
            className={`toggle ${watch('tts_enabled') ? 'toggle-checked' : ''}`}
          >
            <span className={`toggle-dot ${watch('tts_enabled') ? 'toggle-dot-checked' : ''}`} />
          </button>
        </div>
      </div>

      <div className="space-y-3 mb-6">
        <label className="label">Движок озвучки</label>
        {TTS_PROVIDERS.map((provider) => (
          <label key={provider.id} className={`block p-4 rounded-xl border-2 cursor-pointer transition-all ${
            watch('tts_provider') === provider.id
              ? 'border-emerald-500 bg-emerald-500/10' 
              : 'border-white/10 hover:border-white/20 bg-white/5'
          }`}>
            <div className="flex items-start gap-3">
              <input
                type="radio"
                value={provider.id}
                {...register('tts_provider')}
                className="mt-1 accent-emerald-500"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-white">{provider.name}</span>
                  <span className={provider.badgeColor}>{provider.badge}</span>
                </div>
                <p className="text-sm text-white/60 mt-1">{provider.description}</p>
              </div>
            </div>
          </label>
        ))}
      </div>

      {watch('tts_provider') === 'openai' && (
        <OpenaiTtsSection register={register} watch={watch} />
      )}

      {watch('tts_provider') === 'edge' && (
        <EdgeTtsSection register={register} watch={watch} />
      )}

      {watch('tts_provider') === 'elevenlabs' && (
        <ElevenlabsTtsSection register={register} watch={watch} />
      )}
    </div>
  );
};

interface TtsSectionProps {
  register: UseFormReturn<SettingsForm>['register'];
  watch: UseFormReturn<SettingsForm>['watch'];
}

const OpenaiTtsSection = ({ register, watch }: TtsSectionProps) => (
  <div className="border-t border-white/10 pt-6 space-y-4">
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Key className="w-4 h-4 text-amber-400" />
        <label className="label">OpenAI API Key</label>
      </div>
      <input
        type="password"
        {...register('openai_api_key')}
        placeholder="sk-..."
        className="input w-full font-mono text-sm"
      />
      <p className="text-white/40 text-xs mt-1">
        Отдельный ключ от{' '}
        <a href="https://platform.openai.com/api-keys" target="_blank" rel="noopener noreferrer" className="text-emerald-400 hover:underline">
          platform.openai.com
        </a>
        {' '}(не OpenRouter)
      </p>
    </div>

    <div>
      <label className="label mb-2">Модель</label>
      <div className="flex gap-3">
        <label className={`flex-1 p-3 rounded-xl border-2 cursor-pointer text-center transition-all ${
          watch('openai_tts_model') === 'tts-1-hd'
            ? 'border-emerald-500 bg-emerald-500/10'
            : 'border-white/10 hover:border-white/20 bg-white/5'
        }`}>
          <input type="radio" value="tts-1-hd" {...register('openai_tts_model')} className="sr-only" />
          <span className="font-medium text-white text-sm">TTS-1-HD</span>
          <p className="text-xs text-white/50 mt-1">Максимальное качество</p>
        </label>
        <label className={`flex-1 p-3 rounded-xl border-2 cursor-pointer text-center transition-all ${
          watch('openai_tts_model') === 'tts-1'
            ? 'border-emerald-500 bg-emerald-500/10'
            : 'border-white/10 hover:border-white/20 bg-white/5'
        }`}>
          <input type="radio" value="tts-1" {...register('openai_tts_model')} className="sr-only" />
          <span className="font-medium text-white text-sm">TTS-1</span>
          <p className="text-xs text-white/50 mt-1">Быстрее, дешевле</p>
        </label>
      </div>
    </div>

    <div>
      <label className="label mb-2">Голос</label>
      <div className="grid grid-cols-2 gap-2">
        {OPENAI_VOICES.map((voice) => (
          <label key={voice.id} className={`p-3 rounded-xl border-2 cursor-pointer transition-all ${
            watch('openai_tts_voice') === voice.id
              ? 'border-emerald-500 bg-emerald-500/10'
              : 'border-white/10 hover:border-white/20 bg-white/5'
          }`}>
            <div className="flex items-start gap-2">
              <input type="radio" value={voice.id} {...register('openai_tts_voice')} className="mt-0.5 accent-emerald-500" />
              <div>
                <span className="font-medium text-white text-sm">{voice.name}</span>
                <p className="text-xs text-white/50">{voice.description}</p>
              </div>
            </div>
          </label>
        ))}
      </div>
    </div>
  </div>
);

const EdgeTtsSection = ({ register, watch }: TtsSectionProps) => (
  <div className="border-t border-white/10 pt-6">
    <label className="label mb-2">Голос Edge TTS</label>
    <div className="space-y-2">
      {EDGE_VOICES.map((voice) => (
        <label key={voice.id} className={`block p-3 rounded-xl border-2 cursor-pointer transition-all ${
          watch('voice_speaker') === voice.id
            ? 'border-emerald-500 bg-emerald-500/10'
            : 'border-white/10 hover:border-white/20 bg-white/5'
        }`}>
          <div className="flex items-center gap-3">
            <input type="radio" value={voice.id} {...register('voice_speaker')} className="accent-emerald-500" />
            <div>
              <span className="font-medium text-white">{voice.name}</span>
              <span className="text-white/50 text-sm ml-2">— {voice.description}</span>
            </div>
          </div>
        </label>
      ))}
    </div>
  </div>
);

const ElevenlabsTtsSection = ({ register, watch }: TtsSectionProps) => (
  <div className="border-t border-white/10 pt-6 space-y-4">
    <div>
      <div className="flex items-center gap-2 mb-2">
        <Key className="w-4 h-4 text-fuchsia-400" />
        <label className="label">ElevenLabs API Key</label>
      </div>
      <input
        type="password"
        {...register('elevenlabs_api_key')}
        placeholder="sk_..."
        className="input w-full font-mono text-sm"
      />
      <p className="text-white/40 text-xs mt-1">
        Ключ от{' '}
        <a href="https://elevenlabs.io/app/settings/api-keys" target="_blank" rel="noopener noreferrer" className="text-fuchsia-400 hover:underline">
          elevenlabs.io
        </a>
        . Free tier: 10 000 символов/мес.
      </p>
    </div>

    <div>
      <label className="label mb-2">Модель</label>
      <div className="space-y-2">
        {ELEVENLABS_MODELS.map((model) => (
          <label key={model.id} className={`block p-3 rounded-xl border-2 cursor-pointer transition-all ${
            watch('elevenlabs_model_id') === model.id
              ? 'border-fuchsia-500 bg-fuchsia-500/10'
              : 'border-white/10 hover:border-white/20 bg-white/5'
          }`}>
            <div className="flex items-start gap-2">
              <input type="radio" value={model.id} {...register('elevenlabs_model_id')} className="mt-0.5 accent-fuchsia-500" />
              <div>
                <span className="font-medium text-white text-sm">{model.name}</span>
                <p className="text-xs text-white/50">{model.description}</p>
              </div>
            </div>
          </label>
        ))}
      </div>
    </div>

    <div>
      <label className="label mb-2">Голос</label>
      <div className="grid grid-cols-2 gap-2">
        {ELEVENLABS_VOICES.map((voice) => (
          <label key={voice.id} className={`p-3 rounded-xl border-2 cursor-pointer transition-all ${
            watch('elevenlabs_voice_id') === voice.id
              ? 'border-fuchsia-500 bg-fuchsia-500/10'
              : 'border-white/10 hover:border-white/20 bg-white/5'
          }`}>
            <div className="flex items-start gap-2">
              <input type="radio" value={voice.id} {...register('elevenlabs_voice_id')} className="mt-0.5 accent-fuchsia-500" />
              <div>
                <span className="font-medium text-white text-sm">{voice.name}</span>
                <p className="text-xs text-white/50">{voice.description}</p>
              </div>
            </div>
          </label>
        ))}
      </div>
    </div>

    {watch('elevenlabs_voice_id') === 'custom' && (
      <div>
        <label className="label mb-2">Custom Voice ID</label>
        <input
          type="text"
          {...register('elevenlabs_custom_voice_id')}
          placeholder="Вставьте Voice ID из ElevenLabs..."
          className="input w-full font-mono text-sm"
        />
        <p className="text-white/40 text-xs mt-1">
          Voice ID можно найти в{' '}
          <a href="https://elevenlabs.io/app/voice-library" target="_blank" rel="noopener noreferrer" className="text-fuchsia-400 hover:underline">
            Voice Library
          </a>
          {' '}или{' '}
          <a href="https://elevenlabs.io/app/voice-lab" target="_blank" rel="noopener noreferrer" className="text-fuchsia-400 hover:underline">
            Voice Lab
          </a>
          {' '}(клонированные голоса).
        </p>
      </div>
    )}

    <div className="p-3 rounded-lg bg-fuchsia-500/5 border border-fuchsia-500/10">
      <p className="text-xs text-white/50">
        ElevenLabs предлагает ультра-реалистичные голоса с поддержкой русского языка через модель Multilingual V2.
        При недоступности ElevenLabs бот автоматически переключится на OpenAI TTS или Edge TTS.
      </p>
    </div>
  </div>
);
