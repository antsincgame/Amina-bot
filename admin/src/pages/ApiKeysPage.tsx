import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import { 
  Save, 
  Loader2, 
  Key, 
  Eye, 
  EyeOff, 
  CheckCircle, 
  AlertCircle, 
  RefreshCw, 
  Globe,
  Sparkles,
  Bot,
  Mic,
  Zap,
  Shield,
  ExternalLink,
} from 'lucide-react';

// Schema
const apiKeysSchema = z.object({
  telegram_bot_token: z.string().optional(),
  openrouter_api_key: z.string().optional(),
  groq_api_key: z.string().optional(),
  perplexity_api_key: z.string().optional(),
  web_search_enabled: z.string().optional(),
  perplexity_model: z.string().optional(),
  web_search_max_tokens: z.string().optional(),
});

type ApiKeysForm = z.infer<typeof apiKeysSchema>;

// Модели Perplexity с ценами (февраль 2026)
const PERPLEXITY_MODELS = [
  { 
    id: 'sonar', 
    name: 'Sonar', 
    description: 'Быстрая и экономичная',
    badge: 'Рекомендуется',
    badgeColor: 'gold',
    inputPrice: 1.00, 
    outputPrice: 1.00, 
    requestFee: 5.00,
    costPerSearch: 0.0055,
  },
  { 
    id: 'sonar-pro', 
    name: 'Sonar Pro', 
    description: 'Больше цитат, сложные запросы',
    badge: 'Продвинутая',
    badgeColor: 'info',
    inputPrice: 3.00, 
    outputPrice: 15.00, 
    requestFee: 6.00,
    costPerSearch: 0.0105,
  },
  { 
    id: 'sonar-reasoning-pro', 
    name: 'Sonar Reasoning', 
    description: 'С логическим рассуждением',
    badge: 'Премиум',
    badgeColor: 'violet',
    inputPrice: 2.00, 
    outputPrice: 8.00, 
    requestFee: 6.00,
    costPerSearch: 0.0085,
  },
];

