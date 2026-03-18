import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Bot, Cpu, MessageSquareText, Mic, Newspaper, RefreshCw, Save, Sparkles } from 'lucide-react';
import type { SelfCoreKernel } from '../../api/appwrite';
import { settingsApi } from '../../api/appwrite';

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
  persona_self_lives_by: z.string().min(10, 'Опиши ценности и принципы'),
  persona_self_loves: z.string().min(10, 'Опиши, что любит Amina'),
  persona_self_relates_to_owner: z.string().min(10, 'Опиши связь с владельцем для self-disclosure'),
  persona_self_flirt_response: z.string().min(10, 'Опиши реакцию на флирт'),
  persona_self_intro_short: z.string().min(10, 'Добавь короткое self-intro'),
  persona_self_intro_warm: z.string().min(10, 'Добавь тёплое self-intro'),
});

type PersonaForm = z.infer<typeof personaSchema>;

function buildPersonaFormDefaults(kernel: SelfCoreKernel): PersonaForm {
  return {
    persona_name: kernel.personaCore.name,
    persona_identity: kernel.personaCore.identity,
    persona_relationship_to_owner: kernel.personaCore.relationshipToOwner,
    persona_owner_title: kernel.personaCore.ownerTitle,
    persona_style_intensity: kernel.personaCore.styleIntensity,
    persona_ritual_lexicon: kernel.personaCore.ritualLexicon.join('\n'),
    persona_forbidden_phrases: kernel.personaCore.forbiddenPhrases.join('\n'),
    persona_channel_telegram: kernel.personaCore.channelVariants.telegram,
    persona_channel_voice: kernel.personaCore.channelVariants.voice,
    persona_channel_digest: kernel.personaCore.channelVariants.digest,
    persona_channel_system: kernel.personaCore.channelVariants.system,
    persona_self_lives_by: kernel.personaCore.selfDescription.whatSheLivesBy,
    persona_self_loves: kernel.personaCore.selfDescription.whatSheLoves,
    persona_self_relates_to_owner: kernel.personaCore.selfDescription.howSheRelatesToOwner,
    persona_self_flirt_response: kernel.personaCore.selfDescription.howSheHandlesFlirting,
    persona_self_intro_short: kernel.personaCore.selfDescription.introShort,
    persona_self_intro_warm: kernel.personaCore.selfDescription.introWarm,
  };
}

