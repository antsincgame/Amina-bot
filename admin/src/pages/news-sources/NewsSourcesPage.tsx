import {
  Newspaper, Loader2, Sparkles, Zap, Globe2, Filter, Save,
} from 'lucide-react';
import { CATEGORY_LABELS } from './newsSourcesConstants';
import { useNewsSourcesPage } from './useNewsSourcesPage';
import { ParsingKillSwitchCard } from './ParsingKillSwitchCard';
import { NewsSourcesHealthPanel } from './NewsSourcesHealthPanel';
import { NewsSiteList } from './NewsSiteList';
import { NewsSourceForm } from './NewsSourceForm';
import { TestParseResultModal } from './TestParseResultModal';

const NewsSourcesPage = () => {
  const hook = useNewsSourcesPage();

  if (hook.isLoading) {
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
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-2">
          <Newspaper className="w-7 h-7 text-amber-400" />
          <h1 className="text-2xl font-bold text-gradient-gold">Новостные источники</h1>
        </div>
        <p className="text-gray-400 mt-1">
          RSS-ленты, JSON API и HTML-источники для парсинга заголовков. Поддерживаются категории: городские, AI/Tech, азиатские AI-медиа, dev-сообщества.
        </p>
      </div>

      <ParsingKillSwitchCard
        parsingKilled={hook.parsingKilled}
        killLoading={hook.killLoading}
        toggleParsing={hook.toggleParsing}
        translationProvider={hook.translationProvider}
        providerSaving={hook.providerSaving}
        handleProviderChange={hook.handleProviderChange}
      />

      <div className="flex flex-wrap items-center gap-3 mb-6">
        <button
          onClick={() => hook.addPresets('all')}
          disabled={hook.isAddingPresets}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                     text-purple-400 hover:bg-purple-400/10 transition-all"
          style={{ border: '1px solid rgba(168, 85, 247, 0.3)' }}
        >
          {hook.isAddingPresets ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Sparkles className="w-4 h-4" />
          )}
          Добавить весь каталог ({hook.presetMeta?.counts.all ?? 0})
        </button>

        <button
          onClick={() => hook.bulkEnable({ tier: 'tier1', category: 'asia_tech', enabled: true })}
          disabled={hook.isBulkEnabling}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                     text-green-300 hover:bg-green-400/10 transition-all"
          style={{ border: '1px solid rgba(74, 222, 128, 0.28)' }}
        >
          {hook.isBulkEnabling ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Zap className="w-4 h-4" />
          )}
          Включить Asia Tier 1
        </button>

        <button
          onClick={() => hook.addPresets('asia')}
          disabled={hook.isAddingPresets}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg
                     text-red-300 hover:bg-red-400/10 transition-all"
          style={{ border: '1px solid rgba(248, 113, 113, 0.28)' }}
        >
          <Globe2 className="w-4 h-4" />
          Добавить Asia AI ({hook.presetMeta?.counts.asia ?? 0})
        </button>

        <div className="flex items-center gap-1 ml-auto">
          <Filter className="w-4 h-4 text-gray-500" />
          {(['all', 'ai_tech', 'city_local', 'community', 'asia_tech'] as const).map(cat => (
            <button
              key={cat}
              onClick={() => hook.setCategoryFilter(cat)}
              className={`px-2.5 py-1 text-xs rounded-lg transition-all ${
                hook.categoryFilter === cat
                  ? 'text-amber-400 bg-amber-400/10 border border-amber-400/30'
                  : 'text-gray-500 hover:text-gray-300 border border-transparent'
              }`}
            >
              {cat === 'all' ? 'Все' : CATEGORY_LABELS[cat].label} ({hook.categoryCounts[cat]})
            </button>
          ))}
        </div>
      </div>

      <NewsSourcesHealthPanel
        healthLoading={hook.healthLoading}
        healthResult={hook.healthResult}
        cleanupLoading={hook.cleanupLoading}
        onHealthCheck={hook.handleHealthCheck}
        onCleanupDead={hook.handleCleanupDead}
      />

      <NewsSiteList
        filteredSites={hook.filteredSites}
        sites={hook.sites}
        categoryFilter={hook.categoryFilter}
        onToggle={hook.handleToggle}
        onRemove={hook.handleRemove}
        onTestParse={hook.handleTestParse}
        onEdit={hook.loadSiteIntoForm}
        isTesting={hook.isTesting}
        testingSite={hook.testingSite}
      />

      <NewsSourceForm
        editingIndex={hook.editingIndex}
        newName={hook.newName} setNewName={hook.setNewName}
        newUrl={hook.newUrl} setNewUrl={hook.setNewUrl}
        newType={hook.newType} setNewType={hook.setNewType}
        newCategory={hook.newCategory} setNewCategory={hook.setNewCategory}
        newLanguage={hook.newLanguage} setNewLanguage={hook.setNewLanguage}
        newTier={hook.newTier} setNewTier={hook.setNewTier}
        newFilterKeywords={hook.newFilterKeywords} setNewFilterKeywords={hook.setNewFilterKeywords}
        newJsonMapping={hook.newJsonMapping} setNewJsonMapping={hook.setNewJsonMapping}
        newHtmlMapping={hook.newHtmlMapping} setNewHtmlMapping={hook.setNewHtmlMapping}
        newAutoMode={hook.newAutoMode} setNewAutoMode={hook.setNewAutoMode}
        addError={hook.addError} setAddError={hook.setAddError}
        suggestLoading={hook.suggestLoading}
        handleAdd={hook.handleAdd}
        resetForm={hook.resetForm}
        handleSuggestKeywords={hook.handleSuggestKeywords}
        handleAddDefaultKeywords={hook.handleAddDefaultKeywords}
      />

      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-500">
          {hook.hasChanges ? 'Есть несохранённые изменения' : 'Сохранено'}
        </p>
        <button
          onClick={() => hook.saveSites()}
          disabled={hook.isSaving || !hook.hasChanges}
          className="btn-primary"
        >
          {hook.isSaving ? (
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

      {hook.testResult && (
        <TestParseResultModal
          testResult={hook.testResult}
          onClose={() => hook.setTestResult(null)}
        />
      )}
    </div>
  );
};

export default NewsSourcesPage;
