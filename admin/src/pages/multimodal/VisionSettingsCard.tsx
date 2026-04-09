import type { UseFormReturn } from 'react-hook-form';
import { Eye, Loader2, Download, CheckCircle, AlertCircle, MessageSquare } from 'lucide-react';
import type { SettingsForm } from './settingsSchema';
import type { VisionModel, ModelTestResult } from './multimodalConstants';

interface VisionSettingsCardProps {
  form: UseFormReturn<SettingsForm>;
  visionModels: VisionModel[];
  isRefreshingVision: boolean;
  refreshMessage: string;
  testingModel: string | null;
  modelTestResults: Record<string, ModelTestResult>;
  fetchVisionModels: (force: boolean) => Promise<void>;
  testVisionModel: (modelId: string) => Promise<void>;
}

export const VisionSettingsCard = ({
  form,
  visionModels,
  isRefreshingVision,
  refreshMessage,
  testingModel,
  modelTestResults,
  fetchVisionModels,
  testVisionModel,
}: VisionSettingsCardProps) => {
  const { register, watch, formState: { errors } } = form;
  const visionMaxTokens = watch('vision_max_tokens');
  const selectedVisionModel = watch('vision_model');

  return (
    <div className="card animate-fade-in-up stagger-3">
      <div className="flex items-center gap-3 mb-6">
        <div className="p-2.5 bg-gradient-to-br from-purple-500 to-pink-500 rounded-xl shadow-lg shadow-purple-500/25">
          <Eye className="w-6 h-6 text-white" />
        </div>
        <div className="flex-1">
          <h2 className="text-lg font-semibold text-white">Анализ изображений</h2>
          <p className="text-sm text-white/50">Только анализ изображений и распознавание текста, не модели общего чата</p>
        </div>
        <button
          type="button"
          onClick={() => fetchVisionModels(true)}
          disabled={isRefreshingVision}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-gradient-to-r from-amber-500 to-orange-500 rounded-lg hover:from-amber-600 hover:to-orange-600 transition-all shadow-md hover:shadow-lg disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isRefreshingVision ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="hidden sm:inline">Загрузка...</span>
            </>
          ) : (
            <>
              <Download className="w-4 h-4" />
              <span className="hidden sm:inline">Обновить модели</span>
            </>
          )}
        </button>
      </div>

      {refreshMessage && (
        <div className={`mb-4 text-sm p-3 rounded-lg flex items-center gap-2 ${
          refreshMessage.startsWith('Ошибка') 
            ? 'bg-red-500/10 border border-red-500/20 text-red-400' 
            : 'bg-emerald-500/10 border border-emerald-500/20 text-emerald-400'
        }`}>
          {refreshMessage.startsWith('Ошибка') ? (
            <AlertCircle className="w-4 h-4" />
          ) : (
            <CheckCircle className="w-4 h-4" />
          )}
          {refreshMessage}
        </div>
      )}

      <VisionModelSelector
        visionModels={visionModels}
        selectedVisionModel={selectedVisionModel}
        testingModel={testingModel}
        modelTestResults={modelTestResults}
        testVisionModel={testVisionModel}
        register={register}
      />

      <div className="border-t border-white/10 pt-6 space-y-4">
        <div className="flex items-center gap-2 mb-2">
          <MessageSquare className="w-5 h-5 text-purple-400" />
          <label className="label">Промпт для описания изображений</label>
        </div>
        <textarea
          {...register('vision_prompt')}
          rows={3}
          className="input w-full resize-none"
          placeholder="Как модель должна описывать изображения..."
        />
        {errors.vision_prompt && (
          <p className="text-red-400 text-sm">{errors.vision_prompt.message}</p>
        )}
        <p className="text-white/40 text-xs">
          Этот промпт отправляется vision-модели для описания картинки. 
          Описание затем передаётся основной LLM для ответа пользователю.
        </p>
      </div>

      <div className="pt-4 space-y-2">
        <div className="flex items-center justify-between">
          <label className="label">Максимум токенов для описания</label>
          <span className="text-sm text-violet-400 font-mono">{visionMaxTokens}</span>
        </div>
        <input
          type="range"
          min={256}
          max={2048}
          step={128}
          {...register('vision_max_tokens', { valueAsNumber: true })}
          className="w-full accent-purple-500"
        />
        <div className="flex justify-between text-xs text-white/40">
          <span>256 (короткое)</span>
          <span>2048 (детальное)</span>
        </div>
      </div>
    </div>
  );
};

