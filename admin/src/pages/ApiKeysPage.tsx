import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import { Save, Loader2, Key, Eye, EyeOff, CheckCircle, AlertCircle, Info, RefreshCw, Globe } from 'lucide-react';

// Schema
const apiKeysSchema = z.object({
  telegram_bot_token: z.string().optional(),
  openrouter_api_key: z.string().optional(),
  groq_api_key: z.string().optional(),
  perplexity_api_key: z.string().optional(),
  web_search_enabled: z.string().optional(),
});

type ApiKeysForm = z.infer<typeof apiKeysSchema>;

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
      setSaveMessage('✅ API ключи сохранены!');
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
    },
  });

  const telegramKey = watch('telegram_bot_token');
  const openRouterKey = watch('openrouter_api_key');
  const groqKey = watch('groq_api_key');
  const perplexityKey = watch('perplexity_api_key');
  const webSearchEnabled = watch('web_search_enabled');

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
    });
  };

  // Маскировать ключ для отображения
  const maskKey = (key: string | undefined): string => {
    if (!key || key.length < 10) return '••••••••';
    return key.substring(0, 6) + '••••••••' + key.substring(key.length - 4);
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
        <h1 className="text-2xl font-bold text-gray-900">API Ключи</h1>
        <p className="text-gray-600 mt-1">
          Настройте ключи для AI сервисов. Можно задать здесь или в Render.
        </p>
      </div>

      {/* В Render только 2 переменные */}
      <div className="mb-6 p-4 bg-amber-50 rounded-xl border border-amber-200">
        <h3 className="font-semibold text-amber-900 mb-2">В Render задайте только 2 переменные</h3>
        <p className="text-sm text-amber-800 mb-2">
          Без них бот не подключится к базе данных. Остальное настраивается здесь.
        </p>
        <div className="space-y-1 text-sm font-mono text-amber-900 bg-white/50 p-3 rounded mb-2">
          <div>SUPABASE_URL — URL вашего проекта Supabase</div>
          <div>SUPABASE_SERVICE_KEY — ключ service_role из Supabase → Settings → API</div>
        </div>
        <p className="text-xs text-amber-700">
          При первом запуске, если бот ещё не работал, задайте в Render также <code className="bg-white/70 px-1 rounded">TELEGRAM_BOT_TOKEN</code>, 
          сохраните его здесь, затем можно удалить из Render — бот будет брать токен из админки.
        </p>
      </div>

      {/* Info */}
      <div className="mb-6 p-4 bg-blue-50 rounded-xl flex items-start gap-3">
        <Info className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
        <div className="text-sm text-blue-800">
          <p className="font-medium mb-1">Как это работает:</p>
          <ul className="space-y-1 text-blue-700">
            <li>• В Render обязательны только SUPABASE_URL и SUPABASE_SERVICE_KEY</li>
            <li>• Все ключи ниже можно задать здесь — бот подхватит их при старте</li>
          </ul>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        
        {/* Telegram Bot Token */}
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 bg-sky-100 rounded-xl">
              <Key className="w-6 h-6 text-sky-600" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-gray-900">Telegram Bot Token</h2>
              <p className="text-sm text-gray-500">Обязателен для работы бота</p>
            </div>
            {telegramKey && (
              <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                Задан
              </span>
            )}
          </div>

          <div className="relative">
            <input
              type={showTelegram ? 'text' : 'password'}
              placeholder="123456:ABC..."
              className="input bg-white text-gray-900 pr-12 font-mono text-sm"
              style={{ colorScheme: 'light' }}
              {...register('telegram_bot_token')}
            />
            <button
              type="button"
              onClick={() => setShowTelegram(!showTelegram)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showTelegram ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>

          <p className="mt-2 text-xs text-gray-500">
            Получить токен: напишите <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">@BotFather</a> в Telegram → /newbot
          </p>
        </div>

        {/* OpenRouter API Key */}
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 bg-green-100 rounded-xl">
              <Key className="w-6 h-6 text-green-600" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-gray-900">OpenRouter API Key</h2>
              <p className="text-sm text-gray-500">Для AI моделей (обязателен)</p>
            </div>
            {openRouterKey && (
              <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                Задан
              </span>
            )}
          </div>

          <div className="relative">
            <input
              type={showOpenRouter ? 'text' : 'password'}
              placeholder="sk-or-v1-..."
              className="input bg-white text-gray-900 pr-12 font-mono text-sm"
              style={{ colorScheme: 'light' }}
              {...register('openrouter_api_key')}
            />
            <button
              type="button"
              onClick={() => setShowOpenRouter(!showOpenRouter)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showOpenRouter ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>

          <p className="mt-2 text-xs text-gray-500">
            Получить ключ: <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">openrouter.ai/keys</a>
          </p>
        </div>

        {/* Groq API Key */}
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 bg-purple-100 rounded-xl">
              <Key className="w-6 h-6 text-purple-600" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-gray-900">Groq API Key</h2>
              <p className="text-sm text-gray-500">Для бесплатной транскрипции голоса</p>
            </div>
            {groqKey && (
              <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                Задан
              </span>
            )}
          </div>

          <div className="relative">
            <input
              type={showGroq ? 'text' : 'password'}
              placeholder="gsk_..."
              className="input bg-white text-gray-900 pr-12 font-mono text-sm"
              style={{ colorScheme: 'light' }}
              {...register('groq_api_key')}
            />
            <button
              type="button"
              onClick={() => setShowGroq(!showGroq)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showGroq ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>

          <p className="mt-2 text-xs text-gray-500">
            Получить ключ: <a href="https://console.groq.com/keys" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">console.groq.com/keys</a>
          </p>

          <div className="mt-3 p-3 bg-green-50 rounded-lg">
            <p className="text-sm text-green-700">
              <span className="font-medium">Бесплатно!</span> Groq Whisper позволяет бесплатно транскрибировать голосовые сообщения.
            </p>
          </div>
        </div>

        {/* Perplexity API Key */}
        <div className="card border-2 border-indigo-200 bg-gradient-to-br from-indigo-50 to-purple-50">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2.5 bg-indigo-100 rounded-xl">
              <Globe className="w-6 h-6 text-indigo-600" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-semibold text-gray-900">Perplexity API Key</h2>
              <p className="text-sm text-gray-500">Доступ в интернет для поиска информации</p>
            </div>
            {perplexityKey && (
              <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded-full">
                Задан
              </span>
            )}
          </div>

          <div className="relative">
            <input
              type={showPerplexity ? 'text' : 'password'}
              placeholder="pplx-..."
              className="input bg-white text-gray-900 pr-12 font-mono text-sm"
              style={{ colorScheme: 'light' }}
              {...register('perplexity_api_key')}
            />
            <button
              type="button"
              onClick={() => setShowPerplexity(!showPerplexity)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              {showPerplexity ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
            </button>
          </div>

          <p className="mt-2 text-xs text-gray-500">
            Получить ключ: <a href="https://www.perplexity.ai/settings/api" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">perplexity.ai/settings/api</a>
          </p>

          {/* Web Search Toggle */}
          <div className="mt-4 p-4 bg-white rounded-lg border border-indigo-100">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-medium text-gray-900">Автоматический веб-поиск</h3>
                <p className="text-sm text-gray-500">Бот сам будет искать в интернете при необходимости</p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={webSearchEnabled === 'true'}
                  onChange={(e) => setValue('web_search_enabled', e.target.checked ? 'true' : 'false', { shouldDirty: true })}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
              </label>
            </div>
          </div>

          <div className="mt-3 p-3 bg-indigo-100 rounded-lg">
            <p className="text-sm text-indigo-800">
              <span className="font-medium">🌐 Веб-поиск</span> — бот сможет искать актуальную информацию: новости, погоду, курсы валют и т.д.
              <br />
              <span className="text-xs">Команда /search доступна всегда, авто-поиск — при включении переключателя.</span>
            </p>
          </div>
        </div>

        {/* Что в Render */}
        <div className="card bg-gradient-to-br from-green-50 to-emerald-50">
          <h3 className="font-semibold text-gray-900 mb-3">В Render только 2 переменные</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-green-600">●</span>
              <span className="text-gray-700"><code className="bg-white px-1 rounded">SUPABASE_URL</code></span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-green-600">●</span>
              <span className="text-gray-700"><code className="bg-white px-1 rounded">SUPABASE_SERVICE_KEY</code></span>
            </div>
          </div>
          <p className="mt-3 text-xs text-gray-600">
            Остальное (Telegram, OpenRouter, Groq, Perplexity) настраивается на этой странице.
          </p>
        </div>

        {/* Save */}
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

export default ApiKeysPage;
