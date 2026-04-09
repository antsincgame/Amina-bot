import type { FC } from 'react';
import { Loader2, StopCircle, PlayCircle, Cpu } from 'lucide-react';
import { TRANSLATION_PROVIDERS } from './newsSourcesConstants';

interface ParsingKillSwitchCardProps {
  parsingKilled: boolean;
  killLoading: boolean;
  toggleParsing: () => void;
  translationProvider: string;
  providerSaving: boolean;
  handleProviderChange: (provider: string) => void;
}

export const ParsingKillSwitchCard: FC<ParsingKillSwitchCardProps> = ({
  parsingKilled, killLoading, toggleParsing,
  translationProvider, providerSaving, handleProviderChange,
}) => (
  <>
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

    <div className="card mb-6">
      <div className="flex items-center gap-3 mb-3">
        <Cpu className="w-5 h-5 text-purple-400" />
        <div>
          <h3 className="text-white font-medium">AI-провайдер перевода новостей</h3>
          <p className="text-xs text-gray-500">
            Какая нейронка переводит заголовки и описания при парсинге
          </p>
        </div>
        {providerSaving && <Loader2 className="w-4 h-4 animate-spin text-purple-400 ml-auto" />}
      </div>
      <div className="flex flex-wrap gap-2">
        {TRANSLATION_PROVIDERS.map(({ value, label, desc, accent }) => {
          const isActive = translationProvider === value;
          return (
            <button
              key={value}
              onClick={() => handleProviderChange(value)}
              className="flex flex-col items-start px-4 py-2.5 rounded-xl text-sm transition-all"
              style={{
                color: isActive ? accent : 'rgb(156, 163, 175)',
                background: isActive ? `${accent}15` : 'transparent',
                border: `1px solid ${isActive ? `${accent}50` : 'rgba(255, 255, 255, 0.06)'}`,
              }}
            >
              <span className="font-medium">{label}</span>
              <span className="text-[10px]" style={{ color: 'rgb(107, 114, 128)' }}>{desc}</span>
            </button>
          );
        })}
      </div>
    </div>
  </>
);
