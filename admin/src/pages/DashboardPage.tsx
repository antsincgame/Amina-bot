import { useQuery } from '@tanstack/react-query';
import { analyticsApi, statusApi } from '../api/supabase';
import {
  MessageSquare,
  Phone,
  Users,
  Zap,
  TrendingUp,
  Activity,
} from 'lucide-react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { format, subDays, startOfDay, endOfDay } from 'date-fns';
import { ru } from 'date-fns/locale';

const DashboardPage = () => {
  const today = new Date();
  const weekAgo = subDays(today, 7);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => analyticsApi.getStats(startOfDay(weekAgo), endOfDay(today)),
  });

  const { data: status, isLoading: statusLoading } = useQuery({
    queryKey: ['service-status'],
    queryFn: () => statusApi.getServiceStatus(),
    refetchInterval: 30000, // Refresh every 30 seconds
  });

  const statCards = [
    {
      label: 'Сообщений',
      value: stats?.totalMessages ?? 0,
      icon: MessageSquare,
      color: 'text-blue-600',
      bgColor: 'bg-blue-100',
    },
    {
      label: 'Звонков',
      value: stats?.totalCalls ?? 0,
      icon: Phone,
      color: 'text-green-600',
      bgColor: 'bg-green-100',
    },
    {
      label: 'Пользователей',
      value: stats?.uniqueUsers ?? 0,
      icon: Users,
      color: 'text-purple-600',
      bgColor: 'bg-purple-100',
    },
    {
      label: 'Токенов (7 дней)',
      value: stats?.tokensByDay.reduce((sum, d) => sum + d.tokens, 0) ?? 0,
      icon: Zap,
      color: 'text-amber-600',
      bgColor: 'bg-amber-100',
      format: (v: number) => v.toLocaleString(),
    },
  ];

  // Map status to display format
  const getStatusInfo = (key: string): { status: 'online' | 'offline' | 'warning'; description: string } => {
    if (statusLoading) {
      return { status: 'warning', description: 'Проверка...' };
    }
    
    const check = status?.checks[key];
    if (!check) {
      return { status: 'offline', description: 'Не настроен' };
    }
    
    return {
      status: check.ready ? 'online' : 'warning',
      description: check.ready ? `${check.engine} подключен` : `${check.engine} требует настройки`,
    };
  };

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 
          className="text-2xl font-bold text-gradient-gold tracking-wide"
          style={{ fontFamily: 'var(--font-display)' }}
        >
          Dashboard
        </h1>
        <p className="text-gray-400 mt-1">
          Обзор активности за последние 7 дней
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {statCards.map((stat) => (
          <div key={stat.label} className="card glow-gold-hover">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-400">{stat.label}</p>
                <p className="text-2xl font-bold mt-1 text-gray-100">
                  {statsLoading ? (
                    <span className="animate-pulse bg-gray-700 rounded h-8 w-16 block" />
                  ) : (
                    stat.format ? stat.format(stat.value) : stat.value
                  )}
                </p>
              </div>
              <div 
                className="p-3 rounded-lg"
                style={{
                  background: 'rgba(255, 215, 0, 0.1)',
                  border: '1px solid rgba(255, 215, 0, 0.2)',
                }}
              >
                <stat.icon className="w-6 h-6 text-amber-400" />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Tokens Chart */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-5 h-5 text-amber-400" />
            <h3 className="font-semibold text-gray-200">Использование токенов</h3>
          </div>
          <div className="h-64">
            {statsLoading ? (
              <div className="h-full flex items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={stats?.tokensByDay ?? []}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(date) => format(new Date(date), 'd MMM', { locale: ru })}
                    stroke="#9ca3af"
                    fontSize={12}
                  />
                  <YAxis stroke="#9ca3af" fontSize={12} />
                  <Tooltip
                    formatter={(value: number) => [value.toLocaleString(), 'Токенов']}
                    labelFormatter={(date) => format(new Date(date), 'd MMMM yyyy', { locale: ru })}
                  />
                  <Line
                    type="monotone"
                    dataKey="tokens"
                    stroke="#0ea5e9"
                    strokeWidth={2}
                    dot={{ fill: '#0ea5e9', strokeWidth: 0, r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>

        {/* Activity Card */}
        <div className="card">
          <div className="flex items-center gap-2 mb-4">
            <Activity className="w-5 h-5 text-amber-400" />
            <h3 className="font-semibold text-gray-200">Статус системы</h3>
          </div>
          <div className="space-y-4">
            <StatusItem
              label="Telegram Bot"
              {...getStatusInfo('telegram')}
            />
            <StatusItem
              label="OpenRouter API"
              {...getStatusInfo('ai')}
            />
            <StatusItem
              label="Voximplant"
              {...getStatusInfo('voximplant')}
            />
            <StatusItem
              label="База данных"
              {...getStatusInfo('database')}
            />
            <StatusItem
              label="Админ панель"
              {...getStatusInfo('admin')}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

// Status indicator component with Neon styling
const StatusItem = ({
  label,
  status,
  description,
}: {
  label: string;
  status: 'online' | 'offline' | 'warning';
  description: string;
}) => {
  const statusClasses = {
    online: 'status-online',
    offline: 'status-offline',
    warning: 'status-warning',
  };

  return (
    <div 
      className="flex items-center justify-between py-3 border-b last:border-0"
      style={{ borderColor: 'rgba(255, 215, 0, 0.1)' }}
    >
      <div className="flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full ${statusClasses[status]}`} />
        <span className="font-medium text-sm text-gray-200">{label}</span>
      </div>
      <span className="text-sm text-gray-400">{description}</span>
    </div>
  );
};

export default DashboardPage;
