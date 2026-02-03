import { useQuery } from '@tanstack/react-query';
import { analyticsApi } from '../api/supabase';
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

  const { data: stats, isLoading } = useQuery({
    queryKey: ['dashboard-stats'],
    queryFn: () => analyticsApi.getStats(startOfDay(weekAgo), endOfDay(today)),
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

  return (
    <div className="p-6 lg:p-8 max-w-7xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="text-gray-600 mt-1">
          Обзор активности за последние 7 дней
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {statCards.map((stat) => (
          <div key={stat.label} className="card">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-gray-600">{stat.label}</p>
                <p className="text-2xl font-bold mt-1">
                  {isLoading ? (
                    <span className="animate-pulse bg-gray-200 rounded h-8 w-16 block" />
                  ) : (
                    stat.format ? stat.format(stat.value) : stat.value
                  )}
                </p>
              </div>
              <div className={`p-3 rounded-lg ${stat.bgColor}`}>
                <stat.icon className={`w-6 h-6 ${stat.color}`} />
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
            <TrendingUp className="w-5 h-5 text-gray-400" />
            <h3 className="font-semibold">Использование токенов</h3>
          </div>
          <div className="h-64">
            {isLoading ? (
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
            <Activity className="w-5 h-5 text-gray-400" />
            <h3 className="font-semibold">Статус системы</h3>
          </div>
          <div className="space-y-4">
            <StatusItem
              label="Telegram Bot"
              status="online"
              description="Подключен и работает"
            />
            <StatusItem
              label="OpenRouter API"
              status="online"
              description="Все модели доступны"
            />
            <StatusItem
              label="Voximplant"
              status="warning"
              description="Требуется настройка"
            />
            <StatusItem
              label="Vosk STT"
              status="online"
              description="Модель загружена"
            />
            <StatusItem
              label="Silero TTS"
              status="online"
              description="Готов к синтезу"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

// Status indicator component
const StatusItem = ({
  label,
  status,
  description,
}: {
  label: string;
  status: 'online' | 'offline' | 'warning';
  description: string;
}) => {
  const statusColors = {
    online: 'bg-green-500',
    offline: 'bg-red-500',
    warning: 'bg-amber-500',
  };

  return (
    <div className="flex items-center justify-between py-2 border-b border-gray-100 last:border-0">
      <div className="flex items-center gap-3">
        <div className={`w-2 h-2 rounded-full ${statusColors[status]}`} />
        <span className="font-medium text-sm">{label}</span>
      </div>
      <span className="text-sm text-gray-500">{description}</span>
    </div>
  );
};

export default DashboardPage;
