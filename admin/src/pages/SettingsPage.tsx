import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import { Save, Loader2, RefreshCw, Info } from 'lucide-react';

const settingsSchema = z.object({
  openrouter_model: z.string().min(1, 'Выберите модель'),
  max_tokens: z.coerce.number().min(100).max(16000),
  temperature: z.coerce.number().min(0).max(2),
});

type SettingsForm = z.infer<typeof settingsSchema>;

// Popular OpenRouter models
const MODELS = [
  { id: 'anthropic/claude-3-haiku', name: 'Claude 3 Haiku (быстрый, дешёвый)' },
  { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (сбалансированный)' },
  { id: 'anthropic/claude-3-opus', name: 'Claude 3 Opus (мощный, дорогой)' },
  { id: 'openai/gpt-4-turbo', name: 'GPT-4 Turbo' },
  { id: 'openai/gpt-4o', name: 'GPT-4o' },
  { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini (дешёвый)' },
  { id: 'google/gemini-pro', name: 'Gemini Pro' },
  { id: 'google/gemini-flash-1.5', name: 'Gemini Flash 1.5 (быстрый)' },
  { id: 'mistralai/mistral-large', name: 'Mistral Large' },
  { id: 'meta-llama/llama-3-70b-instruct', name: 'Llama 3 70B' },
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
    formState: { errors, isDirty },
  } = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      openrouter_model: 'anthropic/claude-3-haiku',
      max_tokens: 2048,
      temperature: 0.7,
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
        openrouter_model: settingsMap['openrouter_model'] ?? 'anthropic/claude-3-haiku',
        max_tokens: Number(settingsMap['max_tokens']) || 2048,
        temperature: Number(settingsMap['temperature']) || 0.7,
      });
    }
  }, [settings, reset]);

  const onSubmit = (data: SettingsForm) => {
    saveSettings({
      openrouter_model: data.openrouter_model,
      max_tokens: String(data.max_tokens),
      temperature: String(data.temperature),
    });
  };

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
        <h1 className="text-2xl font-bold text-gray-900">Настройки AI</h1>
        <p className="text-gray-600 mt-1">
          Конфигурация модели и параметров генерации
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* OpenRouter Settings */}
        <div className="card">
          <h3 className="font-semibold text-lg mb-4">Параметры OpenRouter</h3>
          
          <div className="space-y-4">
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
              <p className="mt-1 text-xs text-gray-500">
                Цены и лимиты: <a href="https://openrouter.ai/models" target="_blank" rel="noopener noreferrer" className="text-primary-600 hover:underline">openrouter.ai/models</a>
              </p>
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
                <p className="mt-1 text-xs text-gray-500">
                  Максимальная длина ответа (100-16000)
                </p>
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
                <p className="mt-1 text-xs text-gray-500">
                  Креативность: 0 = точный, 2 = творческий
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Info */}
        <div className="flex items-start gap-2 p-4 rounded-lg bg-blue-50 text-blue-700 text-sm">
          <Info className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">API ключ настраивается в Render</p>
            <p className="mt-1 text-blue-600">
              Переменная <code className="bg-blue-100 px-1 rounded">OPENROUTER_API_KEY</code> задаётся в Environment Variables сервиса на Render Dashboard.
            </p>
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
