import { useEffect, useState, useCallback } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { fetchBotApi, settingsApi } from '../api/appwrite';
import { Save, Loader2, RefreshCw, Eye, Mic, CheckCircle, AlertCircle, Sparkles, MessageSquare, Download, Volume2, Key } from 'lucide-react';

// Bot API URL
// Schema
const settingsSchema = z.object({
  tts_enabled: z.boolean(),
  audio_model: z.string().min(1),
  vision_model: z.string().min(1),
  vision_prompt: z.string().min(10).max(500),
  vision_max_tokens: z.number().min(100).max(4096),
  openrouter_image_model: z.string().optional(),
  tts_provider: z.string(),
  // ElevenLabs
  elevenlabs_api_key: z.string().optional(),
  elevenlabs_voice_id: z.string().optional(),
  elevenlabs_custom_voice_id: z.string().optional(),
  elevenlabs_model_id: z.string().optional(),
  // OpenAI
  openai_tts_voice: z.string(),
  openai_tts_model: z.string(),
  voice_speaker: z.string(),
  openai_api_key: z.string().optional(),
});

type SettingsForm = z.infer<typeof settingsSchema>;

// TTS провайдеры
const TTS_PROVIDERS = [
  { id: 'edge', name: 'Microsoft Edge TTS', description: 'Бесплатно, нейронный голос. Хорошее качество.', badge: 'БЕСПЛАТНО', badgeColor: 'badge-success' },
  { id: 'openai', name: 'OpenAI TTS HD', description: 'Максимально натуральный голос. ~$0.015 за 1000 символов.', badge: 'ПРЕМИУМ', badgeColor: 'text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full text-xs font-medium' },
  { id: 'elevenlabs', name: 'ElevenLabs', description: 'Ультра-реалистичный мультиязычный голос. Лучшее качество для русского языка.', badge: 'ПРЕМИУМ+', badgeColor: 'text-fuchsia-400 bg-fuchsia-500/10 border border-fuchsia-500/20 px-2 py-0.5 rounded-full text-xs font-medium' },
];

