import type { FC } from 'react';
import type { NewsSourceType, NewsSourceCategory, NewsSourceLanguage, NewsSourceTier } from '../../../../shared/types/index.js';
import {
  Plus, Loader2, ToggleLeft, ToggleRight,
  AlertCircle, Sparkles, Filter, Languages,
  Cpu, Pencil, Wand2, Zap,
} from 'lucide-react';

interface NewsSourceFormProps {
  editingIndex: number | null;
  newName: string;
  setNewName: (v: string) => void;
  newUrl: string;
  setNewUrl: (v: string) => void;
  newType: NewsSourceType;
  setNewType: (v: NewsSourceType) => void;
  newCategory: NewsSourceCategory;
  setNewCategory: (v: NewsSourceCategory) => void;
  newLanguage: NewsSourceLanguage;
  setNewLanguage: (v: NewsSourceLanguage) => void;
  newTier: NewsSourceTier;
  setNewTier: (v: NewsSourceTier) => void;
  newFilterKeywords: string;
  setNewFilterKeywords: (v: string) => void;
  newJsonMapping: string;
  setNewJsonMapping: (v: string) => void;
  newHtmlMapping: string;
  setNewHtmlMapping: (v: string) => void;
  newAutoMode: boolean;
  setNewAutoMode: (v: boolean) => void;
  addError: string;
  setAddError: (v: string) => void;
  suggestLoading: boolean;
  handleAdd: () => void;
  resetForm: () => void;
  handleSuggestKeywords: () => void;
  handleAddDefaultKeywords: () => void;
}

export const NewsSourceForm: FC<NewsSourceFormProps> = ({
  editingIndex, newName, setNewName, newUrl, setNewUrl,
  newType, setNewType, newCategory, setNewCategory,
  newLanguage, setNewLanguage, newTier, setNewTier,
  newFilterKeywords, setNewFilterKeywords,
  newJsonMapping, setNewJsonMapping, newHtmlMapping, setNewHtmlMapping,
  newAutoMode, setNewAutoMode, addError, setAddError,
  suggestLoading, handleAdd, resetForm,
  handleSuggestKeywords, handleAddDefaultKeywords,
}) => (
  <div className="card mb-6">
    <div className="flex items-center justify-between mb-4">
      <h3 className="font-semibold text-lg text-gray-200">
        {editingIndex !== null ? 'Редактировать источник' : 'Добавить источник'}
      </h3>
      {editingIndex !== null && (
        <button onClick={resetForm} className="text-sm text-gray-500 hover:text-white transition-colors">
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
        <select className="input bg-white/5 text-gray-200" value={newType}
          onChange={(e) => setNewType(e.target.value as NewsSourceType)}>
          <option value="rss">RSS / Atom</option>
          <option value="json_api">JSON API</option>
          <option value="html_scrape">HTML Scraping</option>
        </select>
      </div>
      <div>
        <label className="label text-sm text-gray-400 flex items-center gap-1">
          <Filter className="w-3 h-3" /> Категория
        </label>
        <select className="input bg-white/5 text-gray-200" value={newCategory}
          onChange={(e) => setNewCategory(e.target.value as NewsSourceCategory)}>
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
        <select className="input bg-white/5 text-gray-200" value={newLanguage}
          onChange={(e) => setNewLanguage(e.target.value as NewsSourceLanguage)}>
          <option value="ru">Русский</option>
          <option value="en">English</option>
          <option value="zh">中文 (Chinese)</option>
          <option value="ja">日本語 (Japanese)</option>
          <option value="ko">한국어 (Korean)</option>
        </select>
      </div>
      <div>
        <label className="label text-sm text-gray-400">Tier</label>
        <select className="input bg-white/5 text-gray-200" value={newTier}
          onChange={(e) => setNewTier(e.target.value as NewsSourceTier)}>
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
              onClick={handleAddDefaultKeywords}
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
              onClick={handleSuggestKeywords}
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

    <div className="flex items-center gap-3 mb-4 p-3 rounded-xl"
      style={{ background: 'rgba(255, 215, 0, 0.03)', border: '1px solid rgba(255, 215, 0, 0.1)' }}
    >
      <button type="button" onClick={() => setNewAutoMode(!newAutoMode)} className="flex-shrink-0">
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
        <button onClick={resetForm} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
          Отмена
        </button>
      )}
    </div>
  </div>
);
