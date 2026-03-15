import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Users,
  User,
  MessageSquare,
  Mic,
  Image,
  Clock,
  ChevronRight,
  Brain,
  Plus,
  Trash2,
  Pin,
  Search,
  RefreshCw,
  Loader2,
  History,
  Zap,
} from 'lucide-react';

// API URL
const BOT_URL = import.meta.env.VITE_BOT_URL ?? '';

// Types
interface UserProfile {
  id: string;
  user_id: string;
  username?: string;
  first_name?: string;
  last_name?: string;
  language_code: string;
  total_messages: number;
  total_voice_messages: number;
  total_images: number;
  total_tokens_used: number;
  first_seen_at: string;
  last_seen_at: string;
  last_message_at?: string;
}

interface UserMemory {
  id: string;
  user_id: string;
  memory_type: 'fact' | 'preference' | 'context' | 'summary' | 'important';
  content: string;
  is_pinned: boolean;
  created_at: string;
}

interface UserLog {
  id: string;
  user_id: string;
  event_type: string;
  content?: string;
  metadata: Record<string, unknown>;
  model?: string;
  tokens_prompt?: number;
  tokens_completion?: number;
  response_time_ms?: number;
  timestamp: string;
}

// API functions
const usersApi = {
  async getAll(): Promise<UserProfile[]> {
    const response = await fetch(`${BOT_URL}/api/users?limit=100`);
    if (!response.ok) throw new Error('Failed to fetch users');
    const data = await response.json();
    return data.data ?? [];
  },

  async getMemory(userId: string): Promise<UserMemory[]> {
    const response = await fetch(`${BOT_URL}/api/users/${userId}/memory`);
    if (!response.ok) throw new Error('Failed to fetch memory');
    const data = await response.json();
    return data.data ?? [];
  },

  async addMemory(userId: string, memory: { memory_type: string; content: string; is_pinned?: boolean }): Promise<void> {
    const response = await fetch(`${BOT_URL}/api/users/${userId}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(memory),
    });
    if (!response.ok) throw new Error('Failed to add memory');
  },

  async deleteMemory(userId: string, memoryId: string): Promise<void> {
    const response = await fetch(`${BOT_URL}/api/users/${userId}/memory/${memoryId}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Failed to delete memory');
  },

  async getLogs(userId: string, limit: number = 50): Promise<UserLog[]> {
    const response = await fetch(`${BOT_URL}/api/users/${userId}/logs?limit=${limit}`);
    if (!response.ok) throw new Error('Failed to fetch logs');
    const data = await response.json();
    return data.data ?? [];
  },
};

// Memory type config
const MEMORY_TYPES = {
  important: { label: 'Важное', color: 'bg-red-100 text-red-700', icon: '⚠️' },
  fact: { label: 'Факт', color: 'bg-blue-100 text-blue-700', icon: '📋' },
  preference: { label: 'Предпочтение', color: 'bg-green-100 text-green-700', icon: '💚' },
  context: { label: 'Контекст', color: 'bg-purple-100 text-purple-700', icon: '🎯' },
  summary: { label: 'Итог', color: 'bg-white/10 text-white/70', icon: '📝' },
};

// Event type config
const EVENT_TYPES: Record<string, { label: string; color: string }> = {
  message: { label: 'Сообщение', color: 'bg-blue-100 text-blue-700' },
  voice: { label: 'Голос', color: 'bg-purple-100 text-purple-700' },
  image: { label: 'Фото', color: 'bg-green-100 text-green-700' },
  ai_response: { label: 'AI Ответ', color: 'bg-amber-100 text-amber-700' },
  error: { label: 'Ошибка', color: 'bg-red-100 text-red-700' },
  memory_created: { label: 'Память+', color: 'bg-cyan-100 text-cyan-700' },
};

const UsersPage = () => {
  const queryClient = useQueryClient();
  const [selectedUser, setSelectedUser] = useState<UserProfile | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [activeTab, setActiveTab] = useState<'memory' | 'logs'>('memory');
  const [newMemory, setNewMemory] = useState({ type: 'fact', content: '', isPinned: false });
  const [showAddMemory, setShowAddMemory] = useState(false);

  // Fetch users
  const { data: users, isLoading: usersLoading, refetch: refetchUsers } = useQuery({
    queryKey: ['users'],
    queryFn: usersApi.getAll,
  });

  // Fetch memory for selected user
  const { data: memory, isLoading: memoryLoading } = useQuery({
    queryKey: ['user-memory', selectedUser?.user_id],
    queryFn: () => usersApi.getMemory(selectedUser!.user_id),
    enabled: !!selectedUser,
  });

  // Fetch logs for selected user
  const { data: logs, isLoading: logsLoading } = useQuery({
    queryKey: ['user-logs', selectedUser?.user_id],
    queryFn: () => usersApi.getLogs(selectedUser!.user_id),
    enabled: !!selectedUser && activeTab === 'logs',
  });

  // Add memory mutation
  const addMemoryMutation = useMutation({
    mutationFn: () =>
      usersApi.addMemory(selectedUser!.user_id, {
        memory_type: newMemory.type,
        content: newMemory.content,
        is_pinned: newMemory.isPinned,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-memory', selectedUser?.user_id] });
      setNewMemory({ type: 'fact', content: '', isPinned: false });
      setShowAddMemory(false);
    },
  });

  // Delete memory mutation
  const deleteMemoryMutation = useMutation({
    mutationFn: (memoryId: string) => usersApi.deleteMemory(selectedUser!.user_id, memoryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-memory', selectedUser?.user_id] });
    },
  });

  // Filter users by search
  const filteredUsers = users?.filter((user) => {
    const searchLower = searchQuery.toLowerCase();
    return (
      user.user_id.includes(searchLower) ||
      user.username?.toLowerCase().includes(searchLower) ||
      user.first_name?.toLowerCase().includes(searchLower)
    );
  });

  // Format date
  const formatDate = (date: string) => {
    return new Date(date).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Get user display name
  const getUserName = (user: UserProfile) => {
    return user.first_name || user.username || `User ${user.user_id}`;
  };

  return (
    <div className="p-6 lg:p-8">
      <div className="flex gap-6">
        {/* Users List */}
        <div className="w-80 flex-shrink-0">
          <div className="card h-[calc(100vh-8rem)] flex flex-col">
            {/* Header */}
            <div className="p-4 border-b border-white/10">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-white flex items-center gap-2">
                  <Users className="w-5 h-5" />
                  Пользователи
                </h2>
                <button
                  onClick={() => refetchUsers()}
                  className="p-1.5 hover:bg-white/10 rounded"
                >
                  <RefreshCw className="w-4 h-4 text-white/50" />
                </button>
              </div>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  type="text"
                  placeholder="Поиск..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="input pl-9 py-2 text-sm"
                />
              </div>
            </div>

            {/* Users List */}
            <div className="flex-1 overflow-y-auto">
              {usersLoading ? (
                <div className="p-4 text-center">
                  <Loader2 className="w-6 h-6 animate-spin text-gray-400 mx-auto" />
                </div>
              ) : filteredUsers?.length === 0 ? (
                <div className="p-4 text-center text-white/50 text-sm">
                  Пользователи не найдены
                </div>
              ) : (
                filteredUsers?.map((user) => (
                  <div
                    key={user.id}
                    onClick={() => setSelectedUser(user)}
                    className={`p-3 border-b border-white/10 cursor-pointer transition-colors ${
                      selectedUser?.id === user.id
                        ? 'bg-primary-50 border-l-4 border-l-primary-500'
                        : 'hover:bg-white/5'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-full bg-gradient-to-br from-primary-400 to-purple-500 flex items-center justify-center text-white font-medium">
                        {getUserName(user).charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-white truncate">
                          {getUserName(user)}
                        </p>
                        <p className="text-xs text-white/50">
                          {user.username ? `@${user.username}` : `ID: ${user.user_id}`}
                        </p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    </div>
                    <div className="flex items-center gap-3 mt-2 text-xs text-white/50">
                      <span className="flex items-center gap-1">
                        <MessageSquare className="w-3 h-3" />
                        {user.total_messages}
                      </span>
                      <span className="flex items-center gap-1">
                        <Mic className="w-3 h-3" />
                        {user.total_voice_messages}
                      </span>
                      <span className="flex items-center gap-1">
                        <Image className="w-3 h-3" />
                        {user.total_images}
                      </span>
                    </div>
                  </div>
                ))
              )}
            </div>

            {/* Stats */}
            <div className="p-3 border-t border-white/10 bg-white/5 text-xs text-white/50">
              Всего: {users?.length ?? 0} пользователей
            </div>
          </div>
        </div>

        {/* User Details */}
        <div className="flex-1">
          {selectedUser ? (
            <div className="space-y-6">
              {/* User Header */}
              <div className="card p-6">
                <div className="flex items-start gap-4">
                  <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary-400 to-purple-500 flex items-center justify-center text-white text-2xl font-medium">
                    {getUserName(selectedUser).charAt(0).toUpperCase()}
                  </div>
                  <div className="flex-1">
                    <h2 className="text-xl font-bold text-white">
                      {getUserName(selectedUser)}
                    </h2>
                    <p className="text-white/50">
                      {selectedUser.username ? `@${selectedUser.username}` : ''} • ID: {selectedUser.user_id}
                    </p>
                    <div className="flex items-center gap-4 mt-3 text-sm">
                      <span className="flex items-center gap-1 text-white/60">
                        <Clock className="w-4 h-4" />
                        Первый визит: {formatDate(selectedUser.first_seen_at)}
                      </span>
                      <span className="flex items-center gap-1 text-white/60">
                        <Zap className="w-4 h-4" />
                        Токенов: {selectedUser.total_tokens_used.toLocaleString()}
                      </span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div className="p-3 bg-blue-50 rounded-lg">
                      <p className="text-2xl font-bold text-blue-600">{selectedUser.total_messages}</p>
                      <p className="text-xs text-blue-600">Сообщений</p>
                    </div>
                    <div className="p-3 bg-purple-50 rounded-lg">
                      <p className="text-2xl font-bold text-purple-600">{selectedUser.total_voice_messages}</p>
                      <p className="text-xs text-purple-600">Голосовых</p>
                    </div>
                    <div className="p-3 bg-green-50 rounded-lg">
                      <p className="text-2xl font-bold text-green-600">{selectedUser.total_images}</p>
                      <p className="text-xs text-green-600">Фото</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Tabs */}
              <div className="flex gap-2">
                <button
                  onClick={() => setActiveTab('memory')}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                    activeTab === 'memory'
                      ? 'bg-primary-500 text-white'
                      : 'bg-white/10 text-white/70 hover:bg-white/10'
                  }`}
                >
                  <Brain className="w-4 h-4" />
                  Память ({memory?.length ?? 0})
                </button>
                <button
                  onClick={() => setActiveTab('logs')}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors flex items-center gap-2 ${
                    activeTab === 'logs'
                      ? 'bg-primary-500 text-white'
                      : 'bg-white/10 text-white/70 hover:bg-white/10'
                  }`}
                >
                  <History className="w-4 h-4" />
                  История
                </button>
              </div>

              {/* Memory Tab */}
              {activeTab === 'memory' && (
                <div className="card">
                  <div className="p-4 border-b border-white/10 flex items-center justify-between">
                    <h3 className="font-semibold text-white">Память о пользователе</h3>
                    <button
                      onClick={() => setShowAddMemory(!showAddMemory)}
                      className="btn-primary text-sm py-1.5"
                    >
                      <Plus className="w-4 h-4 mr-1" />
                      Добавить
                    </button>
                  </div>

                  {/* Add Memory Form */}
                  {showAddMemory && (
                    <div className="p-4 bg-white/5 border-b border-white/10">
                      <div className="space-y-3">
                        <div className="flex gap-3">
                          <select
                            value={newMemory.type}
                            onChange={(e) => setNewMemory({ ...newMemory, type: e.target.value })}
                            className="input w-40 bg-white/5 text-gray-200"
                          >
                            {Object.entries(MEMORY_TYPES).map(([key, { label }]) => (
                              <option key={key} value={key}>{label}</option>
                            ))}
                          </select>
                          <input
                            type="text"
                            placeholder="Содержимое..."
                            value={newMemory.content}
                            onChange={(e) => setNewMemory({ ...newMemory, content: e.target.value })}
                            className="input flex-1 bg-white/5 text-gray-200"
                          />
                        </div>
                        <div className="flex items-center justify-between">
                          <label className="flex items-center gap-2 text-sm text-white/60">
                            <input
                              type="checkbox"
                              checked={newMemory.isPinned}
                              onChange={(e) => setNewMemory({ ...newMemory, isPinned: e.target.checked })}
                              className="rounded"
                            />
                            <Pin className="w-4 h-4" />
                            Закрепить (всегда в контексте)
                          </label>
                          <div className="flex gap-2">
                            <button
                              onClick={() => setShowAddMemory(false)}
                              className="btn-secondary text-sm py-1.5"
                            >
                              Отмена
                            </button>
                            <button
                              onClick={() => addMemoryMutation.mutate()}
                              disabled={!newMemory.content || addMemoryMutation.isPending}
                              className="btn-primary text-sm py-1.5"
                            >
                              {addMemoryMutation.isPending ? (
                                <Loader2 className="w-4 h-4 animate-spin" />
                              ) : (
                                'Сохранить'
                              )}
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Memory List */}
                  <div className="divide-y divide-gray-100">
                    {memoryLoading ? (
                      <div className="p-8 text-center">
                        <Loader2 className="w-6 h-6 animate-spin text-gray-400 mx-auto" />
                      </div>
                    ) : memory?.length === 0 ? (
                      <div className="p-8 text-center text-white/50">
                        <Brain className="w-12 h-12 text-gray-300 mx-auto mb-2" />
                        <p>Нет записей в памяти</p>
                        <p className="text-sm mt-1">Бот автоматически извлекает факты из разговоров</p>
                      </div>
                    ) : (
                      memory?.map((item) => {
                        const typeConfig = MEMORY_TYPES[item.memory_type] || MEMORY_TYPES.fact;
                        return (
                          <div key={item.id} className="p-4 hover:bg-white/5">
                            <div className="flex items-start gap-3">
                              <span className="text-lg">{typeConfig.icon}</span>
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <span className={`px-2 py-0.5 text-xs rounded ${typeConfig.color}`}>
                                    {typeConfig.label}
                                  </span>
                                  {item.is_pinned && (
                                    <Pin className="w-3 h-3 text-amber-500" />
                                  )}
                                </div>
                                <p className="text-white">{item.content}</p>
                                <p className="text-xs text-white/50 mt-1">
                                  {formatDate(item.created_at)}
                                </p>
                              </div>
                              <button
                                onClick={() => deleteMemoryMutation.mutate(item.id)}
                                className="p-1.5 hover:bg-red-100 rounded text-gray-400 hover:text-red-500"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}

              {/* Logs Tab */}
              {activeTab === 'logs' && (
                <div className="card">
                  <div className="p-4 border-b border-white/10">
                    <h3 className="font-semibold text-white">История взаимодействий</h3>
                  </div>
                  <div className="divide-y divide-gray-100 max-h-[600px] overflow-y-auto">
                    {logsLoading ? (
                      <div className="p-8 text-center">
                        <Loader2 className="w-6 h-6 animate-spin text-gray-400 mx-auto" />
                      </div>
                    ) : logs?.length === 0 ? (
                      <div className="p-8 text-center text-white/50">
                        <History className="w-12 h-12 text-gray-300 mx-auto mb-2" />
                        <p>Нет записей</p>
                      </div>
                    ) : (
                      logs?.map((log) => {
                        const eventConfig = EVENT_TYPES[log.event_type] || { label: log.event_type, color: 'bg-white/10 text-white/70' };
                        return (
                          <div key={log.id} className="p-3 hover:bg-white/5">
                            <div className="flex items-start gap-3">
                              <span className={`px-2 py-0.5 text-xs rounded ${eventConfig.color}`}>
                                {eventConfig.label}
                              </span>
                              <div className="flex-1 min-w-0">
                                {log.content && (
                                  <p className="text-sm text-white truncate">{log.content}</p>
                                )}
                                <div className="flex items-center gap-3 text-xs text-white/50 mt-1">
                                  <span>{formatDate(log.timestamp)}</span>
                                  {log.model && <span>Модель: {log.model}</span>}
                                  {log.response_time_ms && <span>{log.response_time_ms}ms</span>}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="card p-12 text-center">
              <User className="w-16 h-16 text-gray-300 mx-auto mb-4" />
              <h3 className="text-lg font-medium text-white mb-2">
                Выберите пользователя
              </h3>
              <p className="text-white/50">
                Выберите пользователя из списка слева для просмотра его профиля, памяти и истории
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default UsersPage;
