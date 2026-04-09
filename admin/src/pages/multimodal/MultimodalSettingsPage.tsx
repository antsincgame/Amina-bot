import { Save, Loader2, RefreshCw, Eye, Mic, CheckCircle, AlertCircle, Sparkles, Volume2 } from 'lucide-react';
import { useMultimodalSettings } from './useMultimodalSettings';
import { AudioTranscriptionCard } from './AudioTranscriptionCard';
import { TtsSettingsCard } from './TtsSettingsCard';
import { VisionSettingsCard } from './VisionSettingsCard';
import { ImageGenerationCard } from './ImageGenerationCard';

const MultimodalSettingsPage = () => {
  const {
    form,
    isLoading,
    isSaving,
    saveMessage,
    runtimeTruth,
    visionModels,
    imageModels,
    isRefreshingVision,
    isRefreshingImage,
    refreshMessage,
    audioRuntimeState,
    testingModel,
    modelTestResults,
    fetchVisionModels,
    fetchImageModels,
    testVisionModel,
    onSubmit,
    resetForm,
  } = useMultimodalSettings();

  const { handleSubmit, formState: { isDirty } } = form;

  if (isLoading) {
    return (
      <div className="p-6 lg:p-8 max-w-3xl mx-auto">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-8 h-8 animate-spin text-violet-500" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-8">
      <div className="animate-fade-in-up">
        <div className="flex items-center gap-3 mb-2">
          <div className="p-2 bg-gradient-to-br from-violet-500 to-purple-600 rounded-xl shadow-lg shadow-violet-500/25">
            <Sparkles className="w-6 h-6 text-white" />
          </div>
          <h1 className="heading-section">Голос и Фото</h1>
        </div>
        <p className="text-white/60">
          Настройки обработки голосовых сообщений и анализа изображений
        </p>
      </div>

      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        <AudioTranscriptionCard form={form} audioRuntimeState={audioRuntimeState} />

        <TtsSettingsCard form={form} runtimeTruth={runtimeTruth} />

        <VisionSettingsCard
          form={form}
          visionModels={visionModels}
          isRefreshingVision={isRefreshingVision}
          refreshMessage={refreshMessage}
          testingModel={testingModel}
          modelTestResults={modelTestResults}
          fetchVisionModels={fetchVisionModels}
          testVisionModel={testVisionModel}
        />

        <ImageGenerationCard
          form={form}
          imageModels={imageModels}
          isRefreshingImage={isRefreshingImage}
          fetchImageModels={fetchImageModels}
        />

        <HowItWorksCard />

        <div className="flex items-center justify-between animate-fade-in-up stagger-5">
          {saveMessage && (
            <div className={`flex items-center gap-2 text-sm ${
              saveMessage.includes('сохранены') ? 'text-emerald-400' : 'text-red-400'
            }`}>
              {saveMessage.includes('сохранены') ? (
                <CheckCircle className="w-4 h-4" />
              ) : (
                <AlertCircle className="w-4 h-4" />
              )}
              {saveMessage}
            </div>
          )}
          <div className="flex items-center gap-3 ml-auto">
            <button
              type="button"
              onClick={resetForm}
              disabled={!isDirty}
              className="btn-secondary"
            >
              <RefreshCw className="w-4 h-4 mr-2" />
              Сбросить
            </button>
            <button
              type="submit"
              disabled={isSaving || !isDirty}
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
        </div>
      </form>
    </div>
  );
};

const HowItWorksCard = () => (
  <div className="card-info animate-fade-in-up stagger-4">
    <h3 className="font-semibold text-white mb-4">Как это работает</h3>
    <div className="space-y-4 text-sm">
      <div className="flex items-start gap-3">
        <div className="p-1.5 bg-blue-500/20 rounded-lg">
          <Mic className="w-4 h-4 text-blue-400" />
        </div>
        <div>
          <p className="font-medium text-white">Голосовое сообщение</p>
          <p className="text-white/60">
            Голос → Groq Whisper (бесплатно) → Текст → Основная LLM → Ответ
          </p>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <div className="p-1.5 bg-purple-500/20 rounded-lg">
          <Eye className="w-4 h-4 text-purple-400" />
        </div>
        <div>
          <p className="font-medium text-white">Изображение</p>
          <p className="text-white/60">
            Фото → Vision-модель → Описание → Основная LLM → Ответ
          </p>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <div className="p-1.5 bg-emerald-500/20 rounded-lg">
          <Volume2 className="w-4 h-4 text-emerald-400" />
        </div>
        <div>
          <p className="font-medium text-white">Озвучка (TTS)</p>
          <p className="text-white/60">
            Ответ бота → ElevenLabs / OpenAI TTS HD / Edge TTS → Голосовое сообщение
          </p>
        </div>
      </div>
      <div className="flex items-start gap-3">
        <div className="p-1.5 bg-amber-500/20 rounded-lg">
          <RefreshCw className="w-4 h-4 text-amber-400" />
        </div>
        <div>
          <p className="font-medium text-white">Авто-fallback</p>
          <p className="text-white/60">
            Если основной движок TTS или vision упал → автоматический переход на запасной вариант. Прозрачно для пользователя.
          </p>
        </div>
      </div>
    </div>
  </div>
);

export default MultimodalSettingsPage;
