import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { promptsApi, Prompt } from '../api/supabase';
import {
  Plus,
  Edit2,
  Trash2,
  Check,
  X,
  MessageSquare,
  Phone,
  Globe,
  Loader2,
} from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';

const PromptsPage = () => {
  const queryClient = useQueryClient();
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const { data: prompts, isLoading } = useQuery({
    queryKey: ['prompts'],
    queryFn: promptsApi.getAll,
  });

  const { mutate: createPrompt, isPending: isCreatingPrompt } = useMutation({
    mutationFn: promptsApi.create,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts'] });
      setIsCreating(false);
    },
  });

  const { mutate: updatePrompt, isPending: isUpdating } = useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Prompt>) =>
      promptsApi.update(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts'] });
      setEditingPrompt(null);
    },
  });

  const { mutate: deletePrompt } = useMutation({
    mutationFn: promptsApi.delete,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts'] });
    },
  });

  const { mutate: setActivePrompt } = useMutation({
    mutationFn: promptsApi.setActive,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prompts'] });
    },
  });

  const handleCreate = (data: { name: string; content: string; channel: Prompt['channel'] }) => {
    createPrompt({
      ...data,
      is_active: false,
    });
  };

  const channelIcons = {
    telegram: MessageSquare,
    voice: Phone,
    all: Globe,
  };

  const channelLabels = {
    telegram: 'Telegram',
    voice: 'Голос',
    all: 'Все каналы',
  };

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Промпты</h1>
          <p className="text-gray-600 mt-1">
            Системные промпты для AI ассистента
          </p>
        </div>
        <button
          onClick={() => setIsCreating(true)}
          className="btn-primary"
        >
          <Plus className="w-4 h-4 mr-2" />
          Новый промпт
        </button>
      </div>

      {/* Create Form */}
      {isCreating && (
        <div className="card mb-6">
          <PromptForm
            onSubmit={handleCreate}
            onCancel={() => setIsCreating(false)}
            isLoading={isCreatingPrompt}
          />
        </div>
      )}

      {/* Prompts List */}
      {isLoading ? (
        <div className="space-y-4">
          {[1, 2, 3].map((i) => (
            <div key={i} className="card animate-pulse">
              <div className="h-6 bg-white/10 rounded w-1/4 mb-4" />
              <div className="h-20 bg-white/10 rounded" />
            </div>
          ))}
        </div>
      ) : (
        <div className="space-y-4">
          {prompts?.map((prompt) => (
            <div
              key={prompt.id}
              className={`card ${prompt.is_active ? 'ring-2 ring-primary-500' : ''}`}
            >
              {editingPrompt?.id === prompt.id ? (
                <PromptForm
                  initialData={prompt}
                  onSubmit={(data) => updatePrompt({ id: prompt.id, ...data })}
                  onCancel={() => setEditingPrompt(null)}
                  isLoading={isUpdating}
                />
              ) : (
                <>
                  {/* Header */}
                  <div className="flex items-start justify-between mb-4">
                    <div className="flex items-center gap-3">
                      <h3 className="font-semibold text-lg">{prompt.name}</h3>
                      {prompt.is_active && (
                        <span className="px-2 py-0.5 text-xs font-medium bg-green-500/20 text-green-400 rounded-full">
                          Активен
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      {!prompt.is_active && (
                        <button
                          onClick={() => setActivePrompt(prompt.id)}
                          className="btn-secondary text-xs px-2 py-1"
                        >
                          <Check className="w-3 h-3 mr-1" />
                          Активировать
                        </button>
                      )}
                      <button
                        onClick={() => setEditingPrompt(prompt)}
                        className="p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg"
                      >
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => {
                          if (confirm('Удалить этот промпт?')) {
                            deletePrompt(prompt.id);
                          }
                        }}
                        className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  {/* Content */}
                  <pre className="whitespace-pre-wrap text-sm text-gray-300 bg-white/5 rounded-lg p-4 mb-4 font-sans">
                    {prompt.content}
                  </pre>

                  {/* Footer */}
                  <div className="flex items-center justify-between text-sm text-gray-500">
                    <div className="flex items-center gap-2">
                      {(() => {
                        const Icon = channelIcons[prompt.channel];
                        return <Icon className="w-4 h-4" />;
                      })()}
                      {channelLabels[prompt.channel]}
                    </div>
                    <span>
                      Обновлён {format(new Date(prompt.updated_at), 'd MMM yyyy, HH:mm', { locale: ru })}
                    </span>
                  </div>
                </>
              )}
            </div>
          ))}

          {prompts?.length === 0 && (
            <div className="card text-center py-12">
              <MessageSquare className="w-12 h-12 text-gray-300 mx-auto mb-4" />
              <p className="text-gray-500">Нет промптов</p>
              <button
                onClick={() => setIsCreating(true)}
                className="btn-primary mt-4"
              >
                <Plus className="w-4 h-4 mr-2" />
                Создать первый промпт
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// Prompt Form Component
const PromptForm = ({
  initialData,
  onSubmit,
  onCancel,
  isLoading,
}: {
  initialData?: Prompt;
  onSubmit: (data: { name: string; content: string; channel: Prompt['channel'] }) => void;
  onCancel: () => void;
  isLoading: boolean;
}) => {
  const [name, setName] = useState(initialData?.name ?? '');
  const [content, setContent] = useState(initialData?.content ?? '');
  const [channel, setChannel] = useState<Prompt['channel']>(initialData?.channel ?? 'all');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({ name, content, channel });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Название</label>
          <input
            type="text"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Название промпта"
            required
          />
        </div>
        <div>
          <label className="label">Канал</label>
          <select
            className="input"
            value={channel}
            onChange={(e) => setChannel(e.target.value as Prompt['channel'])}
          >
            <option value="all">Все каналы</option>
            <option value="telegram">Только Telegram</option>
            <option value="voice">Только голос</option>
          </select>
        </div>
      </div>
      <div>
        <label className="label">Содержимое промпта</label>
        <textarea
          className="input min-h-[200px] font-mono text-sm"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Ты — AI-ассистент..."
          required
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="btn-secondary">
          <X className="w-4 h-4 mr-2" />
          Отмена
        </button>
        <button type="submit" disabled={isLoading} className="btn-primary">
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Сохранение...
            </>
          ) : (
            <>
              <Check className="w-4 h-4 mr-2" />
              Сохранить
            </>
          )}
        </button>
      </div>
    </form>
  );
};

export default PromptsPage;
