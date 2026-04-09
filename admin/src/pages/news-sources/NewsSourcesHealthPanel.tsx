import type { FC } from 'react';
import { Loader2, HeartPulse, Trash, Search } from 'lucide-react';
import type { HealthResult } from './useNewsSourcesPage';

interface NewsSourcesHealthPanelProps {
  healthLoading: boolean;
  healthResult: HealthResult | null;
  cleanupLoading: boolean;
  onHealthCheck: () => void;
  onCleanupDead: () => void;
}

export const NewsSourcesHealthPanel: FC<NewsSourcesHealthPanelProps> = ({
  healthLoading, healthResult, cleanupLoading, onHealthCheck, onCleanupDead,
}) => (
  <div className="card mb-6">
    <div className="flex items-center justify-between mb-3">
      <div className="flex items-center gap-2">
        <HeartPulse className="w-5 h-5 text-green-400" />
        <h3 className="font-semibold text-gray-200">Здоровье источников</h3>
      </div>
      <div className="flex items-center gap-2">
        <button
          disabled={healthLoading}
          onClick={onHealthCheck}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                     text-green-400 hover:bg-green-400/10 transition-all"
          style={{ border: '1px solid rgba(74, 222, 128, 0.25)' }}
        >
          {healthLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
          Проверить все
        </button>
        {healthResult && healthResult.dead.length > 0 && (
          <button
            disabled={cleanupLoading}
            onClick={onCleanupDead}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg
                       text-red-400 hover:bg-red-400/10 transition-all"
            style={{ border: '1px solid rgba(248, 113, 113, 0.25)' }}
          >
            {cleanupLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash className="w-3.5 h-3.5" />}
            Выключить мёртвые ({healthResult.dead.length})
          </button>
        )}
      </div>
    </div>

    {healthResult && (
      <div>
        <div className="flex items-center gap-4 mb-3 text-sm">
          <span className="text-green-400">✅ Доступны: {healthResult.healthy}</span>
          <span className="text-red-400">❌ Недоступны: {healthResult.unhealthy}</span>
          <span className="text-gray-500">Проверено: {healthResult.totalChecked}</span>
        </div>
        {healthResult.dead.length > 0 && (
          <div className="space-y-1.5 max-h-48 overflow-y-auto">
            {healthResult.dead.map((d, i) => (
              <div key={i} className="flex items-center gap-2 p-2 rounded-lg text-xs"
                style={{ background: 'rgba(248, 113, 113, 0.05)', border: '1px solid rgba(248, 113, 113, 0.15)' }}>
                <span className="text-red-400 font-medium truncate flex-1">{d.name}</span>
                <span className="text-gray-500 truncate max-w-[200px]">{d.reason}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    )}

    {!healthResult && !healthLoading && (
      <p className="text-xs text-gray-500">
        Нажми «Проверить все» для диагностики доступности источников. Мёртвые можно отключить одной кнопкой.
      </p>
    )}
  </div>
);
