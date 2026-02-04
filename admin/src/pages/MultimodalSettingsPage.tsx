import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import { Save, Loader2, RefreshCw, Eye, Mic, CheckCircle, AlertCircle, Sparkles, MessageSquare } from 'lucide-react';

// Schema with additional settings
const settingsSchema = z.object({
  audio_mode: z.enum(['groq', 'openrouter']),
  vision_mode: z.enum(['free', 'premium']),
  vision_prompt: z.string().min(10).max(500),
  vision_max_tokens: z.number().min(100).max(4096),
});

type SettingsForm = z.infer<typeof settingsSchema>;

const DEFAULT_VISION_PROMPT = 'Опиши подробно что изображено на этой картинке. Обрати внимание на детали, цвета, объекты и их расположение.';
const DEFAULT_VISION_MAX_TOKENS = 1024;

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
    formState: { isDirty, errors },
  } = useForm<SettingsForm>({
    resolver: zodResolver(settingsSchema),
    defaultValues: {
      audio_mode: 'groq',
      vision_mode: 'free',
      vision_prompt: DEFAULT_VISION_PROMPT,
      vision_max_tokens: DEFAULT_VISION_MAX_TOKENS,
    },
  });

  const audioMode = watch('audio_mode');
  const visionMode = watch('vision_mode');
  const visionMaxTokens = watch('vision_max_tokens');

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

      // Vision prompt и max_tokens
      const visionPrompt = map['vision_prompt'] || DEFAULT_VISION_PROMPT;
      const visionMaxTokens = parseInt(map['vision_max_tokens'] || String(DEFAULT_VISION_MAX_TOKENS), 10);

      reset({ 
        audio_mode: audioMode, 
        vision_mode: visionMode,
        vision_prompt: visionPrompt,
        vision_max_tokens: visionMaxTokens,
      });
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
              <p className="text-sm text-white/50">Транскрипция голоса в текст</p>
            </div>
          </div>

          <div className="space-y-3">
            {/* Groq Option */}
            <label className={`block p-4 rounded-xl border-2 cursor-pointer transition-all ${
              audioMode === 'groq' 
                ? 'border-blue-500 bg-blue-500/10' 
                : 'border-white/10 hover:border-white/20 bg-white/5'
            }`}>
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  value="groq"
                  {...register('audio_mode')}
                  className="mt-1 accent-blue-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">Groq Whisper</span>
                    <span className="badge-success">БЕСПЛАТНО</span>
                  </div>
                  <p className="text-sm text-white/60 mt-1">
                    Быстрая и качественная транскрипция на русском языке
                  </p>
                </div>
              </div>
            </label>

            {/* OpenRouter Option */}
            <label className={`block p-4 rounded-xl border-2 cursor-pointer transition-all ${
              audioMode === 'openrouter' 
                ? 'border-blue-500 bg-blue-500/10' 
                : 'border-white/10 hover:border-white/20 bg-white/5'
            }`}>
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  value="openrouter"
                  {...register('audio_mode')}
                  className="mt-1 accent-blue-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">OpenRouter Audio</span>
                    <span className="badge-warning">ПЛАТНО</span>
                  </div>
                  <p className="text-sm text-white/60 mt-1">
                    Использует баланс OpenRouter для транскрипции
                  </p>
                </div>
              </div>
            </label>
          </div>
        </div>

        {/* ============ VISION ============ */}
        <div className="card animate-fade-in-up stagger-2">
          <div className="flex items-center gap-3 mb-6">
            <div className="p-2.5 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl shadow-lg shadow-purple-500/25">
              <Eye className="w-6 h-6 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-white">Анализ изображений</h2>
              <p className="text-sm text-white/50">Описание картинок для основной LLM</p>
            </div>
          </div>

          <div className="space-y-3 mb-6">
            {/* Free Option */}
            <label className={`block p-4 rounded-xl border-2 cursor-pointer transition-all ${
              visionMode === 'free' 
                ? 'border-purple-500 bg-purple-500/10' 
                : 'border-white/10 hover:border-white/20 bg-white/5'
            }`}>
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  value="free"
                  {...register('vision_mode')}
                  className="mt-1 accent-purple-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">Molmo 2</span>
                    <span className="badge-success">БЕСПЛАТНО</span>
                  </div>
                  <p className="text-sm text-white/60 mt-1">
                    Хорошо описывает фото, не тратит баланс OpenRouter
                  </p>
                </div>
              </div>
            </label>

            {/* Premium Option */}
            <label className={`block p-4 rounded-xl border-2 cursor-pointer transition-all ${
              visionMode === 'premium' 
                ? 'border-purple-500 bg-purple-500/10' 
                : 'border-white/10 hover:border-white/20 bg-white/5'
            }`}>
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  value="premium"
                  {...register('vision_mode')}
                  className="mt-1 accent-purple-500"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-white">GPT-4o Mini</span>
                    <span className="badge-warning">ПЛАТНО</span>
                  </div>
                  <p className="text-sm text-white/60 mt-1">
                    Точнее понимает контекст и мелкие детали изображений
                  </p>
                </div>
              </div>
            </label>
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
                  Голос → Транскрипция → Текст отправляется в основную LLM → Ответ
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
                  Фото → Vision-модель описывает → Описание + вопрос → Основная LLM → Ответ
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* ============ SAVE ============ */}
        <div className="flex items-center justify-between animate-fade-in-up stagger-4">
          {saveMessage && (
            <div className={`flex items-center gap-2 text-sm ${
              saveMessage.includes('✅') ? 'text-emerald-400' : 'text-red-400'
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
              onClick={() => {
                if (settings) {
                  const map = settings.reduce(
                    (acc, s) => ({ ...acc, [s.key]: s.value }),
                    {} as Record<string, string>
                  );
                  const savedAudio = map['audio_model'] || '';
                  const audioMode = savedAudio.startsWith('groq/') ? 'groq' : 'openrouter';
                  const savedVision = map['vision_model'] || '';
                  const visionMode = savedVision.includes(':free') || savedVision.includes('molmo') ? 'free' : 'premium';
                  const visionPrompt = map['vision_prompt'] || DEFAULT_VISION_PROMPT;
                  const visionMaxTokens = parseInt(map['vision_max_tokens'] || String(DEFAULT_VISION_MAX_TOKENS), 10);
                  reset({ audio_mode: audioMode, vision_mode: visionMode, vision_prompt: visionPrompt, vision_max_tokens: visionMaxTokens });
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
