import { Trash2 } from 'lucide-react';
import type { ScenarioEditorProps } from './types';
import { Field } from './ui';

export const ScenarioEditor = ({ scenario, onUpdate, onPolicyUpdate, onRemove }: ScenarioEditorProps) => (
  <div className="rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-4">
    <div className="grid grid-cols-1 md:grid-cols-[1fr,1fr,180px,180px,120px] gap-3">
      <Field label="ID">
        <input className="input w-full font-mono text-sm" value={scenario.id} onChange={(e) => onUpdate(scenario.id, 'id', e.target.value)} />
      </Field>
      <Field label="Название">
        <input className="input w-full" value={scenario.name} onChange={(e) => onUpdate(scenario.id, 'name', e.target.value)} />
      </Field>
      <Field label="Режим">
        <select className="input w-full" value={scenario.callMode} onChange={(e) => onUpdate(scenario.id, 'callMode', e.target.value)}>
          <option value="ask_question">Ask question</option>
          <option value="speech">Speech only</option>
        </select>
      </Field>
      <Field label="Runtime">
        <select className="input w-full" value={scenario.runtimeMode} onChange={(e) => onUpdate(scenario.id, 'runtimeMode', e.target.value)}>
          <option value="scripted">Scripted</option>
          <option value="hybrid">Hybrid</option>
          <option value="realtime">Realtime</option>
        </select>
      </Field>
      <div className="flex items-end gap-2">
        <button
          type="button"
          className={`flex-1 px-3 py-2 rounded-xl border text-sm ${
            scenario.enabled ? 'border-emerald-500/20 bg-emerald-500/10 text-emerald-300' : 'border-gray-700 bg-gray-800/50 text-gray-500'
          }`}
          onClick={() => onUpdate(scenario.id, 'enabled', !scenario.enabled)}
        >
          {scenario.enabled ? 'Включён' : 'Выключен'}
        </button>
        <button className="p-2 rounded-lg text-gray-500 hover:text-red-400 hover:bg-red-400/10 transition-colors" onClick={() => onRemove(scenario.id)}>
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>

    <Field label="Цель сценария">
      <textarea className="input w-full min-h-[72px] text-sm resize-y" value={scenario.goal} onChange={(e) => onUpdate(scenario.id, 'goal', e.target.value)} />
    </Field>

    <Field label="System prompt для голосового агента">
      <textarea className="input w-full min-h-[88px] text-sm resize-y" value={scenario.systemPrompt} onChange={(e) => onUpdate(scenario.id, 'systemPrompt', e.target.value)} />
    </Field>

    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      <Field label="Fallback">
        <select className="input w-full" value={scenario.policy.fallbackMode} onChange={(e) => onPolicyUpdate(scenario.id, 'fallbackMode', e.target.value)}>
          <option value="scripted">Scripted fallback</option>
          <option value="fail">Fail fast</option>
        </select>
      </Field>
      <Field label="Max silence (ms)">
        <input
          type="number"
          className="input w-full"
          value={scenario.policy.maxSilenceMs}
          onChange={(e) => onPolicyUpdate(scenario.id, 'maxSilenceMs', Number(e.target.value))}
        />
      </Field>
      <Field label="Max turns">
        <input
          type="number"
          className="input w-full"
          value={scenario.policy.maxTurns}
          onChange={(e) => onPolicyUpdate(scenario.id, 'maxTurns', Number(e.target.value))}
        />
      </Field>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Field label="Стартовая реплика">
        <textarea className="input w-full min-h-[72px] text-sm resize-y" value={scenario.openingLine} onChange={(e) => onUpdate(scenario.id, 'openingLine', e.target.value)} />
      </Field>
      <Field label="Подсказка по вопросу">
        <textarea className="input w-full min-h-[72px] text-sm resize-y" value={scenario.questionHint} onChange={(e) => onUpdate(scenario.id, 'questionHint', e.target.value)} />
      </Field>
    </div>

    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Field label="Что считать успехом">
        <textarea className="input w-full min-h-[72px] text-sm resize-y" value={scenario.successCriteria} onChange={(e) => onUpdate(scenario.id, 'successCriteria', e.target.value)} />
      </Field>
      <Field label="Подсказка для summary после записи">
        <textarea className="input w-full min-h-[72px] text-sm resize-y" value={scenario.resultPrompt} onChange={(e) => onUpdate(scenario.id, 'resultPrompt', e.target.value)} />
      </Field>
    </div>

    <Field label="Лимит символов для speech-only">
      <input
        type="number"
        className="input w-40"
        value={scenario.maxSpeechChars}
        onChange={(e) => onUpdate(scenario.id, 'maxSpeechChars', Number(e.target.value))}
      />
    </Field>
  </div>
);
