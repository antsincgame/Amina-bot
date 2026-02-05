import { useEffect, useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import { Save, Loader2, RefreshCw, Eye, Mic, CheckCircle, AlertCircle, Sparkles, MessageSquare, Download } from 'lucide-react';

// Bot API URL
const BOT_URL = import.meta.env.VITE_BOT_URL || 'https://amina-bot.onrender.com';

// Schema
const settingsSchema = z.object({
  audio_model: z.string().min(1),
  vision_model: z.string().min(1),
  vision_prompt: z.string().min(10).max(500),
  vision_max_tokens: z.number().min(100).max(4096),
});

type SettingsForm = z.infer<typeof settingsSchema>;

const DEFAULT_VISION_PROMPT = 'Опиши подробно что изображено на этой картинке. Обрати внимание на детали, цвета, объекты и их расположение.';
const DEFAULT_VISION_MAX_TOKENS = 1024;
const DEFAULT_AUDIO_MODEL = 'groq/whisper-large-v3';
const DEFAULT_VISION_MODEL = 'allenai/molmo-2-8b:free';

// Groq audio models (бесплатные)
const AUDIO_MODELS = [
  { id: 'groq/whisper-large-v3', name: 'Groq Whisper Large V3', description: 'Лучшее качество транскрипции' },
  { id: 'groq/whisper-large-v3-turbo', name: 'Groq Whisper Turbo', description: 'Быстрая транскрипция' },
  { id: 'groq/distil-whisper-large-v3-en', name: 'Groq Distil Whisper (EN)', description: 'Для английского языка' },
];

interface VisionModel {
  id: string;
  name: string;
  description: string;
}

const MultimodalSettingsPage = () => {
  const queryClient = useQueryClient();
  const [saveMessage, setSaveMessage] = useState('');
  const [visionModels, setVisionModels] = useState<VisionModel[]>([]);
  const [isRefreshingVision, setIsRefreshingVision] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');

  // Fetch current settings
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });

  // Fetch vision models from bot API
  const fetchVisionModels = useCallback(async (force = false) => {
    try {
      setIsRefreshingVision(true);
      const endpoint = force ? '/api/models/vision/refresh' : '/api/models/vision';
      const method = force ? 'POST' : 'GET';
      const response = await fetch(`${BOT_URL}${endpoint}`, { method });
      if (response.ok) {
        const result = await response.json();
        const models = force ? result.data?.models : result.data?.models;
        if (models && models.length > 0) {
          setVisionModels(models);
          if (force) {
            setRefreshMessage(`Загружено ${models.length} бесплатных vision моделей`);
            setTimeout(() => setRefreshMessage(''), 3000);
          }
        }
      }
    } catch {
      if (force) {
        setRefreshMessage('Ошибка загрузки моделей');
        setTimeout(() => setRefreshMessage(''), 3000);
      }
    } finally {
      setIsRefreshingVision(false);
    }
  }, []);

  // Load vision models on mount
  useEffect(() => {
    fetchVisionModels(false);
  }, [fetchVisionModels]);

  // Save mutation
  const { mutate: saveSettings, isPending: isSaving } = useMutation({
    mutationFn: (data: Record<string, string>) => settingsApi.updateMany(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaveMessage('Настройки сохранены!');
      setTimeout(() => setSaveMessage(''), 3000);
    },
    onError: () => {
      setSaveMessage('Ошибка сохранения');
      setTimeout(() => setSaveMessage(''), 3000);
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { isDirty, errors },
  } = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      audio_model: DEFAULT_AUDIO_MODEL,
      vision_model: DEFAULT_VISION_MODEL,
      vision_prompt: DEFAULT_VISION_PROMPT,
      vision_max_tokens: DEFAULT_VISION_MAX_TOKENS,
    },
  });

  const visionMaxTokens = watch('vision_max_tokens');
  const selectedVisionModel = watch('vision_model');

  // Load settings into form
  useEffect(() => {
    if (settings) {
      const map = settings.reduce(
        (acc, s) => ({ ...acc, [s.key]: s.value }),
        {} as Record<string, string>
      );

      reset({
        audio_model: map['audio_model'] || DEFAULT_AUDIO_MODEL,
        vision_model: map['vision_model'] || DEFAULT_VISION_MODEL,
        vision_prompt: map['vision_prompt'] || DEFAULT_VISION_PROMPT,
        vision_max_tokens: parseInt(map['vision_max_tokens'] || String(DEFAULT_VISION_MAX_TOKENS), 10),
      });
    }
  }, [settings, reset]);

  const onSubmit = (data: SettingsForm) => {
    saveSettings({
      audio_model: data.audio_model,
      audio_model_override: '',
      vision_model: data.vision_model,
      vision_model_override: '',
      vision_prompt: data.vision_prompt,
      vision_max_tokens: String(data.vision_max_tokens),
    });
  };

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-8">
      {/* Header */}
      <div className="animate-fade-in-up">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-gradient-to-br from-violet-500 to-purple-600 rounded-xl shadow-lg shadow-violet-500/25">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <h1 className="heading-section">Голос и Фото</h1>
        </div>
        <p className="text-white/60">
          Настройки обработки голосовых сообщений и анализа изображений
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        
        {/* ============ АУДИО ============ */}
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

        {/* ============ VISION ============ */}
        <div className="card animate-fade-in-up stagger-2">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2.5 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl shadow-lg shadow-purple-500/25">
              <Eye className="w-6 h-6 text-white" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-white">Анализ изображений</h2>
              <p className="text-sm text-white/50">Бесплатные vision модели с авто-fallback</p>
            </div>
            <button
              type="button"
              onClick={() => fetchVisionModels(true)}
              disabled={isRefreshingVision}
              className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-amber-500 to-orange-500 rounded-lg hover:from-amber-600 hover:to-orange-600 transition-all shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isRefreshingVision ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span className="hidden sm:inline">Загрузка...</span>
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  <span className="hidden sm:inline">Обновить модели</span>
                </>
              )}
            </button>
          </div>

          {refreshMessage && (
            <div className={`mb-4 text-sm p-3 rounded-lg flex items-center gap-2 ${
              refreshMessage.startsWith('Ошибка') 
                ? 'bg-red-500/10 border border-red-500/20 text-red-400' 
                : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
            }`}>
              {refreshMessage.startsWith('Ошибка') ? (
                <AlertCircle className="w-4 h-4" />
              ) : (
                <CheckCircle className="w-4 h-4" />
              )}
              {refreshMessage}
            </div>
          )}

          {/* Vision Model Selection */}
          <div className="mb-6">
            <label className="label mb-2">Основная vision модель</label>
            {visionModels.length > 0 ? (
              <div className="space-y-2 max-h-[320px] overflow-y-auto pr-2 scrollbar-thin">
                {visionModels.map((model) => (
                  <label key={model.id} className={`block p-3 rounded-xl border-2 cursor-pointer transition-all ${
                    selectedVisionModel === model.id
                      ? 'border-purple-500 bg-purple-500/10' 
                      : 'border-white/10 hover:border-white/20 bg-white/5'
                  }`}>
                    <div className="flex items-start gap-3">
                      <input
                        type="radio"
                        value={model.id}
                        {...register('vision_model')}
                        className="mt-1 accent-purple-500"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-white text-sm truncate">{model.name}</span>
                          <span className="badge-success text-xs">FREE</span>
                        </div>
                        <p className="text-xs text-white/40 mt-0.5 font-mono truncate">{model.id}</p>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            ) : (
              <div className="p-4 rounded-xl border-2 border-white/10 bg-white/5 text-center">
                <p className="text-white/50 text-sm">
                  Нажмите "Обновить модели" для загрузки списка
                </p>
              </div>
            )}
            <p className="text-white/40 text-xs mt-2">
              При недоступности выбранной модели автоматически запустится гонка всех бесплатных vision моделей. Победитель станет новой основной моделью.
            </p>
          </div>

          {/* Vision Prompt */}
          <div className="border-t border-white/10 pt-6 space-y-4">
            <div className="flex items-center gap-2 mb-2">
              <MessageSquare className="w-5 h-5 text-purple-400" />
              <label className="label">Промпт для описания изображений</label>
            </div>
            <textarea
              {...register('vision_prompt')}
              rows={3}
              className="input w-full resize-none"
              placeholder="Как модель должна описывать изображения..."
            />
            {errors.vision_prompt && (
              <p className="text-red-400 text-sm">{errors.vision_prompt.message}</p>
            )}
            <p className="text-white/40 text-xs">
              Этот промпт отправляется vision-модели для описания картинки. 
              Описание затем передаётся основной LLM для ответа пользователю.
            </p>
          </div>

          {/* Vision Max Tokens */}
          <div className="pt-4 space-y-2">
            <div className="flex items-center justify-between">
              <label className="label">Максимум токенов для описания</label>
              <span className="text-sm text-violet-400 font-mono">{visionMaxTokens}</span>
            </div>
            <input
              type="range"
              min={256}
              max={2048}
              step={128}
              {...register('vision_max_tokens', { valueAsNumber: true })}
              className="w-full accent-purple-500"
            />
            <div className="flex justify-between text-xs text-white/40">
              <span>256 (короткое)</span>
              <span>2048 (детальное)</span>
            </div>
          </div>
        </div>

        {/* ============ HOW IT WORKS ============ */}
        <div className="card-info animate-fade-in-up stagger-3">
          <h3 className="font-semibold text-white mb-4">Как это работает</h3>
          <div className="space-y-4 text-sm">
            <div className="flex items-start gap-3">
              <div className="p-1.5 bg-blue-500/20 rounded-lg">
                <Mic className="w-4 h-4 text-blue-400" />
              </div>
              <div>
                <p className="font-medium text-white">Голосовое сообщение</p>
                <p className="text-white/60">
                  Голос → Groq Whisper (бесплатно) → Текст → Основная LLM → Ответ
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="p-1.5 bg-purple-500/20 rounded-lg">
                <Eye className="w-4 h-4 text-purple-400" />
              </div>
              <div>
                <p className="font-medium text-white">Изображение</p>
                <p className="text-white/60">
                  Фото → Vision-модель → Описание → Основная LLM → Ответ
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="p-1.5 bg-amber-500/20 rounded-lg">
                <RefreshCw className="w-4 h-4 text-amber-400" />
              </div>
              <div>
                <p className="font-medium text-white">Авто-fallback</p>
                <p className="text-white/60">
                  Если vision модель упала → обновление списка → гонка всех бесплатных → победитель становится основной моделью. Прозрачно для пользователя.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ============ SAVE ============ */}
        <div className="flex items-center justify-between animate-fade-in-up stagger-4">
          {saveMessage && (
            <div className={`flex items-center gap-2 text-sm ${
              saveMessage.includes('сохранены') ? 'text-emerald-400' : 'text-red-400'
            }`}>
              {saveMessage.includes('сохранены') ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <AlertCircle className="w-4 h-4" />
              )}
              {saveMessage}
            </div>
          )}
          <div className="flex items-center gap-3 ml-auto">
            <button
              type="button"
              onClick={() => {
                if (settings) {
                  const map = settings.reduce(
                    (acc, s) => ({ ...acc, [s.key]: s.value }),
                    {} as Record<string, string>
                  );
                  reset({
                    audio_model: map['audio_model'] || DEFAULT_AUDIO_MODEL,
                    vision_model: map['vision_model'] || DEFAULT_VISION_MODEL,
                    vision_prompt: map['vision_prompt'] || DEFAULT_VISION_PROMPT,
                    vision_max_tokens: parseInt(map['vision_max_tokens'] || String(DEFAULT_VISION_MAX_TOKENS), 10),
                  });
                }
              }}
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
