import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Edit2, Globe, Loader2, MessageSquare, Phone, Plus, Trash2, X } from 'lucide-react';
import { format } from 'date-fns';
import { ru } from 'date-fns/locale';
import type { Prompt } from '../../api/appwrite';
import { promptsApi } from '../../api/appwrite';

function PromptForm(props: {
  initialData?: Prompt;
  isLoading: boolean;
  onCancel: () => void;
  onSubmit: (data: { name: string; content: string; channel: Prompt['channel'] }) => void;
}): JSX.Element {
  const [name, setName] = useState(props.initialData?.name ?? '');
  const [content, setContent] = useState(props.initialData?.content ?? '');
  const [channel, setChannel] = useState<Prompt['channel']>(props.initialData?.channel ?? 'all');

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit({ name, content, channel });
      }}
      className="space-y-4"
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="label">Название</label>
          <input type="text" className="input" value={name} onChange={(event) => setName(event.target.value)} required />
        </div>
        <div>
          <label className="label">Канал</label>
          <select className="input" value={channel} onChange={(event) => setChannel(event.target.value as Prompt['channel'])}>
            <option value="all">Все каналы</option>
            <option value="telegram">Только Telegram</option>
            <option value="voice">Только голос</option>
          </select>
        </div>
      </div>
      <div>
        <label className="label">Содержимое prompt layer</label>
        <textarea
          className="input min-h-[180px] font-mono text-sm"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          required
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={props.onCancel} className="btn-secondary">
          <X className="w-4 h-4 mr-2" />
          Отмена
        </button>
        <button type="submit" disabled={props.isLoading} className="btn-primary">
          {props.isLoading ? (
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
}

export function PromptLayersSection(props: {
  onStatus: (message: string) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null);
  const { data: prompts = [], isLoading } = useQuery({
    queryKey: ['prompts'],
    queryFn: promptsApi.getAll,
  });

  const refreshAll = (): void => {
    queryClient.invalidateQueries({ queryKey: ['prompts'] });
    queryClient.invalidateQueries({ queryKey: ['self-core'] });
  };

  const createMutation = useMutation({
    mutationFn: promptsApi.create,
    onSuccess: () => {
      props.onStatus('Новый prompt layer сохранён');
      setIsCreating(false);
      refreshAll();
    },
  });
  const updateMutation = useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Prompt>) => promptsApi.update(id, data),
    onSuccess: () => {
      props.onStatus('Prompt layer обновлён');
      setEditingPrompt(null);
      refreshAll();
    },
  });
  const deleteMutation = useMutation({
    mutationFn: promptsApi.delete,
    onSuccess: () => {
      props.onStatus('Prompt layer удалён');
      refreshAll();
    },
  });
  const activateMutation = useMutation({
    mutationFn: promptsApi.setActive,
    onSuccess: () => {
      props.onStatus('Активный prompt layer обновлён');
      refreshAll();
    },
  });

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
    <div className="card space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Prompt Layers</h2>
          <p className="text-sm text-gray-500 mt-1">
            Полный CRUD операторских prompt layers прямо в `Self Core` с записью в `amina_prompts`.
          </p>
        </div>
        <button type="button" onClick={() => setIsCreating(true)} className="btn-primary">
          <Plus className="w-4 h-4 mr-2" />
          Новый prompt
        </button>
      </div>

      {isCreating && (
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
          <PromptForm
            isLoading={createMutation.isPending}
            onCancel={() => setIsCreating(false)}
            onSubmit={(data) => createMutation.mutate({ ...data, is_active: false })}
          />
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-gray-400">Загружаю prompt layers...</div>
      ) : prompts.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-white/10 p-6 text-sm text-gray-400">
          В Appwrite пока нет prompt layers.
        </div>
      ) : (
        <div className="space-y-4">
          {prompts.map((prompt) => (
            <div key={prompt.id} className={`rounded-2xl border p-4 ${prompt.is_active ? 'border-primary-500/40 bg-primary-500/5' : 'border-white/10 bg-white/[0.02]'}`}>
              {editingPrompt?.id === prompt.id ? (
                <PromptForm
                  initialData={prompt}
                  isLoading={updateMutation.isPending}
                  onCancel={() => setEditingPrompt(null)}
                  onSubmit={(data) => updateMutation.mutate({ id: prompt.id, ...data })}
                />
              ) : (
                <>
                  <div className="flex items-start justify-between gap-4 mb-4">
                    <div>
                      <div className="flex items-center gap-3">
                        <p className="font-semibold text-lg">{prompt.name}</p>
                        {prompt.is_active && (
                          <span className="px-2 py-0.5 text-xs font-medium bg-green-500/20 text-green-400 rounded-full">
                            Активен
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 mt-2">
                        {prompt.channel === 'all' ? 'Global layer' : `Layer: ${channelLabels[prompt.channel]}`} · Обновлён {format(new Date(prompt.updated_at), 'd MMM yyyy, HH:mm', { locale: ru })}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      {!prompt.is_active && (
                        <button
                          type="button"
                          className="btn-secondary text-xs px-2 py-1"
                          disabled={activateMutation.isPending}
                          onClick={() => activateMutation.mutate(prompt.id)}
                        >
                          <Check className="w-3 h-3 mr-1" />
                          Активировать в канале
                        </button>
                      )}
                      <button type="button" className="p-2 text-gray-400 hover:text-white hover:bg-white/10 rounded-lg" onClick={() => setEditingPrompt(prompt)}>
                        <Edit2 className="w-4 h-4" />
                      </button>
                      <button
                        type="button"
                        className="p-2 text-gray-400 hover:text-red-400 hover:bg-red-500/10 rounded-lg"
                        onClick={() => {
                          if (confirm('Удалить этот prompt layer?')) {
                            deleteMutation.mutate(prompt.id);
                          }
                        }}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-sm text-gray-500 mb-3">
                    {(() => {
                      const Icon = channelIcons[prompt.channel];
                      return <Icon className="w-4 h-4" />;
                    })()}
                    <span>{channelLabels[prompt.channel]}</span>
                  </div>
                  <pre className="whitespace-pre-wrap text-sm text-gray-300 bg-white/5 rounded-lg p-4 font-sans">
                    {prompt.content}
                  </pre>
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
