import type { FC } from 'react';
import type { NewsSourceCategory } from '../../../../shared/types/index.js';
import { TestTube2, X, ExternalLink } from 'lucide-react';
import { CATEGORY_LABELS, UNCATEGORIZED_BADGE } from './newsSourcesConstants';
import type { TestResultData } from './useNewsSourcesPage';

interface TestParseResultModalProps {
  testResult: TestResultData;
  onClose: () => void;
}

export const TestParseResultModal: FC<TestParseResultModalProps> = ({ testResult, onClose }) => (
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
        <button onClick={onClose} className="p-1 text-gray-400 hover:text-white transition-colors">
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
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors">
          Закрыть
        </button>
      </div>
    </div>
  </div>
);
