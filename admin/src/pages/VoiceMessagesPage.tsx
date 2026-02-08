import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { voiceMessagesApi, type VoiceMessage } from '../api/supabase';
import {
  Mic,
  Download,
  Play,
  Archive,
  Loader2,
  Clock,
  HardDrive,
  Users,
  Filter,
  X,
} from 'lucide-react';

// Helpers
const formatDuration = (sec: number): string => {
  if (sec < 60) return `${sec}с`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}м ${s}с`;
};

const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const formatDate = (iso: string): string => {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
};

const getUserDisplay = (msg: VoiceMessage): string => {
  if (msg.first_name) return msg.first_name;
  if (msg.username) return `@${msg.username}`;
  return `ID: ${msg.user_id}`;
};

const VoiceMessagesPage = () => {
  // Filters
  const [filterUserId, setFilterUserId] = useState('');
  const [filterDateFrom, setFilterDateFrom] = useState('');
  const [filterDateTo, setFilterDateTo] = useState('');
  const [page, setPage] = useState(0);
  const pageSize = 20;

  // Playing audio
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [audioEl, setAudioEl] = useState<HTMLAudioElement | null>(null);

  // Query: list
  const { data: listResult, isLoading } = useQuery({
    queryKey: ['voice-messages', filterUserId, filterDateFrom, filterDateTo, page],
    queryFn: () =>
      voiceMessagesApi.list({
        userId: filterUserId || undefined,
        dateFrom: filterDateFrom || undefined,
        dateTo: filterDateTo || undefined,
        limit: pageSize,
        offset: page * pageSize,
      }),
  });

  // Query: stats
  const { data: stats } = useQuery({
    queryKey: ['voice-messages-stats'],
    queryFn: () => voiceMessagesApi.stats(),
  });

  // Mutation: download archive
  const { mutate: downloadArchive, isPending: isArchiving } = useMutation({
    mutationFn: () =>
      voiceMessagesApi.downloadArchive({
        userId: filterUserId || undefined,
        dateFrom: filterDateFrom || undefined,
        dateTo: filterDateTo || undefined,
      }),
    onSuccess: (blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `voice-messages-${new Date().toISOString().slice(0, 10)}.zip`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });

  // Play voice
  const handlePlay = async (msg: VoiceMessage) => {
    if (playingId === msg.id) {
      audioEl?.pause();
      setPlayingId(null);
      setAudioEl(null);
      return;
    }

    try {
      const url = await voiceMessagesApi.getDownloadUrl(msg.id);
      const audio = new Audio(url);
      audio.onended = () => { setPlayingId(null); setAudioEl(null); };
      audio.play();
      setPlayingId(msg.id);
      setAudioEl(audio);
    } catch {
      // ignore
    }
  };

  // Download single
  const handleDownload = async (msg: VoiceMessage) => {
    try {
      const url = await voiceMessagesApi.getDownloadUrl(msg.id);
      const a = document.createElement('a');
      a.href = url;
      a.download = `voice_${msg.user_id}_${msg.duration}s.ogg`;
      a.target = '_blank';
      a.click();
    } catch {
      // ignore
    }
  };

  const clearFilters = () => {
    setFilterUserId('');
    setFilterDateFrom('');
    setFilterDateTo('');
    setPage(0);
  };

  const messages = listResult?.data ?? [];
  const total = listResult?.total ?? 0;
  const totalPages = Math.ceil(total / pageSize);
  const hasFilters = !!(filterUserId || filterDateFrom || filterDateTo);

  return (
    <div className="p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div className="flex items-center gap-4">
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, rgba(255, 215, 0, 0.15), rgba(139, 92, 246, 0.15))',
              border: '1px solid rgba(255, 215, 0, 0.3)',
              boxShadow: '0 0 30px rgba(255, 215, 0, 0.1)',
            }}
          >
            <Mic className="w-7 h-7 text-amber-400" />
          </div>
          <div>
            <h1
              className="text-3xl font-bold text-gradient-gold"
              style={{ fontFamily: 'var(--font-display)' }}
            >
              Голосовые сообщения
            </h1>
            <p className="text-sm text-gray-500 mt-1">
              Хранилище голосовых сообщений пользователей
            </p>
          </div>
        </div>

        <button
          onClick={() => downloadArchive()}
          disabled={isArchiving || total === 0}
          className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-all duration-300 disabled:opacity-50"
          style={{
            background: 'linear-gradient(135deg, rgba(255, 215, 0, 0.15), rgba(139, 92, 246, 0.15))',
            border: '1px solid rgba(255, 215, 0, 0.3)',
            color: 'var(--gold-pure)',
            fontFamily: 'var(--font-heading)',
          }}
        >
          {isArchiving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Archive className="w-4 h-4" />}
          {isArchiving ? 'Создание...' : 'Скачать архив'}
        </button>
      </div>

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-8">
          <StatCard
            icon={<Mic className="w-5 h-5 text-amber-400" />}
            label="Всего записей"
            value={String(stats.totalCount)}
          />
          <StatCard
            icon={<Clock className="w-5 h-5 text-purple-400" />}
            label="Общая длительность"
            value={formatDuration(stats.totalDuration)}
          />
          <StatCard
            icon={<HardDrive className="w-5 h-5 text-blue-400" />}
            label="Общий размер"
            value={formatSize(stats.totalSize)}
          />
          <StatCard
            icon={<Users className="w-5 h-5 text-green-400" />}
            label="Пользователей"
            value={String(stats.byUser.length)}
          />
        </div>
      )}

      {/* Filters */}
      <div
        className="p-4 rounded-2xl mb-6"
        style={{
          background: 'linear-gradient(135deg, rgba(15, 15, 25, 0.8), rgba(20, 20, 35, 0.8))',
          border: '1px solid rgba(255, 215, 0, 0.1)',
        }}
      >
        <div className="flex items-center gap-3 flex-wrap">
          <Filter className="w-4 h-4 text-gray-500" />

          <input
            type="text"
            placeholder="User ID"
            value={filterUserId}
            onChange={(e) => { setFilterUserId(e.target.value); setPage(0); }}
            className="px-3 py-2 rounded-lg text-sm bg-gray-900/50 border border-gray-700 text-gray-200 placeholder-gray-500 focus:outline-none focus:border-amber-500/50 w-40"
          />

          <input
            type="date"
            value={filterDateFrom}
            onChange={(e) => { setFilterDateFrom(e.target.value); setPage(0); }}
            className="px-3 py-2 rounded-lg text-sm bg-gray-900/50 border border-gray-700 text-gray-200 focus:outline-none focus:border-amber-500/50"
          />

          <span className="text-gray-600">—</span>

          <input
            type="date"
            value={filterDateTo}
            onChange={(e) => { setFilterDateTo(e.target.value); setPage(0); }}
            className="px-3 py-2 rounded-lg text-sm bg-gray-900/50 border border-gray-700 text-gray-200 focus:outline-none focus:border-amber-500/50"
          />

          {hasFilters && (
            <button
              onClick={clearFilters}
              className="flex items-center gap-1 px-3 py-2 rounded-lg text-sm text-red-400 hover:bg-red-500/10 transition-colors"
            >
              <X className="w-3 h-3" />
              Сбросить
            </button>
          )}

          <div className="ml-auto text-sm text-gray-500">
            Найдено: {total}
          </div>
        </div>
      </div>

      {/* Table */}
      <div
        className="rounded-2xl overflow-hidden"
        style={{
          background: 'linear-gradient(135deg, rgba(15, 15, 25, 0.8), rgba(20, 20, 35, 0.8))',
          border: '1px solid rgba(255, 215, 0, 0.1)',
        }}
      >
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-8 h-8 animate-spin text-amber-400" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
            <Mic className="w-12 h-12 mb-3 opacity-30" />
            <p className="text-lg">Нет голосовых сообщений</p>
            <p className="text-sm mt-1">Голосовые будут появляться здесь после отправки в бот</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr
                style={{
                  borderBottom: '1px solid rgba(255, 215, 0, 0.1)',
                  background: 'rgba(255, 215, 0, 0.03)',
                }}
              >
                <th className="text-left px-5 py-3 text-xs text-gray-400 font-medium uppercase tracking-wider">Дата</th>
                <th className="text-left px-5 py-3 text-xs text-gray-400 font-medium uppercase tracking-wider">Пользователь</th>
                <th className="text-left px-5 py-3 text-xs text-gray-400 font-medium uppercase tracking-wider">Длит.</th>
                <th className="text-left px-5 py-3 text-xs text-gray-400 font-medium uppercase tracking-wider">Размер</th>
                <th className="text-left px-5 py-3 text-xs text-gray-400 font-medium uppercase tracking-wider">Расшифровка</th>
                <th className="text-right px-5 py-3 text-xs text-gray-400 font-medium uppercase tracking-wider">Действия</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((msg) => (
                <tr
                  key={msg.id}
                  className="hover:bg-white/[0.02] transition-colors"
                  style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.03)' }}
                >
                  <td className="px-5 py-3 text-sm text-gray-300 whitespace-nowrap">
                    {formatDate(msg.created_at)}
                  </td>
                  <td className="px-5 py-3 text-sm text-gray-300">
                    {getUserDisplay(msg)}
                  </td>
                  <td className="px-5 py-3 text-sm text-gray-400 whitespace-nowrap">
                    {formatDuration(msg.duration)}
                  </td>
                  <td className="px-5 py-3 text-sm text-gray-500 whitespace-nowrap">
                    {formatSize(msg.file_size)}
                  </td>
                  <td className="px-5 py-3 text-sm text-gray-400 max-w-xs truncate">
                    {msg.transcription || <span className="text-gray-600 italic">нет расшифровки</span>}
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    <button
                      onClick={() => handlePlay(msg)}
                      className="p-1.5 rounded-lg hover:bg-amber-500/10 transition-colors mr-1"
                      title={playingId === msg.id ? 'Остановить' : 'Прослушать'}
                    >
                      <Play
                        className={`w-4 h-4 ${playingId === msg.id ? 'text-amber-400' : 'text-gray-500'}`}
                      />
                    </button>
                    <button
                      onClick={() => handleDownload(msg)}
                      className="p-1.5 rounded-lg hover:bg-blue-500/10 transition-colors"
                      title="Скачать"
                    >
                      <Download className="w-4 h-4 text-gray-500" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            className="flex items-center justify-between px-5 py-3"
            style={{ borderTop: '1px solid rgba(255, 215, 0, 0.1)' }}
          >
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-3 py-1.5 text-sm rounded-lg text-gray-400 hover:text-gray-200 hover:bg-white/5 disabled:opacity-30 transition-colors"
            >
              Назад
            </button>
            <span className="text-sm text-gray-500">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="px-3 py-1.5 text-sm rounded-lg text-gray-400 hover:text-gray-200 hover:bg-white/5 disabled:opacity-30 transition-colors"
            >
              Далее
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

// Stat Card component
const StatCard = ({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) => (
  <div
    className="p-4 rounded-2xl"
    style={{
      background: 'linear-gradient(135deg, rgba(15, 15, 25, 0.8), rgba(20, 20, 35, 0.8))',
      border: '1px solid rgba(255, 215, 0, 0.1)',
    }}
  >
    <div className="flex items-center gap-3">
      <div
        className="w-10 h-10 rounded-xl flex items-center justify-center"
        style={{
          background: 'rgba(255, 215, 0, 0.08)',
          border: '1px solid rgba(255, 215, 0, 0.15)',
        }}
      >
        {icon}
      </div>
      <div>
        <p className="text-xl font-bold text-gray-100" style={{ fontFamily: 'var(--font-display)' }}>
          {value}
        </p>
        <p className="text-xs text-gray-500">{label}</p>
      </div>
    </div>
  </div>
);

export default VoiceMessagesPage;
