import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { analyticsApi, AnalyticsEvent } from '../api/appwrite';
import {
  BarChart3,
  Calendar,
  Filter,
  MessageSquare,
  Phone,
  Zap,
  AlertCircle,
} from 'lucide-react';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { ru } from 'date-fns/locale';

const AnalyticsPage = () => {
  const [dateRange, setDateRange] = useState<'7d' | '30d' | '90d'>('7d');
  const [channelFilter, setChannelFilter] = useState<string>('all');

  const getDates = () => {
    const to = endOfDay(new Date());
    const days = dateRange === '7d' ? 7 : dateRange === '30d' ? 30 : 90;
    const from = startOfDay(subDays(new Date(), days));
    return { from, to };
  };

  const { from, to } = getDates();

  const { data: events, isLoading } = useQuery({
    queryKey: ['analytics-events', dateRange, channelFilter],
    queryFn: () =>
      analyticsApi.getEvents({
        from,
        to,
        channel: channelFilter !== 'all' ? channelFilter : undefined,
        limit: 100,
      }),
  });

  const { data: stats } = useQuery({
    queryKey: ['analytics-stats', dateRange],
    queryFn: () => analyticsApi.getStats(from, to),
  });

  const eventTypeLabels: Record<string, string> = {
    message_received: 'Сообщение получено',
    message_sent: 'Сообщение отправлено',
    ai_response: 'Ответ AI',
    call_started: 'Звонок начат',
    call_ended: 'Звонок завершён',
    error: 'Ошибка',
    settings_updated: 'Настройки обновлены',
    prompt_updated: 'Промпт обновлён',
  };

  const eventTypeIcons: Record<string, typeof MessageSquare> = {
    message_received: MessageSquare,
    message_sent: MessageSquare,
    ai_response: Zap,
    call_started: Phone,
    call_ended: Phone,
    error: AlertCircle,
    settings_updated: Filter,
    prompt_updated: MessageSquare,
  };

  const eventTypeColors: Record<string, string> = {
    message_received: 'bg-blue-500/20 text-blue-400',
    message_sent: 'bg-green-500/20 text-green-400',
    ai_response: 'bg-purple-500/20 text-purple-400',
    call_started: 'bg-amber-100 text-amber-700',
    call_ended: 'bg-amber-100 text-amber-700',
    error: 'bg-red-500/20 text-red-400',
    settings_updated: 'bg-white/10 text-white/70',
    prompt_updated: 'bg-white/10 text-white/70',
  };

  return (
    <div className="p-6 lg:p-8 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Аналитика</h1>
          <p className="text-white/60 mt-1">
            История событий и статистика использования
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Date Range */}
          <div className="flex items-center gap-1 bg-white/5 rounded-lg p-1 border border-white/10">
            {(['7d', '30d', '90d'] as const).map((range) => (
              <button
                key={range}
                onClick={() => setDateRange(range)}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  dateRange === range
                    ? 'bg-white/10 text-amber-400 shadow-sm border border-amber-400/30'
                    : 'text-gray-400 hover:text-gray-200'
                }`}
              >
                {range === '7d' ? '7 дней' : range === '30d' ? '30 дней' : '90 дней'}
              </button>
            ))}
          </div>

          {/* Channel Filter */}
          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            className="input w-auto"
          >
            <option value="all">Все каналы</option>
            <option value="telegram">Telegram</option>
            <option value="voice">Голос</option>
            <option value="admin">Админка</option>
          </select>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-8">
        <StatCard
          label="Сообщений"
          value={stats?.totalMessages ?? 0}
          icon={MessageSquare}
        />
        <StatCard
          label="Звонков"
          value={stats?.totalCalls ?? 0}
          icon={Phone}
        />
        <StatCard
          label="Уникальных пользователей"
          value={stats?.uniqueUsers ?? 0}
          icon={BarChart3}
        />
      </div>

      {/* Events List */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <Calendar className="w-5 h-5 text-gray-400" />
          <h3 className="font-semibold">Последние события</h3>
        </div>

        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="animate-pulse flex items-center gap-4 py-3">
                <div className="w-8 h-8 bg-white/10 rounded-lg" />
                <div className="flex-1">
                  <div className="h-4 bg-white/10 rounded w-1/4 mb-2" />
                  <div className="h-3 bg-white/10 rounded w-1/2" />
                </div>
              </div>
            ))}
          </div>
        ) : events?.length === 0 ? (
          <div className="text-center py-12 text-white/50">
            <BarChart3 className="w-12 h-12 mx-auto mb-4 text-white/30" />
            <p>Нет событий за выбранный период</p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {events?.map((event) => (
              <EventRow
                key={event.id}
                event={event}
                label={eventTypeLabels[event.event_type] ?? event.event_type}
                Icon={eventTypeIcons[event.event_type] ?? MessageSquare}
                colorClass={eventTypeColors[event.event_type] ?? 'bg-white/10 text-white/70'}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

// Stat Card Component
const StatCard = ({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value: number;
  icon: typeof MessageSquare;
}) => (
  <div className="card flex items-center gap-4">
    <div className="p-3 rounded-lg bg-primary-100">
      <Icon className="w-6 h-6 text-primary-600" />
    </div>
    <div>
      <p className="text-sm text-white/60">{label}</p>
      <p className="text-2xl font-bold">{value.toLocaleString()}</p>
    </div>
  </div>
);

// Event Row Component
const EventRow = ({
  event,
  label,
  Icon,
  colorClass,
}: {
  event: AnalyticsEvent;
  label: string;
  Icon: typeof MessageSquare;
  colorClass: string;
}) => {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="py-3">
      <div
        className="flex items-center gap-4 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className={`p-2 rounded-lg ${colorClass}`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="font-medium text-sm">{label}</p>
          <p className="text-xs text-white/50">
            {event.channel} • {event.user_id ? `Пользователь: ${event.user_id.slice(0, 8)}...` : 'Система'}
          </p>
        </div>
        <div className="text-sm text-white/50">
          {format(new Date(event.timestamp), 'd MMM, HH:mm', { locale: ru })}
        </div>
      </div>

      {expanded && Object.keys(event.data).length > 0 && (
        <div className="mt-3 ml-12 p-3 bg-white/5 rounded-lg">
          <pre className="text-xs text-white/60 overflow-auto">
            {JSON.stringify(event.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
};

export default AnalyticsPage;
