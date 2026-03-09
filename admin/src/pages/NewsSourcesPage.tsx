import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { newsSourcesApi } from '../api/supabase';
import type { NewsSite, NewsSourceType, NewsSourceCategory, NewsSourceLanguage } from '../../../shared/types/index.js';
import {
  Newspaper,
  Plus,
  Trash2,
  TestTube2,
  ExternalLink,
  Save,
  Loader2,
  ToggleLeft,
  ToggleRight,
  X,
  Globe,
  Link,
  AlertCircle,
  Sparkles,
  Filter,
  Languages,
  Cpu,
  Rss,
  Code,
  Globe2,
} from 'lucide-react';

// ===== Метки =====

const TYPE_LABELS: Record<NewsSourceType, { label: string; icon: typeof Rss }> = {
  rss: { label: 'RSS', icon: Rss },
  json_api: { label: 'JSON API', icon: Code },
  html_scrape: { label: 'HTML', icon: Globe2 },
};

const CATEGORY_LABELS: Record<NewsSourceCategory, { label: string; color: string }> = {
  ai_tech: { label: 'AI/Tech', color: 'text-purple-400 bg-purple-400/10 border-purple-400/20' },
  city_local: { label: 'Город', color: 'text-blue-400 bg-blue-400/10 border-blue-400/20' },
  community: { label: 'Сообщество', color: 'text-green-400 bg-green-400/10 border-green-400/20' },
  asia_tech: { label: 'Азия', color: 'text-red-400 bg-red-400/10 border-red-400/20' },
};

const LANGUAGE_FLAGS: Record<NewsSourceLanguage, string> = {
  ru: '🇷🇺',
  en: '🇬🇧',
  zh: '🇨🇳',
  ja: '🇯🇵',
  ko: '🇰🇷',
};

