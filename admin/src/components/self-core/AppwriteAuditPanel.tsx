import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Database, Layers3 } from 'lucide-react';
import type { Prompt, Setting } from '../../api/appwrite';
import { promptsApi, settingsApi } from '../../api/appwrite';

const PERSONA_SETTING_KEYS = [
  'persona_name',
  'persona_identity',
  'persona_relationship_to_owner',
  'persona_owner_title',
  'persona_style_intensity',
  'persona_ritual_lexicon',
  'persona_forbidden_phrases',
  'persona_channel_telegram',
  'persona_channel_voice',
  'persona_channel_digest',
  'persona_channel_system',
  'persona_self_lives_by',
  'persona_self_loves',
  'persona_self_relates_to_owner',
  'persona_self_flirt_response',
  'persona_self_intro_short',
  'persona_self_intro_warm',
] as const;

type PromptChannel = Prompt['channel'];

function countActiveByChannel(prompts: Prompt[]): Record<PromptChannel, number> {
  return prompts.reduce<Record<PromptChannel, number>>((acc, prompt) => {
    if (prompt.is_active) {
      acc[prompt.channel] += 1;
    }
    return acc;
  }, { telegram: 0, voice: 0, all: 0 });
}

function formatKeyList(keys: string[]): string {
  return keys.length > 0 ? keys.join(', ') : 'нет';
}

export function AppwriteAuditPanel(): JSX.Element {
  const { data: settings = [], isLoading: isLoadingSettings } = useQuery({
    queryKey: ['settings'],
    queryFn: settingsApi.getAll,
  });
  const { data: prompts = [], isLoading: isLoadingPrompts } = useQuery({
    queryKey: ['prompts'],
    queryFn: promptsApi.getAll,
  });

  const audit = useMemo(() => {
    const settingsMap = new Map(settings.map((setting: Setting) => [setting.key, setting.value?.trim() ?? '']));
    const missingKeys = PERSONA_SETTING_KEYS.filter((key) => !settingsMap.has(key));
    const emptyKeys = PERSONA_SETTING_KEYS.filter((key) => settingsMap.has(key) && !settingsMap.get(key));
    const activeByChannel = countActiveByChannel(prompts);
    const duplicateActiveChannels = (Object.entries(activeByChannel) as Array<[PromptChannel, number]>)
      .filter(([, count]) => count > 1)
      .map(([channel]) => channel);
    const invalidPrompts = prompts
      .filter((prompt) => !prompt.name.trim() || !prompt.content.trim())
      .map((prompt) => prompt.id);

    return {
      missingKeys,
      emptyKeys,
      activeByChannel,
      duplicateActiveChannels,
      invalidPrompts,
      isHealthy: missingKeys.length === 0 && duplicateActiveChannels.length === 0 && invalidPrompts.length === 0,
    };
  }, [prompts, settings]);

  return (
    <div className="card">
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-rose-500/10 border border-rose-500/20 text-rose-300">
          <Database className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-lg font-semibold">Appwrite Audit</h2>
          <p className="text-sm text-gray-500">
            Канонический срез `amina_settings` и `amina_prompts` перед удалением legacy UI.
          </p>
        </div>
      </div>

      {(isLoadingSettings || isLoadingPrompts) ? (
        <div className="text-sm text-gray-400">Проверяю Appwrite-канон...</div>
      ) : (
        <div className="space-y-4">
          <div className={`rounded-2xl border p-4 text-sm ${
            audit.isHealthy
              ? 'border-emerald-500/20 bg-emerald-500/5 text-emerald-100'
              : 'border-amber-500/20 bg-amber-500/5 text-amber-100'
          }`}>
            <div className="flex items-center gap-2">
              {audit.isHealthy ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-300" />
              ) : (
                <AlertTriangle className="w-4 h-4 text-amber-300" />
              )}
              <span>
                {audit.isHealthy
                  ? 'Критичных расхождений между каноном Appwrite и Self Core не найдено.'
                  : 'Найдены расхождения, которые нужно держать под контролем до удаления legacy UI.'}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex items-center gap-2 mb-3">
                <Layers3 className="w-4 h-4 text-blue-300" />
                <p className="font-medium">Persona settings audit</p>
              </div>
              <div className="space-y-2 text-sm">
                <p><span className="text-gray-500">Ожидаемых persona-ключей:</span> {PERSONA_SETTING_KEYS.length}</p>
                <p><span className="text-gray-500">Отсутствуют:</span> {formatKeyList(audit.missingKeys)}</p>
                <p><span className="text-gray-500">Пустые значения:</span> {formatKeyList(audit.emptyKeys)}</p>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
              <div className="flex items-center gap-2 mb-3">
                <Layers3 className="w-4 h-4 text-fuchsia-300" />
                <p className="font-medium">Prompt layers audit</p>
              </div>
              <div className="space-y-2 text-sm">
                <p><span className="text-gray-500">Всего prompt-записей:</span> {prompts.length}</p>
                <p><span className="text-gray-500">Активные по каналам:</span> telegram {audit.activeByChannel.telegram}, voice {audit.activeByChannel.voice}, all {audit.activeByChannel.all}</p>
                <p><span className="text-gray-500">Дубли активных каналов:</span> {formatKeyList(audit.duplicateActiveChannels)}</p>
                <p><span className="text-gray-500">Некорректные prompt ids:</span> {formatKeyList(audit.invalidPrompts)}</p>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