const ApiKeysPage = () => {
  const queryClient = useQueryClient();
  const [showTelegram, setShowTelegram] = useState(false);
  const [showOpenRouter, setShowOpenRouter] = useState(false);
  const [showGroq, setShowGroq] = useState(false);
  const [showPerplexity, setShowPerplexity] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  // Fetch settings
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });

  // Save mutation
  const { mutate: saveSettings, isPending: isSaving } = useMutation({
    mutationFn: (data: Record<string, string>) => settingsApi.updateMany(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaveMessage('success');
      setTimeout(() => setSaveMessage(''), 3000);
    },
    onError: () => {
      setSaveMessage('error');
      setTimeout(() => setSaveMessage(''), 3000);
    },
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { isDirty },
  } = useForm<ApiKeysForm>({
    resolver: zodResolver(apiKeysSchema),
    defaultValues: {
      telegram_bot_token: '',
      openrouter_api_key: '',
      groq_api_key: '',
      perplexity_api_key: '',
      web_search_enabled: 'false',
      perplexity_model: 'sonar',
      web_search_max_tokens: '1200',
    },
  });

  const telegramKey = watch('telegram_bot_token');
  const openRouterKey = watch('openrouter_api_key');
  const groqKey = watch('groq_api_key');
  const perplexityKey = watch('perplexity_api_key');
  const webSearchEnabled = watch('web_search_enabled');
  const perplexityModel = watch('perplexity_model');
  const searchMaxTokens = watch('web_search_max_tokens');

  // Load settings
  useEffect(() => {
    if (settings) {
      const map = settings.reduce(
        (acc, s) => ({ ...acc, [s.key]: s.value }),
        {} as Record<string, string>
      );

      reset({
        telegram_bot_token: map['telegram_bot_token'] || '',
        openrouter_api_key: map['openrouter_api_key'] || '',
        groq_api_key: map['groq_api_key'] || '',
        perplexity_api_key: map['perplexity_api_key'] || '',
        web_search_enabled: map['web_search_enabled'] || 'false',
        perplexity_model: map['perplexity_model'] || 'sonar',
        web_search_max_tokens: map['web_search_max_tokens'] || '1200',
      });
    }
  }, [settings, reset]);

  const onSubmit = (data: ApiKeysForm) => {
    saveSettings({
      telegram_bot_token: data.telegram_bot_token || '',
      openrouter_api_key: data.openrouter_api_key || '',
      groq_api_key: data.groq_api_key || '',
      perplexity_api_key: data.perplexity_api_key || '',
      web_search_enabled: data.web_search_enabled || 'false',
      perplexity_model: data.perplexity_model || 'sonar',
      web_search_max_tokens: data.web_search_max_tokens || '1200',
    });
  };

  // Получить информацию о выбранной модели
  const selectedModelInfo = PERPLEXITY_MODELS.find(m => m.id === perplexityModel) || PERPLEXITY_MODELS[0];

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="relative">
            <div className="absolute inset-0 rounded-full animate-pulse-glow" 
                 style={{ background: 'radial-gradient(circle, rgba(255, 215, 0, 0.3) 0%, transparent 70%)', filter: 'blur(10px)' }} />
            <Loader2 className="w-12 h-12 animate-spin text-amber-400 relative" />
          </div>
          <span className="text-gray-400 text-sm" style={{ fontFamily: 'var(--font-heading)' }}>
            Загрузка...
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="p-8 max-w-4xl mx-auto">
      {/* Header */}
      <div className="mb-10 animate-fade-in-up">
        <div className="flex items-center gap-4 mb-3">
          <div className="relative">
            <div className="absolute inset-0 rounded-2xl" 
                 style={{ background: 'radial-gradient(circle, rgba(255, 215, 0, 0.4) 0%, transparent 70%)', filter: 'blur(12px)' }} />
            <div className="relative w-14 h-14 rounded-2xl flex items-center justify-center"
                 style={{ 
                   background: 'linear-gradient(135deg, rgba(255, 215, 0, 0.2), rgba(139, 92, 246, 0.15))',
                   border: '1px solid rgba(255, 215, 0, 0.3)',
                 }}>
              <Key className="w-7 h-7 text-amber-400" />
            </div>
          </div>
          <div>
            <h1 className="text-3xl font-bold text-gradient-gold heading-display">
              API Ключи
            </h1>
            <p className="text-gray-400 text-sm mt-1" style={{ fontFamily: 'var(--font-heading)' }}>
              Настройка подключений к AI сервисам
            </p>
          </div>
        </div>
      </div>

      {/* Info Card */}
      <div className="card-info mb-8 animate-fade-in-up stagger-1" style={{ opacity: 0 }}>
        <div className="flex items-start gap-4">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
               style={{ background: 'rgba(59, 130, 246, 0.2)', border: '1px solid rgba(59, 130, 246, 0.3)' }}>
            <Shield className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h3 className="font-semibold text-white mb-2" style={{ fontFamily: 'var(--font-heading)' }}>
              Безопасное хранение
            </h3>
            <p className="text-gray-400 text-sm leading-relaxed">
              Все API ключи хранятся в зашифрованной базе данных Supabase. 
              В Render достаточно только <code className="px-1.5 py-0.5 rounded bg-white/5 text-amber-400 text-xs">SUPABASE_URL</code> и <code className="px-1.5 py-0.5 rounded bg-white/5 text-amber-400 text-xs">SUPABASE_SERVICE_KEY</code>.
            </p>
          </div>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        
        {/* Telegram Bot Token */}
        <div className="card animate-fade-in-up stagger-2" style={{ opacity: 0 }}>
          <div className="flex items-center gap-4 mb-5">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                 style={{ 
                   background: 'linear-gradient(135deg, rgba(56, 189, 248, 0.2), rgba(56, 189, 248, 0.1))',
                   border: '1px solid rgba(56, 189, 248, 0.3)',
                   boxShadow: '0 0 20px rgba(56, 189, 248, 0.15)',
                 }}>
              <Bot className="w-6 h-6 text-sky-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: 'var(--font-heading)' }}>
                Telegram Bot Token
              </h2>
              <p className="text-sm text-gray-500">Обязателен для работы бота</p>
            </div>
            {telegramKey && (
              <span className="badge-success">
                <CheckCircle className="w-3.5 h-3.5 mr-1" />
                Задан
              </span>
            )}
          </div>

          <div className="relative">
            <input
              type={showTelegram ? 'text' : 'password'}
              placeholder="123456789:ABCdefGHIjklMNOpqrSTUvwxYZ..."
              className="input pr-12 font-mono text-sm"
              {...register('telegram_bot_token')}
            />
            <button
              type="button"
              onClick={() => setShowTelegram(!showTelegram)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg
                         text-gray-500 hover:text-amber-400 hover:bg-amber-400/10
                         transition-all duration-200"
            >
              {showTelegram ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1.5 mt-3 text-xs text-gray-500 hover:text-amber-400 transition-colors">
            <ExternalLink className="w-3 h-3" />
            <span>Получить токен у @BotFather</span>
          </a>
        </div>

        {/* OpenRouter API Key */}
        <div className="card animate-fade-in-up stagger-3" style={{ opacity: 0 }}>
          <div className="flex items-center gap-4 mb-5">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                 style={{ 
                   background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.2), rgba(34, 197, 94, 0.1))',
                   border: '1px solid rgba(34, 197, 94, 0.3)',
                   boxShadow: '0 0 20px rgba(34, 197, 94, 0.15)',
                 }}>
              <Sparkles className="w-6 h-6 text-green-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: 'var(--font-heading)' }}>
                OpenRouter API Key
              </h2>
              <p className="text-sm text-gray-500">Для AI моделей (GPT, Claude, Llama)</p>
            </div>
            {openRouterKey && (
              <span className="badge-success">
                <CheckCircle className="w-3.5 h-3.5 mr-1" />
                Задан
              </span>
            )}
          </div>

          <div className="relative">
            <input
              type={showOpenRouter ? 'text' : 'password'}
              placeholder="sk-or-v1-..."
              className="input pr-12 font-mono text-sm"
              {...register('openrouter_api_key')}
            />
            <button
              type="button"
              onClick={() => setShowOpenRouter(!showOpenRouter)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg
                         text-gray-500 hover:text-amber-400 hover:bg-amber-400/10
                         transition-all duration-200"
            >
              {showOpenRouter ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1.5 mt-3 text-xs text-gray-500 hover:text-amber-400 transition-colors">
            <ExternalLink className="w-3 h-3" />
            <span>openrouter.ai/keys</span>
          </a>
        </div>

        {/* Groq API Key */}
        <div className="card animate-fade-in-up stagger-4" style={{ opacity: 0 }}>
          <div className="flex items-center gap-4 mb-5">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                 style={{ 
                   background: 'linear-gradient(135deg, rgba(168, 85, 247, 0.2), rgba(168, 85, 247, 0.1))',
                   border: '1px solid rgba(168, 85, 247, 0.3)',
                   boxShadow: '0 0 20px rgba(168, 85, 247, 0.15)',
                 }}>
              <Mic className="w-6 h-6 text-purple-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: 'var(--font-heading)' }}>
                Groq API Key
              </h2>
              <p className="text-sm text-gray-500">Для транскрипции голоса (Whisper)</p>
            </div>
            {groqKey && (
              <span className="badge-success">
                <CheckCircle className="w-3.5 h-3.5 mr-1" />
                Задан
              </span>
            )}
          </div>

          <div className="relative">
            <input
              type={showGroq ? 'text' : 'password'}
              placeholder="gsk_..."
              className="input pr-12 font-mono text-sm"
              {...register('groq_api_key')}
            />
            <button
              type="button"
              onClick={() => setShowGroq(!showGroq)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg
                         text-gray-500 hover:text-amber-400 hover:bg-amber-400/10
                         transition-all duration-200"
            >
              {showGroq ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          <div className="flex items-center justify-between mt-3">
            <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer"
               className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-amber-400 transition-colors">
              <ExternalLink className="w-3 h-3" />
              <span>console.groq.com/keys</span>
            </a>
            <span className="badge-success text-xs">
              <Zap className="w-3 h-3 mr-1" />
              Бесплатно
            </span>
          </div>
        </div>

        {/* Perplexity API Key + Web Search Settings */}
        <div className="card-glow animate-fade-in-up stagger-5" style={{ opacity: 0 }}>
          <div className="flex items-center gap-4 mb-5">
            <div className="relative">
              <div className="absolute inset-0 rounded-xl animate-pulse-glow"
                   style={{ background: 'radial-gradient(circle, rgba(99, 102, 241, 0.3) 0%, transparent 70%)', filter: 'blur(8px)' }} />
              <div className="relative w-12 h-12 rounded-xl flex items-center justify-center"
                   style={{ 
                     background: 'linear-gradient(135deg, rgba(99, 102, 241, 0.3), rgba(139, 92, 246, 0.2))',
                     border: '1px solid rgba(99, 102, 241, 0.4)',
                   }}>
                <Globe className="w-6 h-6 text-indigo-400" />
              </div>
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: 'var(--font-heading)' }}>
                Perplexity API Key
              </h2>
              <p className="text-sm text-gray-500">Доступ в интернет для актуальной информации</p>
            </div>
            {perplexityKey && (
              <span className="badge-success">
                <CheckCircle className="w-3.5 h-3.5 mr-1" />
                Задан
              </span>
            )}
          </div>

          <div className="relative mb-4">
            <input
              type={showPerplexity ? 'text' : 'password'}
              placeholder="pplx-..."
              className="input pr-12 font-mono text-sm"
              {...register('perplexity_api_key')}
            />
            <button
              type="button"
              onClick={() => setShowPerplexity(!showPerplexity)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg
                         text-gray-500 hover:text-amber-400 hover:bg-amber-400/10
                         transition-all duration-200"
            >
              {showPerplexity ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>

          <a href="https://www.perplexity.ai/settings/api" target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1.5 text-xs text-gray-500 hover:text-amber-400 transition-colors mb-6">
            <ExternalLink className="w-3 h-3" />
            <span>perplexity.ai/settings/api</span>
          </a>

          <div className="divider my-6" />

          {/* Web Search Toggle */}
          <div className="p-4 rounded-xl mb-5"
               style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center"
                     style={{ background: 'rgba(99, 102, 241, 0.15)' }}>
                  <Globe className="w-5 h-5 text-indigo-400" />
                </div>
                <div>
                  <h3 className="font-medium text-white" style={{ fontFamily: 'var(--font-heading)' }}>
                    Автоматический веб-поиск
                  </h3>
                  <p className="text-xs text-gray-500">Бот ищет в интернете когда нужна актуальная информация</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setValue('web_search_enabled', webSearchEnabled === 'true' ? 'false' : 'true', { shouldDirty: true })}
                className={`toggle ${webSearchEnabled === 'true' ? 'toggle-checked' : ''}`}
              >
                <span className={`toggle-dot ${webSearchEnabled === 'true' ? 'toggle-dot-checked' : ''}`} />
              </button>
            </div>
          </div>

          {/* Model Selector */}
          <div className="p-4 rounded-xl"
               style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <h3 className="font-medium text-white mb-4" style={{ fontFamily: 'var(--font-heading)' }}>
              Модель поиска
            </h3>
            
            <div className="space-y-3">
              {PERPLEXITY_MODELS.map((model) => (
                <label
                  key={model.id}
                  className={`flex items-center p-4 rounded-xl cursor-pointer transition-all duration-300 ${
                    perplexityModel === model.id
                      ? 'border-amber-500/50 bg-amber-500/5'
                      : 'border-white/5 bg-white/[0.02] hover:border-white/20 hover:bg-white/[0.04]'
                  }`}
                  style={{ border: '1px solid' }}
                >
                  <input
                    type="radio"
                    value={model.id}
                    checked={perplexityModel === model.id}
                    onChange={(e) => setValue('perplexity_model', e.target.value, { shouldDirty: true })}
                    className="sr-only"
                  />
                  
                  {/* Radio indicator */}
                  <div className={`w-5 h-5 rounded-full border-2 mr-4 flex items-center justify-center transition-all ${
                    perplexityModel === model.id
                      ? 'border-amber-400 bg-amber-400'
                      : 'border-gray-600'
                  }`}>
                    {perplexityModel === model.id && (
                      <div className="w-2 h-2 rounded-full bg-gray-900" />
                    )}
                  </div>

                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-white" style={{ fontFamily: 'var(--font-heading)' }}>
                        {model.name}
                      </span>
                      <span className={`badge-${model.badgeColor === 'gold' ? 'gold' : model.badgeColor === 'violet' ? 'info' : 'info'} text-[10px] px-2 py-0.5`}>
                        {model.badge}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500">{model.description}</p>
                  </div>

                  <div className="text-right">
                    <div className="text-sm font-semibold text-amber-400" style={{ fontFamily: 'var(--font-heading)' }}>
                      ~${model.costPerSearch.toFixed(4)}
                    </div>
                    <div className="text-[10px] text-gray-500">за поиск</div>
                  </div>
                </label>
              ))}
            </div>

            {/* Cost Summary */}
            <div className="mt-4 p-3 rounded-lg flex items-center justify-between"
                 style={{ background: 'rgba(255, 215, 0, 0.05)', border: '1px solid rgba(255, 215, 0, 0.1)' }}>
              <span className="text-sm text-gray-400">
                Примерная стоимость 100 поисков:
              </span>
              <span className="font-semibold text-amber-400" style={{ fontFamily: 'var(--font-heading)' }}>
                ~${(selectedModelInfo.costPerSearch * 100).toFixed(2)}
              </span>
            </div>
          </div>

          <div className="divider my-6" />

          {/* Max Tokens Setting */}
          <div className="p-4 rounded-xl"
               style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-lg flex items-center justify-center"
                   style={{ background: 'rgba(251, 146, 60, 0.15)' }}>
                <Zap className="w-5 h-5 text-orange-400" />
              </div>
              <div>
                <h3 className="font-medium text-white" style={{ fontFamily: 'var(--font-heading)' }}>
                  Длина ответа поиска
                </h3>
                <p className="text-xs text-gray-500">Максимум токенов для каждого поискового запроса</p>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center gap-4">
                <input
                  type="range"
                  min="400"
                  max="4000"
                  step="200"
                  value={searchMaxTokens || '1200'}
                  onChange={(e) => setValue('web_search_max_tokens', e.target.value, { shouldDirty: true })}
                  className="flex-1 accent-amber-400"
                  style={{ accentColor: 'rgb(251, 191, 36)' }}
                />
                <div className="w-20 text-right">
                  <span className="text-lg font-bold text-amber-400" style={{ fontFamily: 'var(--font-heading)' }}>
                    {searchMaxTokens || '1200'}
                  </span>
                </div>
              </div>

              <div className="flex justify-between text-[10px] text-gray-600 px-1">
                <span>400 — Экономно</span>
                <span>1200 — Баланс</span>
                <span>2500 — Подробно</span>
                <span>4000 — Макс</span>
              </div>

              <div className="p-2.5 rounded-lg text-xs"
                   style={{ background: 'rgba(251, 146, 60, 0.08)', border: '1px solid rgba(251, 146, 60, 0.15)' }}>
                <span className="text-gray-400">
                  💡 Больше токенов = более подробные ответы, но дороже.{' '}
                  {Number(searchMaxTokens || 1200) >= 2000 
                    ? 'Отличный выбор для глубоких ответов!' 
                    : Number(searchMaxTokens || 1200) >= 1000 
                      ? 'Хороший баланс цены и качества.' 
                      : 'Экономный режим — ответы могут быть краткими.'}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Save Button */}
        <div className="flex items-center justify-between pt-6 animate-fade-in-up stagger-5" style={{ opacity: 0 }}>
          {saveMessage && (
            <div className={`flex items-center gap-2 px-4 py-2 rounded-xl ${
              saveMessage === 'success' 
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                : 'bg-red-500/10 text-red-400 border border-red-500/20'
            }`}>
              {saveMessage === 'success' ? (
                <>
                  <CheckCircle className="w-4 h-4" />
                  <span className="text-sm font-medium" style={{ fontFamily: 'var(--font-heading)' }}>
                    Сохранено
                  </span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4" />
                  <span className="text-sm font-medium" style={{ fontFamily: 'var(--font-heading)' }}>
                    Ошибка сохранения
                  </span>
                </>
              )}
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

export default ApiKeysPage;
