import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, FileSearch, Loader2, Phone, StickyNote } from 'lucide-react';
import {
  reconciliationApi,
  type NotesApplyBatchResult,
  type ReconciliationApplyContract,
  type NotesReconciliationDetail,
  type NotesReconciliationItem,
  type ReconciliationCounts,
  type ReconciliationSummary,
  type TelephonyReconciliationDetail,
  type TelephonyReconciliationItem,
} from '../api/appwrite';

type ReconciliationTab = 'telephony' | 'notes';

function getStatusBadgeClass(status: 'safe' | 'review' | 'block'): string {
  switch (status) {
    case 'safe':
      return 'bg-emerald-500/10 text-emerald-300 border border-emerald-500/20';
    case 'review':
      return 'bg-amber-500/10 text-amber-300 border border-amber-500/20';
    default:
      return 'bg-red-500/10 text-red-300 border border-red-500/20';
  }
}

function SummaryCard({ summary }: { summary: ReconciliationSummary }): JSX.Element {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.02] p-4">
      <p className="text-sm font-medium text-white">{summary.domain === 'telephony' ? 'Telephony legacy' : 'Notes artifacts'}</p>
      <div className="mt-3 grid grid-cols-4 gap-2 text-center text-sm">
        <Metric label="Всего" value={summary.total} />
        <Metric label="Safe" value={summary.safe} />
        <Metric label="Review" value={summary.review} />
        <Metric label="Block" value={summary.block} />
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-xl border border-white/10 bg-black/10 p-2">
      <p className="text-xs text-gray-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-white">{value}</p>
    </div>
  );
}

