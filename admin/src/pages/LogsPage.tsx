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
  Download,
  FileJson,
  FileText,
  Copy,
  Check,
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
const BOT_URL = import.meta.env.VITE_BOT_URL ?? '';

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
  debug: { icon: Bug, color: 'text-gray-500', bg: 'bg-white/10', label: 'Debug' },
  info: { icon: Info, color: 'text-blue-500', bg: 'bg-blue-500/20', label: 'Info' },
  warn: { icon: AlertTriangle, color: 'text-yellow-500', bg: 'bg-yellow-500/20', label: 'Warning' },
  error: { icon: AlertCircle, color: 'text-red-500', bg: 'bg-red-500/20', label: 'Error' },
  fatal: { icon: Skull, color: 'text-purple-500', bg: 'bg-purple-500/20', label: 'Fatal' },
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
  const [copyMessage, setCopyMessage] = useState('');

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

  // Download logs as JSON
  const downloadJSON = (data: SystemLog[], filename: string) => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Download logs as CSV
  const downloadCSV = (data: SystemLog[], filename: string) => {
    const headers = ['timestamp', 'level', 'module', 'message', 'user_id', 'request_id', 'data', 'error_stack'];
    const csvRows = [
      headers.join(','),
      ...data.map(log => [
        `"${log.timestamp}"`,
        `"${log.level}"`,
        `"${log.module}"`,
        `"${log.message.replace(/"/g, '""')}"`,
        `"${log.user_id || ''}"`,
        `"${log.request_id || ''}"`,
        `"${log.data ? JSON.stringify(log.data).replace(/"/g, '""') : ''}"`,
        `"${log.error_stack?.replace(/"/g, '""') || ''}"`,
      ].join(','))
    ];
    const blob = new Blob([csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Download logs as TXT (human-readable)
  const downloadTXT = (data: SystemLog[], filename: string) => {
    const lines = data.map(log => {
      const parts = [
        `[${new Date(log.timestamp).toLocaleString('ru-RU')}]`,
        `[${log.level.toUpperCase()}]`,
        `[${log.module}]`,
        log.message,
      ];
      if (log.user_id) parts.push(`| User: ${log.user_id}`);
      if (log.data && Object.keys(log.data).length > 0) {
        parts.push(`\n  Data: ${JSON.stringify(log.data)}`);
      }
      if (log.error_stack) {
        parts.push(`\n  Stack:\n    ${log.error_stack.split('\n').join('\n    ')}`);
      }
      return parts.join(' ');
    });
    const blob = new Blob([lines.join('\n\n')], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  // Get filename with current filters
  const getFilename = (ext: string) => {
    const parts = ['amina-logs'];
    if (levelFilter) parts.push(levelFilter);
    if (moduleFilter) parts.push(moduleFilter);
    parts.push(dateRange);
    parts.push(new Date().toISOString().slice(0, 10));
    return `${parts.join('-')}.${ext}`;
  };

  // Filter logs by level for download
  const getLogsByLevel = (level: string) => logs?.filter(l => l.level === level) ?? [];

  const copyAllLogs = async () => {
    if (!logs || logs.length === 0) {
      setCopyMessage('Нет логов для копирования');
      setTimeout(() => setCopyMessage(''), 2000);
      return;
    }
    try {
      const text = JSON.stringify(logs, null, 2);
      await navigator.clipboard.writeText(text);
      setCopyMessage('Скопировано!');
      setTimeout(() => setCopyMessage(''), 2000);
    } catch {
      setCopyMessage('Ошибка копирования');
      setTimeout(() => setCopyMessage(''), 2000);
    }
  };

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
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => refetchLogs()}
            className="btn-secondary flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Обновить
          </button>

          {/* Copy all logs */}
          <button
            onClick={copyAllLogs}
            disabled={!logs || logs.length === 0}
            className="btn-secondary flex items-center gap-2"
            title="Скопировать все логи в буфер обмена (JSON)"
          >
            {copyMessage ? (
              <>
                <Check className="w-4 h-4 text-green-600" />
                {copyMessage}
              </>
            ) : (
              <>
                <Copy className="w-4 h-4" />
                Копировать все логи
              </>
            )}
          </button>
          
          {/* Download dropdown */}
          {logs && logs.length > 0 && (
            <div className="relative group">
              <button className="btn-primary flex items-center gap-2">
                <Download className="w-4 h-4" />
                Скачать
                <ChevronDown className="w-3 h-3" />
              </button>
              <div className="absolute right-0 mt-1 w-48 bg-[#1a1a2e] rounded-lg shadow-lg border border-[rgba(255,215,0,0.2)] opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
                <div className="p-2 border-b border-white/10">
                  <p className="text-xs font-medium text-white/50 px-2">Все логи ({logs.length})</p>
                </div>
                <button
                  onClick={() => downloadJSON(logs, getFilename('json'))}
                  className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-white/10 flex items-center gap-2"
                >
                  <FileJson className="w-4 h-4 text-blue-500" />
                  JSON
                </button>
                <button
                  onClick={() => downloadCSV(logs, getFilename('csv'))}
                  className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-white/10 flex items-center gap-2"
                >
                  <FileText className="w-4 h-4 text-green-500" />
                  CSV
                </button>
                <button
                  onClick={() => downloadTXT(logs, getFilename('txt'))}
                  className="w-full px-3 py-2 text-left text-sm text-gray-300 hover:bg-white/10 flex items-center gap-2"
                >
                  <FileText className="w-4 h-4 text-gray-500" />
                  TXT
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        {Object.entries(LEVEL_CONFIG).map(([level, config]) => {
          const count = stats?.byLevel[level] ?? 0;
          const levelLogs = getLogsByLevel(level);
          const Icon = config.icon;
          return (
            <div
              key={level}
              className={`card p-4 transition-all ${
                levelFilter === level ? 'ring-2 ring-primary-500' : ''
              }`}
            >
              <div className="flex items-center justify-between">
                <div 
                  className="flex items-center gap-3 cursor-pointer flex-1"
                  onClick={() => setLevelFilter(levelFilter === level ? '' : level)}
                >
                  <div className={`p-2 rounded-lg ${config.bg}`}>
                    <Icon className={`w-5 h-5 ${config.color}`} />
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-gray-900">{count}</p>
                    <p className="text-sm text-gray-500">{config.label}</p>
                  </div>
                </div>
                {levelLogs.length > 0 && (
                  <div className="relative group">
                    <button 
                      className="p-1.5 rounded hover:bg-white/10 transition-colors"
                      title={`Скачать ${config.label} логи`}
                    >
                      <Download className="w-4 h-4 text-gray-400" />
                    </button>
                    <div className="absolute right-0 mt-1 w-32 bg-[#1a1a2e] rounded-lg shadow-lg border border-[rgba(255,215,0,0.2)] opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
                      <button
                        onClick={() => downloadJSON(levelLogs, `amina-${level}-${dateRange}.json`)}
                        className="w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-white/10"
                      >
                        JSON
                      </button>
                      <button
                        onClick={() => downloadCSV(levelLogs, `amina-${level}-${dateRange}.csv`)}
                        className="w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-white/10"
                      >
                        CSV
                      </button>
                      <button
                        onClick={() => downloadTXT(levelLogs, `amina-${level}-${dateRange}.txt`)}
                        className="w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-white/10"
                      >
                        TXT
                      </button>
                    </div>
                  </div>
                )}
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
            className="input w-auto"
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
            className="input w-auto"
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
            className="input w-auto"
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
                  className="p-4 hover:bg-white/5 transition-colors"
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
                        <span className="px-2 py-0.5 text-xs font-medium rounded bg-white/10 text-white/60">
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
                        <p className="text-xs font-medium text-white/50 mb-1">
                          Сообщение:
                        </p>
                        <p className="text-sm text-gray-300 bg-white/5 p-2 rounded">
                          {log.message}
                        </p>
                      </div>

                      {/* Data */}
                      {log.data && Object.keys(log.data).length > 0 && (
                        <div>
                          <p className="text-xs font-medium text-white/50 mb-1">
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
                          <p className="text-xs font-medium text-white/50 mb-1">
                            Stack Trace:
                          </p>
                          <pre className="text-xs bg-red-500/10 text-red-400 p-3 rounded overflow-x-auto whitespace-pre-wrap">
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
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-900">Логи по модулям</h3>
          </div>
          <div className="flex flex-wrap gap-2">
            {Object.entries(stats.byModule)
              .sort((a, b) => b[1] - a[1])
              .map(([module, count]) => {
                const moduleLogs = logs?.filter(l => l.module === module) ?? [];
                return (
                  <div key={module} className="relative group inline-flex">
                    <button
                      onClick={() =>
                        setModuleFilter(moduleFilter === module ? '' : module)
                      }
                      className={`px-3 py-1.5 text-sm rounded-l-full transition-colors ${
                        moduleFilter === module
                          ? 'bg-primary-500 text-white'
                          : 'bg-white/10 text-white/70 hover:bg-white/15'
                      }`}
                    >
                      {module}: {count}
                    </button>
                    {moduleLogs.length > 0 && (
                      <div className="relative">
                        <button
                          className={`px-2 py-1.5 text-sm rounded-r-full border-l transition-colors ${
                            moduleFilter === module
                              ? 'bg-primary-600 text-white border-primary-400'
                              : 'bg-white/10 text-white/50 hover:bg-white/15 border-white/10'
                          }`}
                          title={`Скачать логи ${module}`}
                        >
                          <Download className="w-3 h-3" />
                        </button>
                        <div className="absolute right-0 mt-1 w-32 bg-[#1a1a2e] rounded-lg shadow-lg border border-[rgba(255,215,0,0.2)] opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-10">
                          <button
                            onClick={() => downloadJSON(moduleLogs, `amina-${module}-${dateRange}.json`)}
                            className="w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-white/10"
                          >
                            JSON
                          </button>
                          <button
                            onClick={() => downloadCSV(moduleLogs, `amina-${module}-${dateRange}.csv`)}
                            className="w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-white/10"
                          >
                            CSV
                          </button>
                          <button
                            onClick={() => downloadTXT(moduleLogs, `amina-${module}-${dateRange}.txt`)}
                            className="w-full px-3 py-1.5 text-left text-xs text-gray-300 hover:bg-white/10"
                          >
                            TXT
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}
    </div>
  );
};

export default LogsPage;
