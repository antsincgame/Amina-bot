import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { newsSourcesApi, newsParsingApi, settingsApi } from '../../api/appwrite';
import type {
  NewsSite, NewsSourceType, NewsSourceCategory, NewsSourceLanguage,
  NewsSourceTier, JsonFieldMapping, HtmlFieldMapping, ParsedHeadline,
} from '../../../../shared/types/index.js';
import { formatJsonBlock, parseJsonBlock } from './newsSourcesUtils';
import { DEFAULT_VIBECODING_KEYWORDS } from './newsSourcesConstants';

export interface HealthResult {
  healthy: number;
  unhealthy: number;
  totalChecked: number;
  dead: Array<{ url: string; name: string; reason: string }>;
}

export interface TestResultData {
  url: string;
  headlines: ParsedHeadline[];
  count: number;
  parseTimeMs?: number;
  error?: string;
}

export const useNewsSourcesPage = () => {
  const queryClient = useQueryClient();

  const [sites, setSites] = useState<NewsSite[]>([]);
  const [hasChanges, setHasChanges] = useState(false);
  const [parsingKilled, setParsingKilled] = useState(false);
  const [killLoading, setKillLoading] = useState(false);
  const [translationProvider, setTranslationProvider] = useState('auto');
  const [providerSaving, setProviderSaving] = useState(false);
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
  const [healthLoading, setHealthLoading] = useState(false);
  const [healthResult, setHealthResult] = useState<HealthResult | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [testResult, setTestResult] = useState<TestResultData | null>(null);
  const [testingSite, setTestingSite] = useState<string | null>(null);

  useEffect(() => {
    newsParsingApi.getStatus().then(setParsingKilled).catch(() => {});
    settingsApi.getAll().then(settings => {
      const found = settings.find(s => s.key === 'news_translation_provider');
      if (found?.value) setTranslationProvider(found.value);
    }).catch(() => {});
  }, []);

  const handleProviderChange = async (provider: string) => {
    setTranslationProvider(provider);
    setProviderSaving(true);
    try { await settingsApi.update('news_translation_provider', provider); }
    catch { /* ignore */ }
    setProviderSaving(false);
  };

  const toggleParsing = async () => {
    setKillLoading(true);
    try {
      if (parsingKilled) { await newsParsingApi.resume(); setParsingKilled(false); }
      else { await newsParsingApi.kill(); setParsingKilled(true); }
    } catch { /* ignore */ }
    setKillLoading(false);
  };

  const { isLoading } = useQuery({
    queryKey: ['news-sites'],
    queryFn: async () => {
      const data = await newsSourcesApi.getAll();
      setSites(data); setHasChanges(false);
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
    mutationFn: (site: Partial<NewsSite> & { url: string }) =>
      newsSourcesApi.testParse(site),
    onSuccess: (result) => {
      setTestResult(result.data);
      if (!result.success && result.error) {
        setTestResult({ ...result.data, error: result.error });
      }
      setTestingSite(null);
    },
    onError: (err) => {
      setTestResult({
        url: testingSite ?? '', headlines: [], count: 0, error: String(err),
      });
      setTestingSite(null);
    },
  });

  const { mutate: addPresets, isPending: isAddingPresets } = useMutation({
    mutationFn: (group: 'all' | 'global' | 'asia') =>
      newsSourcesApi.addPresets(group),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['news-site-presets'] });
      queryClient.invalidateQueries({ queryKey: ['news-sites'] });
      setHasChanges(false);
    },
  });

  const { mutate: bulkEnable, isPending: isBulkEnabling } = useMutation({
    mutationFn: (params: { tier?: string; category?: string; enabled: boolean }) =>
      newsSourcesApi.bulkEnable(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['news-sites'] });
    },
  });

  const resetForm = () => {
    setEditingIndex(null); setNewName(''); setNewUrl('');
    setNewType('rss'); setNewCategory('city_local');
    setNewLanguage('ru'); setNewTier('tier1');
    setNewFilterKeywords(''); setNewJsonMapping(''); setNewHtmlMapping('');
    setNewAutoMode(false); setAddError('');
  };

  const loadSiteIntoForm = (site: NewsSite, index: number) => {
    setEditingIndex(index); setNewName(site.name); setNewUrl(site.url);
    setNewType(site.type ?? 'rss'); setNewCategory(site.category ?? 'city_local');
    setNewLanguage(site.language ?? 'ru'); setNewTier(site.tier ?? 'tier1');
    setNewFilterKeywords(site.filterKeywords?.join(', ') ?? '');
    setNewJsonMapping(formatJsonBlock(site.jsonMapping));
    setNewHtmlMapping(formatJsonBlock(site.htmlMapping));
    setNewAutoMode(site.autoMode ?? false); setAddError('');
  };

  const handleAdd = () => {
    setAddError('');
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name) { setAddError('Укажите название'); return; }
    if (!url) { setAddError('Укажите URL'); return; }
    try { new URL(url); } catch { setAddError('Неверный формат URL'); return; }
    if (sites.some((site, i) => site.url === url && i !== editingIndex)) {
      setAddError('Этот сайт уже добавлен'); return;
    }
    try {
      const filterKeywords = newFilterKeywords
        .split(',').map(k => k.trim()).filter(Boolean);
      const jsonMapping = newType === 'json_api'
        ? parseJsonBlock<JsonFieldMapping>(newJsonMapping, 'JSON mapping')
        : undefined;
      const htmlMapping = newType === 'html_scrape'
        ? parseJsonBlock<HtmlFieldMapping>(newHtmlMapping, 'HTML mapping')
        : undefined;
      const nextSite: NewsSite = {
        name, url,
        enabled: editingIndex !== null ? sites[editingIndex]?.enabled !== false : true,
        type: newType, category: newCategory,
        language: newLanguage, tier: newTier,
        ...(jsonMapping ? { jsonMapping } : {}),
        ...(htmlMapping ? { htmlMapping } : {}),
        ...(filterKeywords.length > 0 ? { filterKeywords } : {}),
        ...(newAutoMode ? { autoMode: true } : {}),
      };
      if (editingIndex !== null) {
        setSites(sites.map((s, i) => i === editingIndex ? nextSite : s));
      } else {
        setSites([...sites, nextSite]);
      }
      setHasChanges(true); resetForm();
    } catch (error) {
      setAddError(error instanceof Error
        ? error.message : 'Не удалось разобрать расширенную конфигурацию');
    }
  };

  const handleRemove = (index: number) => {
    setSites(sites.filter((_, i) => i !== index)); setHasChanges(true);
  };

  const handleToggle = (index: number) => {
    setSites(sites.map((s, i) => i === index ? { ...s, enabled: !s.enabled } : s));
    setHasChanges(true);
  };

  const handleTestParse = (site: NewsSite) => {
    setTestingSite(site.url); setTestResult(null);
    testParse({
      name: site.name, url: site.url, enabled: site.enabled,
      type: site.type, category: site.category, language: site.language,
      tier: site.tier, jsonMapping: site.jsonMapping,
      htmlMapping: site.htmlMapping, filterKeywords: site.filterKeywords,
      autoMode: site.autoMode,
    });
  };

  const matchesCategory = (s: NewsSite, cat: NewsSourceCategory): boolean =>
    cat === 'city_local' ? !s.category || s.category === 'city_local' : s.category === cat;

  const filteredSites = categoryFilter === 'all'
    ? sites : sites.filter(s => matchesCategory(s, categoryFilter));

  const categoryCounts = {
    all: sites.length,
    ai_tech: sites.filter(s => matchesCategory(s, 'ai_tech')).length,
    city_local: sites.filter(s => matchesCategory(s, 'city_local')).length,
    community: sites.filter(s => matchesCategory(s, 'community')).length,
    asia_tech: sites.filter(s => matchesCategory(s, 'asia_tech')).length,
  };

  const handleHealthCheck = async () => {
    setHealthLoading(true); setHealthResult(null);
    try {
      const result = await newsSourcesApi.healthCheck(8000);
      const deadResult = await newsSourcesApi.cleanupDead(true);
      setHealthResult({
        healthy: result.healthy, unhealthy: result.unhealthy,
        totalChecked: result.totalChecked, dead: deadResult.dead,
      });
    } catch { /* ignore */ }
    setHealthLoading(false);
  };

  const handleCleanupDead = async () => {
    setCleanupLoading(true);
    try {
      await newsSourcesApi.cleanupDead(false);
      queryClient.invalidateQueries({ queryKey: ['news-sites'] });
      setHealthResult(prev => prev ? { ...prev, dead: [] } : null);
    } catch { /* ignore */ }
    setCleanupLoading(false);
  };

  const handleSuggestKeywords = async () => {
    setSuggestLoading(true); setAddError('');
    try {
      const keywords = await newsSourcesApi.suggestKeywords({
        url: newUrl.trim(), name: newName.trim(),
        category: newCategory, language: newLanguage,
      });
      const existing = newFilterKeywords.split(',').map(k => k.trim()).filter(Boolean);
      const merged = [...new Set([...existing, ...keywords])];
      setNewFilterKeywords(merged.join(', '));
    } catch (err) {
      setAddError(`Автоподбор: ${err instanceof Error ? err.message : 'ошибка'}`);
    }
    setSuggestLoading(false);
  };

  const handleAddDefaultKeywords = () => {
    const existing = newFilterKeywords.split(',').map(k => k.trim()).filter(Boolean);
    const merged = [...new Set([...existing, ...DEFAULT_VIBECODING_KEYWORDS])];
    setNewFilterKeywords(merged.join(', '));
  };

  return {
    isLoading, isSaving, isTesting, isAddingPresets, isBulkEnabling,
    parsingKilled, killLoading, toggleParsing,
    translationProvider, providerSaving, handleProviderChange,
    sites, hasChanges, filteredSites,
    categoryFilter, setCategoryFilter, categoryCounts,
    handleToggle, handleRemove, handleTestParse, saveSites,
    presetMeta, addPresets, bulkEnable,
    editingIndex, newName, setNewName, newUrl, setNewUrl,
    newType, setNewType, newCategory, setNewCategory,
    newLanguage, setNewLanguage, newTier, setNewTier,
    newFilterKeywords, setNewFilterKeywords,
    newJsonMapping, setNewJsonMapping, newHtmlMapping, setNewHtmlMapping,
    newAutoMode, setNewAutoMode, addError, setAddError,
    suggestLoading, handleAdd, resetForm, loadSiteIntoForm,
    handleSuggestKeywords, handleAddDefaultKeywords,
    healthLoading, healthResult, cleanupLoading,
    handleHealthCheck, handleCleanupDead,
    testResult, setTestResult, testingSite,
  };
};
