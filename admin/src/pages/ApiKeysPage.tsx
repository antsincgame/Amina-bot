import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi, fetchBotApi } from '../api/appwrite';
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
  cerebras_api_key: z.string().optional(),
  perplexity_api_key: z.string().optional(),
  web_search_enabled: z.string().optional(),
  perplexity_model: z.string().optional(),
  web_search_max_tokens: z.string().optional(),
});

type ApiKeysForm = z.infer<typeof apiKeysSchema>;

const PERPLEXITY_MODELS = [
  {
    id: 'sonar',
    name: 'Sonar',
    description: 'Быстрая и экономичная',
    badge: 'Бюджет',
    badgeColor: 'gold',
    inputPrice: 1.00,
    outputPrice: 1.00,
    requestFee: 5.00,
    costPerSearch: 0.0055,
  },
  {
    id: 'sonar-pro',
    name: 'Sonar Pro',
    description: 'Больше цитат, сложные запросы, 200K контекст',
    badge: 'Рекомендуется',
    badgeColor: 'info',
    inputPrice: 3.00,
    outputPrice: 15.00,
    requestFee: 6.00,
    costPerSearch: 0.0105,
  },
  {
    id: 'sonar-pro-search',
    name: 'Sonar Pro Search',
    description: 'Глубокий поиск с максимумом источников',
    badge: 'Премиум',
    badgeColor: 'violet',
    inputPrice: 3.00,
    outputPrice: 15.00,
    requestFee: 6.00,
    costPerSearch: 0.0105,
  },
  {
    id: 'sonar-reasoning-pro',
    name: 'Sonar Reasoning Pro',
    description: 'Аналитика с логическим рассуждением',
    badge: 'Аналитика',
    badgeColor: 'teal',
    inputPrice: 2.00,
    outputPrice: 8.00,
    requestFee: 6.00,
    costPerSearch: 0.0085,
  },
  {
    id: 'sonar-deep-research',
    name: 'Sonar Deep Research',
    description: 'Глубокое исследование с автоматическим анализом',
    badge: 'Исследование',
    badgeColor: 'rose',
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
  const [showCerebras, setShowCerebras] = useState(false);
  const [showPerplexity, setShowPerplexity] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');

  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });

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
      cerebras_api_key: '',
      perplexity_api_key: '',
      web_search_enabled: 'false',
      perplexity_model: 'sonar',
      web_search_max_tokens: '1200',
    },
  });

  const telegramKey = watch('telegram_bot_token');
  const openRouterKey = watch('openrouter_api_key');
  const groqKey = watch('groq_api_key');
  const cerebrasKey = watch('cerebras_api_key');
  const perplexityKey = watch('perplexity_api_key');
  const webSearchEnabled = watch('web_search_enabled');
  const perplexityModel = watch('perplexity_model');
  const searchMaxTokens = watch('web_search_max_tokens');

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
        cerebras_api_key: map['cerebras_api_key'] || '',
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
      cerebras_api_key: data.cerebras_api_key || '',
      perplexity_api_key: data.perplexity_api_key || '',
      web_search_enabled: data.web_search_enabled || 'false',
      perplexity_model: data.perplexity_model || 'sonar',
      web_search_max_tokens: data.web_search_max_tokens || '1200',
    });
  };

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
              Все API ключи хранятся в базе данных Appwrite.
              В Coolify достаточно только <code className="px-1.5 py-0.5 rounded bg-white/5 text-amber-400 text-xs">APPWRITE_API_KEY</code> и <code className="px-1.5 py-0.5 rounded bg-white/5 text-amber-400 text-xs">APPWRITE_PROJECT_ID</code>.
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
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-500 hover:text-amber-400 hover:bg-amber-400/10 transition-all duration-200"
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
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-500 hover:text-amber-400 hover:bg-amber-400/10 transition-all duration-200"
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
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-500 hover:text-amber-400 hover:bg-amber-400/10 transition-all duration-200"
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

        {/* Cerebras API Key */}
        <div className="card animate-fade-in-up stagger-4" style={{ opacity: 0 }}>
          <div className="flex items-center gap-4 mb-5">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                 style={{
                   background: 'linear-gradient(135deg, rgba(236, 72, 153, 0.2), rgba(168, 85, 247, 0.15))',
                   border: '1px solid rgba(236, 72, 153, 0.3)',
                   boxShadow: '0 0 20px rgba(236, 72, 153, 0.15)',
                 }}>
              <Sparkles className="w-6 h-6 text-pink-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: 'var(--font-heading)' }}>
                Cerebras API Key
              </h2>
              <p className="text-sm text-gray-500">Для быстрого инференса (Llama на Cerebras)</p>
            </div>
            {cerebrasKey && (
              <span className="badge-success">
                <CheckCircle className="w-3.5 h-3.5 mr-1" />
                Задан
              </span>
            )}
          </div>
          <div className="relative">
            <input
              type={showCerebras ? 'text' : 'password'}
              placeholder="csk_..."
              className="input pr-12 font-mono text-sm"
              {...register('cerebras_api_key')}
            />
            <button
              type="button"
              onClick={() => setShowCerebras(!showCerebras)}
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-500 hover:text-amber-400 hover:bg-amber-400/10 transition-all duration-200"
            >
              {showCerebras ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
          <a href="https://cerebras.ai" target="_blank" rel="noopener noreferrer"
             className="inline-flex items-center gap-1.5 mt-3 text-xs text-gray-500 hover:text-amber-400 transition-colors">
            <ExternalLink className="w-3 h-3" />
            <span>cerebras.ai</span>
          </a>
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
              className="absolute right-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-gray-500 hover:text-amber-400 hover:bg-amber-400/10 transition-all duration-200"
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
                      <span className={`badge-${model.badgeColor === 'gold' ? 'gold' : 'info'} text-[10px] px-2 py-0.5`}>
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
            </div>
          </div>
        </div>

        {/* LLM Verification Diagnostics */}
        <div className="card animate-fade-in-up stagger-5" style={{ opacity: 0 }}>
          <div className="flex items-center gap-4 mb-5">
            <div className="w-12 h-12 rounded-xl flex items-center justify-center"
                 style={{
                   background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.2), rgba(245, 158, 11, 0.1))',
                   border: '1px solid rgba(245, 158, 11, 0.3)',
                   boxShadow: '0 0 20px rgba(245, 158, 11, 0.15)',
                 }}>
              <Shield className="w-6 h-6 text-amber-400" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-white" style={{ fontFamily: 'var(--font-heading)' }}>
                Верификация ответов
              </h2>
              <p className="text-sm text-gray-500">Diagnostics-only блок: runtime всегда сам решает политику верификации</p>
            </div>
          </div>

          <div className="p-4 rounded-xl space-y-4"
               style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid rgba(255, 255, 255, 0.05)' }}>
            <div className="flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg flex items-center justify-center"
                     style={{ background: 'rgba(245, 158, 11, 0.15)' }}>
                  <CheckCircle className="w-5 h-5 text-amber-400" />
                </div>
                <div>
                  <h3 className="font-medium text-white" style={{ fontFamily: 'var(--font-heading)' }}>
                    Политика верификации активна
                  </h3>
                  <p className="text-xs text-gray-500">
                    Runtime слой сам проверяет симуляцию поиска, фактические галлюцинации и отказы использовать поиск.
                  </p>
                </div>
              </div>
              <span className="badge-success">
                <CheckCircle className="w-3.5 h-3.5 mr-1" />
                Всегда под контролем runtime
              </span>
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
                  <span className="text-sm font-medium" style={{ fontFamily: 'var(--font-heading)' }}>Сохранено</span>
                </>
              ) : (
                <>
                  <AlertCircle className="w-4 h-4" />
                  <span className="text-sm font-medium" style={{ fontFamily: 'var(--font-heading)' }}>Ошибка сохранения</span>
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

      {/* === Тест соединений всех провайдеров === */}
      <ProviderTestPanel />
    </div>
  );
};

