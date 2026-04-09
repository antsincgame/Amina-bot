import { formatEventType } from './telephonyFormatters';
import type { SessionDetailPanelProps } from './types';
import { PreviewRow } from './ui';

export const SessionDetailPanel = ({ details }: SessionDetailPanelProps) => (
  <div className="rounded-2xl border border-violet-500/10 bg-black/20 p-4 space-y-4">
    {details.outcome && (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <PreviewRow label="Outcome" value={details.outcome.outcomeLabel} />
        <PreviewRow label="Result summary" value={details.outcome.resultSummary} />
      </div>
    )}

    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div className="space-y-3">
        <p className="text-xs uppercase tracking-wide text-gray-500">Артефакты</p>
        {details.artifacts.length === 0 ? (
          <p className="text-sm text-gray-500">Пока нет артефактов.</p>
        ) : (
          <div className="space-y-2">
            {details.artifacts.map((artifact) => (
              <div key={artifact.id} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-white">{artifact.artifactType}</span>
                  <span className="text-xs text-gray-500">{artifact.status}</span>
                </div>
                {artifact.url && (
                  <a href={artifact.url} target="_blank" rel="noreferrer" className="mt-2 inline-block text-emerald-400 hover:text-emerald-300">
                    Открыть артефакт
                  </a>
                )}
                {artifact.storagePath && (
                  <p className="mt-2 text-xs font-mono text-gray-500 break-all">{artifact.storagePath}</p>
                )}
                {artifact.content && (
                  <p className="mt-2 text-sm text-gray-300 whitespace-pre-wrap">{artifact.content}</p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <p className="text-xs uppercase tracking-wide text-gray-500">Таймлайн событий</p>
        {details.events.length === 0 ? (
          <p className="text-sm text-gray-500">Событий пока нет.</p>
        ) : (
          <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
            {details.events.map((event) => (
              <div key={event.id} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-white">{formatEventType(event.eventType)}</span>
                  <span className="text-[11px] text-gray-500">{new Date(event.createdAt).toLocaleTimeString('ru-RU')}</span>
                </div>
                {Object.keys(event.payload).length > 0 && (
                  <pre className="mt-2 whitespace-pre-wrap break-all text-[11px] text-gray-400">
                    {JSON.stringify(event.payload, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>

    <div className="space-y-3">
      <p className="text-xs uppercase tracking-wide text-gray-500">Turns</p>
      {details.turns.length === 0 ? (
        <p className="text-sm text-gray-500">Пока нет turns.</p>
      ) : (
        <div className="space-y-2">
          {details.turns.map((turn) => (
            <div key={turn.id} className="rounded-xl border border-white/5 bg-white/[0.02] px-3 py-2.5">
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-sm text-white">{turn.turnIndex}. {turn.speaker}</span>
                <span className="text-[11px] text-gray-500">{turn.source}</span>
              </div>
              <p className="text-sm text-gray-300 whitespace-pre-wrap">{turn.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  </div>
);
