import type { UseFormReturn } from 'react-hook-form';
import { Sparkles, RefreshCw, Loader2 } from 'lucide-react';
import type { SettingsForm } from './settingsSchema';
import type { ImageModel } from './multimodalConstants';

interface ImageGenerationCardProps {
  form: UseFormReturn<SettingsForm>;
  imageModels: ImageModel[];
  isRefreshingImage: boolean;
  fetchImageModels: () => Promise<void>;
}

export const ImageGenerationCard = ({
  form,
  imageModels,
  isRefreshingImage,
  fetchImageModels,
}: ImageGenerationCardProps) => {
  const { register, watch } = form;
  const selectedImageModel = watch('openrouter_image_model');

  return (
    <div className="card animate-fade-in-up stagger-4">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-gradient-to-br from-pink-500 to-rose-600 rounded-xl shadow-lg shadow-pink-500/25">
            <Sparkles className="w-5 h-5 text-white" />
          </div>
          <div>
            <h2 className="text-xl font-semibold text-white">Генерация изображений</h2>
            <p className="text-white/50 text-sm">OpenRouter → Gemini / FLUX / Riverflow</p>
          </div>
        </div>
        <button
          type="button"
          onClick={fetchImageModels}
          disabled={isRefreshingImage}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-pink-500/10 border border-pink-500/30 hover:bg-pink-500/20 text-pink-400 text-sm transition-all"
        >
          <RefreshCw className={`w-4 h-4 ${isRefreshingImage ? 'animate-spin' : ''}`} />
          Обновить модели
        </button>
      </div>

      <div className="space-y-4">
        <div className="p-4 rounded-xl border-2 border-pink-500/20 bg-pink-500/5">
          <p className="text-white/60 text-sm leading-relaxed">
            <strong className="text-pink-400">Fallback стратегия:</strong> HuggingFace (бесплатно) → OpenRouter (платно).
            Если HF кредиты закончились — автоматически используется OpenRouter.
          </p>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="w-5 h-5 text-pink-400" />
            <label className="label">OpenRouter модель (fallback)</label>
          </div>
          
          {imageModels.length > 0 ? (
            <div className="space-y-2">
              {imageModels.map((model) => (
                <label
                  key={model.id}
                  className={`flex items-center justify-between p-4 rounded-xl border-2 cursor-pointer transition-all ${
                    selectedImageModel === model.id
                      ? 'border-pink-500 bg-pink-500/10'
                      : 'border-white/10 hover:border-white/20 bg-white/5'
                  }`}
                >
                  <div className="flex items-start gap-3 flex-1 min-w-0">
                    <input
                      type="radio"
                      value={model.id}
                      {...register('openrouter_image_model')}
                      className="mt-1 accent-pink-500"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-white text-sm truncate">{model.name}</span>
                        {model.pricing.perImage <= 0.05 && (
                          <span className="badge-success text-xs">ДЕШЕВО</span>
                        )}
                        {model.pricing.perImage > 0.1 && (
                          <span className="text-amber-400 bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 rounded-full text-xs font-medium">
                            ПРЕМИУМ
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-white/40 mt-0.5 font-mono truncate">{model.id}</p>
                      {model.description && (
                        <p className="text-xs text-white/50 mt-1">{model.description}</p>
                      )}
                    </div>
                  </div>
                  <div className="text-right ml-4">
                    <div className="text-sm font-semibold text-pink-400">
                      ${model.pricing.perImage < 0.001 
                        ? model.pricing.perImage.toExponential(2) 
                        : model.pricing.perImage.toFixed(4)}
                    </div>
                    <div className="text-xs text-white/40">за 1K image</div>
                  </div>
                </label>
              ))}
            </div>
          ) : (
            <div className="p-4 rounded-xl border-2 border-white/10 bg-white/5 text-center">
              <p className="text-white/50 text-sm">
                {isRefreshingImage ? (
                  <span className="flex items-center justify-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Загрузка моделей...
                  </span>
                ) : (
                  'Нажмите "Обновить модели" для загрузки списка'
                )}
              </p>
            </div>
          )}
        </div>

        <div className="p-3 rounded-lg bg-amber-500/5 border border-amber-500/20 text-xs text-white/60">
          <strong className="text-amber-400">💡 Подсказка:</strong> Gemini 2.5 Flash Image — ~$0.003 за картинку.
          Для 1000 картинок = ~$3. Gemini 3.1 Flash Image Preview ещё дешевле.
          Если список пуст — проверьте, что бот запущен и OpenRouter API ключ настроен.
        </div>
      </div>
    </div>
  );
};
