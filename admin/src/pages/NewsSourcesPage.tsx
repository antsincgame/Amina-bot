import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { newsSourcesApi, newsParsingApi } from '../api/appwrite';
import type {
  NewsSite,
  NewsSourceType,
  NewsSourceCategory,
  NewsSourceLanguage,
  NewsSourceTier,
  JsonFieldMapping,
  HtmlFieldMapping,
  ParsedHeadline,
} from '../../../shared/types/index.js';
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
  Pencil,
  StopCircle,
  PlayCircle,
  Wand2,
  Zap,
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

const UNCATEGORIZED_BADGE = {
  label: 'Без категории',
  color: 'text-gray-300 bg-gray-500/10 border-gray-500/20',
};

const LANGUAGE_FLAGS: Record<NewsSourceLanguage, string> = {
  ru: '🇷🇺',
  en: '🇬🇧',
  zh: '🇨🇳',
  ja: '🇯🇵',
  ko: '🇰🇷',
};

const TIER_LABELS: Record<NewsSourceTier, string> = {
  tier1: 'Tier 1',
  tier2: 'Tier 2',
  tier3: 'Tier 3',
};

const DEFAULT_VIBECODING_KEYWORDS = [
  'vibecoding', 'vibe coding', 'вайбкодинг',
  'ai coding', 'ai-assisted coding',
  'cursor', 'copilot', 'claude code',
  'windsurf', 'codeium', 'bolt.new', 'v0.dev',
  'replit agent', 'devin', 'aider',
  'code generation', 'ai ide',
  'deepseek coder', 'qwen coder',
];

const formatJsonBlock = (value?: JsonFieldMapping | HtmlFieldMapping): string =>
  value ? JSON.stringify(value, null, 2) : '';

const parseJsonBlock = <T extends object>(raw: string, label: string): T | undefined => {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(`Поле "${label}" должно содержать валидный JSON`);
  }
};