// Провайдер лейблы для отображения
const PROVIDER_DISPLAY: Record<string, { label: string; icon: string }> = {
  appwrite: { label: 'Appwrite (БД)', icon: '🗄️' },
  openrouter: { label: 'OpenRouter (Chat)', icon: '🤖' },
  cerebras: { label: 'Cerebras (Chat)', icon: '⚡' },
  groq_chat: { label: 'Groq (Chat)', icon: '🟢' },
  groq_whisper: { label: 'Groq Whisper (Аудио)', icon: '🎙️' },
  perplexity: { label: 'Perplexity (Поиск)', icon: '🌐' },
  vision: { label: 'Vision (Зрение)', icon: '👁️' },
  lmstudio: { label: 'LM Studio (Локальная)', icon: '🖥️' },
};

interface TestResult {
  provider: string;
  status: 'ok' | 'error' | 'skipped';
  latencyMs: number;
  model?: string;
  modelSource?: string;
  error?: string;
  detail?: string;
  keySource?: string;
  keyPreview?: string;
  diagnosis?: string;
  tunnelUrl?: string;
  healthSource?: string;
  heartbeatAt?: string;
  circuitBreaker?: { state: string; recentFailures: number; cooldownRemainingSec: number };
}

const ProviderTestPanel = () => {
  const [results, setResults] = useState<TestResult[]>([]);
  const [totalMs, setTotalMs] = useState<number>(0);
  const [testing, setTesting] = useState(false);
  const [testedAt, setTestedAt] = useState('');
  const [currentProvider, setCurrentProvider] = useState('');
  const [health, setHealth] = useState<Record<string, { available: boolean; consecutiveFailures: number; lastFailureCode: string; cooldownUntil: string | null; rpm: number; rpmLimit: number }>>({});

  const loadHealth = async () => {
    try {
      const resp = await fetchBotApi('/api/providers/health');
      const json = await resp.json();
      if (json.success) setHealth(json.data || {});
    } catch { /* ignore */ }
  };

  const resetCircuitBreaker = async (provider: string) => {
    try {
      await fetchBotApi('/api/providers/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider }),
      });
      await loadHealth();
    } catch { /* ignore */ }
  };

  const runTests = async () => {
    setTesting(true);
    setResults([]);
    try {
      const resp = await fetchBotApi('/api/providers/test');
      const json = await resp.json();
      if (json.success && Array.isArray(json.data)) {
        setResults(json.data);
        setTotalMs(json.totalMs || 0);
        setTestedAt(new Date().toLocaleTimeString('ru-RU'));
        setCurrentProvider(json.currentProvider || '');
      } else {
        setResults([{ provider: 'api', status: 'error', latencyMs: 0, error: json.error || 'Unknown error' }]);
      }
      await loadHealth();
    } catch (err) {
      setResults([{ provider: 'api', status: 'error', latencyMs: 0, error: err instanceof Error ? err.message : 'Network error' }]);
    } finally {
      setTesting(false);
    }
  };

  const statusBadge = (r: TestResult) => {
    if (r.status === 'ok') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-green-500/20 text-green-400"><CheckCircle className="w-3 h-3" /> OK</span>;
    if (r.status === 'skipped') return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-gray-500/20 text-gray-400"><AlertCircle className="w-3 h-3" /> Пропущен</span>;
    return <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-red-500/20 text-red-400"><AlertCircle className="w-3 h-3" /> Ошибка</span>;
  };

  const latencyColor = (ms: number) => {
    if (ms === 0) return 'text-gray-500';
    if (ms < 500) return 'text-green-400';
    if (ms < 2000) return 'text-amber-400';
    return 'text-red-400';
  };

  return (
    <div className="card mt-8">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Zap className="w-5 h-5 text-amber-400" />
          <h3 className="font-semibold text-lg">Тест соединений</h3>
        </div>
        <div className="flex items-center gap-3">
          {testedAt && <span className="text-xs text-gray-500">Проверено в {testedAt}</span>}
          <button
            type="button"
            onClick={runTests}
            disabled={testing}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-amber-500 to-orange-500 rounded-lg hover:from-amber-600 hover:to-orange-600 transition-all shadow-md disabled:opacity-50"
          >
            {testing ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Тестирую...</>
            ) : (
              <><Zap className="w-4 h-4" /> Тест всех провайдеров</>
            )}
          </button>
        </div>
      </div>

      {results.length > 0 && (
        <>
          {currentProvider && (
            <div className="mb-3 px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(255,215,0,0.08)', border: '1px solid rgba(255,215,0,0.15)' }}>
              Активный AI провайдер: <span className="font-semibold text-amber-400">{currentProvider}</span>
              {' • '}{results.filter(r => r.status === 'ok').length}/{results.length} сервисов работают
            </div>
          )}
          {/* Circuit breaker warnings */}
          {Object.entries(health).some(([, h]) => !h.available) && (
            <div className="mb-3 px-3 py-2 rounded-lg text-xs" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
              <span className="text-red-400 font-medium">⚡ Circuit breaker активен:</span>{' '}
              {Object.entries(health).filter(([, h]) => !h.available).map(([name, h]) => (
                <span key={name} className="text-red-300">
                  {name} ({h.lastFailureCode}, до {h.cooldownUntil ? new Date(h.cooldownUntil).toLocaleTimeString('ru-RU') : '?'})
                </span>
              )).reduce((prev, curr, i) => <>{prev}{i > 0 ? ', ' : ''}{curr}</> as any, <></>)}
            </div>
          )}
          <div className="space-y-2">
            {results.map((r) => {
              const display = PROVIDER_DISPLAY[r.provider] || { label: r.provider, icon: '❓' };
              return (
                <div
                  key={r.provider}
                  className="flex items-center justify-between py-2.5 px-3 rounded-lg"
                  style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)' }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-lg flex-shrink-0">{display.icon}</span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-200">{display.label}</p>
                      {r.model && (
                        <p className="text-xs text-gray-500 truncate">
                          {r.model}
                          {r.modelSource && <span className="text-gray-600"> ({r.modelSource})</span>}
                        </p>
                      )}
                      {r.detail && r.status === 'ok' && <p className="text-xs text-green-500/70 truncate">{r.detail}</p>}
                      {r.keySource && <p className="text-xs text-gray-600">Ключ: {r.keyPreview} — {r.keySource}</p>}
                      {r.tunnelUrl && (
                        <p className="text-xs text-gray-600 truncate">
                          Туннель: <span className="text-gray-400">{r.tunnelUrl}</span>
                          {r.healthSource && <span className="text-gray-500"> · {r.healthSource}</span>}
                          {r.heartbeatAt && <span className="text-gray-500"> · heartbeat {new Date(r.heartbeatAt).toLocaleTimeString('ru-RU')}</span>}
                        </p>
                      )}
                      {r.circuitBreaker && r.circuitBreaker.state !== 'closed' && (
                        <p className="text-xs text-red-400 mt-0.5">
                          ⚡ CB: {r.circuitBreaker.state} · {r.circuitBreaker.recentFailures} ошибок
                          {r.circuitBreaker.cooldownRemainingSec > 0 && ` · cooldown ${r.circuitBreaker.cooldownRemainingSec}с`}
                        </p>
                      )}
                      {r.diagnosis && r.status !== 'ok' && (
                        <p className="text-xs text-amber-400 mt-0.5">{r.diagnosis}</p>
                      )}
                      {r.error && r.status === 'error' && !r.diagnosis && (
                        <p className="text-xs text-red-400 truncate">{r.error.slice(0, 100)}</p>
                      )}
                      {/* Circuit breaker status */}
                      {(() => {
                        const hKey = r.provider === 'groq_chat' || r.provider === 'groq_whisper' ? 'groq' : r.provider;
                        const h = health[hKey];
                        if (!h) return null;
                        const parts: string[] = [];
                        if (h.rpm > 0) parts.push(`${h.rpm}/${h.rpmLimit} RPM`);
                        if (!h.available && h.cooldownUntil) parts.push(`⚡ circuit breaker до ${new Date(h.cooldownUntil).toLocaleTimeString('ru-RU')}`);
                        if (h.consecutiveFailures > 0 && h.available) parts.push(`${h.consecutiveFailures} ошибок подряд`);
                        if (parts.length === 0) return null;
                        return (
                          <div className="flex items-center gap-2 mt-0.5">
                            <p className={`text-xs ${!h.available ? 'text-red-400' : 'text-gray-500'}`}>{parts.join(' • ')}</p>
                            {!h.available && (
                              <button type="button" onClick={() => resetCircuitBreaker(hKey)}
                                className="text-xs px-1.5 py-0.5 rounded bg-red-500/20 hover:bg-red-500/30 text-red-400 transition-all">
                                сброс
                              </button>
                            )}
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0">
                    <span className={`text-sm font-mono ${latencyColor(r.latencyMs)}`}>
                      {r.latencyMs > 0 ? `${r.latencyMs}ms` : '—'}
                    </span>
                    {statusBadge(r)}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-3 pt-3 flex items-center justify-between text-xs text-gray-500" style={{ borderTop: '1px solid rgba(255,255,255,0.06)' }}>
            <span>Всего: {totalMs}ms параллельно</span>
            <span>
              {results.filter(r => r.status === 'ok').length}/{results.length} OK
            </span>
          </div>
        </>
      )}

      {results.length === 0 && !testing && (
        <p className="text-sm text-gray-500 text-center py-4">
          Нажмите «Тест всех провайдеров» для проверки соединений
        </p>
      )}
    </div>
  );
};

export default ApiKeysPage;