const NewsSourcesPage = () => {
  const queryClient = useQueryClient();

  const [sites, setSites] = useState<NewsSite[]>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newType, setNewType] = useState<NewsSourceType>('rss');
  const [newCategory, setNewCategory] = useState<NewsSourceCategory>('city_local');
  const [newLanguage, setNewLanguage] = useState<NewsSourceLanguage>('ru');
  const [addError, setAddError] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<NewsSourceCategory | 'all'>('all');

  const [testResult, setTestResult] = useState<{
    url: string;
    headlines: Array<{ title: string; url: string; source: string }>;
    count: number;
    parseTimeMs?: number;
    error?: string;
  } | null>(null);
  const [testingSite, setTestingSite] = useState<string | null>(null);

  const { isLoading } = useQuery({
    queryKey: ['news-sites'],
    queryFn: async () => {
      const data = await newsSourcesApi.getAll();
      setSites(data);
      setHasChanges(false);
      return data;
    },
  });

  const { mutate: saveSites, isPending: isSaving } = useMutation({
    mutationFn: () => newsSourcesApi.save(sites),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['news-sites'] });
      setHasChanges(false);
    },
  });

  const { mutate: testParse, isPending: isTesting } = useMutation({
    mutationFn: (url: string) => newsSourcesApi.testParse(url),
    onSuccess: (result) => {
      setTestResult(result.data);
      if (!result.success && result.error) {
        setTestResult({ ...result.data, error: result.error });
      }
      setTestingSite(null);
    },
    onError: (err) => {
      setTestResult({ url: testingSite ?? '', headlines: [], count: 0, error: String(err) });
      setTestingSite(null);
    },
  });

  const { mutate: addPresets, isPending: isAddingPresets } = useMutation({
    mutationFn: () => newsSourcesApi.addPresets(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['news-sites'] });
      setHasChanges(false);
    },
  });

  const handleAdd = () => {
    setAddError('');
    const name = newName.trim();
    const url = newUrl.trim();

    if (!name) { setAddError('Укажите название'); return; }
    if (!url) { setAddError('Укажите URL'); return; }

    try { new URL(url); } catch { setAddError('Неверный формат URL'); return; }

    if (sites.some(s => s.url === url)) {
      setAddError('Этот сайт уже добавлен');
      return;
    }

    const newSite: NewsSite = {
      name, url, enabled: true,
      type: newType,
      category: newCategory,
      language: newLanguage,
    };

    setSites([...sites, newSite]);
    setNewName('');
    setNewUrl('');
    setHasChanges(true);
  };

  const handleRemove = (index: number) => {
    setSites(sites.filter((_, i) => i !== index));
    setHasChanges(true);
  };

  const handleToggle = (index: number) => {
    setSites(sites.map((s, i) => i === index ? { ...s, enabled: !s.enabled } : s));
    setHasChanges(true);
  };

  const handleTestParse = (url: string) => {
    setTestingSite(url);
    setTestResult(null);
    testParse(url);
  };

  const filteredSites = categoryFilter === 'all'
    ? sites
    : sites.filter(s => s.category === categoryFilter);

  const categoryCounts = {
    all: sites.length,
    ai_tech: sites.filter(s => s.category === 'ai_tech').length,
    city_local: sites.filter(s => !s.category || s.category === 'city_local').length,
    community: sites.filter(s => s.category === 'community').length,
    asia_tech: sites.filter(s => s.category === 'asia_tech').length,
  };

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-5xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 rounded w-1/3" />
          <div className="card space-y-4">
            <div className="h-10 bg-gray-200 rounded" />
            <div className="h-10 bg-gray-200 rounded" />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto">
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Newspaper className="w-7 h-7 text-amber-400" />
          <h1 className="text-2xl font-bold text-gradient-gold">Новостные источники</h1>
        </div>
        <p className="text-gray-400 mt-1">
          RSS-ленты, JSON API и HTML-источники для парсинга заголовков. Поддерживаются категории: городские, AI/Tech, азиатские AI-медиа, dev-сообщества.
        </p>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <button
          onClick={() => addPresets()}
          disabled={isAddingPresets}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                     text-purple-400 hover:bg-purple-400/10 transition-all"
          style={{ border: '1px solid rgba(168, 85, 247, 0.3)' }}
        >
          {isAddingPresets ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Sparkles className="w-4 h-4" />
          )}
          Добавить AI/Tech пресеты ({DEFAULT_PRESET_COUNT} источников)
        </button>

        <div className="flex items-center gap-1 ml-auto">
          <Filter className="w-4 h-4 text-gray-500" />
          {(['all', 'ai_tech', 'city_local', 'community', 'asia_tech'] as const).map(cat => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-2.5 py-1 text-xs rounded-lg transition-all ${
                categoryFilter === cat
                  ? 'text-amber-400 bg-amber-400/10 border border-amber-400/30'
                  : 'text-gray-500 hover:text-gray-300 border border-transparent'
              }`}
            >
              {cat === 'all' ? 'Все' : CATEGORY_LABELS[cat].label} ({categoryCounts[cat]})
            </button>
          ))}
        </div>
      </div>

      {/* Sites List */}
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
                  {/* Toggle */}
                  <button
                    onClick={() => handleToggle(realIndex)}
                    className="flex-shrink-0 transition-colors"
                  >
                    {site.enabled ? (
                      <ToggleRight className="w-6 h-6 text-amber-400" />
                    ) : (
                      <ToggleLeft className="w-6 h-6 text-gray-500" />
                    )}
                  </button>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-gray-200 truncate">{site.name}</p>
                      {site.language && (
                        <span className="text-xs">{LANGUAGE_FLAGS[site.language]}</span>
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
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => handleTestParse(site.url)}
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

                    <button onClick={() => handleRemove(realIndex)}
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

      {/* Add New Site */}
      <div className="card mb-6">
        <h3 className="font-semibold text-lg text-gray-200 mb-4">Добавить источник</h3>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div>
            <label className="label text-sm text-gray-400">Название</label>
            <input
              type="text"
              className="input bg-white/5 text-gray-200"
              placeholder="Hugging Face Blog"
              value={newName}
              onChange={(e) => { setNewName(e.target.value); setAddError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
          </div>
          <div>
            <label className="label text-sm text-gray-400">URL источника</label>
            <input
              type="url"
              className="input bg-white/5 text-gray-200"
              placeholder="https://huggingface.co/blog/feed.xml"
              value={newUrl}
              onChange={(e) => { setNewUrl(e.target.value); setAddError(''); }}
              onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
            />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mb-4">
          <div>
            <label className="label text-sm text-gray-400 flex items-center gap-1">
              <Cpu className="w-3 h-3" /> Тип
            </label>
            <select
              className="input bg-white/5 text-gray-200"
              value={newType}
              onChange={(e) => setNewType(e.target.value as NewsSourceType)}
            >
              <option value="rss">RSS / Atom</option>
              <option value="json_api">JSON API</option>
              <option value="html_scrape">HTML Scraping</option>
            </select>
          </div>
          <div>
            <label className="label text-sm text-gray-400 flex items-center gap-1">
              <Filter className="w-3 h-3" /> Категория
            </label>
            <select
              className="input bg-white/5 text-gray-200"
              value={newCategory}
              onChange={(e) => setNewCategory(e.target.value as NewsSourceCategory)}
            >
              <option value="city_local">Город / Локальные</option>
              <option value="ai_tech">AI / Технологии</option>
              <option value="community">Сообщество</option>
              <option value="asia_tech">Азия / Tech</option>
            </select>
          </div>
          <div>
            <label className="label text-sm text-gray-400 flex items-center gap-1">
              <Languages className="w-3 h-3" /> Язык
            </label>
            <select
              className="input bg-white/5 text-gray-200"
              value={newLanguage}
              onChange={(e) => setNewLanguage(e.target.value as NewsSourceLanguage)}
            >
              <option value="ru">Русский</option>
              <option value="en">English</option>
              <option value="zh">中文 (Chinese)</option>
              <option value="ja">日本語 (Japanese)</option>
              <option value="ko">한국어 (Korean)</option>
            </select>
          </div>
        </div>

        {addError && (
          <div className="flex items-center gap-2 text-sm text-red-400 mb-3">
            <AlertCircle className="w-4 h-4" />
            {addError}
          </div>
        )}

        <button
          onClick={handleAdd}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                     text-amber-400 hover:bg-amber-400/10 transition-all"
          style={{ border: '1px solid rgba(255, 215, 0, 0.3)' }}
        >
          <Plus className="w-4 h-4" />
          Добавить
        </button>
      </div>

      {/* Save Button */}
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {hasChanges ? 'Есть несохранённые изменения' : 'Сохранено'}
        </p>
        <button
          onClick={() => saveSites()}
          disabled={isSaving || !hasChanges}
          className="btn-primary"
        >
          {isSaving ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Сохранение...
            </>
          ) : (
            <>
              <Save className="w-4 h-4 mr-2" />
              Сохранить
            </>
          )}
        </button>
      </div>

      {/* Test Parse Results Modal */}
      {testResult && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0, 0, 0, 0.7)', backdropFilter: 'blur(4px)' }}
        >
          <div
            className="w-full max-w-2xl max-h-[80vh] overflow-auto rounded-2xl p-6"
            style={{
              background: 'linear-gradient(135deg, rgba(15, 15, 25, 0.98), rgba(25, 20, 40, 0.98))',
              border: '1px solid rgba(255, 215, 0, 0.2)',
              boxShadow: '0 0 40px rgba(255, 215, 0, 0.1)',
            }}
          >
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <TestTube2 className="w-5 h-5 text-amber-400" />
                <h3 className="font-semibold text-lg text-gray-200">Результат парсинга</h3>
              </div>
              <button
                onClick={() => setTestResult(null)}
                className="p-1 text-gray-400 hover:text-white transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-xs text-gray-500 mb-1 truncate">URL: {testResult.url}</p>

            {testResult.error ? (
              <div className="p-3 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-sm mb-4">
                {testResult.error}
              </div>
            ) : (
              <p className="text-sm text-gray-400 mb-4">
                Найдено заголовков: <span className="text-amber-400 font-bold">{testResult.count}</span>
                {testResult.parseTimeMs != null && (
                  <span className="ml-2">({testResult.parseTimeMs}ms)</span>
                )}
              </p>
            )}

            {testResult.headlines.length > 0 ? (
              <div className="space-y-2">
                {testResult.headlines.map((h, i) => (
                  <div key={i} className="p-3 rounded-lg"
                    style={{ background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(255, 255, 255, 0.06)' }}>
                    <a href={h.url} target="_blank" rel="noopener noreferrer"
                       className="text-sm text-gray-200 hover:text-amber-400 transition-colors flex items-start gap-2">
                      <span className="text-amber-400/60 font-mono text-xs mt-0.5">{i + 1}.</span>
                      <span className="flex-1">{h.title}</span>
                      <ExternalLink className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-gray-500" />
                    </a>
                  </div>
                ))}
              </div>
            ) : !testResult.error ? (
              <div className="text-center py-6 text-gray-500 text-sm">
                Заголовки не найдены. Возможно, структура сайта не поддерживается парсером.
              </div>
            ) : null}

            <div className="mt-4 flex justify-end">
              <button
                onClick={() => setTestResult(null)}
                className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const DEFAULT_PRESET_COUNT = 18;

export default NewsSourcesPage;
