import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import { Save, Loader2, RefreshCw, Info } from 'lucide-react';

const settingsSchema = z.object({
  openrouter_api_key: z.string().min(1, 'API ключ обязателен'),
  openrouter_model: z.string().min(1, 'Выберите модель'),
  max_tokens: z.coerce.number().min(100).max(16000),
  temperature: z.coerce.number().min(0).max(2),
  voice_enabled: z.boolean(),
  voice_speaker: z.string(),
});

type SettingsForm = z.infer<typeof settingsSchema>;

// Popular OpenRouter models
const MODELS = [
  { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku (fast)' },
  { id: 'anthropic/claude-3-sonnet', name: 'Claude 3 Sonnet (balanced)' },
  { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus (powerful)' },
  { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/gpt-3.5-turbo', name: 'GPT-3.5 Turbo (cheap)' },
  { id: 'google/gemini-pro', name: 'Gemini Pro' },
  { id: 'mistralai/mistral-large', name: 'Mistral Large' },
];

const SPEAKERS = [
  { id: 'xenia', name: 'Ксения (женский)' },
  { id: 'baya', name: 'Байя (женский)' },
  { id: 'kseniya', name: 'Ксения 2 (женский)' },
  { id: 'aidar', name: 'Айдар (мужской)' },
  { id: 'eugene', name: 'Евгений (мужской)' },
];

const SettingsPage = () => {
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });

  const { mutate: saveSettings, isPending: isSaving } = useMutation({
    mutationFn: (data: Record<string, string>) => settingsApi.updateMany(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isDirty },
  } = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      openrouter_api_key: '',
      openrouter_model: 'anthropic/claude-3-haiku',
      max_tokens: 2048,
      temperature: 0.7,
      voice_enabled: true,
      voice_speaker: 'xenia',
    },
  });

  // Load settings into form
  useEffect(() => {
    if (settings) {
      const settingsMap = settings.reduce(
        (acc, s) => ({ ...acc, [s.key]: s.value }),
        {} as Record<string, string>
      );

      reset({
        openrouter_api_key: settingsMap['openrouter_api_key'] ?? '',
        openrouter_model: settingsMap['openrouter_model'] ?? 'anthropic/claude-3-haiku',
        max_tokens: Number(settingsMap['max_tokens']) || 2048,
        temperature: Number(settingsMap['temperature']) || 0.7,
        voice_enabled: settingsMap['voice_enabled'] !== 'false',
        voice_speaker: settingsMap['voice_speaker'] ?? 'xenia',
      });
    }
  }, [settings, reset]);

  const onSubmit = (data: SettingsForm) => {
    saveSettings({
      openrouter_api_key: data.openrouter_api_key,
      openrouter_model: data.openrouter_model,
      max_tokens: String(data.max_tokens),
      temperature: String(data.temperature),
      voice_enabled: String(data.voice_enabled),
      voice_speaker: data.voice_speaker,
    });
  };

  const voiceEnabled = watch('voice_enabled');

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="card space-y-4">
            <div className="h-10 bg-gray-200 rounded" />
            <div className="h-10 bg-gray-200 rounded" />
            <div className="h-10 bg-gray-200 rounded" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Настройки</h1>
        <p className="text-gray-600 mt-1">
          Конфигурация AI и голосовых сервисов
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* OpenRouter Settings */}
        <div className="card">
          <h3 className="font-semibold text-lg mb-4">OpenRouter API</h3>
          
          <div className="space-y-4">
            {/* API Key */}
            <div>
              <label htmlFor="openrouter_api_key" className="label">
                API Ключ
              </label>
              <input
                id="openrouter_api_key"
                type="password"
                className="input"
                placeholder="sk-or-v1-..."
                {...register('openrouter_api_key')}
              />
              {errors.openrouter_api_key && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.openrouter_api_key.message}
                </p>
              )}
              <p className="mt-1 text-xs text-gray-500">
                Получить ключ: <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-primary-600 hover:underline">openrouter.ai/keys</a>
              </p>
            </div>

            {/* Model */}
            <div>
              <label htmlFor="openrouter_model" className="label">
                Модель AI
              </label>
              <select
                id="openrouter_model"
                className="input"
                {...register('openrouter_model')}
              >
                {MODELS.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name}
                  </option>
                ))}
              </select>
              {errors.openrouter_model && (
                <p className="mt-1 text-sm text-red-600">
                  {errors.openrouter_model.message}
                </p>
              )}
            </div>

            {/* Max Tokens & Temperature */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="max_tokens" className="label">
                  Max Tokens
                </label>
                <input
                  id="max_tokens"
                  type="number"
                  className="input"
                  min={100}
                  max={16000}
                  {...register('max_tokens')}
                />
                {errors.max_tokens && (
                  <p className="mt-1 text-sm text-red-600">
                    {errors.max_tokens.message}
                  </p>
                )}
              </div>
              <div>
                <label htmlFor="temperature" className="label">
                  Temperature
                </label>
                <input
                  id="temperature"
                  type="number"
                  className="input"
                  min={0}
                  max={2}
                  step={0.1}
                  {...register('temperature')}
                />
                {errors.temperature && (
                  <p className="mt-1 text-sm text-red-600">
                    {errors.temperature.message}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Voice Settings */}
        <div className="card">
          <h3 className="font-semibold text-lg mb-4">Голосовые настройки</h3>
          
          <div className="space-y-4">
            {/* Voice Enabled */}
            <div className="flex items-center justify-between">
              <div>
                <label className="font-medium text-sm">Голосовой режим</label>
                <p className="text-sm text-gray-500">
                  Включить обработку голосовых сообщений и звонков
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  {...register('voice_enabled')}
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-primary-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-primary-600" />
              </label>
            </div>

            {/* Voice Speaker */}
            {voiceEnabled && (
              <div>
                <label htmlFor="voice_speaker" className="label">
                  Голос TTS (Silero)
                </label>
                <select
                  id="voice_speaker"
                  className="input"
                  {...register('voice_speaker')}
                >
                  {SPEAKERS.map((speaker) => (
                    <option key={speaker.id} value={speaker.id}>
                      {speaker.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Info */}
            <div className="flex items-start gap-2 p-3 rounded-lg bg-blue-50 text-blue-700 text-sm">
              <Info className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <p>
                Vosk STT и Silero TTS работают локально на сервере.
                Модели загружаются при запуске бота.
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => reset()}
            disabled={!isDirty}
            className="btn-secondary"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Сбросить
          </button>
          <button
            type="submit"
            disabled={isSaving || !isDirty}
            className="btn-primary"
          >
            {isSaving ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin mr-2" />
                Сохранение...
              </>
            ) : (
              <>
                <Save className="w-4 h-4 mr-2" />
                Сохранить
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};

export default SettingsPage;
