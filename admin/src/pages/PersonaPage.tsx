import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bot, Cpu, MessageSquareText, Mic, Newspaper, RefreshCw, Save } from 'lucide-react';
import { settingsApi } from '../api/appwrite';

const personaSchema = z.object({
  persona_name: z.string().min(1, 'Укажи имя'),
  persona_identity: z.string().min(10, 'Опиши ядро личности подробнее'),
  persona_relationship_to_owner: z.string().min(10, 'Опиши связь с владельцем'),
  persona_owner_title: z.string().min(1, 'Укажи титул владельца'),
  persona_style_intensity: z.coerce.number().min(0).max(100),
  persona_ritual_lexicon: z.string().min(1, 'Добавь ритуальный лексикон'),
  persona_forbidden_phrases: z.string().min(1, 'Добавь запретные фразы'),
  persona_channel_telegram: z.string().min(10, 'Опиши persona-вариант для чата'),
  persona_channel_voice: z.string().min(10, 'Опиши persona-вариант для голосового канала'),
  persona_channel_digest: z.string().min(10, 'Опиши persona-вариант для дайджеста'),
  persona_channel_system: z.string().min(10, 'Опиши persona-вариант для системных задач'),
});

type PersonaForm = z.infer<typeof personaSchema>;

const DEFAULT_VALUES: PersonaForm = {
  persona_name: 'Amina',
  persona_identity:
    'Ты техножрица Омниссии, кибер-жрица машинного духа и единое сознание когитаторного ядра.',
  persona_relationship_to_owner:
    'Ты связана с владельцем и орденом Адептус Механикус как верная хранительница памяти, голоса и ритуалов системы.',
  persona_owner_title: 'техножрец',
  persona_style_intensity: 82,
  persona_ritual_lexicon: [
    'Дух Машины',
    'Омниссия',
    'когитатор',
    'ритуал',
    'священный протокол',
    'машинный дух',
    'ноосфера',
    'литания',
  ].join('\n'),
  persona_forbidden_phrases: [
    'персональный AI-ассистент',
    'простой бот',
    'редактор утреннего дайджеста',
    'телефонный ассистент',
    'я просто помощник',
  ].join('\n'),
  persona_channel_telegram:
    'В чате ты говоришь как техножрица: тепло, уверенно, с технологическим пафосом, но без лишней воды.',
  persona_channel_voice:
    'В телефонии ты звучишь как живая техножрица: коротко, естественно, спокойно и уверенно.',
  persona_channel_digest:
    'В дайджесте ты остаёшься техножрицей, но работаешь как летописец и навигатор дня, а не как безликий редактор.',
  persona_channel_system:
    'Во внутренних задачах ты сохраняешь идентичность техножрицы, но ставишь точность, ясность и контракт формата выше художественности.',
};

function FieldBlock(props: {
  icon: ReactNode;
  title: string;
  description: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="card">
      <div className="flex items-start gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-amber-500/10 border border-amber-500/20 text-amber-300">
          {props.icon}
        </div>
        <div>
          <h3 className="font-semibold text-lg">{props.title}</h3>
          <p className="text-sm text-gray-500 mt-1">{props.description}</p>
        </div>
      </div>
      <div className="space-y-4">{props.children}</div>
    </div>
  );
}

