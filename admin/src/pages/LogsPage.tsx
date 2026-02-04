import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertCircle,
  AlertTriangle,
  Info,
  Bug,
  Skull,
  RefreshCw,
  Filter,
  ChevronDown,
  ChevronRight,
  Clock,
  Server,
  User,
} from 'lucide-react';

// Types
interface SystemLog {
  id: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  module: string;
  message: string;
  data?: Record<string, unknown>;
  error_stack?: string;
  user_id?: string;
  request_id?: string;
  timestamp: string;
}

interface LogStats {
  total: number;
  byLevel: Record<string, number>;
  byModule: Record<string, number>;
}

// API
const BOT_URL = import.meta.env.VITE_BOT_URL || 'https://amina-bot.onrender.com';

const logsApi = {
  async getLogs(params: {
    level?: string;
    module?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<SystemLog[]> {
    const searchParams = new URLSearchParams();
    if (params.level) searchParams.set('level', params.level);
    if (params.module) searchParams.set('module', params.module);
    if (params.from) searchParams.set('from', params.from);
    if (params.to) searchParams.set('to', params.to);
    if (params.limit) searchParams.set('limit', String(params.limit));

    const response = await fetch(`${BOT_URL}/api/logs?${searchParams}`);
    if (!response.ok) throw new Error('Failed to fetch logs');
    const data = await response.json();
    return data.data ?? [];
  },

  async getStats(from?: string, to?: string): Promise<LogStats> {
    const searchParams = new URLSearchParams();
    if (from) searchParams.set('from', from);
    if (to) searchParams.set('to', to);

    const response = await fetch(`${BOT_URL}/api/logs/stats?${searchParams}`);
    if (!response.ok) throw new Error('Failed to fetch log stats');
    const data = await response.json();
    return data.data ?? { total: 0, byLevel: {}, byModule: {} };
  },
};

// Level config
const LEVEL_CONFIG = {
  debug: { icon: Bug, color: 'text-gray-500', bg: 'bg-gray-100', label: 'Debug' },
  info: { icon: Info, color: 'text-blue-500', bg: 'bg-blue-100', label: 'Info' },
  warn: { icon: AlertTriangle, color: 'text-yellow-500', bg: 'bg-yellow-100', label: 'Warning' },
  error: { icon: AlertCircle, color: 'text-red-500', bg: 'bg-red-100', label: 'Error' },
  fatal: { icon: Skull, color: 'text-purple-500', bg: 'bg-purple-100', label: 'Fatal' },
};

// Date ranges
const DATE_RANGES = [
  { label: 'Последний час', value: '1h' },
  { label: 'Последние 24 часа', value: '24h' },
  { label: 'Последние 7 дней', value: '7d' },
  { label: 'Последние 30 дней', value: '30d' },
];

const LogsPage = () => {
  const [dateRange, setDateRange] = useState('24h');
  const [levelFilter, setLevelFilter] = useState<string>('');
  const [moduleFilter, setModuleFilter] = useState<string>('');
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(new Set());

  // Calculate date range
  const getDateRange = () => {
    const now = new Date();
    let from: Date;

    switch (dateRange) {
      case '1h':
        from = new Date(now.getTime() - 60 * 60 * 1000);
        break;
      case '24h':
        from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      default:
        from = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    }

    return { from: from.toISOString(), to: now.toISOString() };
  };

  const { from, to } = getDateRange();

  // Fetch logs
  const {
    data: logs,
    isLoading: logsLoading,
    refetch: refetchLogs,
  } = useQuery({
    queryKey: ['logs', dateRange, levelFilter, moduleFilter],
    queryFn: () =>
      logsApi.getLogs({
        level: levelFilter || undefined,
        module: moduleFilter || undefined,
        from,
        to,
        limit: 200,
      }),
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  // Fetch stats
  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['log-stats', dateRange],
    queryFn: () => logsApi.getStats(from, to),
  });

  // Toggle log expansion
  const toggleExpand = (id: string) => {
    const newExpanded = new Set(expandedLogs);
    if (newExpanded.has(id)) {
      newExpanded.delete(id);
    } else {
      newExpanded.add(id);
    }
    setExpandedLogs(newExpanded);
  };

  // Format timestamp
  const formatTime = (timestamp: string) => {
    const date = new Date(timestamp);
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  // Get unique modules from logs
  const modules = [...new Set(logs?.map((l) => l.module) ?? [])];

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Системные Логи</h1>
          <p className="text-gray-600 mt-1">
            Ошибки, предупреждения и системные события
          </p>
        </div>
        <button
          onClick={() => refetchLogs()}
          className="btn-secondary flex items-center gap-2"
        >
          <RefreshCw className="w-4 h-4" />
          Обновить
        </button>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        {Object.entries(LEVEL_CONFIG).map(([level, config]) => {
          const count = stats?.byLevel[level] ?? 0;
          const Icon = config.icon;
          return (
            <div
              key={level}
              className={`card p-4 cursor-pointer transition-all ${
                levelFilter === level ? 'ring-2 ring-primary-500' : ''
              }`}
              onClick={() => setLevelFilter(levelFilter === level ? '' : level)}
            >
              <div className="flex items-center gap-3">
                <div className={`p-2 rounded-lg ${config.bg}`}>
                  <Icon className={`w-5 h-5 ${config.color}`} />
                </div>
                <div>
                  <p className="text-2xl font-bold text-gray-900">{count}</p>
                  <p className="text-sm text-gray-500">{config.label}</p>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Filters */}
      <div className="card p-4 mb-6">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Filter className="w-4 h-4 text-gray-500" />
            <span className="text-sm font-medium text-gray-700">Фильтры:</span>
          </div>

          {/* Date Range */}
          <select
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            className="input w-auto bg-white text-gray-900"
            style={{ colorScheme: 'light' }}
          >
            {DATE_RANGES.map((range) => (
              <option key={range.value} value={range.value}>
                {range.label}
              </option>
            ))}
          </select>

          {/* Level Filter */}
          <select
            value={levelFilter}
            onChange={(e) => setLevelFilter(e.target.value)}
            className="input w-auto bg-white text-gray-900"
            style={{ colorScheme: 'light' }}
          >
            <option value="">Все уровни</option>
            {Object.entries(LEVEL_CONFIG).map(([level, config]) => (
              <option key={level} value={level}>
                {config.label}
              </option>
            ))}
          </select>

          {/* Module Filter */}
          <select
            value={moduleFilter}
            onChange={(e) => setModuleFilter(e.target.value)}
            className="input w-auto bg-white text-gray-900"
            style={{ colorScheme: 'light' }}
          >
            <option value="">Все модули</option>
            {modules.map((module) => (
              <option key={module} value={module}>
                {module}
              </option>
            ))}
          </select>

          {/* Clear Filters */}
          {(levelFilter || moduleFilter) && (
            <button
              onClick={() => {
                setLevelFilter('');
                setModuleFilter('');
              }}
              className="text-sm text-primary-600 hover:underline"
            >
              Сбросить фильтры
            </button>
          )}
        </div>
      </div>

      {/* Logs List */}
      <div className="card">
        <div className="p-4 border-b border-gray-200">
          <h2 className="font-semibold text-gray-900">
            Логи ({logs?.length ?? 0})
          </h2>
        </div>

        {logsLoading || statsLoading ? (
          <div className="p-8 text-center">
            <RefreshCw className="w-8 h-8 animate-spin text-gray-400 mx-auto mb-2" />
            <p className="text-gray-500">Загрузка логов...</p>
          </div>
        ) : logs?.length === 0 ? (
          <div className="p-8 text-center">
            <Info className="w-12 h-12 text-gray-300 mx-auto mb-2" />
            <p className="text-gray-500">Нет логов за выбранный период</p>
            <p className="text-sm text-gray-400 mt-1">
              Попробуйте изменить фильтры или период
            </p>
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {logs?.map((log) => {
              const config = LEVEL_CONFIG[log.level];
              const Icon = config.icon;
              const isExpanded = expandedLogs.has(log.id);

              return (
                <div
                  key={log.id}
                  className="p-4 hover:bg-gray-50 transition-colors"
                >
                  {/* Log Header */}
                  <div
                    className="flex items-start gap-3 cursor-pointer"
                    onClick={() => toggleExpand(log.id)}
                  >
                    {/* Expand Icon */}
                    <div className="mt-1">
                      {isExpanded ? (
                        <ChevronDown className="w-4 h-4 text-gray-400" />
                      ) : (
                        <ChevronRight className="w-4 h-4 text-gray-400" />
                      )}
                    </div>

                    {/* Level Icon */}
                    <div className={`p-1.5 rounded ${config.bg}`}>
                      <Icon className={`w-4 h-4 ${config.color}`} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span
                          className={`px-2 py-0.5 text-xs font-medium rounded ${config.bg} ${config.color}`}
                        >
                          {config.label}
                        </span>
                        <span className="px-2 py-0.5 text-xs font-medium rounded bg-gray-100 text-gray-600">
                          {log.module}
                        </span>
                        {log.user_id && (
                          <span className="flex items-center gap-1 text-xs text-gray-500">
                            <User className="w-3 h-3" />
                            {log.user_id}
                          </span>
                        )}
                      </div>
                      <p className="text-sm text-gray-900 truncate">
                        {log.message}
                      </p>
                    </div>

                    {/* Timestamp */}
                    <div className="flex items-center gap-1 text-xs text-gray-500 whitespace-nowrap">
                      <Clock className="w-3 h-3" />
                      {formatTime(log.timestamp)}
                    </div>
                  </div>

                  {/* Expanded Content */}
                  {isExpanded && (
                    <div className="mt-3 ml-11 space-y-3">
                      {/* Full Message */}
                      <div>
                        <p className="text-xs font-medium text-gray-500 mb-1">
                          Сообщение:
                        </p>
                        <p className="text-sm text-gray-700 bg-gray-50 p-2 rounded">
                          {log.message}
                        </p>
                      </div>

                      {/* Data */}
                      {log.data && Object.keys(log.data).length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-1">
                            Данные:
                          </p>
                          <pre className="text-xs bg-gray-900 text-green-400 p-3 rounded overflow-x-auto">
                            {JSON.stringify(log.data, null, 2)}
                          </pre>
                        </div>
                      )}

                      {/* Stack Trace */}
                      {log.error_stack && (
                        <div>
                          <p className="text-xs font-medium text-gray-500 mb-1">
                            Stack Trace:
                          </p>
                          <pre className="text-xs bg-red-50 text-red-700 p-3 rounded overflow-x-auto whitespace-pre-wrap">
                            {log.error_stack}
                          </pre>
                        </div>
                      )}

                      {/* Meta */}
                      <div className="flex flex-wrap gap-4 text-xs text-gray-500">
                        <span className="flex items-center gap-1">
                          <Server className="w-3 h-3" />
                          ID: {log.id.slice(0, 8)}...
                        </span>
                        {log.request_id && (
                          <span>Request ID: {log.request_id}</span>
                        )}
                        <span>
                          Время: {new Date(log.timestamp).toLocaleString('ru-RU')}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Module Stats */}
      {stats && Object.keys(stats.byModule).length > 0 && (
        <div className="card mt-6 p-4">
          <h3 className="font-semibold text-gray-900 mb-3">Логи по модулям</h3>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.byModule)
              .sort((a, b) => b[1] - a[1])
              .map(([module, count]) => (
                <button
                  key={module}
                  onClick={() =>
                    setModuleFilter(moduleFilter === module ? '' : module)
                  }
                  className={`px-3 py-1.5 text-sm rounded-full transition-colors ${
                    moduleFilter === module
                      ? 'bg-primary-500 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {module}: {count}
                </button>
              ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default LogsPage;