// ElevenLabs голоса
const ELEVENLABS_VOICES = [
  { id: '21m00Tcm4TlvDq8ikWAM', name: 'Rachel', description: 'Тёплый женский — идеально для ассистента' },
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Bella', description: 'Мягкий женский голос' },
  { id: 'MF3mGyEYCl7XYWbV9V6O', name: 'Elli', description: 'Молодой женский голос' },
  { id: '29vD33N1CtxCmqQRPOHJ', name: 'Drew', description: 'Уверенный мужской голос' },
  { id: 'ErXwobaYiN019PkySvjV', name: 'Antoni', description: 'Спокойный мужской голос' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', name: 'Josh', description: 'Глубокий мужской голос' },
  { id: 'custom', name: 'Custom Voice', description: 'Свой голос — укажите Voice ID вручную' },
];

// ElevenLabs модели
const ELEVENLABS_MODELS = [
  { id: 'eleven_multilingual_v2', name: 'Multilingual V2', description: 'Лучшее качество, русский и 28 языков' },
  { id: 'eleven_turbo_v2_5', name: 'Turbo V2.5', description: 'Быстрее, мультиязычный, дешевле' },
  { id: 'eleven_flash_v2_5', name: 'Flash V2.5', description: 'Самый быстрый, низкая задержка' },
];

// OpenAI голоса
const OPENAI_VOICES = [
  { id: 'nova', name: 'Nova', description: 'Тёплый, дружелюбный — идеально для ассистента' },
  { id: 'alloy', name: 'Alloy', description: 'Нейтральный, сбалансированный' },
  { id: 'shimmer', name: 'Shimmer', description: 'Яркий, оптимистичный' },
  { id: 'echo', name: 'Echo', description: 'Спокойный, глубокий' },
  { id: 'fable', name: 'Fable', description: 'Выразительный, артистичный' },
  { id: 'onyx', name: 'Onyx', description: 'Глубокий, авторитетный' },
];

// Edge голоса
const EDGE_VOICES = [
  { id: 'svetlana', name: 'Светлана', description: 'Женский русский голос' },
  { id: 'dmitry', name: 'Дмитрий', description: 'Мужской русский голос' },
];

const DEFAULT_VISION_PROMPT = 'Опиши подробно что изображено на этой картинке. Обрати внимание на детали, цвета, объекты и их расположение.';
const DEFAULT_VISION_MAX_TOKENS = 1024;
const DEFAULT_AUDIO_MODEL = 'groq/whisper-large-v3';
const DEFAULT_VISION_MODEL = 'google/gemma-3-27b-it:free';

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

interface AudioRuntimeState {
  preferredModel: string;
  effectiveModel: string;
  overrideModel: string;
  source: string;
}

interface ImageModel {
  id: string;
  name: string;
  description: string;
  pricing: {
    input: number;
    output: number;
    perImage: number;
  };
}

const MultimodalSettingsPage = () => {
  const queryClient = useQueryClient();
  const [saveMessage, setSaveMessage] = useState('');
  const [visionModels, setVisionModels] = useState<VisionModel[]>([]);
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [isRefreshingVision, setIsRefreshingVision] = useState(false);
  const [isRefreshingImage, setIsRefreshingImage] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState('');
  const [audioRuntimeState, setAudioRuntimeState] = useState<AudioRuntimeState | null>(null);

  // Fetch current settings
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });

  const { data: runtimeTruth } = useQuery({
    queryKey: ['settings-runtime-truth'],
    queryFn: settingsApi.getRuntimeTruth,
  });

  // Fetch vision models from bot API
  const fetchVisionModels = useCallback(async (force = false) => {
    try {
      setIsRefreshingVision(true);
      const endpoint = force ? '/api/models/vision/refresh' : '/api/models/vision';
      const method = force ? 'POST' : 'GET';
      const response = await fetchBotApi(endpoint, {
        method,
        headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
        body: method === 'POST' ? '{}' : undefined,
      });
      if (response.ok) {
        const result = await response.json();
        const models = result.data?.models;
        if (models && models.length > 0) {
          setVisionModels(models);
          if (force) {
            setRefreshMessage(`Загружено ${models.length} моделей. Автотест...`);
            // Автотест всех моделей после обновления
            let tested = 0;
            let ok = 0;
            for (const m of models) {
              try {
                const resp = await fetchBotApi('/api/models/vision/test', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model: m.id }),
                });
                const json = await resp.json();
                const isOk = json.status === 'ok';
                if (isOk) ok++;
                tested++;
                setModelTestResults(prev => ({
                  ...prev,
                  [m.id]: { status: isOk ? 'ok' : 'error', latencyMs: json.latencyMs || 0, detail: json.detail, error: json.error },
                }));
                setRefreshMessage(`Тест ${tested}/${models.length}... (${ok} рабочих)`);
              } catch {
                tested++;
                setModelTestResults(prev => ({ ...prev, [m.id]: { status: 'error', latencyMs: 0, error: 'Сетевая ошибка' } }));
              }
            }
            setRefreshMessage(`✅ ${ok}/${models.length} моделей рабочие`);
            setTimeout(() => setRefreshMessage(''), 5000);
          }
        }
      } else {
        const errorText = await response.text();
        if (force) {
          setRefreshMessage(`Ошибка ${response.status}: ${errorText || 'не удалось загрузить модели'}`);
          setTimeout(() => setRefreshMessage(''), 5000);
        }
      }
    } catch (err) {
      if (force) {
        const msg = err instanceof Error ? err.message : 'Неизвестная ошибка';
        setRefreshMessage(`Ошибка загрузки моделей: ${msg}`);
        setTimeout(() => setRefreshMessage(''), 5000);
      }
    } finally {
      setIsRefreshingVision(false);
    }
  }, []);

  const fetchAudioState = useCallback(async () => {
    try {
      const response = await fetchBotApi('/api/models/audio');
      if (!response.ok) {
        setAudioRuntimeState(null);
        return;
      }
      const result = await response.json();
      setAudioRuntimeState({
        preferredModel: result.data?.preferredModel || DEFAULT_AUDIO_MODEL,
        effectiveModel: result.data?.effectiveModel || DEFAULT_AUDIO_MODEL,
        overrideModel: result.data?.overrideModel || '',
        source: result.data?.source || 'default',
      });
    } catch {
      setAudioRuntimeState(null);
    }
  }, []);

  // Load vision models on mount
  useEffect(() => {
    fetchVisionModels(false);
  }, [fetchVisionModels]);

  useEffect(() => {
    fetchAudioState();
  }, [fetchAudioState]);

  // Fetch image generation models from OpenRouter
  const fetchImageModels = useCallback(async () => {
    try {
      setIsRefreshingImage(true);
      const response = await fetchBotApi('/api/models/openrouter/image');
      if (response.ok) {
        const result = await response.json();
        const allModels = result.data?.all || [];
        if (allModels.length > 0) {
          setImageModels(allModels);
        }
      } else {
        const message = `Ошибка ${response.status}: не удалось загрузить image модели`;
        setRefreshMessage(message);
        setTimeout(() => setRefreshMessage(''), 5000);
        throw new Error(message);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Не удалось загрузить image модели';
      setRefreshMessage(message);
      setTimeout(() => setRefreshMessage(''), 5000);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setIsRefreshingImage(false);
    }
  }, []);

  // Auto-load image models on mount (retry once on failure)
  useEffect(() => {
    let retryTimeout: ReturnType<typeof setTimeout> | null = null;
    void fetchImageModels().catch(() => {
      retryTimeout = setTimeout(() => {
        void fetchImageModels().catch(() => undefined);
      }, 3000);
    });

    return () => {
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
    };
  }, [fetchImageModels]);

  // Save mutation with retry
  const { mutate: saveSettings, isPending: isSaving } = useMutation({
    mutationFn: (data: Record<string, string>) => settingsApi.updateMany(data),
    retry: 1, // 1 автоматический retry при ошибке
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['settings-runtime-truth'] });
      void fetchVisionModels(false);
      void fetchAudioState();
      setSaveMessage('Настройки сохранены!');
      setTimeout(() => setSaveMessage(''), 3000);
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : 'Неизвестная ошибка';
      // Если ошибка сети но бот ответил в логах — считаем что сохранилось
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('timeout')) {
        setSaveMessage('⚠️ Возможно сохранено (ответ не получен). Обновите страницу.');
      } else {
        setSaveMessage(`Ошибка: ${msg.slice(0, 100)}`);
      }
      setTimeout(() => setSaveMessage(''), 5000);
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { isDirty, errors },
  } = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      tts_enabled: true,
      audio_model: DEFAULT_AUDIO_MODEL,
      vision_model: DEFAULT_VISION_MODEL,
      vision_prompt: DEFAULT_VISION_PROMPT,
      vision_max_tokens: DEFAULT_VISION_MAX_TOKENS,
      openrouter_image_model: 'google/gemini-2.5-flash-image',
      tts_provider: 'edge',
      // ElevenLabs
      elevenlabs_api_key: '',
      elevenlabs_voice_id: '21m00Tcm4TlvDq8ikWAM',
      elevenlabs_custom_voice_id: '',
      elevenlabs_model_id: 'eleven_multilingual_v2',
      // OpenAI
      openai_tts_voice: 'nova',
      openai_tts_model: 'tts-1-hd',
      voice_speaker: 'svetlana',
      openai_api_key: '',
    },
  });

  const visionMaxTokens = watch('vision_max_tokens');
  const selectedVisionModel = watch('vision_model');
  const selectedImageModel = watch('openrouter_image_model');

  // Vision model test state
  const [testingModel, setTestingModel] = useState<string | null>(null);
  const [modelTestResults, setModelTestResults] = useState<Record<string, { status: 'ok' | 'error'; latencyMs: number; detail?: string; error?: string }>>({});

  const testVisionModel = async (modelId: string) => {
    setTestingModel(modelId);
    try {
      const resp = await fetchBotApi('/api/models/vision/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      });
      const json = await resp.json();
      setModelTestResults(prev => ({
        ...prev,
        [modelId]: {
          status: json.status === 'ok' ? 'ok' : 'error',
          latencyMs: json.latencyMs || 0,
          detail: json.detail,
          error: json.error,
        },
      }));
    } catch (err) {
      setModelTestResults(prev => ({
        ...prev,
        [modelId]: { status: 'error', latencyMs: 0, error: 'Сетевая ошибка' },
      }));
    } finally {
      setTestingModel(null);
    }
  };

  // Load settings into form
  useEffect(() => {
    if (settings) {
      const map = settings.reduce(
        (acc, s) => ({ ...acc, [s.key]: s.value }),
        {} as Record<string, string>
      );

      reset({
        tts_enabled: map['tts_enabled'] !== 'false',
        audio_model: map['audio_model'] || DEFAULT_AUDIO_MODEL,
        vision_model: map['preferred_vision_model'] || map['vision_model'] || DEFAULT_VISION_MODEL,
        vision_prompt: map['vision_prompt'] || DEFAULT_VISION_PROMPT,
        vision_max_tokens: parseInt(map['vision_max_tokens'] || String(DEFAULT_VISION_MAX_TOKENS), 10),
        openrouter_image_model: map['openrouter_image_model'] || 'google/gemini-2.5-flash-image',
        tts_provider: map['tts_provider'] || 'edge',
        // ElevenLabs
        elevenlabs_api_key: map['elevenlabs_api_key'] || '',
        elevenlabs_voice_id: (() => {
          const vid = map['elevenlabs_voice_id'] || '21m00Tcm4TlvDq8ikWAM';
          const knownIds = ELEVENLABS_VOICES.map(v => v.id);
          return knownIds.includes(vid) ? vid : 'custom';
        })(),
        elevenlabs_custom_voice_id: (() => {
          const vid = map['elevenlabs_voice_id'] || '';
          const knownIds = ELEVENLABS_VOICES.map(v => v.id);
          return knownIds.includes(vid) ? (map['elevenlabs_custom_voice_id'] || '') : vid;
        })(),
        elevenlabs_model_id: map['elevenlabs_model_id'] || 'eleven_multilingual_v2',
        // OpenAI
        openai_tts_voice: map['openai_tts_voice'] || 'nova',
        openai_tts_model: map['openai_tts_model'] || 'tts-1-hd',
        voice_speaker: map['voice_speaker'] || 'svetlana',
        openai_api_key: map['openai_api_key'] || '',
      });
    }
  }, [settings, reset]);

  const onSubmit = (data: SettingsForm) => {
    // Проверка: выбранная vision модель мертва?
    const visionTest = modelTestResults[data.vision_model];
    if (visionTest?.status === 'error') {
      const ok = confirm(`⚠️ Vision модель "${data.vision_model}" не прошла тест: ${visionTest.error || 'ошибка'}.\n\nВсё равно сохранить?`);
      if (!ok) return;
    }

    const toSave: Record<string, string> = {
      audio_model: data.audio_model,
      tts_enabled: data.tts_enabled ? 'true' : 'false',
      preferred_vision_model: data.vision_model,
      vision_prompt: data.vision_prompt,
      vision_max_tokens: String(data.vision_max_tokens),
      openrouter_image_model: data.openrouter_image_model || 'google/gemini-2.5-flash-image',
      tts_provider: data.tts_provider,
      // ElevenLabs
      elevenlabs_voice_id: data.elevenlabs_voice_id === 'custom'
        ? (data.elevenlabs_custom_voice_id || '21m00Tcm4TlvDq8ikWAM')
        : (data.elevenlabs_voice_id || '21m00Tcm4TlvDq8ikWAM'),
      elevenlabs_model_id: data.elevenlabs_model_id || 'eleven_multilingual_v2',
      // OpenAI
      openai_tts_voice: data.openai_tts_voice,
      openai_tts_model: data.openai_tts_model,
      voice_speaker: data.voice_speaker,
    };
    // Сохраняем ключи только если заполнены
    if (data.elevenlabs_api_key) {
      toSave.elevenlabs_api_key = data.elevenlabs_api_key;
    }
    if (data.openai_api_key) {
      toSave.openai_api_key = data.openai_api_key;
    }
    saveSettings(toSave);
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

        {/* ============ TTS (ОЗВУЧКА) ============ */}
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

          {/* Выбор провайдера */}
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

          {/* OpenAI настройки */}
          {watch('tts_provider') === 'openai' && (
            <div className="border-t border-white/10 pt-6 space-y-4">
              {/* API ключ */}
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

              {/* Модель */}
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

              {/* Голос OpenAI */}
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
          )}

          {/* Edge настройки */}
          {watch('tts_provider') === 'edge' && (
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
          )}

          {/* ElevenLabs настройки */}
          {watch('tts_provider') === 'elevenlabs' && (
            <div className="border-t border-white/10 pt-6 space-y-4">
              {/* API ключ */}
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

              {/* Модель */}
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

              {/* Голос */}
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

              {/* Custom Voice ID */}
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

              {/* Info */}
              <div className="p-3 rounded-lg bg-fuchsia-500/5 border border-fuchsia-500/10">
                <p className="text-xs text-white/50">
                  ElevenLabs предлагает ультра-реалистичные голоса с поддержкой русского языка через модель Multilingual V2.
                  При недоступности ElevenLabs бот автоматически переключится на OpenAI TTS или Edge TTS.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ============ VISION ============ */}
        <div className="card animate-fade-in-up stagger-3">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2.5 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl shadow-lg shadow-purple-500/25">
              <Eye className="w-6 h-6 text-white" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-white">Анализ изображений</h2>
              <p className="text-sm text-white/50">Только анализ изображений и распознавание текста, не модели общего чата</p>
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
            <div className="flex items-center justify-between mb-2">
              <label className="label">Основная vision модель</label>
              {visionModels.length > 0 && (
                <button
                  type="button"
                  onClick={async () => {
                    for (const m of visionModels) {
                      await testVisionModel(m.id);
                    }
                  }}
                  disabled={testingModel !== null}
                  className="text-xs px-3 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 transition-all disabled:opacity-50"
                >
                  {testingModel ? '⏳ Тестирую...' : '🧪 Проверить все'}
                </button>
              )}
            </div>
            {visionModels.length > 0 ? (
              <div className="space-y-2 max-h-[320px] overflow-y-auto pr-2 scrollbar-thin">
                {[...visionModels].sort((a, b) => {
                  const aResult = modelTestResults[a.id];
                  const bResult = modelTestResults[b.id];
                  const aScore = aResult?.status === 'ok' ? 0 : aResult?.status === 'error' ? 2 : 1;
                  const bScore = bResult?.status === 'ok' ? 0 : bResult?.status === 'error' ? 2 : 1;
                  return aScore - bScore;
                }).map((model) => (
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
                          {modelTestResults[model.id]?.status === 'ok' && (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400">✓ {modelTestResults[model.id].latencyMs}ms</span>
                          )}
                          {modelTestResults[model.id]?.status === 'error' && (
                            <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400" title={modelTestResults[model.id].error}>✗ мёртвая</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          <p className="text-xs text-white/40 font-mono truncate flex-1">{model.id}</p>
                          <button
                            type="button"
                            onClick={(e) => { e.preventDefault(); e.stopPropagation(); testVisionModel(model.id); }}
                            disabled={testingModel === model.id}
                            className="text-xs px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-all flex-shrink-0 disabled:opacity-50"
                          >
                            {testingModel === model.id ? '⏳' : '🧪 тест'}
                          </button>
                        </div>
                        {modelTestResults[model.id]?.status === 'error' && (
                          <p className="text-xs text-red-400 mt-0.5">{modelTestResults[model.id].error}</p>
                        )}
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
              Бесплатные vision модели с авто-fallback могут распознавать изображения, присылать их описания и извлекать текст из фото. Этот блок используется только для анализа изображений.
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

        {/* ============ IMAGE GENERATION ============ */}
        <div className="card animate-fade-in-up stagger-4">
          <div className="flex items-center justify-between mb-6">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-gradient-to-br from-pink-500 to-rose-600 rounded-xl shadow-lg shadow-pink-500/25">
                <Sparkles className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2 className="text-xl font-semibold text-white">Генерация изображений</h2>
                <p className="text-white/50 text-sm">OpenRouter → Gemini / FLUX / Riverflow</p>
              </div>
            </div>
            <button
              type="button"
              onClick={fetchImageModels}
              disabled={isRefreshingImage}
              className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-pink-500/10 border border-pink-500/30 hover:bg-pink-500/20 text-pink-400 text-sm transition-all"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshingImage ? 'animate-spin' : ''}`} />
              Обновить модели
            </button>
          </div>

          <div className="space-y-4">
            <div className="p-4 rounded-xl border-2 border-pink-500/20 bg-pink-500/5">
              <p className="text-white/60 text-sm leading-relaxed">
                <strong className="text-pink-400">Fallback стратегия:</strong> HuggingFace (бесплатно) → OpenRouter (платно).
                Если HF кредиты закончились — автоматически используется OpenRouter.
              </p>
            </div>

            {/* Model Selector */}
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-5 h-5 text-pink-400" />
                <label className="label">OpenRouter модель (fallback)</label>
              </div>
              
              {imageModels.length > 0 ? (
                <div className="space-y-2">
                  {imageModels.map((model) => (
                    <label
                      key={model.id}
                      className={`flex items-center justify-between p-4 rounded-xl border-2 cursor-pointer transition-all ${
                        selectedImageModel === model.id
                          ? 'border-pink-500 bg-pink-500/10'
                          : 'border-white/10 hover:border-white/20 bg-white/5'
                      }`}
                    >
                      <div className="flex items-start gap-3 flex-1 min-w-0">
                        <input
                          type="radio"
                          value={model.id}
                          {...register('openrouter_image_model')}
                          className="mt-1 accent-pink-500"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium text-white text-sm truncate">{model.name}</span>
                            {model.pricing.perImage <= 0.05 && (
                              <span className="badge-success text-xs">ДЕШЕВО</span>
                            )}
                            {model.pricing.perImage > 0.1 && (
                              <span className="text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full text-xs font-medium">
                                ПРЕМИУМ
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-white/40 mt-0.5 font-mono truncate">{model.id}</p>
                          {model.description && (
                            <p className="text-xs text-white/50 mt-1">{model.description}</p>
                          )}
                        </div>
                      </div>
                      <div className="text-right ml-4">
                        <div className="text-sm font-semibold text-pink-400">
                          ${model.pricing.perImage < 0.001 
                            ? model.pricing.perImage.toExponential(2) 
                            : model.pricing.perImage.toFixed(4)}
                        </div>
                        <div className="text-xs text-white/40">за 1K image</div>
                      </div>
                    </label>
                  ))}
                </div>
              ) : (
                <div className="p-4 rounded-xl border-2 border-white/10 bg-white/5 text-center">
                  <p className="text-white/50 text-sm">
                    {isRefreshingImage ? (
                      <span className="flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Загрузка моделей...
                      </span>
                    ) : (
                      'Нажмите "Обновить модели" для загрузки списка'
                    )}
                  </p>
                </div>
              )}
            </div>

            <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 text-xs text-white/60">
              <strong className="text-amber-400">💡 Подсказка:</strong> Gemini 2.5 Flash Image — ~$0.003 за картинку.
              Для 1000 картинок = ~$3. Gemini 3.1 Flash Image Preview ещё дешевле.
              Если список пуст — проверьте, что бот запущен и OpenRouter API ключ настроен.
            </div>
          </div>
        </div>

        {/* ============ HOW IT WORKS ============ */}
        <div className="card-info animate-fade-in-up stagger-4">
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
              <div className="p-1.5 bg-emerald-500/20 rounded-lg">
                <Volume2 className="w-4 h-4 text-emerald-400" />
              </div>
              <div>
                <p className="font-medium text-white">Озвучка (TTS)</p>
                <p className="text-white/60">
                  Ответ бота → ElevenLabs / OpenAI TTS HD / Edge TTS → Голосовое сообщение
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
                  Если основной движок TTS или vision упал → автоматический переход на запасной вариант. Прозрачно для пользователя.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ============ SAVE ============ */}
        <div className="flex items-center justify-between animate-fade-in-up stagger-5">
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
                    vision_model: map['preferred_vision_model'] || map['vision_model'] || DEFAULT_VISION_MODEL,
                    vision_prompt: map['vision_prompt'] || DEFAULT_VISION_PROMPT,
                    vision_max_tokens: parseInt(map['vision_max_tokens'] || String(DEFAULT_VISION_MAX_TOKENS), 10),
                    tts_provider: map['tts_provider'] || 'edge',
                    // ElevenLabs
                    elevenlabs_api_key: map['elevenlabs_api_key'] || '',
                    elevenlabs_voice_id: (() => {
                      const vid = map['elevenlabs_voice_id'] || '21m00Tcm4TlvDq8ikWAM';
                      const knownIds = ELEVENLABS_VOICES.map(v => v.id);
                      return knownIds.includes(vid) ? vid : 'custom';
                    })(),
                    elevenlabs_custom_voice_id: (() => {
                      const vid = map['elevenlabs_voice_id'] || '';
                      const knownIds = ELEVENLABS_VOICES.map(v => v.id);
                      return knownIds.includes(vid) ? (map['elevenlabs_custom_voice_id'] || '') : vid;
                    })(),
                    elevenlabs_model_id: map['elevenlabs_model_id'] || 'eleven_multilingual_v2',
                    // OpenAI
                    openai_tts_voice: map['openai_tts_voice'] || 'nova',
                    openai_tts_model: map['openai_tts_model'] || 'tts-1-hd',
                    voice_speaker: map['voice_speaker'] || 'svetlana',
                    openai_api_key: map['openai_api_key'] || '',
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
