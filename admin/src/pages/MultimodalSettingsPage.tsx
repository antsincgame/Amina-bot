import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import { Save, Loader2, RefreshCw, Info, Eye, Mic, CheckCircle, AlertCircle } from 'lucide-react';

// API URL
const BOT_URL = import.meta.env.VITE_BOT_URL || 'https://amina-bot.onrender.com';

// Schema — максимально простой
const settingsSchema = z.object({
  audio_mode: z.enum(['groq', 'openrouter']),
  vision_mode: z.enum(['free', 'premium']),
});

type SettingsForm = z.infer<typeof settingsSchema>;

const MultimodalSettingsPage = () => {
  const queryClient = useQueryClient();
  const [saveMessage, setSaveMessage] = useState('');

  // Fetch current settings
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });

  // Save mutation
  const { mutate: saveSettings, isPending: isSaving } = useMutation({
    mutationFn: (data: Record<string, string>) => settingsApi.updateMany(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaveMessage('✅ Настройки сохранены!');
      setTimeout(() => setSaveMessage(''), 3000);
    },
    onError: () => {
      setSaveMessage('❌ Ошибка сохранения');
      setTimeout(() => setSaveMessage(''), 3000);
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { isDirty },
  } = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      audio_mode: 'groq',
      vision_mode: 'free',
    },
  });

  const audioMode = watch('audio_mode');
  const visionMode = watch('vision_mode');

  // Load settings
  useEffect(() => {
    if (settings) {
      const map = settings.reduce(
        (acc, s) => ({ ...acc, [s.key]: s.value }),
        {} as Record<string, string>
      );

      // Определяем режим аудио по сохранённой модели
      const savedAudio = map['audio_model'] || '';
      const audioMode = savedAudio.startsWith('groq/') ? 'groq' : 'openrouter';

      // Определяем режим vision
      const savedVision = map['vision_model'] || '';
      const visionMode = savedVision.includes(':free') || savedVision.includes('molmo') ? 'free' : 'premium';

      reset({ audio_mode: audioMode, vision_mode: visionMode });
    }
  }, [settings, reset]);

  const onSubmit = (data: SettingsForm) => {
    // Преобразуем простые опции в конкретные модели
    const audioModel = data.audio_mode === 'groq' 
      ? 'groq/whisper-large-v3' 
      : 'openai/gpt-audio-mini';
    
    const visionModel = data.vision_mode === 'free'
      ? 'allenai/molmo-2-8b:free'
      : 'openai/gpt-4o-mini';

    saveSettings({
      audio_model: audioModel,
      audio_model_override: '',
      vision_model: visionModel,
      vision_model_override: '',
    });
  };

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-2xl mx-auto">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-blue-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-2xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Голос и Фото</h1>
        <p className="text-gray-600 mt-1">
          Настройки обработки голосовых сообщений и изображений
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        
        {/* ============ АУДИО ============ */}
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 bg-blue-100 rounded-xl">
              <Mic className="w-6 h-6 text-blue-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Голосовые сообщения</h2>
              <p className="text-sm text-gray-500">Как бот понимает голос</p>
            </div>
          </div>

          <div className="space-y-4">
            {/* Groq Option */}
            <label className={`block p-4 rounded-xl border-2 cursor-pointer transition-all ${
              audioMode === 'groq' 
                ? 'border-blue-500 bg-blue-50' 
                : 'border-gray-200 hover:border-gray-300'
            }`}>
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  value="groq"
                  {...register('audio_mode')}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">Groq Whisper</span>
                    <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                      БЕСПЛАТНО
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">
                    Быстрая и качественная транскрипция. Требует GROQ_API_KEY в настройках Render.
                  </p>
                </div>
              </div>
            </label>

            {/* OpenRouter Option */}
            <label className={`block p-4 rounded-xl border-2 cursor-pointer transition-all ${
              audioMode === 'openrouter' 
                ? 'border-blue-500 bg-blue-50' 
                : 'border-gray-200 hover:border-gray-300'
            }`}>
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  value="openrouter"
                  {...register('audio_mode')}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">OpenRouter</span>
                    <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-medium rounded-full">
                      ПЛАТНО
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">
                    Использует баланс OpenRouter. Работает без GROQ_API_KEY.
                  </p>
                </div>
              </div>
            </label>
          </div>

          {/* Info box */}
          <div className="mt-4 p-3 bg-blue-50 rounded-lg flex items-start gap-2">
            <Info className="w-4 h-4 text-blue-600 mt-0.5 flex-shrink-0" />
            <p className="text-sm text-blue-700">
              {audioMode === 'groq' 
                ? 'Если GROQ_API_KEY не задан в Render, бот автоматически переключится на OpenRouter.'
                : 'Транскрипция будет списываться с баланса OpenRouter.'}
            </p>
          </div>
        </div>

        {/* ============ VISION ============ */}
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 bg-purple-100 rounded-xl">
              <Eye className="w-6 h-6 text-purple-600" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-gray-900">Изображения</h2>
              <p className="text-sm text-gray-500">Как бот видит картинки</p>
            </div>
          </div>

          <div className="space-y-4">
            {/* Free Option */}
            <label className={`block p-4 rounded-xl border-2 cursor-pointer transition-all ${
              visionMode === 'free' 
                ? 'border-purple-500 bg-purple-50' 
                : 'border-gray-200 hover:border-gray-300'
            }`}>
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  value="free"
                  {...register('vision_mode')}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">Бесплатная модель</span>
                    <span className="px-2 py-0.5 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                      БЕСПЛАТНО
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">
                    Molmo 2 — хорошо описывает фото. Не тратит баланс OpenRouter.
                  </p>
                </div>
              </div>
            </label>

            {/* Premium Option */}
            <label className={`block p-4 rounded-xl border-2 cursor-pointer transition-all ${
              visionMode === 'premium' 
                ? 'border-purple-500 bg-purple-50' 
                : 'border-gray-200 hover:border-gray-300'
            }`}>
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  value="premium"
                  {...register('vision_mode')}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-900">Премиум модель</span>
                    <span className="px-2 py-0.5 bg-amber-100 text-amber-700 text-xs font-medium rounded-full">
                      ПЛАТНО
                    </span>
                  </div>
                  <p className="text-sm text-gray-600 mt-1">
                    GPT-4o Mini — точнее понимает контекст и детали изображений.
                  </p>
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* ============ HOW IT WORKS ============ */}
        <div className="card bg-gradient-to-br from-gray-50 to-gray-100">
          <h3 className="font-semibold text-gray-900 mb-3">Как это работает</h3>
          <div className="space-y-3 text-sm">
            <div className="flex items-start gap-3">
              <Mic className="w-5 h-5 text-blue-500 mt-0.5" />
              <div>
                <p className="font-medium text-gray-800">Голосовое сообщение</p>
                <p className="text-gray-600">
                  Бот распознаёт речь → отправляет текст в AI → отвечает. 
                  Пользователь видит только ответ.
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Eye className="w-5 h-5 text-purple-500 mt-0.5" />
              <div>
                <p className="font-medium text-gray-800">Изображение</p>
                <p className="text-gray-600">
                  Vision модель описывает картинку → AI формирует ответ. 
                  Пользователь видит только финальный ответ.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ============ SAVE ============ */}
        <div className="flex items-center justify-between">
          {saveMessage && (
            <div className={`flex items-center gap-2 text-sm ${
              saveMessage.includes('✅') ? 'text-green-600' : 'text-red-600'
            }`}>
              {saveMessage.includes('✅') ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <AlertCircle className="w-4 h-4" />
              )}
              {saveMessage.replace(/[✅❌]\s*/, '')}
            </div>
          )}
          <div className="flex items-center gap-3 ml-auto">
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
        </div>
      </form>
    </div>
  );
};

export default MultimodalSettingsPage;
