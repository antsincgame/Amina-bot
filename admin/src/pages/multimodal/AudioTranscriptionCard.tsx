import type { UseFormReturn } from 'react-hook-form';
import { Mic } from 'lucide-react';
import type { SettingsForm } from './settingsSchema';
import { AUDIO_MODELS, type AudioRuntimeState } from './multimodalConstants';

interface AudioTranscriptionCardProps {
  form: UseFormReturn<SettingsForm>;
  audioRuntimeState: AudioRuntimeState | null;
}

export const AudioTranscriptionCard = ({ form, audioRuntimeState }: AudioTranscriptionCardProps) => {
  const { register, watch } = form;

  return (
    <div className="card animate-fade-in-up stagger-1">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 bg-gradient-to-br from-blue-500 to-cyan-500 rounded-xl shadow-lg shadow-blue-500/25">
          <Mic className="w-6 h-6 text-white" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-white">Голосовые сообщения</h2>
          <p className="text-sm text-white/50">Транскрипция через Groq Whisper (бесплатно)</p>
        </div>
      </div>

      {audioRuntimeState && (
        <div className="mb-6 grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-wide text-white/40 mb-2">Preferred audio model</p>
            <p className="text-sm text-white break-all">{audioRuntimeState.preferredModel}</p>
            <p className="text-xs text-white/50 mt-2">Это приоритетный выбор из админки.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-wide text-white/40 mb-2">Effective audio model</p>
            <p className="text-sm text-white break-all">{audioRuntimeState.effectiveModel}</p>
            <p className="text-xs text-white/50 mt-2">Это модель, которой runtime реально пользуется сейчас.</p>
          </div>
          <div className="rounded-xl border border-white/10 bg-white/5 p-4">
            <p className="text-xs uppercase tracking-wide text-white/40 mb-2">Source</p>
            <p className="text-sm text-white">{audioRuntimeState.source}</p>
            <p className="text-xs text-white/50 mt-2">
              {audioRuntimeState.overrideModel
                ? `Активен internal override: ${audioRuntimeState.overrideModel}`
                : 'Скрытый override аудио-модели сейчас не активен.'}
            </p>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {AUDIO_MODELS.map((model) => (
          <label key={model.id} className={`block p-4 rounded-xl border-2 cursor-pointer transition-all ${
            watch('audio_model') === model.id
              ? 'border-blue-500 bg-blue-500/10' 
              : 'border-white/10 hover:border-white/20 bg-white/5'
          }`}>
            <div className="flex items-start gap-3">
              <input
                type="radio"
                value={model.id}
                {...register('audio_model')}
                className="mt-1 accent-blue-500"
              />
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-white">{model.name}</span>
                  <span className="badge-success">БЕСПЛАТНО</span>
                </div>
                <p className="text-sm text-white/60 mt-1">{model.description}</p>
              </div>
            </div>
          </label>
        ))}
      </div>
    </div>
  );
};