const NewsSourcesPage = () => {
  const queryClient = useQueryClient();

  const [sites, setSites] = useState<NewsSite[]>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [parsingKilled, setParsingKilled] = useState(false);
  const [killLoading, setKillLoading] = useState(false);

  useEffect(() => {
    newsParsingApi.getStatus().then(setParsingKilled).catch(() => {});
  }, []);

  const toggleParsing = async () => {
    setKillLoading(true);
    try {
      if (parsingKilled) {
        await newsParsingApi.resume();
        setParsingKilled(false);
      } else {
        await newsParsingApi.kill();
        setParsingKilled(true);
      }
    } catch { /* ignore */ }
    setKillLoading(false);
  };
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newType, setNewType] = useState<NewsSourceType>('rss');
  const [newCategory, setNewCategory] = useState<NewsSourceCategory>('city_local');
  const [newLanguage, setNewLanguage] = useState<NewsSourceLanguage>('ru');
  const [newTier, setNewTier] = useState<NewsSourceTier>('tier1');
  const [newFilterKeywords, setNewFilterKeywords] = useState('');
  const [newJsonMapping, setNewJsonMapping] = useState('');
  const [newHtmlMapping, setNewHtmlMapping] = useState('');
  const [newAutoMode, setNewAutoMode] = useState(false);
  const [addError, setAddError] = useState('');
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<NewsSourceCategory | 'all'>('all');

  const [testResult, setTestResult] = useState<{
    url: string;
    headlines: ParsedHeadline[];
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

  const { data: presetMeta } = useQuery({
    queryKey: ['news-site-presets'],
    queryFn: () => newsSourcesApi.getPresets(),
  });

  const { mutate: saveSites, isPending: isSaving } = useMutation({
    mutationFn: () => newsSourcesApi.save(sites),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['news-sites'] });
      setHasChanges(false);
    },
  });

  const { mutate: testParse, isPending: isTesting } = useMutation({
    mutationFn: (site: Partial<NewsSite> & { url: string }) => newsSourcesApi.testParse(site),
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
    mutationFn: (group: 'all' | 'global' | 'asia') => newsSourcesApi.addPresets(group),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['news-site-presets'] });
      queryClient.invalidateQueries({ queryKey: ['news-sites'] });
      setHasChanges(false);
    },
  });

  const { mutate: bulkEnable, isPending: isBulkEnabling } = useMutation({
    mutationFn: (params: { tier?: string; category?: string; enabled: boolean }) => newsSourcesApi.bulkEnable(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['news-sites'] });
    },
  });

  const resetForm = () => {
    setEditingIndex(null);
    setNewName('');
    setNewUrl('');
    setNewType('rss');
    setNewCategory('city_local');
    setNewLanguage('ru');
    setNewTier('tier1');
    setNewFilterKeywords('');
    setNewJsonMapping('');
    setNewHtmlMapping('');
    setNewAutoMode(false);
    setAddError('');
  };

  const loadSiteIntoForm = (site: NewsSite, index: number) => {
    setEditingIndex(index);
    setNewName(site.name);
    setNewUrl(site.url);
    setNewType(site.type ?? 'rss');
    setNewCategory(site.category ?? 'city_local');
    setNewLanguage(site.language ?? 'ru');
    setNewTier(site.tier ?? 'tier1');
    setNewFilterKeywords(site.filterKeywords?.join(', ') ?? '');
    setNewJsonMapping(formatJsonBlock(site.jsonMapping));
    setNewHtmlMapping(formatJsonBlock(site.htmlMapping));
    setNewAutoMode(site.autoMode ?? false);
    setAddError('');
  };

  const handleAdd = () => {
    setAddError('');
    const name = newName.trim();
    const url = newUrl.trim();

    if (!name) { setAddError('Укажите название'); return; }
    if (!url) { setAddError('Укажите URL'); return; }

    try { new URL(url); } catch { setAddError('Неверный формат URL'); return; }

    if (sites.some((site, index) => site.url === url && index !== editingIndex)) {
      setAddError('Этот сайт уже добавлен');
      return;
    }

    try {
      const filterKeywords = newFilterKeywords
        .split(',')
        .map(keyword => keyword.trim())
        .filter(Boolean);

      const jsonMapping = newType === 'json_api'
        ? parseJsonBlock<JsonFieldMapping>(newJsonMapping, 'JSON mapping')
        : undefined;
      const htmlMapping = newType === 'html_scrape'
        ? parseJsonBlock<HtmlFieldMapping>(newHtmlMapping, 'HTML mapping')
        : undefined;

      const nextSite: NewsSite = {
        name,
        url,
        enabled: editingIndex !== null ? sites[editingIndex]?.enabled !== false : true,
        type: newType,
        category: newCategory,
        language: newLanguage,
        tier: newTier,
        ...(jsonMapping ? { jsonMapping } : {}),
        ...(htmlMapping ? { htmlMapping } : {}),
        ...(filterKeywords.length > 0 ? { filterKeywords } : {}),
        ...(newAutoMode ? { autoMode: true } : {}),
      };

      if (editingIndex !== null) {
        const updatedSites = sites.map((site, index) => index === editingIndex ? nextSite : site);
        setSites(updatedSites);
      } else {
        setSites([...sites, nextSite]);
      }

      setHasChanges(true);
      resetForm();
    } catch (error) {
      setAddError(error instanceof Error ? error.message : 'Не удалось разобрать расширенную конфигурацию');
    }
  };

  const handleRemove = (index: number) => {
    setSites(sites.filter((_, i) => i !== index));
    setHasChanges(true);
  };

  const handleToggle = (index: number) => {
    setSites(sites.map((s, i) => i === index ? { ...s, enabled: !s.enabled } : s));
    setHasChanges(true);
  };

  const handleTestParse = (site: NewsSite) => {
    setTestingSite(site.url);
    setTestResult(null);
    testParse({
      name: site.name,
      url: site.url,
      enabled: site.enabled,
      type: site.type,
      category: site.category,
      language: site.language,
      tier: site.tier,
      jsonMapping: site.jsonMapping,
      htmlMapping: site.htmlMapping,
      filterKeywords: site.filterKeywords,
      autoMode: site.autoMode,
    });
  };

  const matchesCategory = (s: NewsSite, cat: NewsSourceCategory): boolean =>
    cat === 'city_local'
      ? !s.category || s.category === 'city_local'
      : s.category === cat;

  const filteredSites = categoryFilter === 'all'
    ? sites
    : sites.filter(s => matchesCategory(s, categoryFilter));

  const categoryCounts = {
    all: sites.length,
    ai_tech: sites.filter(s => matchesCategory(s, 'ai_tech')).length,
    city_local: sites.filter(s => matchesCategory(s, 'city_local')).length,
    community: sites.filter(s => matchesCategory(s, 'community')).length,
    asia_tech: sites.filter(s => matchesCategory(s, 'asia_tech')).length,
  };

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-5xl mx-auto">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-white/10 rounded w-1/3" />
          <div className="card space-y-4">
            <div className="h-10 bg-white/10 rounded" />
            <div className="h-10 bg-white/10 rounded" />
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

      {/* Kill Switch */}
      <div className="card mb-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          {parsingKilled ? (
            <StopCircle className="w-6 h-6 text-red-400" />
          ) : (
            <PlayCircle className="w-6 h-6 text-green-400" />
          )}
          <div>
            <h3 className="text-white font-medium">
              {parsingKilled ? 'Парсинг остановлен' : 'Парсинг активен'}
            </h3>
            <p className="text-xs text-gray-500">
              {parsingKilled ? 'Новости не обновляются, LLM-токены не тратятся' : 'Источники парсятся по расписанию'}
            </p>
          </div>
        </div>
        <button
          onClick={toggleParsing}
          disabled={killLoading}
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-all ${
            parsingKilled
              ? 'text-green-400 hover:bg-green-400/10'
              : 'text-red-400 hover:bg-red-400/10'
          }`}
          style={{ border: `1px solid ${parsingKilled ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'}` }}
        >
          {killLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : parsingKilled ? (
            <><PlayCircle className="w-4 h-4" /> Возобновить</>
          ) : (
            <><StopCircle className="w-4 h-4" /> Остановить</>
          )}
        </button>
      </div>

      {/* Quick Actions */}
      <div className="flex flex-wrap items-center gap-3 mb-6">
        <button
          onClick={() => addPresets('all')}
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
          Добавить весь каталог ({presetMeta?.counts.all ?? 0})
        </button>

        <button
          onClick={() => bulkEnable({ tier: 'tier1', category: 'asia_tech', enabled: true })}
          disabled={isBulkEnabling}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                     text-green-300 hover:bg-green-400/10 transition-all"
          style={{ border: '1px solid rgba(74, 222, 128, 0.28)' }}
        >
          {isBulkEnabling ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Zap className="w-4 h-4" />
          )}
          Включить Asia Tier 1
        </button>

        <button
          onClick={() => addPresets('asia')}
          disabled={isAddingPresets}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                     text-red-300 hover:bg-red-400/10 transition-all"
          style={{ border: '1px solid rgba(248, 113, 113, 0.28)' }}
        >
          <Globe2 className="w-4 h-4" />
          Добавить Asia AI ({presetMeta?.counts.asia ?? 0})
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

                  {/* Actions */}
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => loadSiteIntoForm(site, realIndex)}
                      className="p-1.5 text-gray-400 hover:text-cyan-300 transition-colors"
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleTestParse(site)}
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
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-lg text-gray-200">
            {editingIndex !== null ? 'Редактировать источник' : 'Добавить источник'}
          </h3>
          {editingIndex !== null && (
            <button
              onClick={resetForm}
              className="text-sm text-gray-500 hover:text-white transition-colors"
            >
              Сбросить форму
            </button>
          )}
        </div>

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

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
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
          <div>
            <label className="label text-sm text-gray-400">Tier</label>
            <select
              className="input bg-white/5 text-gray-200"
              value={newTier}
              onChange={(e) => setNewTier(e.target.value as NewsSourceTier)}
            >
              <option value="tier1">Tier 1 — стабильный RSS/API</option>
              <option value="tier2">Tier 2 — HTML / site recipe</option>
              <option value="tier3">Tier 3 — paywall / anti-bot / degraded</option>
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 mb-4">
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="label text-sm text-gray-400 mb-0">Ключевые слова фильтрации</label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    const existing = newFilterKeywords.split(',').map(k => k.trim()).filter(Boolean);
                    const merged = [...new Set([...existing, ...DEFAULT_VIBECODING_KEYWORDS])];
                    setNewFilterKeywords(merged.join(', '));
                  }}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg
                             text-cyan-400 hover:bg-cyan-400/10 transition-all"
                  style={{ border: '1px solid rgba(34, 211, 238, 0.25)' }}
                >
                  <Sparkles className="w-3 h-3" />
                  Дефолтные
                </button>
                <button
                  type="button"
                  disabled={suggestLoading || !newUrl.trim()}
                  onClick={async () => {
                    setSuggestLoading(true);
                    setAddError('');
                    try {
                      const keywords = await newsSourcesApi.suggestKeywords({
                        url: newUrl.trim(),
                        name: newName.trim(),
                        category: newCategory,
                        language: newLanguage,
                      });
                      const existing = newFilterKeywords.split(',').map(k => k.trim()).filter(Boolean);
                      const merged = [...new Set([...existing, ...keywords])];
                      setNewFilterKeywords(merged.join(', '));
                    } catch (err) {
                      setAddError(`Автоподбор: ${err instanceof Error ? err.message : 'ошибка'}`);
                    }
                    setSuggestLoading(false);
                  }}
                  className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded-lg
                             text-purple-400 hover:bg-purple-400/10 transition-all disabled:opacity-40"
                  style={{ border: '1px solid rgba(168, 85, 247, 0.25)' }}
                >
                  {suggestLoading ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Wand2 className="w-3 h-3" />
                  )}
                  AI подбор
                </button>
              </div>
            </div>
            <input
              type="text"
              className="input bg-white/5 text-gray-200"
              placeholder="AI, 生成AI, 바이브 코딩, DeepSeek"
              value={newFilterKeywords}
              onChange={(e) => { setNewFilterKeywords(e.target.value); setAddError(''); }}
            />
            <p className="text-xs text-gray-500 mt-1">Через запятую. Используются для отсеивания нерелевантных заголовков.</p>
          </div>
        </div>

        {/* Auto-mode toggle */}
        <div className="flex items-center gap-3 mb-4 p-3 rounded-xl"
          style={{ background: 'rgba(255, 215, 0, 0.03)', border: '1px solid rgba(255, 215, 0, 0.1)' }}
        >
          <button
            type="button"
            onClick={() => setNewAutoMode(!newAutoMode)}
            className="flex-shrink-0"
          >
            {newAutoMode ? (
              <ToggleRight className="w-6 h-6 text-amber-400" />
            ) : (
              <ToggleLeft className="w-6 h-6 text-gray-500" />
            )}
          </button>
          <div>
            <div className="flex items-center gap-2">
              <Zap className="w-4 h-4 text-amber-400" />
              <span className="text-sm font-medium text-gray-200">Авто-режим парсинга</span>
            </div>
            <p className="text-xs text-gray-500 mt-0.5">
              Бот пробует ВСЕ каналы (RSS → HTML scrape) и объединяет результаты. Больше новостей, но медленнее.
            </p>
          </div>
        </div>

        {newType === 'json_api' && (
          <div className="mb-4">
            <label className="label text-sm text-gray-400">JSON mapping</label>
            <textarea
              className="input min-h-[130px] bg-white/5 text-gray-200 font-mono text-xs"
              placeholder={'{\n  "itemsPath": "",\n  "titleField": "title",\n  "urlField": "url",\n  "dateField": "published_at",\n  "descriptionField": "description|summary"\n}'}
              value={newJsonMapping}
              onChange={(e) => { setNewJsonMapping(e.target.value); setAddError(''); }}
            />
            <p className="mt-2 text-xs text-gray-500">
              Можно указать `descriptionField` с fallback через `|`, например `description|summary|content_text`.
            </p>
          </div>
        )}

        {newType === 'html_scrape' && (
          <div className="mb-4">
            <label className="label text-sm text-gray-400">HTML mapping</label>
            <textarea
              className="input min-h-[150px] bg-white/5 text-gray-200 font-mono text-xs"
              placeholder={'{\n  "itemSelectors": ["article", ".news-item"],\n  "titleSelectors": ["h2", "h3", ".entry-title"],\n  "descriptionSelectors": [".summary", "p"],\n  "linkSelectors": ["a[href]"],\n  "removeSelectors": ["nav", "footer"]\n}'}
              value={newHtmlMapping}
              onChange={(e) => { setNewHtmlMapping(e.target.value); setAddError(''); }}
            />
            <p className="mt-2 text-xs text-gray-500">
              Для HTML-источников добавляйте `descriptionSelectors`, чтобы preview сразу показывал описание новости.
            </p>
          </div>
        )}

        {addError && (
          <div className="flex items-center gap-2 text-sm text-red-400 mb-3">
            <AlertCircle className="w-4 h-4" />
            {addError}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={handleAdd}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                       text-amber-400 hover:bg-amber-400/10 transition-all"
            style={{ border: '1px solid rgba(255, 215, 0, 0.3)' }}
          >
            {editingIndex !== null ? <Pencil className="w-4 h-4" /> : <Plus className="w-4 h-4" />}
            {editingIndex !== null ? 'Сохранить в список' : 'Добавить'}
          </button>

          {editingIndex !== null && (
            <button
              onClick={resetForm}
              className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
            >
              Отмена
            </button>
          )}
        </div>
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
              <div className="mb-4">
                <p className="text-sm text-gray-400">
                  Найдено заголовков: <span className="text-amber-400 font-bold">{testResult.count}</span>
                  {testResult.parseTimeMs != null && (
                    <span className="ml-2">({testResult.parseTimeMs}ms)</span>
                  )}
                </p>
                <p className="mt-1 text-xs text-gray-500">
                  Preview уже показывает parser-only descriptions в русском виде, как они попадут в structured digest.
                </p>
              </div>
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
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-gray-400">Источник: {h.source}</span>
                      <span className={`px-2 py-0.5 rounded-full border ${
                        h.category && h.category in CATEGORY_LABELS
                          ? CATEGORY_LABELS[h.category as NewsSourceCategory].color
                          : UNCATEGORIZED_BADGE.color
                      }`}>
                        {h.category && h.category in CATEGORY_LABELS
                          ? CATEGORY_LABELS[h.category as NewsSourceCategory].label
                          : UNCATEGORIZED_BADGE.label}
                      </span>
                      {h.alternateSources.length > 0 && (
                        <span className="text-gray-500">Дублей схлопнуто: {h.alternateSources.length}</span>
                      )}
                    </div>
                    <p className="mt-2 text-xs text-gray-400 leading-relaxed">{h.description}</p>
                    <div className="mt-1 text-[11px] text-gray-500 break-all">
                      canonical: {h.canonicalUrl}
                    </div>
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

export default NewsSourcesPage;
