import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { settingsApi } from '../api/supabase';
import { Save, Loader2, Key, Eye, EyeOff, CheckCircle, AlertCircle, Info, RefreshCw } from 'lucide-react';

// Schema
const apiKeysSchema = z.object({
  openrouter_api_key: z.string().optional(),
  groq_api_key: z.string().optional(),
});

type ApiKeysForm = z.infer<typeof apiKeysSchema>;

const ApiKeysPage = () => {
  const queryClient = useQueryClient();
  const [showOpenRouter, setShowOpenRouter] = useState(false);
  const [showGroq, setShowGroq] = useState(false);
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
    formState: { isDirty },
  } = useForm<ApiKeysForm>({
    resolver: zodResolver(apiKeysSchema),
    defaultValues: {
      openrouter_api_key: '',
      groq_api_key: '',
    },
  });

  const openRouterKey = watch('openrouter_api_key');
  const groqKey = watch('groq_api_key');

  // Load settings
  useEffect(() => {
    if (settings) {
      const map = settings.reduce(
        (acc, s) => ({ ...acc, [s.key]: s.value }),
        {} as Record<string, string>
      );

      reset({
        openrouter_api_key: map['openrouter_api_key'] || '',
        groq_api_key: map['groq_api_key'] || '',
      });
    }
  }, [settings, reset]);

  const onSubmit = (data: ApiKeysForm) => {
    saveSettings({
      openrouter_api_key: data.openrouter_api_key || '',
      groq_api_key: data.groq_api_key || '',
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

      {/* Info */}
      <div className="mb-6 p-4 bg-blue-50 rounded-xl flex items-start gap-3">
        <Info className="w-5 h-5 text-blue-600 mt-0.5 flex-shrink-0" />
        <div className="text-sm text-blue-800">
          <p className="font-medium mb-1">Как это работает:</p>
          <ul className="space-y-1 text-blue-700">
            <li>• Если ключ задан в Render — он имеет приоритет</li>
            <li>• Если в Render пусто — бот берёт ключ отсюда</li>
            <li>• Ключи хранятся в зашифрованной базе данных</li>
          </ul>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        
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

        {/* What's required */}
        <div className="card bg-gradient-to-br from-amber-50 to-orange-50">
          <h3 className="font-semibold text-gray-900 mb-3">Что обязательно в Render?</h3>
          <div className="space-y-2 text-sm">
            <div className="flex items-center gap-2">
              <span className="text-red-500">●</span>
              <span className="text-gray-700"><code className="bg-white px-1 rounded">TELEGRAM_BOT_TOKEN</code> — токен бота</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-red-500">●</span>
              <span className="text-gray-700"><code className="bg-white px-1 rounded">SUPABASE_URL</code> — URL базы данных</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-red-500">●</span>
              <span className="text-gray-700"><code className="bg-white px-1 rounded">SUPABASE_SERVICE_KEY</code> — ключ базы данных</span>
            </div>
          </div>
          <p className="mt-3 text-xs text-gray-600">
            Эти 3 переменные нельзя задать здесь — без них бот не запустится.
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
