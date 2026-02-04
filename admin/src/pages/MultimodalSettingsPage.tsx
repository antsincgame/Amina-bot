import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import { Save, Loader2, RefreshCw, Info, Eye, Mic, Image, Volume2, Download, CheckCircle, AlertCircle } from 'lucide-react';

// API URL
const BOT_URL = import.meta.env.VITE_BOT_URL || 'https://amina-bot.onrender.com';

// Types
interface ModelInfo {
  id: string;
  name: string;
  description: string;
}

interface ModelsResponse {
  free: ModelInfo[];
  premium: ModelInfo[];
}

// Schema — только две модели: для изображений и для аудио
const multimodalSchema = z.object({
  vision_model: z.string().min(1, 'Выберите модель'),
  audio_model: z.string().min(1, 'Выберите модель'),
});

type MultimodalForm = z.infer<typeof multimodalSchema>;

const CUSTOM_MODEL_VALUE = '__custom__';

// Default models (проверены на OpenRouter 2026-02-04)
const DEFAULT_VISION_MODELS: ModelsResponse = {
  free: [
    { id: 'allenai/molmo-2-8b:free', name: 'Molmo2 8B (free)', description: 'AllenAI vision модель, поддерживает фото и видео' },
  ],
  premium: [
    { id: 'openai/gpt-4o', name: 'GPT-4o', description: 'OpenAI мультимодальная модель' },
    { id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', description: 'Быстрая OpenAI vision модель' },
    { id: 'anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: 'Anthropic vision модель' },
  ],
};

// Audio модели - Groq Whisper БЕСПЛАТНО!
const DEFAULT_AUDIO_MODELS: ModelsResponse = {
  free: [
    { id: 'groq/whisper-large-v3', name: 'Groq Whisper Large V3 (FREE)', description: 'Бесплатная транскрипция через Groq' },
    { id: 'groq/whisper-large-v3-turbo', name: 'Groq Whisper Turbo (FREE)', description: 'Быстрая бесплатная транскрипция' },
    { id: 'groq/distil-whisper-large-v3-en', name: 'Groq Distil Whisper (FREE)', description: 'Облегчённая версия для английского' },
  ],
  premium: [
    { id: 'openai/gpt-audio', name: 'GPT Audio', description: 'OpenAI специализированная аудио модель' },
    { id: 'openai/gpt-audio-mini', name: 'GPT Audio Mini', description: 'Быстрая аудио модель' },
  ],
};

const MultimodalSettingsPage = () => {
  const queryClient = useQueryClient();
  const [visionModels, setVisionModels] = useState<ModelsResponse>(DEFAULT_VISION_MODELS);
  const [audioModels, setAudioModels] = useState<ModelsResponse>(DEFAULT_AUDIO_MODELS);
  const [customVisionInput, setCustomVisionInput] = useState('');
  const [customAudioInput, setCustomAudioInput] = useState('');
  
  const [isRefreshingVision, setIsRefreshingVision] = useState(false);
  const [isRefreshingAudio, setIsRefreshingAudio] = useState(false);
  const [visionRefreshMessage, setVisionRefreshMessage] = useState('');
  const [audioRefreshMessage, setAudioRefreshMessage] = useState('');

  // Fetch settings
  const { data: settings, isLoading: settingsLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });

  // Fetch vision models
  const { data: visionModelsData, isLoading: visionLoading } = useQuery({
    queryKey: ['vision-models'],
    queryFn: async () => {
      const response = await fetch(`${BOT_URL}/api/models/vision`);
      if (!response.ok) throw new Error('Failed to fetch vision models');
      const data = await response.json();
      return data.data as ModelsResponse;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Fetch audio models
  const { data: audioModelsData, isLoading: audioLoading } = useQuery({
    queryKey: ['audio-models'],
    queryFn: async () => {
      const response = await fetch(`${BOT_URL}/api/models/audio`);
      if (!response.ok) throw new Error('Failed to fetch audio models');
      const data = await response.json();
      return data.data as ModelsResponse;
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  // Update models when data arrives
  useEffect(() => {
    if (visionModelsData) {
      setVisionModels(visionModelsData);
    }
  }, [visionModelsData]);

  useEffect(() => {
    if (audioModelsData) {
      setAudioModels(audioModelsData);
    }
  }, [audioModelsData]);

  // Refresh vision models from OpenRouter
  const refreshVisionModels = async () => {
    setIsRefreshingVision(true);
    setVisionRefreshMessage('');
    try {
      const response = await fetch(`${BOT_URL}/api/models/openrouter/vision`);
      if (!response.ok) throw new Error('Failed to fetch');
      const data = await response.json();
      
      if (data.success && data.data) {
        setVisionModels(data.data);
        const total = data.data.free.length + data.data.premium.length;
        setVisionRefreshMessage(`✅ Загружено ${total} vision моделей (${data.data.free.length} бесплатных)`);
      } else {
        throw new Error('Invalid response');
      }
    } catch {
      setVisionRefreshMessage('❌ Ошибка загрузки моделей');
    } finally {
      setIsRefreshingVision(false);
      setTimeout(() => setVisionRefreshMessage(''), 5000);
    }
  };

  // Refresh audio models from OpenRouter
  const refreshAudioModels = async () => {
    setIsRefreshingAudio(true);
    setAudioRefreshMessage('');
    try {
      const response = await fetch(`${BOT_URL}/api/models/openrouter/audio`);
      if (!response.ok) throw new Error('Failed to fetch');
      const data = await response.json();
      
      if (data.success && data.data) {
        setAudioModels(data.data);
        const total = data.data.free.length + data.data.premium.length;
        if (total === 0) {
          setAudioRefreshMessage('⚠️ Бесплатных audio моделей не найдено. Используйте платные.');
        } else {
          setAudioRefreshMessage(`✅ Загружено ${total} audio моделей (${data.data.free.length} бесплатных)`);
        }
      } else {
        throw new Error('Invalid response');
      }
    } catch {
      setAudioRefreshMessage('❌ Ошибка загрузки моделей');
    } finally {
      setIsRefreshingAudio(false);
      setTimeout(() => setAudioRefreshMessage(''), 5000);
    }
  };

  // Save mutation
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
  } = useForm<MultimodalForm>({
    resolver: zodResolver(multimodalSchema),
    defaultValues: {
      vision_model: 'google/gemini-2.0-flash-exp:free',
      audio_model: 'google/gemini-2.0-flash-exp:free',
    },
  });

  const selectedVisionModel = watch('vision_model');
  const selectedAudioModel = watch('audio_model');

  // Load settings into form (только выбранные модели; приоритет у сохранённого значения)
  useEffect(() => {
    if (settings) {
      const settingsMap = settings.reduce(
        (acc, s) => ({ ...acc, [s.key]: s.value }),
        {} as Record<string, string>
      );
      const visionValue = settingsMap['vision_model_override']?.trim() || settingsMap['vision_model'] ?? 'google/gemini-2.0-flash-exp:free';
      const audioValue = settingsMap['audio_model_override']?.trim() || settingsMap['audio_model'] ?? 'google/gemini-2.0-flash-exp:free';

      const allVisionModels = [...visionModels.free, ...visionModels.premium];
      const allAudioModels = [...audioModels.free, ...audioModels.premium];
      const isKnownVision = allVisionModels.some(m => m.id === visionValue);
      const isKnownAudio = allAudioModels.some(m => m.id === audioValue);

      if (!isKnownVision) setCustomVisionInput(visionValue);
      if (!isKnownAudio) setCustomAudioInput(audioValue);

      reset({
        vision_model: isKnownVision ? visionValue : CUSTOM_MODEL_VALUE,
        audio_model: isKnownAudio ? audioValue : CUSTOM_MODEL_VALUE,
      });
    }
  }, [settings, reset, visionModels, audioModels]);

  const onSubmit = (data: MultimodalForm) => {
    const actualVisionModel = data.vision_model === CUSTOM_MODEL_VALUE ? customVisionInput.trim() : data.vision_model;
    const actualAudioModel = data.audio_model === CUSTOM_MODEL_VALUE ? customAudioInput.trim() : data.audio_model;

    saveSettings({
      vision_model: actualVisionModel,
      vision_model_override: '',
      audio_model: actualAudioModel,
      audio_model_override: '',
    });
  };

  const isLoading = settingsLoading || visionLoading || audioLoading;

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="card space-y-4">
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
        <h1 className="text-2xl font-bold text-gray-900">Мультимодальные Настройки</h1>
        <p className="text-gray-600 mt-1">
          Модели для обработки голосовых сообщений и изображений
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Vision Models */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-purple-100 rounded-lg">
                <Eye className="w-5 h-5 text-purple-600" />
              </div>
              <div>
                <h3 className="font-semibold text-lg">Vision Модель</h3>
                <p className="text-sm text-gray-500">Для анализа изображений и фото</p>
              </div>
            </div>
            <button
              type="button"
              onClick={refreshVisionModels}
              disabled={isRefreshingVision}
              className="btn-secondary text-sm flex items-center gap-2"
            >
              {isRefreshingVision ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Загрузка...
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  Обновить модели
                </>
              )}
            </button>
          </div>

          {visionRefreshMessage && (
            <div className={`mb-4 p-3 rounded-lg flex items-center gap-2 text-sm ${
              visionRefreshMessage.startsWith('✅') 
                ? 'bg-green-100 text-green-700' 
                : visionRefreshMessage.startsWith('⚠️')
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-red-100 text-red-700'
            }`}>
              {visionRefreshMessage.startsWith('✅') ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <AlertCircle className="w-4 h-4" />
              )}
              {visionRefreshMessage.replace(/^[✅❌⚠️]\s*/, '')}
            </div>
          )}

          <div className="space-y-4">
            {/* Vision Model Select */}
            <div>
              <label htmlFor="vision_model" className="label">
                <Image className="w-4 h-4 inline mr-1" />
                Модель для изображений ({visionModels.free.length + visionModels.premium.length} доступно)
              </label>
              <select
                id="vision_model"
                className="input bg-white text-gray-900"
                style={{ colorScheme: 'light' }}
                {...register('vision_model')}
              >
                <optgroup label={`🆓 Бесплатные (${visionModels.free.length})`} className="bg-white text-gray-900">
                  {visionModels.free.map((model) => (
                    <option key={model.id} value={model.id} className="bg-white text-gray-900">
                      {model.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={`💎 Премиум (${visionModels.premium.length})`} className="bg-white text-gray-900">
                  {visionModels.premium.map((model) => (
                    <option key={model.id} value={model.id} className="bg-white text-gray-900">
                      {model.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="⚙️ Другое" className="bg-white text-gray-900">
                  <option value={CUSTOM_MODEL_VALUE} className="bg-white text-gray-900">
                    ✏️ Другая модель
                  </option>
                </optgroup>
              </select>
              {errors.vision_model && (
                <p className="mt-1 text-sm text-red-600">{errors.vision_model.message}</p>
              )}
            </div>

            {selectedVisionModel === CUSTOM_MODEL_VALUE && (
              <div className="border-l-4 border-purple-500 pl-4 py-2 bg-purple-50 rounded-r">
                <label className="label text-sm">ID модели (например provider/model-name)</label>
                <input
                  type="text"
                  className="input bg-white text-gray-900 font-mono text-sm"
                  style={{ colorScheme: 'light' }}
                  placeholder="provider/model-name"
                  value={customVisionInput}
                  onChange={(e) => setCustomVisionInput(e.target.value)}
                />
              </div>
            )}
          </div>
        </div>

        {/* Audio Models */}
        <div className="card">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-blue-100 rounded-lg">
                <Mic className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h3 className="font-semibold text-lg">Audio Модель</h3>
                <p className="text-sm text-gray-500">Для транскрипции голосовых сообщений</p>
              </div>
            </div>
            <button
              type="button"
              onClick={refreshAudioModels}
              disabled={isRefreshingAudio}
              className="btn-secondary text-sm flex items-center gap-2"
            >
              {isRefreshingAudio ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Загрузка...
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  Обновить модели
                </>
              )}
            </button>
          </div>

          {audioRefreshMessage && (
            <div className={`mb-4 p-3 rounded-lg flex items-center gap-2 text-sm ${
              audioRefreshMessage.startsWith('✅') 
                ? 'bg-green-100 text-green-700' 
                : audioRefreshMessage.startsWith('⚠️')
                ? 'bg-yellow-100 text-yellow-700'
                : 'bg-red-100 text-red-700'
            }`}>
              {audioRefreshMessage.startsWith('✅') ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <AlertCircle className="w-4 h-4" />
              )}
              {audioRefreshMessage.replace(/^[✅❌⚠️]\s*/, '')}
            </div>
          )}

          <div className="space-y-4">
            {/* Audio Model Select */}
            <div>
              <label htmlFor="audio_model" className="label">
                <Volume2 className="w-4 h-4 inline mr-1" />
                Модель для аудио ({audioModels.free.length + audioModels.premium.length} доступно)
              </label>
              <select
                id="audio_model"
                className="input bg-white text-gray-900"
                style={{ colorScheme: 'light' }}
                {...register('audio_model')}
              >
                <optgroup label={`🆓 Бесплатные (${audioModels.free.length})`} className="bg-white text-gray-900">
                  {audioModels.free.map((model) => (
                    <option key={model.id} value={model.id} className="bg-white text-gray-900">
                      {model.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label={`💎 Премиум (${audioModels.premium.length})`} className="bg-white text-gray-900">
                  {audioModels.premium.map((model) => (
                    <option key={model.id} value={model.id} className="bg-white text-gray-900">
                      {model.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="⚙️ Другое" className="bg-white text-gray-900">
                  <option value={CUSTOM_MODEL_VALUE} className="bg-white text-gray-900">
                    ✏️ Другая модель
                  </option>
                </optgroup>
              </select>
              {errors.audio_model && (
                <p className="mt-1 text-sm text-red-600">{errors.audio_model.message}</p>
              )}
            </div>

            {selectedAudioModel === CUSTOM_MODEL_VALUE && (
              <div className="border-l-4 border-blue-500 pl-4 py-2 bg-blue-50 rounded-r">
                <label className="label text-sm">ID модели (например provider/model-name)</label>
                <input
                  type="text"
                  className="input bg-white text-gray-900 font-mono text-sm"
                  style={{ colorScheme: 'light' }}
                  placeholder="provider/model-name"
                  value={customAudioInput}
                  onChange={(e) => setCustomAudioInput(e.target.value)}
                />
              </div>
            )}

            <p className="text-xs text-gray-500">
              Если выбрана модель Groq, но ключ GROQ_API_KEY не задан — бот автоматически использует OpenRouter (GPT Audio Mini).
            </p>
          </div>
        </div>

        {/* How it works */}
        <div className="card bg-gradient-to-r from-purple-50 to-blue-50">
          <h4 className="font-semibold text-gray-900 mb-3">Как это работает</h4>
          <div className="space-y-3 text-sm text-gray-700">
            <div className="flex items-start gap-3">
              <div className="p-1.5 bg-purple-100 rounded">
                <Image className="w-4 h-4 text-purple-600" />
              </div>
              <div>
                <p className="font-medium">Изображения и фото</p>
                <p className="text-gray-500">
                  Vision модель анализирует картинку → описание отправляется в основную LLM → бот отвечает
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <div className="p-1.5 bg-blue-100 rounded">
                <Mic className="w-4 h-4 text-blue-600" />
              </div>
              <div>
                <p className="font-medium">Голосовые сообщения</p>
                <p className="text-gray-500">
                  Audio модель транскрибирует речь → текст отправляется в основную LLM → бот отвечает
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Info */}
        <div className="flex items-start gap-2 p-4 rounded-lg bg-amber-50 text-amber-700 text-sm">
          <Info className="w-5 h-5 mt-0.5 flex-shrink-0" />
          <div>
            <p className="font-medium">Рекомендации</p>
            <ul className="mt-1 space-y-1 text-amber-600">
              <li>• Бесплатные модели Gemini хорошо работают с изображениями и аудио</li>
              <li>• Для лучшего качества транскрипции используйте GPT Audio</li>
              <li>• Vision модели могут описывать фото, документы, скриншоты</li>
            </ul>
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

export default MultimodalSettingsPage;