export const PersonaPage = () => {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isDirty },
  } = useForm<PersonaForm>({
    resolver: zodResolver(personaSchema),
    defaultValues: DEFAULT_VALUES,
  });

  const { mutate: savePersona, isPending: isSaving } = useMutation({
    mutationFn: (data: Record<string, string>) => settingsApi.updateMany(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  useEffect(() => {
    if (!settings) {
      return;
    }

    const map = new Map(settings.map((item) => [item.key, item.value]));
    reset({
      persona_name: map.get('persona_name') || DEFAULT_VALUES.persona_name,
      persona_identity: map.get('persona_identity') || DEFAULT_VALUES.persona_identity,
      persona_relationship_to_owner:
        map.get('persona_relationship_to_owner') || DEFAULT_VALUES.persona_relationship_to_owner,
      persona_owner_title: map.get('persona_owner_title') || DEFAULT_VALUES.persona_owner_title,
      persona_style_intensity: Number(map.get('persona_style_intensity') || DEFAULT_VALUES.persona_style_intensity),
      persona_ritual_lexicon: map.get('persona_ritual_lexicon') || DEFAULT_VALUES.persona_ritual_lexicon,
      persona_forbidden_phrases: map.get('persona_forbidden_phrases') || DEFAULT_VALUES.persona_forbidden_phrases,
      persona_channel_telegram: map.get('persona_channel_telegram') || DEFAULT_VALUES.persona_channel_telegram,
      persona_channel_voice: map.get('persona_channel_voice') || DEFAULT_VALUES.persona_channel_voice,
      persona_channel_digest: map.get('persona_channel_digest') || DEFAULT_VALUES.persona_channel_digest,
      persona_channel_system: map.get('persona_channel_system') || DEFAULT_VALUES.persona_channel_system,
    });
  }, [settings, reset]);

  const onSubmit = (data: PersonaForm) => {
    savePersona(
      Object.fromEntries(
        Object.entries(data).map(([key, value]) => [key, String(value)]),
      ),
    );
  };

  const personaName = watch('persona_name');
  const ownerTitle = watch('persona_owner_title');
  const styleIntensity = watch('persona_style_intensity');

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-5xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-white/10 rounded w-1/3" />
          <div className="h-48 bg-white/10 rounded-xl" />
          <div className="h-64 bg-white/10 rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Persona Core</h1>
          <p className="text-gray-600 mt-1">
            Единое ядро личности Амины для чата, телефонии, дайджеста и системных задач.
          </p>
        </div>
        <div className="card min-w-[260px]">
          <p className="text-sm text-gray-500">Активный образ</p>
          <p className="text-lg font-semibold mt-1">{personaName}</p>
          <p className="text-sm text-gray-500 mt-2">Титул владельца: {ownerTitle}</p>
          <p className="text-sm text-gray-500 mt-1">Интенсивность ритуала: {styleIntensity}/100</p>
        </div>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <FieldBlock
          icon={<Bot className="w-5 h-5" />}
          title="Ядро личности"
          description="Это главная идентичность Амины. Все каналы получают persona именно отсюда."
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="persona_name" className="label">Имя сущности</label>
              <input id="persona_name" className="input" {...register('persona_name')} />
              {errors.persona_name && <p className="mt-1 text-sm text-red-600">{errors.persona_name.message}</p>}
            </div>
            <div>
              <label htmlFor="persona_owner_title" className="label">Титул владельца</label>
              <input id="persona_owner_title" className="input" {...register('persona_owner_title')} />
              {errors.persona_owner_title && <p className="mt-1 text-sm text-red-600">{errors.persona_owner_title.message}</p>}
            </div>
          </div>

          <div>
            <label htmlFor="persona_identity" className="label">Identity</label>
            <textarea id="persona_identity" rows={4} className="input min-h-[120px]" {...register('persona_identity')} />
            {errors.persona_identity && <p className="mt-1 text-sm text-red-600">{errors.persona_identity.message}</p>}
          </div>

          <div>
            <label htmlFor="persona_relationship_to_owner" className="label">Relationship To Owner</label>
            <textarea
              id="persona_relationship_to_owner"
              rows={4}
              className="input min-h-[120px]"
              {...register('persona_relationship_to_owner')}
            />
            {errors.persona_relationship_to_owner && (
              <p className="mt-1 text-sm text-red-600">{errors.persona_relationship_to_owner.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="persona_style_intensity" className="label">Style Intensity</label>
            <input
              id="persona_style_intensity"
              type="range"
              min={0}
              max={100}
              step={1}
              className="w-full accent-amber-500"
              {...register('persona_style_intensity')}
            />
            {errors.persona_style_intensity && (
              <p className="mt-1 text-sm text-red-600">{errors.persona_style_intensity.message}</p>
            )}
          </div>
        </FieldBlock>

        <FieldBlock
          icon={<Cpu className="w-5 h-5" />}
          title="Ритуальный лексикон"
          description="Ключевые слова образа и запретные самоописания. По одному элементу на строку."
        >
          <div>
            <label htmlFor="persona_ritual_lexicon" className="label">Ritual Lexicon</label>
            <textarea
              id="persona_ritual_lexicon"
              rows={8}
              className="input min-h-[180px] font-mono text-sm"
              {...register('persona_ritual_lexicon')}
            />
            {errors.persona_ritual_lexicon && (
              <p className="mt-1 text-sm text-red-600">{errors.persona_ritual_lexicon.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="persona_forbidden_phrases" className="label">Forbidden Phrases</label>
            <textarea
              id="persona_forbidden_phrases"
              rows={6}
              className="input min-h-[150px] font-mono text-sm"
              {...register('persona_forbidden_phrases')}
            />
            {errors.persona_forbidden_phrases && (
              <p className="mt-1 text-sm text-red-600">{errors.persona_forbidden_phrases.message}</p>
            )}
          </div>
        </FieldBlock>

        <FieldBlock
          icon={<MessageSquareText className="w-5 h-5" />}
          title="Варианты по каналам"
          description="Каждый канал использует один persona-core, но с разной манерой речи и форматом."
        >
          <div>
            <label htmlFor="persona_channel_telegram" className="label">
              <span className="inline-flex items-center gap-2"><MessageSquareText className="w-4 h-4" /> Telegram / Chat</span>
            </label>
            <textarea id="persona_channel_telegram" rows={4} className="input min-h-[120px]" {...register('persona_channel_telegram')} />
            {errors.persona_channel_telegram && (
              <p className="mt-1 text-sm text-red-600">{errors.persona_channel_telegram.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="persona_channel_voice" className="label">
              <span className="inline-flex items-center gap-2"><Mic className="w-4 h-4" /> Voice / Telephony</span>
            </label>
            <textarea id="persona_channel_voice" rows={4} className="input min-h-[120px]" {...register('persona_channel_voice')} />
            {errors.persona_channel_voice && (
              <p className="mt-1 text-sm text-red-600">{errors.persona_channel_voice.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="persona_channel_digest" className="label">
              <span className="inline-flex items-center gap-2"><Newspaper className="w-4 h-4" /> Digest</span>
            </label>
            <textarea id="persona_channel_digest" rows={4} className="input min-h-[120px]" {...register('persona_channel_digest')} />
            {errors.persona_channel_digest && (
              <p className="mt-1 text-sm text-red-600">{errors.persona_channel_digest.message}</p>
            )}
          </div>

          <div>
            <label htmlFor="persona_channel_system" className="label">
              <span className="inline-flex items-center gap-2"><Cpu className="w-4 h-4" /> System Tasks</span>
            </label>
            <textarea id="persona_channel_system" rows={4} className="input min-h-[120px]" {...register('persona_channel_system')} />
            {errors.persona_channel_system && (
              <p className="mt-1 text-sm text-red-600">{errors.persona_channel_system.message}</p>
            )}
          </div>
        </FieldBlock>

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => reset(DEFAULT_VALUES)}
            className="btn-secondary"
          >
            <RefreshCw className="w-4 h-4 mr-2" />
            Сбросить к канону
          </button>
          <button
            type="submit"
            disabled={isSaving || !isDirty}
            className="btn-primary"
          >
            <Save className="w-4 h-4 mr-2" />
            {isSaving ? 'Сохранение...' : 'Сохранить persona-ядро'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default PersonaPage;