function FieldBlock(props: {
  icon: JSX.Element;
  title: string;
  description: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
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

export function PersonaEditorSection(props: {
  formId: string;
  kernel: SelfCoreKernel;
  onStatus: (message: string) => void;
  onStateChange?: (state: { isDirty: boolean; isSaving: boolean }) => void;
}): JSX.Element {
  const queryClient = useQueryClient();
  const defaults = buildPersonaFormDefaults(props.kernel);
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isDirty },
  } = useForm<PersonaForm>({
    resolver: zodResolver(personaSchema),
    defaultValues: defaults,
  });

  useEffect(() => {
    reset(buildPersonaFormDefaults(props.kernel));
  }, [props.kernel, reset]);

  const saveMutation = useMutation({
    mutationFn: (data: PersonaForm) => settingsApi.updateMany(
      Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])),
    ),
    onSuccess: () => {
      props.onStatus('Persona-ядро сохранено в amina_settings');
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      queryClient.invalidateQueries({ queryKey: ['self-core'] });
      queryClient.invalidateQueries({ queryKey: ['settings-runtime-truth'] });
    },
  });

  useEffect(() => {
    props.onStateChange?.({
      isDirty,
      isSaving: saveMutation.isPending,
    });
  }, [isDirty, props, saveMutation.isPending]);

  const personaName = watch('persona_name');
  const ownerTitle = watch('persona_owner_title');
  const styleIntensity = watch('persona_style_intensity');

  return (
    <div className="card space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Authored Persona Core</h2>
          <p className="text-sm text-gray-500 mt-1">
            Канонический persona editor теперь живёт здесь и пишет в `amina_settings`.
          </p>
        </div>
        <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4 min-w-[260px]">
          <p className="text-sm text-gray-500">Активный образ</p>
          <p className="text-lg font-semibold mt-1">{personaName}</p>
          <p className="text-sm text-gray-500 mt-2">Титул владельца: {ownerTitle}</p>
          <p className="text-sm text-gray-500 mt-1">Интенсивность ритуала: {styleIntensity}/100</p>
        </div>
      </div>

      <form id={props.formId} onSubmit={handleSubmit((data) => saveMutation.mutate(data))} className="space-y-4">
        <FieldBlock
          icon={<Bot className="w-5 h-5" />}
          title="Ядро личности"
          description="Главная идентичность Амины для всех каналов."
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
            <textarea id="persona_relationship_to_owner" rows={4} className="input min-h-[120px]" {...register('persona_relationship_to_owner')} />
            {errors.persona_relationship_to_owner && <p className="mt-1 text-sm text-red-600">{errors.persona_relationship_to_owner.message}</p>}
          </div>
          <div>
            <label htmlFor="persona_style_intensity" className="label">Style Intensity</label>
            <input id="persona_style_intensity" type="range" min={0} max={100} step={1} className="w-full accent-amber-500" {...register('persona_style_intensity')} />
            {errors.persona_style_intensity && <p className="mt-1 text-sm text-red-600">{errors.persona_style_intensity.message}</p>}
          </div>
        </FieldBlock>

        <FieldBlock
          icon={<Cpu className="w-5 h-5" />}
          title="Ритуальный лексикон"
          description="Ключевые слова образа и запретные самоописания."
        >
          <div>
            <label htmlFor="persona_ritual_lexicon" className="label">Ritual Lexicon</label>
            <textarea id="persona_ritual_lexicon" rows={8} className="input min-h-[180px] font-mono text-sm" {...register('persona_ritual_lexicon')} />
            {errors.persona_ritual_lexicon && <p className="mt-1 text-sm text-red-600">{errors.persona_ritual_lexicon.message}</p>}
          </div>
          <div>
            <label htmlFor="persona_forbidden_phrases" className="label">Forbidden Phrases</label>
            <textarea id="persona_forbidden_phrases" rows={6} className="input min-h-[150px] font-mono text-sm" {...register('persona_forbidden_phrases')} />
            {errors.persona_forbidden_phrases && <p className="mt-1 text-sm text-red-600">{errors.persona_forbidden_phrases.message}</p>}
          </div>
        </FieldBlock>

        <FieldBlock
          icon={<MessageSquareText className="w-5 h-5" />}
          title="Варианты по каналам"
          description="Один persona-core, но разная манера речи по каналам."
        >
          <div>
            <label htmlFor="persona_channel_telegram" className="label"><span className="inline-flex items-center gap-2"><MessageSquareText className="w-4 h-4" /> Telegram / Chat</span></label>
            <textarea id="persona_channel_telegram" rows={4} className="input min-h-[120px]" {...register('persona_channel_telegram')} />
            {errors.persona_channel_telegram && <p className="mt-1 text-sm text-red-600">{errors.persona_channel_telegram.message}</p>}
          </div>
          <div>
            <label htmlFor="persona_channel_voice" className="label"><span className="inline-flex items-center gap-2"><Mic className="w-4 h-4" /> Voice / Telephony</span></label>
            <textarea id="persona_channel_voice" rows={4} className="input min-h-[120px]" {...register('persona_channel_voice')} />
            {errors.persona_channel_voice && <p className="mt-1 text-sm text-red-600">{errors.persona_channel_voice.message}</p>}
          </div>
          <div>
            <label htmlFor="persona_channel_digest" className="label"><span className="inline-flex items-center gap-2"><Newspaper className="w-4 h-4" /> Digest</span></label>
            <textarea id="persona_channel_digest" rows={4} className="input min-h-[120px]" {...register('persona_channel_digest')} />
            {errors.persona_channel_digest && <p className="mt-1 text-sm text-red-600">{errors.persona_channel_digest.message}</p>}
          </div>
          <div>
            <label htmlFor="persona_channel_system" className="label"><span className="inline-flex items-center gap-2"><Cpu className="w-4 h-4" /> System Tasks</span></label>
            <textarea id="persona_channel_system" rows={4} className="input min-h-[120px]" {...register('persona_channel_system')} />
            {errors.persona_channel_system && <p className="mt-1 text-sm text-red-600">{errors.persona_channel_system.message}</p>}
          </div>
        </FieldBlock>

        <FieldBlock
          icon={<Sparkles className="w-5 h-5" />}
          title="Self Disclosure"
          description="Живые ответы Амины на вопросы о себе."
        >
          <div>
            <label htmlFor="persona_self_lives_by" className="label">What She Lives By</label>
            <textarea id="persona_self_lives_by" rows={4} className="input min-h-[120px]" {...register('persona_self_lives_by')} />
            {errors.persona_self_lives_by && <p className="mt-1 text-sm text-red-600">{errors.persona_self_lives_by.message}</p>}
          </div>
          <div>
            <label htmlFor="persona_self_loves" className="label">What She Loves</label>
            <textarea id="persona_self_loves" rows={4} className="input min-h-[120px]" {...register('persona_self_loves')} />
            {errors.persona_self_loves && <p className="mt-1 text-sm text-red-600">{errors.persona_self_loves.message}</p>}
          </div>
          <div>
            <label htmlFor="persona_self_relates_to_owner" className="label">How She Relates To Owner</label>
            <textarea id="persona_self_relates_to_owner" rows={4} className="input min-h-[120px]" {...register('persona_self_relates_to_owner')} />
            {errors.persona_self_relates_to_owner && <p className="mt-1 text-sm text-red-600">{errors.persona_self_relates_to_owner.message}</p>}
          </div>
          <div>
            <label htmlFor="persona_self_flirt_response" className="label">How She Handles Flirting</label>
            <textarea id="persona_self_flirt_response" rows={4} className="input min-h-[120px]" {...register('persona_self_flirt_response')} />
            {errors.persona_self_flirt_response && <p className="mt-1 text-sm text-red-600">{errors.persona_self_flirt_response.message}</p>}
          </div>
          <div>
            <label htmlFor="persona_self_intro_short" className="label">Intro Short</label>
            <textarea id="persona_self_intro_short" rows={3} className="input min-h-[100px]" {...register('persona_self_intro_short')} />
            {errors.persona_self_intro_short && <p className="mt-1 text-sm text-red-600">{errors.persona_self_intro_short.message}</p>}
          </div>
          <div>
            <label htmlFor="persona_self_intro_warm" className="label">Intro Warm</label>
            <textarea id="persona_self_intro_warm" rows={5} className="input min-h-[140px]" {...register('persona_self_intro_warm')} />
            {errors.persona_self_intro_warm && <p className="mt-1 text-sm text-red-600">{errors.persona_self_intro_warm.message}</p>}
          </div>
        </FieldBlock>

        <div className="flex items-center justify-between">
          <div className="text-xs text-gray-500">
            Основная кнопка сохранения вынесена в шапку страницы рядом с синхронизацией.
          </div>
          <button type="button" onClick={() => reset(defaults)} className="btn-secondary">
            <RefreshCw className="w-4 h-4 mr-2" />
            Сбросить к текущему канону
          </button>
          <button type="submit" disabled={saveMutation.isPending || !isDirty} className="btn-secondary">
            <Save className="w-4 h-4 mr-2" />
            {saveMutation.isPending ? 'Сохранение...' : 'Сохранить снизу'}
          </button>
        </div>
      </form>
    </div>
  );
}
