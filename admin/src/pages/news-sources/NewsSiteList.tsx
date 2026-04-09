import type { FC } from 'react';
import type { NewsSite, NewsSourceCategory } from '../../../../shared/types/index.js';
import {
  ToggleLeft, ToggleRight, Link, Pencil,
  TestTube2, ExternalLink, Trash2, Loader2, Globe, Zap,
} from 'lucide-react';
import { TYPE_LABELS, CATEGORY_LABELS, LANGUAGE_FLAGS, TIER_LABELS } from './newsSourcesConstants';

interface NewsSiteListProps {
  filteredSites: NewsSite[];
  sites: NewsSite[];
  categoryFilter: NewsSourceCategory | 'all';
  onToggle: (index: number) => void;
  onRemove: (index: number) => void;
  onTestParse: (site: NewsSite) => void;
  onEdit: (site: NewsSite, index: number) => void;
  isTesting: boolean;
  testingSite: string | null;
}

export const NewsSiteList: FC<NewsSiteListProps> = ({
  filteredSites, sites, categoryFilter,
  onToggle, onRemove, onTestParse, onEdit,
  isTesting, testingSite,
}) => (
  <div className="card mb-6">
    <div className="flex items-center justify-between mb-4">
      <h3 className="font-semibold text-lg text-gray-200">
        {categoryFilter === 'all' ? 'Все источники' : CATEGORY_LABELS[categoryFilter].label}
      </h3>
      <span className="text-sm text-gray-500">
        {filteredSites.filter(s => s.enabled).length} из {filteredSites.length} активны
      </span>
    </div>

    {filteredSites.length === 0 ? (
      <div className="text-center py-8 text-gray-500">
        <Globe className="w-12 h-12 mx-auto mb-3 opacity-50" />
        <p>Нет настроенных сайтов</p>
        <p className="text-sm mt-1">Добавьте новостной сайт или загрузите пресеты</p>
      </div>
    ) : (
      <div className="space-y-2">
        {filteredSites.map((site, idx) => {
          const realIndex = sites.indexOf(site);
          const typeInfo = TYPE_LABELS[site.type ?? 'rss'];
          const catInfo = CATEGORY_LABELS[site.category ?? 'city_local'];
          const TypeIcon = typeInfo.icon;

          return (
            <div
              key={idx}
              className="flex items-center gap-3 p-3 rounded-xl transition-all"
              style={{
                background: site.enabled
                  ? 'linear-gradient(135deg, rgba(255, 215, 0, 0.04), rgba(139, 92, 246, 0.04))'
                  : 'rgba(255, 255, 255, 0.02)',
                border: `1px solid ${site.enabled ? 'rgba(255, 215, 0, 0.12)' : 'rgba(255, 255, 255, 0.05)'}`,
                opacity: site.enabled ? 1 : 0.5,
              }}
            >
              <button
                onClick={() => onToggle(realIndex)}
                className="flex-shrink-0 transition-colors"
              >
                {site.enabled ? (
                  <ToggleRight className="w-6 h-6 text-amber-400" />
                ) : (
                  <ToggleLeft className="w-6 h-6 text-gray-500" />
                )}
              </button>

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium text-gray-200 truncate">{site.name}</p>
                  {site.language && (
                    <span className="text-xs">{LANGUAGE_FLAGS[site.language]}</span>
                  )}
                  {site.tier && (
                    <span className="inline-flex items-center px-1.5 py-0.5 text-[10px] text-gray-400 border border-gray-700 rounded">
                      {TIER_LABELS[site.tier]}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded border ${catInfo.color}`}>
                    {catInfo.label}
                  </span>
                  <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-gray-500 border border-gray-700 rounded">
                    <TypeIcon className="w-2.5 h-2.5" />
                    {typeInfo.label}
                  </span>
                  <span className="flex items-center gap-1 text-[10px] text-gray-600 truncate">
                    <Link className="w-2.5 h-2.5" />
                    {site.url.length > 60 ? site.url.substring(0, 60) + '...' : site.url}
                  </span>
                  {site.filterKeywords && site.filterKeywords.length > 0 && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-cyan-300 border border-cyan-400/20 rounded">
                      keywords {site.filterKeywords.length}
                    </span>
                  )}
                  {site.autoMode && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-amber-300 border border-amber-400/20 rounded">
                      <Zap className="w-2.5 h-2.5" />
                      auto
                    </span>
                  )}
                  {(site.jsonMapping || site.htmlMapping) && (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] text-violet-300 border border-violet-400/20 rounded">
                      config
                    </span>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={() => onEdit(site, realIndex)}
                  className="p-1.5 text-gray-400 hover:text-cyan-300 transition-colors"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                <button
                  onClick={() => onTestParse(site)}
                  disabled={isTesting && testingSite === site.url}
                  className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg
                             text-amber-400 hover:bg-amber-400/10 transition-all"
                  style={{ border: '1px solid rgba(255, 215, 0, 0.2)' }}
                >
                  {isTesting && testingSite === site.url ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <TestTube2 className="w-3.5 h-3.5" />
                  )}
                  Тест
                </button>
                <a href={site.url} target="_blank" rel="noopener noreferrer"
                   className="p-1.5 text-gray-400 hover:text-amber-400 transition-colors">
                  <ExternalLink className="w-4 h-4" />
                </a>
                <button onClick={() => onRemove(realIndex)}
                        className="p-1.5 text-gray-400 hover:text-red-400 transition-colors">
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    )}
  </div>
);