export default function ReconciliationPage(): JSX.Element {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<ReconciliationTab>('telephony');
  const [selectedTelephonyIds, setSelectedTelephonyIds] = useState<string[]>([]);
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>([]);
  const [selectedTelephonyId, setSelectedTelephonyId] = useState<string | null>(null);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [approvalNote, setApprovalNote] = useState('Owner-approved soft archive for obvious artifact notes');

  const telephonyQuery = useQuery({
    queryKey: ['reconciliation', 'telephony'],
    queryFn: () => reconciliationApi.getTelephony(),
  });
  const notesQuery = useQuery({
    queryKey: ['reconciliation', 'notes'],
    queryFn: () => reconciliationApi.getNotes(),
  });
  const contractQuery = useQuery({
    queryKey: ['reconciliation', 'contract'],
    queryFn: reconciliationApi.getContract,
  });
  const telephonyDetailQuery = useQuery({
    queryKey: ['reconciliation', 'telephony-detail', selectedTelephonyId],
    queryFn: () => reconciliationApi.getTelephonyDetail(selectedTelephonyId!),
    enabled: Boolean(selectedTelephonyId),
  });
  const notesDetailQuery = useQuery({
    queryKey: ['reconciliation', 'notes-detail', selectedNoteId],
    queryFn: () => reconciliationApi.getNotesDetail(selectedNoteId!),
    enabled: Boolean(selectedNoteId),
  });

  const telephonyPreviewMutation = useMutation({
    mutationFn: () => reconciliationApi.previewTelephonyBatch(selectedTelephonyIds),
  });
  const notesPreviewMutation = useMutation({
    mutationFn: () => reconciliationApi.previewNotesBatch(selectedNoteIds),
  });
  const notesApplyMutation = useMutation({
    mutationFn: () => reconciliationApi.applyNotesBatch(
      selectedNoteIds,
      notesPreviewMutation.data?.snapshotToken ?? '',
      approvalNote.trim(),
    ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['reconciliation', 'notes'] });
      queryClient.invalidateQueries({ queryKey: ['reconciliation', 'notes-detail'] });
    },
  });

  const telephonyItems = telephonyQuery.data?.items ?? [];
  const noteItems = notesQuery.data?.items ?? [];
  const selectedTelephonySet = useMemo(() => new Set(selectedTelephonyIds), [selectedTelephonyIds]);
  const selectedNoteSet = useMemo(() => new Set(selectedNoteIds), [selectedNoteIds]);

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-100">Reconciliation Review</h1>
          <p className="text-sm text-gray-400 mt-1">
            Read-only контур для telephony legacy sessions и artifact notes. Никаких merge или archive здесь не происходит.
          </p>
        </div>
        <div className="rounded-2xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-100 max-w-md">
          Batch preview показывает только dry-run. Исторический merge и soft-archive будут вынесены в отдельный approve-этап.
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        {telephonyQuery.data?.summary && <SummaryCard summary={telephonyQuery.data.summary} />}
        {notesQuery.data?.summary && <SummaryCard summary={notesQuery.data.summary} />}
      </div>

      {contractQuery.data && <ContractCard contract={contractQuery.data} />}

      <div className="flex gap-2">
        <button className={tab === 'telephony' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('telephony')}>
          <Phone className="w-4 h-4 mr-2" />
          Telephony legacy
        </button>
        <button className={tab === 'notes' ? 'btn-primary' : 'btn-secondary'} onClick={() => setTab('notes')}>
          <StickyNote className="w-4 h-4 mr-2" />
          Notes artifacts
        </button>
      </div>

      {tab === 'telephony' ? (
        <div className="grid grid-cols-1 xl:grid-cols-[1.25fr,0.95fr] gap-6">
          <div className="card space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">Кандидаты telephony remediation</h2>
                <p className="text-sm text-gray-500">Сильные матчи: `requestId` и `callId`. Матч по номеру и окну времени всегда уходит в review.</p>
              </div>
              <button className="btn-secondary" disabled={selectedTelephonyIds.length === 0 || telephonyPreviewMutation.isPending} onClick={() => telephonyPreviewMutation.mutate()}>
                {telephonyPreviewMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileSearch className="w-4 h-4 mr-2" />}
                Preview batch
              </button>
            </div>

            <div className="space-y-3">
              {telephonyQuery.isLoading ? <LoadingState /> : telephonyItems.map((item) => (
                <TelephonyRow
                  key={item.sessionId}
                  item={item}
                  selected={selectedTelephonySet.has(item.sessionId)}
                  active={selectedTelephonyId === item.sessionId}
                  onSelect={() => setSelectedTelephonyIds((prev) => prev.includes(item.sessionId) ? prev.filter((id) => id !== item.sessionId) : [...prev, item.sessionId])}
                  onOpen={() => setSelectedTelephonyId(item.sessionId)}
                />
              ))}
            </div>

            {telephonyPreviewMutation.data && (
              <BatchPreviewCard
                title="Telephony batch preview"
                counts={telephonyPreviewMutation.data.counts}
                lines={telephonyPreviewMutation.data.items.flatMap((item) => item.stopPoints.map((point) => `${item.sessionId}: ${point}`))}
              />
            )}
          </div>

          <div className="card space-y-4">
            <h2 className="text-lg font-semibold text-white">Detail и stop-points</h2>
            {telephonyDetailQuery.isLoading ? <LoadingState /> : (
              <TelephonyDetail detail={telephonyDetailQuery.data ?? null} />
            )}
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-[1.25fr,0.95fr] gap-6">
          <div className="card space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-lg font-semibold text-white">Подозрительные notes</h2>
                <p className="text-sm text-gray-500">Manual notes без сильных артефактов остаются `safe`. Любое действие потом только owner-approved batch.</p>
              </div>
              <button className="btn-secondary" disabled={selectedNoteIds.length === 0 || notesPreviewMutation.isPending} onClick={() => notesPreviewMutation.mutate()}>
                {notesPreviewMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <FileSearch className="w-4 h-4 mr-2" />}
                Preview batch
              </button>
            </div>

            <div className="space-y-3">
              {notesQuery.isLoading ? <LoadingState /> : noteItems.map((item) => (
                <NotesRow
                  key={item.noteId}
                  item={item}
                  selected={selectedNoteSet.has(item.noteId)}
                  active={selectedNoteId === item.noteId}
                  onSelect={() => setSelectedNoteIds((prev) => prev.includes(item.noteId) ? prev.filter((id) => id !== item.noteId) : [...prev, item.noteId])}
                  onOpen={() => setSelectedNoteId(item.noteId)}
                />
              ))}
            </div>

            {notesPreviewMutation.data && (
              <div className="space-y-3">
                <BatchPreviewCard
                  title="Notes batch preview"
                  counts={notesPreviewMutation.data.counts}
                  lines={notesPreviewMutation.data.items.map((item) => `${item.noteId}: ${item.suggestedAction} · ${item.reasons.join('; ') || 'без замечаний'}`)}
                />
                <div className="rounded-2xl border border-violet-500/20 bg-violet-500/5 p-4 space-y-3">
                  <p className="text-sm font-medium text-violet-100">Owner-approved apply</p>
                  <textarea
                    className="input w-full min-h-[88px] text-sm resize-y"
                    value={approvalNote}
                    onChange={(event) => setApprovalNote(event.target.value)}
                    placeholder="Почему этот batch можно soft-archive"
                  />
                  <button
                    className="btn-primary"
                    disabled={!notesPreviewMutation.data.snapshotToken || !approvalNote.trim() || notesApplyMutation.isPending}
                    onClick={() => notesApplyMutation.mutate()}
                  >
                    {notesApplyMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <StickyNote className="w-4 h-4 mr-2" />}
                    Apply soft-archive batch
                  </button>
                  {notesApplyMutation.data && <ApplyResultCard result={notesApplyMutation.data} />}
                </div>
              </div>
            )}
          </div>

          <div className="card space-y-4">
            <h2 className="text-lg font-semibold text-white">Detail и nearby context</h2>
            {notesDetailQuery.isLoading ? <LoadingState /> : (
              <NotesDetail detail={notesDetailQuery.data ?? null} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ContractCard({ contract }: { contract: ReconciliationApplyContract }): JSX.Element {
  return (
    <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4">
      <p className="font-medium text-blue-100">Apply contract for phase 2</p>
      <p className="text-sm text-blue-50 mt-2">
        previewOnly: {contract.previewOnly ? 'true' : 'false'} · approvalRequired: {contract.approvalRequired ? 'true' : 'false'}
      </p>
      <p className="text-xs text-blue-200 mt-2">{contract.staleCheck}</p>
      <div className="mt-3 grid grid-cols-1 xl:grid-cols-2 gap-3 text-sm text-blue-50">
        <div>
          <p className="text-xs uppercase tracking-wide text-blue-200 mb-1">Telephony allowed</p>
          {contract.telephonyAllowedActions.map((line) => <div key={line}>{line}</div>)}
        </div>
        <div>
          <p className="text-xs uppercase tracking-wide text-blue-200 mb-1">Notes allowed</p>
          {contract.notesAllowedActions.map((line) => <div key={line}>{line}</div>)}
        </div>
      </div>
    </div>
  );
}

function LoadingState(): JSX.Element {
  return <div className="flex items-center gap-2 text-sm text-gray-400"><Loader2 className="w-4 h-4 animate-spin" /> Загрузка...</div>;
}

function TelephonyRow(props: {
  item: TelephonyReconciliationItem;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  onOpen: () => void;
}): JSX.Element {
  const { item, selected, active, onSelect, onOpen } = props;
  return (
    <div className={`rounded-2xl border p-4 ${active ? 'border-violet-500/30 bg-violet-500/5' : 'border-white/10 bg-white/[0.02]'}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected} onChange={onSelect} className="mt-1" />
        <button className="flex-1 text-left" onClick={onOpen}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium text-white">{item.scenarioName || item.sessionId}</p>
              <p className="text-xs text-gray-500">{item.targetPhone} · {new Date(item.createdAt).toLocaleString('ru-RU')}</p>
            </div>
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusBadgeClass(item.status)}`}>{item.status}</span>
          </div>
          <p className="mt-2 text-sm text-gray-400">{item.reasons[0] || 'Готова к dry-run preview.'}</p>
        </button>
      </div>
    </div>
  );
}

function NotesRow(props: {
  item: NotesReconciliationItem;
  selected: boolean;
  active: boolean;
  onSelect: () => void;
  onOpen: () => void;
}): JSX.Element {
  const { item, selected, active, onSelect, onOpen } = props;
  return (
    <div className={`rounded-2xl border p-4 ${active ? 'border-violet-500/30 bg-violet-500/5' : 'border-white/10 bg-white/[0.02]'}`}>
      <div className="flex items-start gap-3">
        <input type="checkbox" checked={selected} onChange={onSelect} className="mt-1" />
        <button className="flex-1 text-left" onClick={onOpen}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium text-white">User {item.userId}</p>
              <p className="text-xs text-gray-500">{new Date(item.createdAt).toLocaleString('ru-RU')} · score {item.score} · {item.archiveState}</p>
            </div>
            <span className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusBadgeClass(item.status)}`}>{item.status}</span>
          </div>
          <p className="mt-2 text-sm text-gray-300 whitespace-pre-wrap">{item.preview}</p>
        </button>
      </div>
    </div>
  );
}

function TelephonyDetail({ detail }: { detail: TelephonyReconciliationDetail | null }): JSX.Element {
  if (!detail) {
    return <p className="text-sm text-gray-500">Выберите session слева, чтобы увидеть stop-points и candidate signals.</p>;
  }
  return (
    <div className="space-y-4">
      <div className={`rounded-2xl p-4 ${getStatusBadgeClass(detail.status)}`}>
        <p className="font-medium">Статус: {detail.status}</p>
        <p className="text-xs mt-2">requestId: {detail.requestId || '—'} · callId: {detail.callId || '—'} · legacy matches: {detail.legacyMatches}</p>
      </div>
      <InfoBlock title="Причины" lines={detail.reasons} empty="Явных причин блокировки не найдено." />
      <InfoBlock title="Stop-points" lines={detail.stopPoints} empty="Stop-points не выявлены." />
      <InfoBlock title="Signals" lines={[
        `requestId exact: ${detail.matchSignals.requestId ? 'yes' : 'no'}`,
        `callId exact: ${detail.matchSignals.callId ? 'yes' : 'no'}`,
        `phone-window only: ${detail.matchSignals.phoneWindow ? 'yes' : 'no'}`,
      ]} empty="Signals отсутствуют." />
    </div>
  );
}

function NotesDetail({ detail }: { detail: NotesReconciliationDetail | null }): JSX.Element {
  if (!detail) {
    return <p className="text-sm text-gray-500">Выберите note слева, чтобы увидеть clean preview и соседний контекст.</p>;
  }
  return (
    <div className="space-y-4">
      <div className={`rounded-2xl p-4 ${getStatusBadgeClass(detail.status)}`}>
        <p className="font-medium">Статус: {detail.status}</p>
        <p className="text-xs mt-2">Suggested action: {detail.suggestedAction} · score {detail.score} · archive {detail.archiveState}</p>
      </div>
      <InfoBlock title="Причины" lines={detail.reasons} empty="Явных артефактов не найдено." />
      <PreviewBlock title="Raw note" value={detail.content} />
      <PreviewBlock title="Clean preview" value={detail.cleanPreview} />
      <InfoBlock
        title="Nearby logs"
        lines={detail.nearbyLogs.map((log) => `${log.eventType} · ${new Date(log.timestamp).toLocaleString('ru-RU')} · ${log.preview}`)}
        empty="Поблизости не найдено user logs."
      />
    </div>
  );
}

function PreviewBlock({ title, value }: { title: string; value: string }): JSX.Element {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">{title}</p>
      <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-gray-300 whitespace-pre-wrap">{value || '—'}</div>
    </div>
  );
}

function InfoBlock({ title, lines, empty }: { title: string; lines: string[]; empty: string }): JSX.Element {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">{title}</p>
      {lines.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-sm text-gray-500">{empty}</div>
      ) : (
        <div className="space-y-2">
          {lines.map((line) => (
            <div key={line} className="rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-sm text-gray-300 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-300 shrink-0" />
              <span>{line}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BatchPreviewCard({ title, counts, lines }: { title: string; counts: ReconciliationCounts; lines: string[] }): JSX.Element {
  return (
    <div className="rounded-2xl border border-blue-500/20 bg-blue-500/5 p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-medium text-blue-100">{title}</p>
        <span className="text-xs text-blue-200">safe {counts.safe} · review {counts.review} · block {counts.block}</span>
      </div>
      <div className="space-y-2">
        {lines.slice(0, 8).map((line) => (
          <div key={line} className="text-sm text-blue-50">{line}</div>
        ))}
      </div>
    </div>
  );
}

function ApplyResultCard({ result }: { result: NotesApplyBatchResult }): JSX.Element {
  return (
    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4 space-y-2">
      <p className="font-medium text-emerald-100">Apply result</p>
      <p className="text-xs text-emerald-200">
        safe {result.counts.safe} · review {result.counts.review} · block {result.counts.block}
      </p>
      {result.results.map((item) => (
        <div key={`${item.noteId}:${item.action}`} className="text-sm text-emerald-50">
          {item.noteId}: {item.action} · {item.message}
        </div>
      ))}
    </div>
  );
}