interface VisionModelSelectorProps {
  visionModels: VisionModel[];
  selectedVisionModel: string;
  testingModel: string | null;
  modelTestResults: Record<string, ModelTestResult>;
  testVisionModel: (modelId: string) => Promise<void>;
  register: UseFormReturn<SettingsForm>['register'];
}

const VisionModelSelector = ({
  visionModels,
  selectedVisionModel,
  testingModel,
  modelTestResults,
  testVisionModel,
  register,
}: VisionModelSelectorProps) => (
  <div className="mb-6">
    <div className="flex items-center justify-between mb-2">
      <label className="label">Основная vision модель</label>
      {visionModels.length > 0 && (
        <button
          type="button"
          onClick={async () => {
            for (const m of visionModels) {
              await testVisionModel(m.id);
            }
          }}
          disabled={testingModel !== null}
          className="text-xs px-3 py-1 rounded-lg bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 transition-all disabled:opacity-50"
        >
          {testingModel ? '⏳ Тестирую...' : '🧪 Проверить все'}
        </button>
      )}
    </div>
    {visionModels.length > 0 ? (
      <div className="space-y-2 max-h-[320px] overflow-y-auto pr-2 scrollbar-thin">
        {[...visionModels].sort((a, b) => {
          const aResult = modelTestResults[a.id];
          const bResult = modelTestResults[b.id];
          const aScore = aResult?.status === 'ok' ? 0 : aResult?.status === 'error' ? 2 : 1;
          const bScore = bResult?.status === 'ok' ? 0 : bResult?.status === 'error' ? 2 : 1;
          return aScore - bScore;
        }).map((model) => (
          <label key={model.id} className={`block p-3 rounded-xl border-2 cursor-pointer transition-all ${
            selectedVisionModel === model.id
              ? 'border-purple-500 bg-purple-500/10' 
              : 'border-white/10 hover:border-white/20 bg-white/5'
          }`}>
            <div className="flex items-start gap-3">
              <input
                type="radio"
                value={model.id}
                {...register('vision_model')}
                className="mt-1 accent-purple-500"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-white text-sm truncate">{model.name}</span>
                  <span className="badge-success text-xs">FREE</span>
                  {modelTestResults[model.id]?.status === 'ok' && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-green-500/20 text-green-400">✓ {modelTestResults[model.id].latencyMs}ms</span>
                  )}
                  {modelTestResults[model.id]?.status === 'error' && (
                    <span className="text-xs px-1.5 py-0.5 rounded-full bg-red-500/20 text-red-400" title={modelTestResults[model.id].error}>✗ мёртвая</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <p className="text-xs text-white/40 font-mono truncate flex-1">{model.id}</p>
                  <button
                    type="button"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); testVisionModel(model.id); }}
                    disabled={testingModel === model.id}
                    className="text-xs px-2 py-0.5 rounded bg-white/10 hover:bg-white/20 text-white/60 hover:text-white transition-all flex-shrink-0 disabled:opacity-50"
                  >
                    {testingModel === model.id ? '⏳' : '🧪 тест'}
                  </button>
                </div>
                {modelTestResults[model.id]?.status === 'error' && (
                  <p className="text-xs text-red-400 mt-0.5">{modelTestResults[model.id].error}</p>
                )}
              </div>
            </div>
          </label>
        ))}
      </div>
    ) : (
      <div className="p-4 rounded-xl border-2 border-white/10 bg-white/5 text-center">
        <p className="text-white/50 text-sm">
          Нажмите "Обновить модели" для загрузки списка
        </p>
      </div>
    )}
    <p className="text-white/40 text-xs mt-2">
      Бесплатные vision модели с авто-fallback могут распознавать изображения, присылать их описания и извлекать текст из фото. Этот блок используется только для анализа изображений.
    </p>
  </div>
);
